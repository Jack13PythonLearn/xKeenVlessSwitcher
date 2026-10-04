'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const zlib = require('node:zlib');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 5000;
const INTERVALS = [0, 1, 6, 12, 24, 72, 168];
const blocked = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(address, prefix);
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8], ['2001:db8::', 32]]) blocked.addSubnet(address, prefix, 'ipv6');

function isPublicAddress(address) {
  const family = net.isIP(address);
  return Boolean(family) && !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

function subscriptionUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Укажите корректную ссылку HTTP или HTTPS.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Нужна ссылка HTTP/HTTPS без логина, пароля и фрагмента #.');
  }
  if (url.href.length > 8192) throw new Error('Ссылка подписки слишком длинная.');
  return url;
}

// Resolve and pin the address for every redirect, so DNS rebinding cannot reach the router.
async function downloadSubscription(value, options = {}) {
  const deadline = Date.now() + (options.timeout || 20000);
  async function request(url, redirects) {
    if (redirects > 5) throw new Error('Слишком много перенаправлений подписки.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    try { addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true }); }
    catch { throw new Error('Не удалось определить адрес сервера подписки.'); }
    if (!addresses.length || (!options.allowPrivate && addresses.some(x => !isPublicAddress(x.address)))) {
      throw new Error('Подписка должна находиться на публичном интернет-сервере.');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Сервер подписки не ответил вовремя.');
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const target = addresses[0];
      const req = (url.protocol === 'https:' ? https : http).get(url, {
        headers: { 'User-Agent': 'xKeenVlessSwitcher/2.1.0', Accept: 'text/plain, */*', 'Accept-Encoding': 'gzip, deflate, br' },
        lookup: (_hostname, opts, cb) => opts.all ? cb(null, [target]) : cb(null, target.address, target.family)
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          let next;
          try {
            if (!res.headers.location) throw new Error();
            next = subscriptionUrl(new URL(res.headers.location, url).href);
            if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error();
          } catch { return finish(new Error('Некорректное или небезопасное перенаправление подписки.')); }
          // The recursive request shares the original deadline.
          request(next, redirects + 1).then(x => finish(null, x), finish);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return finish(new Error(`Сервер подписки вернул HTTP ${res.statusCode}.`));
        }
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_BYTES) { finish(new Error('Подписка превышает 8 МБ.')); res.destroy(); req.destroy(); }
          else chunks.push(chunk);
        });
        res.on('error', () => finish(new Error('Соединение с сервером подписки прервано.')));
        res.on('end', () => {
          if (settled) return;
          try {
            let body = Buffer.concat(chunks);
            const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
            const decode = { gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync }[encoding];
            if (encoding && encoding !== 'identity' && !decode) throw new Error();
            if (decode) body = decode(body, { maxOutputLength: MAX_BYTES });
            if (body.length > MAX_BYTES) throw new Error();
            finish(null, body.toString('utf8'));
          } catch { finish(new Error('Ответ подписки повреждён или превышает 8 МБ.')); }
        });
      });
      const timer = setTimeout(() => { finish(new Error('Сервер подписки не ответил вовремя.')); req.destroy(); }, remaining);
      req.on('error', () => finish(new Error('Не удалось загрузить подписку: ошибка сети или TLS.')));
    });
  }
  // Includes DNS lookup time in the overall deadline.
  let timer;
  try {
    return await Promise.race([request(subscriptionUrl(value), 0), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Сервер подписки не ответил вовремя.')), options.timeout || 20000);
    })]);
  } finally { clearTimeout(timer); }
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])]));
  return value;
}

function connectionKey(content, ignoreSni = false) {
  const parsed = typeof content === 'string' ? JSON.parse(content) : content;
  const outbound = (parsed.outbounds || [parsed]).find(x => !['freedom', 'blackhole', 'dns'].includes(x.protocol));
  if (!outbound) throw new Error('В конфигурации нет прокси-подключения.');
  const value = structuredClone(outbound);
  delete value.tag;
  // Normalize optional defaults used by earlier manual imports.
  for (const server of value.settings?.vnext || []) {
    for (const user of server.users || []) {
      if (!user.flow) delete user.flow;
      if (!user.level) delete user.level;
      if (!user.encryption) user.encryption = 'none';
    }
  }
  const stream = value.streamSettings || {};
  if (ignoreSni) {
    if (stream.tlsSettings) delete stream.tlsSettings.serverName;
    if (stream.realitySettings) delete stream.realitySettings.serverName;
  }
  if (stream.network === 'raw') stream.network = 'tcp';
  if (stream.tlsSettings?.allowInsecure === false) delete stream.tlsSettings.allowInsecure;
  if (stream.realitySettings) {
    if (stream.realitySettings.show === false) delete stream.realitySettings.show;
    if (!stream.realitySettings.spiderX) stream.realitySettings.spiderX = '/';
  }
  return crypto.createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}

// Providers can rotate SNI on every download. Use this only for unambiguous
// matching; full keys still distinguish simultaneous variants and manual edits.
function connectionIdentity(content) { return connectionKey(content, true); }

function parseHysteria2(value) {
  const url = new URL(value);
  const params = url.searchParams;
  const address = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || 443);
  const auth = decodeURIComponent(url.username + (url.password ? ':' + url.password : ''));
  if (!address || !auth || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некорректная ссылка Hysteria2.');
  if (params.has('mport') || params.has('ports')) throw new Error('Диапазоны портов Hysteria2 пока не поддерживаются.');
  const obfs = params.get('obfs');
  if (obfs || params.has('pinSHA256')) throw new Error('Обфускация и pinSHA256 Hysteria2 пока не поддерживаются.');
  const sni = params.get('sni') || address;
  const streamSettings = {
    network: 'hysteria', security: 'tls',
    tlsSettings: { serverName: sni, alpn: (params.get('alpn') || 'h3').split(',') },
    hysteriaSettings: { version: 2, auth }
  };
  if (['1', 'true'].includes(params.get('insecure'))) streamSettings.tlsSettings.allowInsecure = true;
  const outbounds = [{ tag: 'vless-reality', protocol: 'hysteria', settings: { version: 2, address, port }, streamSettings },
    { tag: 'direct', protocol: 'freedom' }, { tag: 'block', protocol: 'blackhole' }];
  return { name: decodeURIComponent(url.hash.slice(1)) || `Hysteria2 - ${address}:${port}`, serverAddress: address,
    serverPort: port, protocol: 'hysteria', network: 'hysteria', security: 'tls', sni, outboundJson: JSON.stringify({ outbounds }, null, 2) };
}

function parseSubscription(text, parseVlessUrl) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw new Error('Подписка превышает 8 МБ.');
  let body = text.replace(/^\uFEFF/, '').trim();
  if (!body) throw new Error('Подписка пуста. Существующие серверы сохранены.');
  if (!/^[\w+.-]+:\/\//m.test(body)) {
    const encoded = body.replace(/\s/g, '');
    if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded) && encoded.length % 4 !== 1) body = Buffer.from(encoded, 'base64').toString('utf8').trim();
  }
  const lines = body.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  if (lines.length > MAX_NODES) throw new Error('В подписке больше 5000 записей.');
  const nodes = new Map();
  const unsupported = new Set();
  let duplicates = 0;
  for (const [index, line] of lines.entries()) {
    const scheme = line.match(/^([\w+.-]+):\/\//)?.[1].toLowerCase();
    if (!scheme) throw new Error(`Строка ${index + 1}: ожидалась ссылка подключения. Поддерживаются текст и Base64.`);
    if (!['vless', 'hy2', 'hysteria2'].includes(scheme)) { unsupported.add(scheme); continue; }
    let parsed;
    try {
      parsed = scheme === 'vless' ? parseVlessUrl(line) : parseHysteria2(line);
      const outbound = JSON.parse(parsed.outboundJson);
      // All presets, including custom router rules, address the same proxy tag.
      outbound.outbounds[0].tag = 'vless-reality';
      parsed.outboundContent = JSON.stringify(outbound, null, 2);
      delete parsed.outboundJson;
      if (!parsed.serverAddress || !Number.isInteger(parsed.serverPort) || parsed.serverPort < 1 || parsed.serverPort > 65535) throw new Error();
    } catch { throw new Error(`Строка ${index + 1}: некорректная или неподдерживаемая настройка ${scheme}.`); }
    const key = connectionKey(parsed.outboundContent);
    if (nodes.has(key)) duplicates++;
    else nodes.set(key, { ...parsed, key });
  }
  if (!nodes.size) throw new Error('Нет поддерживаемых серверов VLESS/Hysteria2. Существующие серверы сохранены.');
  return { nodes: [...nodes.values()], duplicates, unsupported: [...unsupported] };
}

function publicSubscription(sub, connections) {
  const { url, excluded, adoptExistingOnly, ...visible } = sub;
  return { ...visible, source: subscriptionUrl(url).origin, count: connections.filter(x => x.subscriptionId === sub.id).length };
}

function protectedIds(data) {
  const fo = data.settings.failover || {};
  const af = data.settings.autoFailover || {};
  return new Set([data.settings.activeConnectionId, fo.primaryConnectionId, fo.backupConnectionId,
    af.preferredPrimaryId, af.specificPrimaryId, af.activeBackupId, ...(af.poolConnectionIds || [])].filter(Boolean));
}

// Pure reconciliation. No active files are rewritten and no VPN service is restarted.
function reconcile(data, id, parsed, options = {}) {
  const sub = data.subscriptions.find(x => x.id === id);
  if (!sub) throw new Error('Подписка удалена во время обновления.');
  const excluded = new Map((sub.excluded || []).map(x => [x.key, x]));
  const byKey = new Map(data.connections.filter(x => x.subscriptionId === id).map(x => [x.subscriptionKey, x]));
  const manual = new Map();
  const identities = new Map();
  const feedIdentities = new Map();
  const indexIdentity = (identity, conn) => identities.set(identity, [...(identities.get(identity) || []), conn]);
  for (const conn of data.connections.filter(x => !x.subscriptionId || x.subscriptionId === id)) {
    try { indexIdentity(conn.subscriptionIdentity || connectionIdentity(conn.outboundContent), conn); } catch {}
  }
  for (const node of parsed.nodes) {
    const identity = connectionIdentity(node.outboundContent);
    feedIdentities.set(identity, (feedIdentities.get(identity) || 0) + 1);
  }
  const excludedIdentities = new Set([...excluded.values()].map(x => x.identity).filter(Boolean));
  for (const conn of data.connections.filter(x => !x.subscriptionId)) {
    try { const key = connectionKey(conn.outboundContent); if (!manual.has(key)) manual.set(key, conn); } catch {}
  }
  const protectedSet = protectedIds(data);
  const seen = new Set();
  const now = new Date().toISOString();
  const stats = { added: 0, adopted: 0, retained: 0, updated: 0, removed: 0, excluded: 0, protected: 0, duplicates: parsed.duplicates, unsupported: parsed.unsupported };
  for (const node of parsed.nodes) {
    const identity = connectionIdentity(node.outboundContent);
    const uniqueIdentity = feedIdentities.get(identity) === 1;
    if (excluded.has(node.key) || (uniqueIdentity && excludedIdentities.has(identity))) {
      const entry = excluded.get(node.key);
      if (entry) entry.identity = identity;
      stats.excluded++;
      continue;
    }
    let conn = byKey.get(node.key) || manual.get(node.key);
    const candidates = identities.get(identity) || [];
    if (!conn && uniqueIdentity && candidates.length === 1 && !seen.has(candidates[0].id)) conn = candidates[0];
    const { key, name, ...fields } = node;
    if (conn) {
      seen.add(conn.id);
      const owned = conn.subscriptionId === id;
      let edited = false;
      try { edited = owned && connectionKey(conn.outboundContent) !== conn.subscriptionKey; } catch { edited = true; }
      if (edited) {
        conn.subscriptionMissing = true;
        stats.protected++;
        continue;
      }
      if (owned && conn.name === conn.subscriptionName) conn.name = name;
      if (connectionKey(conn.outboundContent) !== key) stats.updated++;
      Object.assign(conn, fields, { subscriptionId: id, subscriptionKey: key, subscriptionIdentity: identity,
        subscriptionName: name, subscriptionMissing: false });
      stats[owned ? 'retained' : 'adopted']++;
    } else if (options.adoptExistingOnly) {
      excluded.set(key, { key, identity, name });
      stats.excluded++;
    } else {
      conn = { ...fields, name, id: 'conn_' + crypto.randomUUID(), description: '', routingId: sub.routingId,
        subscriptionId: id, subscriptionKey: key, subscriptionIdentity: identity, subscriptionName: name, subscriptionMissing: false,
        createdAt: now, lastPing: null, lastPingStatus: null };
      data.connections.push(conn);
      seen.add(conn.id);
      stats.added++;
    }
  }
  data.connections = data.connections.filter(conn => {
    if (conn.subscriptionId !== id || seen.has(conn.id)) return true;
    let edited = true;
    try { edited = connectionKey(conn.outboundContent) !== conn.subscriptionKey; } catch {}
    if (protectedSet.has(conn.id) || edited || parsed.unsupported.length) {
      conn.subscriptionMissing = true;
      stats.protected++;
      return true;
    }
    stats.removed++;
    return false;
  });
  sub.excluded = [...excluded.values()];
  Object.assign(sub, { lastUpdatedAt: now, lastAttemptAt: now, lastError: null, stats });
  return stats;
}

function createSubscriptionManager({ loadData, saveData, parseVlessUrl, fetchText = downloadSubscription }) {
  const running = new Set();
  let timer;
  let ticking = false;
  function write(data) { if (!saveData(data)) throw new Error('Не удалось сохранить настройки.'); }
  function find(data, id) {
    const sub = data.subscriptions.find(x => x.id === id);
    if (!sub) throw new Error('Подписка не найдена.');
    return sub;
  }
  function settings(body, data, current = {}) {
    const name = String(body.name ?? current.name ?? '').trim();
    if (!name || name.length > 120) throw new Error('Название должно содержать от 1 до 120 символов.');
    const url = subscriptionUrl(body.url || current.url).href;
    const intervalHours = Number(body.intervalHours ?? current.intervalHours ?? 24);
    if (!INTERVALS.includes(intervalHours)) throw new Error('Некорректный интервал обновления.');
    const routingId = body.routingId || current.routingId || 'routing_all_vpn';
    if (!data.routings.some(x => x.id === routingId)) throw new Error('Выбранная маршрутизация не найдена.');
    return { name, url, intervalHours, routingId };
  }
  async function refresh(id, options = {}) {
    if (running.has(id)) throw new Error('Эта подписка уже обновляется.');
    const before = find(loadData(), id);
    running.add(id);
    try {
      const parsed = parseSubscription(await fetchText(before.url), parseVlessUrl);
      const data = loadData();
      const current = find(data, id);
      if (current.url !== before.url || current.updatedAt !== before.updatedAt) throw new Error('Настройки изменились во время загрузки. Повторите обновление.');
      // Synchronize the complete provider list. Discard legacy selection filters
      // only after the download and parsing succeed, preserving data on failure.
      current.excluded = [];
      delete current.adoptExistingOnly;
      const stats = reconcile(data, id, parsed);
      write(data);
      return stats;
    } catch (err) {
      const data = loadData();
      const current = data.subscriptions.find(x => x.id === id);
      if (current && current.url === before.url && current.updatedAt === before.updatedAt) {
        current.lastAttemptAt = new Date().toISOString();
        current.lastError = err.message;
        write(data);
      }
      throw err;
    } finally { running.delete(id); }
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const sub of loadData().subscriptions) {
        const last = Date.parse(sub.lastAttemptAt || sub.lastUpdatedAt || sub.createdAt) || 0;
        if (sub.intervalHours > 0 && Date.now() - last >= sub.intervalHours * 3600000 && !running.has(sub.id)) {
          try { await refresh(sub.id); } catch { /* Error is saved for display; URLs are never logged. */ }
        }
      }
    } finally { ticking = false; }
  }
  return {
    list() { const data = loadData(); return data.subscriptions.map(x => ({ ...publicSubscription(x, data.connections), updating: running.has(x.id) })); },
    async add(body) {
      const data = loadData();
      const fields = settings(body, data);
      if (data.subscriptions.some(x => x.url === fields.url)) throw new Error('Эта ссылка уже добавлена.');
      const sub = { ...fields, id: 'sub_' + crypto.randomUUID(), excluded: [],
        createdAt: new Date().toISOString(), updatedAt: crypto.randomUUID() };
      data.subscriptions.push(sub);
      write(data);
      try { return { id: sub.id, stats: await refresh(sub.id) }; }
      catch (err) { return { id: sub.id, error: err.message }; }
    },
    edit(id, body) {
      const data = loadData();
      const sub = find(data, id);
      const fields = settings(body, data, sub);
      if (data.subscriptions.some(x => x.id !== id && x.url === fields.url)) throw new Error('Эта ссылка уже добавлена.');
      Object.assign(sub, fields, { updatedAt: crypto.randomUUID() });
      write(data);
    },
    remove(id) {
      const data = loadData();
      find(data, id);
      data.subscriptions = data.subscriptions.filter(x => x.id !== id);
      for (const conn of data.connections.filter(x => x.subscriptionId === id)) {
        for (const key of ['subscriptionId', 'subscriptionKey', 'subscriptionIdentity', 'subscriptionName', 'subscriptionMissing']) delete conn[key];
      }
      write(data);
    },
    resetExclusions(id) { const data = loadData(); find(data, id).excluded = []; write(data); },
    refresh, tick,
    start() { timer = setInterval(() => { tick().catch(() => {}); }, 60000); timer.unref(); tick().catch(() => {}); },
    stop() { clearInterval(timer); }
  };
}

module.exports = { createSubscriptionManager, parseSubscription, parseHysteria2, connectionKey, connectionIdentity, reconcile,
  subscriptionUrl, downloadSubscription, isPublicAddress, publicSubscription };
