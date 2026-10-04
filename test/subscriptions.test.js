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
const { parseSubscription, connectionKey, createSubscriptionManager, reconcile, downloadSubscription, isPublicAddress, subscriptionUrl } = require('../lib/subscriptions');
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
test('migration choice survives an initial fetch failure and retry', async () => {
  let failed = true;
  const h = harness(async () => { if (failed) throw new Error('offline'); return vless() + '\n' + hy; });
  h.get().subscriptions = [];
  h.get().connections.push({ ...parse(vless()).nodes[0], id: 'kept' });
  const result = await h.manager.add({ name: 'Migrate', url: 'https://example.com/new', adoptExistingOnly: true, routingId: 'custom' });
  assert.equal(result.error, 'offline');
  failed = false;
  await h.manager.refresh(result.id);
  assert.equal(h.get().connections.length, 1);
  assert.equal(h.get().subscriptions[0].excluded.length, 1);
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
test('HTTP API redacts URL, persists exclusions, and backup restore retains subscription ownership', async () => {
  const state = data();
  reconcile(state, 's', parse(vless() + '\n' + hy));
  state.settings.restartCommand = '';
  saveData(state);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const visible = await (await fetch(base + '/api/data')).json();
    assert.equal(visible.subscriptions[0].url, undefined);
    assert.equal(visible.connections[0].subscriptionId, 's');
    const remove = await fetch(base + '/api/connections/' + state.connections[0].id, { method: 'DELETE' });
    assert.equal(remove.status, 200);
    assert.equal(loadData().subscriptions[0].excluded.length, 1);
    const backup = await (await fetch(base + '/api/backup/export')).arrayBuffer();
    const restored = await fetch(base + '/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zipBase64: Buffer.from(backup).toString('base64') }) });
    assert.equal(restored.status, 200, await restored.text());
    assert.equal(loadData().connections[0].subscriptionId, 's');
    assert.equal(loadData().subscriptions[0].url, 'https://example.com/private-token');
    assert.equal(loadData().subscriptions[0].excluded.length, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
