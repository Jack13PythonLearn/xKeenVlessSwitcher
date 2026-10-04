'use strict';
const crypto = require('node:crypto');
const { domainToASCII } = require('node:url');
const { v2flyLists } = require('./routing-sources.json');
const WEEK = 7 * 86400000;
const SOURCES = [
  { id: 'v2fly', name: 'v2fly/domain-list-community', repo: 'v2fly/domain-list-community', branch: 'master', url: 'https://github.com/v2fly/domain-list-community/tree/master/data' },
  { id: 'itdog', name: 'itdoginfo/allow-domains', repo: 'itdoginfo/allow-domains', branch: 'main', path: 'Russia/outside-raw.lst', url: 'https://github.com/itdoginfo/allow-domains/blob/main/Russia/outside-raw.lst' }
];
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = values => [...new Set(values)].sort();
async function github(path) {
  const res = await fetch('https://api.github.com/repos/' + path, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'xKeenVlessSwitcher-routing-sync' },
    signal: AbortSignal.timeout(20000), redirect: 'error'
  });
  if (!res.ok) throw Error(res.status === 403 || res.status === 429 ? 'GitHub ограничил частоту запросов. Повторите позже.' : 'Источник недоступен (HTTP ' + res.status + ').');
  let size = 0; const chunks = [];
  for await (const chunk of res.body) { size += chunk.length; if (size > 4 * 1024 * 1024) { await res.body.cancel().catch(() => {}); throw Error('Ответ источника слишком большой.'); } chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function parseList(text, includes = false) {
  const domains = [], dependencies = [];
  if (typeof text !== 'string' || text.length > 1024 * 1024) throw Error('Некорректный список источника.');
  for (const line of text.split(/\r?\n/)) {
    const clean = line.split('#')[0].trim(); if (!clean) continue;
    const [value, ...attrs] = clean.split(/\s+/);
    if (attrs.some(x => !/^@[\w-]+(?:=[\w-]+)?$/.test(x))) throw Error('Неизвестный формат списка.');
    if (value.startsWith('include:')) {
      const name = value.slice(8);
      if (!includes || attrs.length || !/^[a-z0-9!_-]+$/.test(name)) throw Error('Неподдерживаемое включение списка.');
      dependencies.push(name); continue;
    }
    if (value.startsWith('regexp:')) { if (!includes || value.length > 2048) throw Error('Некорректное регулярное правило.'); domains.push(value); continue; }
    const match = value.match(/^(?:(full|domain):)?(.+)$/);
    const host = domainToASCII(match[2]).toLowerCase();
    if (!host || host.length > 253 || host.split('.').some(s => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s))) throw Error('Некорректный домен в источнике.');
    domains.push((match[1] || 'domain') + ':' + host);
  }
  if (!domains.length && !dependencies.length) throw Error('Источник вернул пустой список.');
  return { domains, dependencies };
}
async function fetchSources(previous = {}, api = github) {
  const results = [];
  for (const source of SOURCES) {
    const tree = await api(source.repo + '/git/trees/' + source.branch + '?recursive=1');
    if (tree.truncated || !Array.isArray(tree.tree)) throw Error('Неполный каталог источника.');
    const index = new Map(tree.tree.filter(x => x.type === 'blob').map(x => [x.path, x.sha]));
    const old = previous[source.id];
    const roots = source.id === 'v2fly' ? v2flyLists.map(n => 'data/' + n) : [source.path];
    const known = unique([...roots, ...(old?.files || []).map(x => x.path)]);
    const signature = paths => paths.map(path => { const sha = index.get(path); if (!/^[a-f0-9]{40}$/.test(sha || '')) throw Error('Файл источника отсутствует.'); return { path, sha }; });
    if (old && known.every(path => index.has(path)) && old.version === digest(signature(known)) && old.selection === digest(roots)) { results.push({ ...old, id: source.id, unchanged: true }); continue; }
    const visited = new Set(), stack = new Set(), domains = [], files = [];
    async function read(path) {
      if (stack.has(path)) throw Error('Циклическое включение списка.');
      if (visited.has(path)) return;
      if (visited.size > 100) throw Error('Слишком много вложенных списков.');
      stack.add(path); visited.add(path);
      const file = signature([path])[0];
      const blob = await api(source.repo + '/git/blobs/' + file.sha);
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw Error('Некорректный файл источника.');
      const bytes = Buffer.from(blob.content, 'base64');
      const actual = crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex');
      if (actual !== file.sha) throw Error('Версия файла источника не совпадает.');
      const parsed = parseList(bytes.toString('utf8'), source.id === 'v2fly');
      domains.push(...parsed.domains); files.push(file);
      for (const name of parsed.dependencies) await read('data/' + name);
      stack.delete(path);
    }
    for (const path of roots) await read(path);
    const ordered = files.sort((a,b) => a.path.localeCompare(b.path, 'en'));
    // Use the same lexical ordering for unchanged checks and first downloads.
    const sorted = unique(ordered.map(x => x.path)).map(path => ordered.find(x => x.path === path));
    results.push({ id: source.id, version: digest(sorted), selection: digest(roots), files: sorted, domains: unique(domains), unchanged: false });
  }
  return results;
}
function findProfile(data) { return data.routings.find(r => r.replacesSystemRouting === 'routing_except_ru' && !r.isSystem); }
function createRoutingSync({ loadData, saveData, parseJson = JSON.parse, apply = async () => {}, api = github, now = () => Date.now() }) {
  let pending, timer;
  function write(data) { if (saveData(data) === false) throw Error('Не удалось сохранить обновление.'); }
  async function run() {
    const initial = findProfile(loadData()); if (!initial) throw Error('Объединённый профиль маршрутизации не найден.');
    const before = initial.content;
    try {
      const fetched = await fetchSources(initial.domainSync?.sources, api);
      const data = loadData(), profile = findProfile(data);
      if (!profile || profile.id !== initial.id || profile.content !== before) throw Error('Профиль изменён во время проверки. Повторите обновление.');
      const stamp = new Date(now()).toISOString();
      const old = profile.domainSync || {};
      if (fetched.every(s => s.unchanged)) {
        profile.domainSync = { ...old, enabled: true, lastCheckedAt: stamp, lastResult: 'unchanged', error: '', message: 'Обновлений нет — версии источников не изменились.' }; write(data);
        return { changed: false, message: profile.domainSync.message };
      }
      const json = parseJson(profile.content), routing = json.routing || json;
      if (!Array.isArray(routing.rules)) throw Error('В профиле нет правил.');
      let rule = null;
      if (old.sources) {
        const reference = old.ruleDomainSnapshot || old.managedDomains || [];
        const shape = r => digest(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'domain')));
        const candidates = routing.rules.filter(r => r.outboundTag === 'direct' && Array.isArray(r.domain) && (!old.ruleShape || shape(r) === old.ruleShape));
        const exact = candidates.filter(r => JSON.stringify(unique(r.domain)) === JSON.stringify(unique(reference)));
        const overlapping = candidates.filter(r => r.domain.some(d => reference.includes(d)));
        if (exact.length === 1) rule = exact[0];
        else if (exact.length === 0 && overlapping.length === 1) rule = overlapping[0];
      }
      if (!rule && !old.sources) rule = routing.rules.filter(r => r.outboundTag === 'direct' && Array.isArray(r.domain)).sort((a,b) => b.domain.length-a.domain.length)[0];
      if (!rule || rule.outboundTag !== 'direct' || !Array.isArray(rule.domain)) throw Error('Обновляемое правило удалено или изменено. Проверьте JSON профиля.');
      const incoming = unique(fetched.flatMap(s => s.domains));
      if (!incoming.length || incoming.length > 20000) throw Error('Неожиданный размер списка.');
      const previousManaged = new Set(old.managedDomains || incoming);
      const manual = rule.domain.filter(x => !previousManaged.has(x));
      const removedManually = old.managedDomains ? old.managedDomains.filter(x => !rule.domain.includes(x)) : [];
      const exclusions = new Set([...(old.exclusions || []), ...removedManually]);
      const nextDomains = unique([...incoming.filter(x => !exclusions.has(x)), ...manual]);
      const changed = JSON.stringify(unique(rule.domain)) !== JSON.stringify(nextDomains);
      rule.domain = nextDomains;
      const content = JSON.stringify(json, null, 2);
      profile.content = content;
      profile.domainSync = { enabled: true, ruleIndex: routing.rules.indexOf(rule), ruleDomainSnapshot: nextDomains, ruleShape: digest(Object.fromEntries(Object.entries(rule).filter(([k]) => k !== 'domain'))), sources: Object.fromEntries(fetched.map(({id,unchanged,...s}) => [id,s])), managedDomains: incoming, exclusions: [...exclusions], manualCount: manual.length, lastCheckedAt: stamp, lastUpdatedAt: changed || !old.lastUpdatedAt ? stamp : old.lastUpdatedAt, lastResult: changed ? 'updated' : 'unchanged', error: '', message: changed ? 'Список обновлён: ' + nextDomains.length + ' записей.' : 'Обновлений нет — состав доменов не изменился.' };
      write(data);
      if (changed) {
        try { await apply(profile.id, before, content); }
        catch { const current = loadData(), r = findProfile(current); if(r) { r.domainSync.error = 'Список сохранён, но применить его к активному подключению не удалось. Активируйте подключение повторно.'; write(current); } return { changed: true, message: 'Список сохранён. Требуется повторная активация подключения.', warning: true }; }
      }
      return { changed, message: profile.domainSync.message };
    } catch (e) {
      const data = loadData(), profile = findProfile(data);
      if(profile) { profile.domainSync = { ...profile.domainSync, enabled: true, lastCheckedAt: new Date(now()).toISOString(), lastResult: 'error', error: e.message }; write(data); }
      throw e;
    }
  }
  function refresh() { if (!pending) pending = run().finally(() => { pending = null; }); return pending; }
  async function tick() {
    const profile = findProfile(loadData()); if (!profile || profile.domainSync?.enabled !== true) return;
    const last = Date.parse(profile.domainSync.lastCheckedAt || '') || 0;
    const delay = profile.domainSync.lastResult === 'error' ? 6*3600000 : WEEK;
    if(now()-last >= delay) await refresh();
  }
  return { refresh, tick, start() { timer = setInterval(() => tick().catch(() => {}), 3600000); timer.unref(); tick().catch(() => {}); }, stop() { clearInterval(timer); } };
}
module.exports = { SOURCES, v2flyLists, parseList, fetchSources, createRoutingSync };
