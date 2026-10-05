
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xkeen-subscriptions-test-'));
process.env.XKEEN_DATA_DIR = dir;
const { parseVlessUrl, extractOutboundMetadata, loadData, saveData, server } = require('../server');
const { parseSubscription, connectionKey, connectionIdentity, createSubscriptionManager, reconcile, downloadSubscription, isPublicAddress, subscriptionUrl } = require('../lib/subscriptions');
const { mergeChanges } = require('../lib/data-merge');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const vless = (host = 'vpn.example.com', name = 'Сервер') => `vless://12345678-1234-4234-8234-123456789abc@${host}:443?security=reality&pbk=test-public-key&sni=example.com&fp=chrome&type=tcp#${encodeURIComponent(name)}`;
const hy = 'hy2://test%3Apassword@hy.example.com:8443?sni=example.com#HY';
const parse = text => parseSubscription(text, parseVlessUrl);
function data() { return { settings: {}, subscriptions: [{ id: 's', name: 'Example', url: 'https://example.com/private-token', intervalHours: 24, routingId: 'custom', excluded: [] }], connections: [], routings: [{ id: 'custom', name: 'Custom', content: '{}' }, { id: 'routing_all_vpn', content: '{}' }] }; }
function harness(fetchText) {
  let state = data();
  const manager = createSubscriptionManager({ loadData: () => structuredClone(state), saveData: next => { state = structuredClone(next); return true; }, parseVlessUrl, fetchText });
  return { manager, get: () => state, set: next => { state = next; } };
}

test('plain text, Base64 and URL-safe Base64 yield the same nodes and deduplicate renamed links', () => {
  const text = '\uFEFF' + vless() + '\r\n' + hy + '\n' + vless('vpn.example.com', 'Другое имя');
  const parsed = parse(text);
  assert.equal(parsed.nodes.length, 2);
  assert.equal(parsed.duplicates, 1);
  assert.deepEqual(parse(Buffer.from(text).toString('base64')), parsed);
  assert.deepEqual(parse(Buffer.from(text).toString('base64url')), parsed);
  for (const node of parsed.nodes) assert.equal(JSON.parse(node.outboundContent).outbounds[0].tag, 'vless-reality');
});
test('Hysteria2 uses UDP transport, auth, TLS ALPN and metadata', () => {
  const node = parse(hy).nodes[0];
  const ob = JSON.parse(node.outboundContent).outbounds[0];
  assert.equal(ob.settings.version, 2);
  assert.equal(ob.streamSettings.hysteriaSettings.auth, 'test:password');
  assert.deepEqual(ob.streamSettings.tlsSettings.alpn, ['h3']);
  assert.equal(extractOutboundMetadata(node.outboundContent).serverPort, 8443);
  assert.equal(parse(hy.replace('hy2:', 'hysteria2:')).nodes[0].key, node.key);
});
test('VLESS supports WS, gRPC, TLS ALPN and XHTTP; rejects unknown transport', () => {
  const base = 'vless://test-id@[2001:db8::1]:443?security=tls&sni=example.com';
  const ws = JSON.parse(parse(base + '&type=ws&path=%2Fws&host=cdn.example.com&alpn=h2,http%2F1.1').nodes[0].outboundContent).outbounds[0];
  assert.equal(ws.streamSettings.wsSettings.path, '/ws');
  assert.deepEqual(ws.streamSettings.tlsSettings.alpn, ['h2', 'http/1.1']);
  const grpc = JSON.parse(parse(base + '&type=grpc&serviceName=test&mode=multi').nodes[0].outboundContent).outbounds[0];
  assert.equal(grpc.streamSettings.grpcSettings.multiMode, true);
  const xhttp = JSON.parse(parse(base + '&type=xhttp&path=%2Ftest&mode=auto').nodes[0].outboundContent).outbounds[0];
  assert.equal(xhttp.streamSettings.xhttpSettings.path, '/test');
  assert.throws(() => parse(base + '&type=unknown'));
});
test('invalid, empty, HTML, too large and unsupported-only responses fail without importing a partial set', () => {
  for (const text of ['', '<html>Login</html>', 'not base64', 'ss://opaque', vless() + '\nvless://bad', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    assert.throws(() => parse(text));
  }
  assert.throws(() => parse(hy.replace('#HY', '&obfs=salamander#HY')));
  assert.throws(() => parse(hy.replace('#HY', '&mport=443-445#HY')));
  assert.deepEqual(parse(vless() + '\nss://opaque').unsupported, ['ss']);
});
test('keys ignore labels, tags and optional VLESS defaults from previous imports', () => {
  const node = parse(vless()).nodes[0];
  const old = JSON.parse(node.outboundContent);
  old.outbounds[0].tag = 'old-tag';
  delete old.outbounds[0].settings.vnext[0].users[0].flow;
  delete old.outbounds[0].settings.vnext[0].users[0].level;
  old.outbounds[0].streamSettings.realitySettings.show = false;
  old.outbounds[0].streamSettings.realitySettings.spiderX = '';
  assert.equal(connectionKey(old), node.key);
});
test('certificate pin is preserved and URL path is decoded only once', () => {
  const node = parse('vless://test-id@vpn.example.com:443?security=tls&type=ws&pcs=test-pin&path=%2Fpath%252Fpart').nodes[0];
  const stream = JSON.parse(node.outboundContent).outbounds[0].streamSettings;
  assert.equal(stream.tlsSettings.pinnedPeerCertSha256, 'test-pin');
  assert.equal(stream.wsSettings.path, '/path%2Fpart');
});
test('refresh adopts matching existing servers, preserves routing, custom names and active ID, and is idempotent', () => {
  const state = data();
  const node = parse(vless()).nodes[0];
  state.connections.push({ ...node, id: 'old', name: 'Моё название', routingId: 'personal' });
  state.settings.activeConnectionId = 'old';
  assert.equal(reconcile(state, 's', parse(vless())).adopted, 1);
  assert.equal(reconcile(state, 's', parse(vless('vpn.example.com', 'Новое имя'))).retained, 1);
  assert.equal(state.connections.length, 1);
  assert.equal(state.connections[0].name, 'Моё название');
  assert.equal(state.connections[0].routingId, 'personal');
  assert.equal(state.settings.activeConnectionId, 'old');
});
test('new nodes inherit the chosen routing and provider renames propagate', () => {
  const state = data();
  reconcile(state, 's', parse(vless()));
  assert.equal(state.connections[0].routingId, 'custom');
  reconcile(state, 's', parse(vless('vpn.example.com', 'Новое имя')));
  assert.equal(state.connections[0].name, 'Новое имя');
});

test('legacy Default adopts provider name without duplicating or changing the active connection', () => {
  const state=data(); const node=parse(vless()).nodes[0];
  state.connections=[{...node,id:'conn_default_123',name:'Default',routingId:'custom'}];
  state.settings.activeConnectionId='conn_default_123';
  reconcile(state,'s',parse(vless('vpn.example.com','🇩🇪 Германия #2')));
  assert.equal(state.connections.length,1);
  assert.equal(state.connections[0].name,'🇩🇪 Германия #2');
  assert.equal(state.settings.activeConnectionId,'conn_default_123');
  assert.equal(state.connections[0].routingId,'custom');
});

test('legacy Default is repaired on load but custom names and manually named Default are preserved', () => {
  const {connectionName}=require('../lib/connection-name');
  const conn={id:'conn_default_123',name:'Default',subscriptionId:'s',subscriptionName:'🇩🇪 Германия #2',outboundContent:'{}'};
  assert.equal(connectionName({...conn,name:'Мой сервер'}),'Мой сервер');
  assert.equal(connectionName({...conn,id:'manual'}),'Default');
  assert.equal(connectionName({...conn,subscriptionId:null}),'Default');
  assert.equal(connectionName({...conn,subscriptionName:''}),'Default');
  const saved=loadData(); saved.connections=[conn]; saved.settings.activeConnectionId=conn.id;
  saveData(saved);
  const loaded=loadData();
  assert.equal(loaded.connections[0].name,'🇩🇪 Германия #2');
  assert.equal(loaded.connections[0].id,conn.id);
  assert.equal(loaded.settings.activeConnectionId,conn.id);
});
test('removed active, failover and manually edited nodes are retained for review', () => {
  const state = data();
  reconcile(state, 's', parse(['a', 'b', 'c', 'd'].map(x => vless(x + '.example.com')).join('\n')));
  state.settings.activeConnectionId = state.connections[0].id;
  state.settings.autoFailover = { poolConnectionIds: [state.connections[1].id] };
  state.connections[2].outboundContent = parse(vless('edited.example.com')).nodes[0].outboundContent;
  const stats = reconcile(state, 's', parse(vless('new.example.com')));
  assert.equal(stats.protected, 3);
  assert.equal(stats.removed, 1);
  assert.equal(state.connections.filter(x => x.subscriptionMissing).length, 3);
});
test('a partially unsupported response cannot prune previous servers', () => {
  const state = data();
  reconcile(state, 's', parse(vless()));
  assert.equal(reconcile(state, 's', parse(vless('new.example.com') + '\nss://opaque')).protected, 1);
});
test('deleted-node exclusions survive refresh and migration only adopts the retained selection', () => {
  const state = data();
  state.connections.push({ ...parse(vless()).nodes[0], id: 'kept', routingId: 'custom' });
  const parsed = parse(vless() + '\n' + hy);
  const stats = reconcile(state, 's', parsed, { adoptExistingOnly: true });
  assert.equal(stats.adopted, 1);
  assert.equal(stats.excluded, 1);
  assert.equal(reconcile(state, 's', parsed).excluded, 1);
  assert.equal(state.connections.length, 1);
});

test('rotating SNI updates an existing profile without changing its ID, custom name or routing', () => {
  const state = data();
  const first = parse(vless().replace('security=reality', 'security=tls'));
  reconcile(state, 's', first);
  const conn = state.connections[0];
  conn.name = 'Custom';
  conn.routingId = 'personal';
  state.settings.activeConnectionId = conn.id;
  const next = parse(vless().replace('security=reality', 'security=tls').replace('sni=example.com', 'sni=rotated.example.com'));
  const stats = reconcile(state, 's', next);
  assert.equal(stats.updated, 1);
  assert.equal(stats.added, 0);
  assert.equal(stats.removed, 0);
  assert.equal(state.connections.length, 1);
  assert.equal(state.connections[0].id, state.settings.activeConnectionId);
  assert.equal(state.connections[0].name, 'Custom');
  assert.equal(state.connections[0].routingId, 'personal');
  assert.equal(state.connections[0].sni, 'rotated.example.com');
  assert.equal(state.connections[0].subscriptionKey, next.nodes[0].key);
  assert.equal(reconcile(state, 's', next).updated, 0);
});

test('migration adopts an existing profile after SNI rotation and keeps excluded nodes excluded', () => {
  const state = data();
  state.connections.push({ ...parse(vless()).nodes[0], id: 'kept', routingId: 'custom' });
  const feed = vless() + '\n' + vless('excluded.example.com', 'Excluded');
  const migrated = reconcile(state, 's', parse(feed.replaceAll('sni=example.com', 'sni=first.example.com')), { adoptExistingOnly: true });
  assert.equal(migrated.adopted, 1);
  assert.equal(migrated.excluded, 1);
  const refreshed = reconcile(state, 's', parse(feed.replaceAll('sni=example.com', 'sni=second.example.com')));
  assert.equal(refreshed.added, 0);
  assert.equal(refreshed.excluded, 1);
  assert.equal(state.connections.length, 1);
  assert.equal(state.connections[0].id, 'kept');
});

test('simultaneous SNI variants stay distinct and ambiguous variants are not adopted heuristically', () => {
  const state = data();
  const first = vless('vpn.example.com', 'First');
  const second = vless('vpn.example.com', 'Second').replace('sni=example.com', 'sni=second.example.com');
  const parsed = parse(first + '\n' + second);
  assert.equal(connectionIdentity(parsed.nodes[0].outboundContent), connectionIdentity(parsed.nodes[1].outboundContent));
  reconcile(state, 's', parsed);
  const ids = state.connections.map(x => x.id);
  assert.equal(reconcile(state, 's', parsed).retained, 2);
  assert.deepEqual(state.connections.map(x => x.id), ids);
  const manualState = data();
  manualState.connections.push({ ...parse(first.replace('sni=example.com', 'sni=manual.example.com')).nodes[0], id: 'manual' });
  assert.equal(reconcile(manualState, 's', parsed, { adoptExistingOnly: true }).adopted, 0);
  assert.equal(manualState.connections.length, 1);
});

test('a manually edited SNI is preserved when the provider rotates it', () => {
  const state = data();
  reconcile(state, 's', parse(vless()));
  const manualContent = parse(vless().replace('sni=example.com', 'sni=manual.example.com')).nodes[0].outboundContent;
  state.connections[0].outboundContent = manualContent;
  const stats = reconcile(state, 's', parse(vless().replace('sni=example.com', 'sni=provider.example.com')));
  assert.equal(stats.protected, 1);
  assert.equal(stats.added, 0);
  assert.equal(state.connections.length, 1);
  assert.equal(state.connections[0].outboundContent, manualContent);
  assert.equal(state.connections[0].subscriptionMissing, true);
});
test('failed fetch preserves servers and source is redacted in the API list', async () => {
  const h = harness(async () => { throw new Error('Network failure'); });
  reconcile(h.get(), 's', parse(vless()));
  const before = structuredClone(h.get().connections);
  await assert.rejects(h.manager.refresh('s'));
  assert.deepEqual(h.get().connections, before);
  assert.equal(h.get().subscriptions[0].lastError, 'Network failure');
  assert.equal(h.manager.list()[0].url, undefined);
  assert.equal(h.manager.list()[0].source, 'https://example.com');
});
test('retry after a failed import loads all servers despite legacy migration options', async () => {
  let failed = true;
  const h = harness(async () => { if (failed) throw new Error('offline'); return vless() + '\n' + hy; });
  h.get().subscriptions = [];
  h.get().connections.push({ ...parse(vless()).nodes[0], id: 'kept' });
  const result = await h.manager.add({ name: 'Migrate', url: 'https://example.com/new', adoptExistingOnly: true, routingId: 'custom' });
  assert.equal(result.error, 'offline');
  failed = false;
  await h.manager.refresh(result.id);
  assert.equal(h.get().connections.length, 2);
  assert.equal(h.get().subscriptions[0].excluded.length, 0);
});

test('every refresh uses the complete provider list and removes legacy exclusions', async () => {
  let feed = vless() + '\n' + hy;
  const h = harness(async () => feed);
  h.get().subscriptions[0].excluded = [{ key: parse(hy).nodes[0].key, identity: connectionIdentity(parse(hy).nodes[0].outboundContent) }];
  h.get().subscriptions[0].adoptExistingOnly = true;
  await h.manager.refresh('s');
  assert.equal(h.get().connections.length, 2);
  assert.equal(h.get().subscriptions[0].excluded.length, 0);
  assert.equal(h.manager.list()[0].excluded, undefined);
  h.get().connections.pop();
  assert.equal((await h.manager.refresh('s')).added, 1);
  assert.equal(h.get().connections.length, 2);
  feed = hy;
  assert.equal((await h.manager.refresh('s')).removed, 1);
  assert.equal(h.get().connections.length, 1);
  assert.equal(h.manager.list()[0].count, 1);
});
test('concurrent refresh, edit and delete cannot resurrect a removed source or apply an old URL', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  const pending = h.manager.refresh('s');
  await assert.rejects(h.manager.refresh('s'), /уже обновляется/);
  h.manager.edit('s', { url: 'https://example.com/replacement' });
  release(vless());
  await assert.rejects(pending, /Настройки изменились/);
  assert.equal(h.get().connections.length, 0);
  const deleted = h.manager.refresh('s');
  h.manager.remove('s');
  release(vless());
  await assert.rejects(deleted, /не найдена/);
  assert.equal(h.get().subscriptions.length, 0);
});
test('schedule obeys manual mode and interval; removing a subscription keeps its servers', async () => {
  let requests = 0;
  const h = harness(async () => { requests++; return vless(); });
  h.get().subscriptions[0].intervalHours = 0;
  await h.manager.tick();
  assert.equal(requests, 0);
  h.get().subscriptions[0].intervalHours = 1;
  await h.manager.tick();
  await h.manager.tick();
  assert.equal(requests, 1);
  h.manager.remove('s');
  assert.equal(h.get().connections.length, 1);
  assert.equal(h.get().connections[0].subscriptionId, undefined);
});
test('public URLs only, with IPv4-mapped IPv6 checked too', async () => {
  for (const ip of ['127.0.0.1', '192.168.1.1', '10.0.0.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:192.168.1.1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  for (const url of ['file:///etc/passwd', 'https://user:secret@example.com', 'https://example.com/#fragment']) assert.throws(() => subscriptionUrl(url));
  await assert.rejects(downloadSubscription('http://127.0.0.1:80/private-token'), /публичном/);
});
test('bounded downloader handles redirects, gzip, HTTP errors and deadlines without leaking tokens', async () => {
  const fixture = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/gzip' }); res.end(); }
    else if (req.url === '/gzip') { res.writeHead(200, { 'Content-Encoding': 'gzip' }); res.end(zlib.gzipSync(vless())); }
    else if (req.url === '/slow') { /* exercise deadline */ }
    else if (req.url === '/bomb') { res.writeHead(200, { 'Content-Encoding': 'gzip' }); res.end(zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1))); }
    else { res.writeHead(403); res.end('private-token'); }
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + fixture.address().port;
  try {
    assert.equal(await downloadSubscription(base + '/redirect', { allowPrivate: true }), vless());
    await assert.rejects(downloadSubscription(base + '/private-token', { allowPrivate: true }), { message: 'Сервер подписки вернул HTTP 403.' });
    await assert.rejects(downloadSubscription(base + '/bomb', { allowPrivate: true }), /8 МБ/);
    await assert.rejects(downloadSubscription(base + '/slow', { allowPrivate: true, timeout: 40 }), /вовремя/);
  } finally { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
});
test('three-way save preserves concurrent subscription additions, settings and deletions during stale pings', () => {
  const original = data();
  original.connections = [{ id: 'a', lastPing: null }, { id: 'b', lastPing: null }];
  const slow = structuredClone(original);
  slow.connections[0].lastPing = 21;
  slow.connections[1].lastPing = 22;
  const fresh = structuredClone(original);
  fresh.connections = [fresh.connections[0], { id: 'new' }];
  fresh.settings.activeConnectionId = 'new';
  const merged = mergeChanges(original, slow, fresh);
  assert.deepEqual(merged.connections, [{ id: 'a', lastPing: 21 }, { id: 'new' }]);
  assert.equal(merged.settings.activeConnectionId, 'new');
  saveData(original);
  const pending = loadData();
  const concurrent = loadData();
  concurrent.connections.push({ id: 'imported', name: 'New', outboundContent: parse(vless()).nodes[0].outboundContent });
  saveData(concurrent);
  pending.connections[0].lastPing = 42;
  saveData(pending);
  assert.equal(loadData().connections.find(x => x.id === 'a').lastPing, 42);
  assert.ok(loadData().connections.some(x => x.id === 'imported'));
});
test('HTTP API redacts URL, deletion does not exclude servers, and backup restore retains subscription ownership', async () => {
  const state = data();
  reconcile(state, 's', parse(vless() + '\n' + hy));
  for (const key of ['outboundPath', 'routingPath']) {
    state.settings[key] = path.join(dir, key + '.json');
    fs.writeFileSync(state.settings[key], '{}');
  }
  state.settings.restartCommand = '';
  saveData(state);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const visible = await (await fetch(base + '/api/data')).json();
    assert.equal(visible.subscriptions[0].url, undefined);
    const editResponse = await fetch(base + '/api/subscriptions/s');
    assert.equal(editResponse.headers.get('cache-control'), 'no-store');
    assert.equal((await editResponse.json()).url, 'https://example.com/private-token');
    assert.equal((await fetch(base + '/api/subscriptions/missing')).status, 404);
    const unchanged = await fetch(base + '/api/subscriptions/s', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({url:'https://example.com/private-token'}) });
    assert.equal(unchanged.status, 200);
    assert.equal(loadData().subscriptions[0].url, 'https://example.com/private-token');
    assert.equal(visible.connections[0].subscriptionId, 's');
    const remove = await fetch(base + '/api/connections/' + state.connections[0].id, { method: 'DELETE' });
    assert.equal(remove.status, 200);
    assert.equal(loadData().subscriptions[0].excluded.length, 0);
    const backup = await (await fetch(base + '/api/backup/export')).arrayBuffer();
    const restored = await fetch(base + '/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zipBase64: Buffer.from(backup).toString('base64') }) });
    assert.equal(restored.status, 200, await restored.text());
    assert.equal(loadData().connections[0].subscriptionId, 's');
    assert.ok(loadData().connections[0].subscriptionIdentity);
    assert.equal(loadData().subscriptions[0].url, 'https://example.com/private-token');
    assert.equal(loadData().subscriptions[0].excluded.length, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('provider metadata decodes UTF-8 and validates usage without exposing account URLs', () => {
  const { subscriptionInfo } = require('../lib/subscriptions');
  const info = subscriptionInfo({ 'profile-title': 'base64:' + Buffer.from('Тестовая подписка').toString('base64'), announce: 'base64:' + Buffer.from('Описание\nВторая строка').toString('base64'), 'subscription-userinfo': 'upload=10; download=20; total=0; expire=1790951622', 'profile-web-page-url': 'https://example.com/secret' });
  assert.deepEqual(info, { title: 'Тестовая подписка', description: 'Описание\nВторая строка', upload: 10, download: 20, total: 0, expire: 1790951622 });
  assert.deepEqual(subscriptionInfo({ 'subscription-userinfo': 'upload=-1; download=NaN; total=9999999999999999999; expire=999999999999', announce: 'base64:!!!' }), {});
});
test('refresh replaces metadata, preserves it on failure, and clears it on URL change', async () => {
  let response = { text: vless(), info: { total: 100, download: 10, upload: 0 } };
  const h = harness(async () => { if (response instanceof Error) throw response; return response; });
  await h.manager.refresh('s');
  assert.equal(h.get().subscriptions[0].info.total, 100);
  response = new Error('Network error');
  await assert.rejects(h.manager.refresh('s'));
  assert.equal(h.get().subscriptions[0].info.total, 100);
  response = { text: vless(), info: {} };
  await h.manager.refresh('s');
  assert.deepEqual(h.get().subscriptions[0].info, {});
  h.manager.edit('s', { url: 'https://example.com/new' });
  assert.equal(h.get().subscriptions[0].info, undefined);
});
test('download returns only final response metadata and keeps the string API compatible', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/feed', 'profile-title': 'Wrong' }); res.end(); }
    else { res.writeHead(200, { 'profile-title': 'Demo', 'subscription-userinfo': 'upload=0; download=20; total=100; expire=0' }); res.end(vless()); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/redirect';
    const result = await downloadSubscription(url, { allowPrivate: true, includeMetadata: true });
    assert.equal(result.text, vless()); assert.equal(result.info.title, 'Demo'); assert.equal(result.info.download, 20);
    assert.equal(await downloadSubscription(url, { allowPrivate: true }), vless());
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('merged routing replaces only the explicit built-in preset and remaps connections and subscriptions', () => {
 const {applyRoutingReplacements}=require('../lib/routing-replacements');
 const state={routings:[{id:'routing_all_vpn',isSystem:true},{id:'routing_except_ru',isSystem:true},{id:'merged',isSystem:false,replacesSystemRouting:'routing_except_ru'}],connections:[{routingId:'routing_except_ru'},{routingId:'routing_all_vpn'}],subscriptions:[{routingId:'routing_except_ru'}]};
 applyRoutingReplacements(state);assert.equal(state.routings.length,2);assert.equal(state.connections[0].routingId,'merged');assert.equal(state.connections[1].routingId,'routing_all_vpn');assert.equal(state.subscriptions[0].routingId,'merged');
 const unchanged={routings:[{id:'routing_except_ru',isSystem:true},{id:'custom',isSystem:false}],connections:[]};applyRoutingReplacements(unchanged);assert.equal(unchanged.routings.length,2);
});
