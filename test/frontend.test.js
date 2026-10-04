const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
const scope = { URLSearchParams, stripComments: x => x, console };
vm.createContext(scope);
vm.runInContext(source.slice(source.indexOf('function getConnectionVlessUrl('), source.indexOf('// Open QR Code Modal')), scope);
vm.runInContext(source.slice(source.indexOf('function escapeHtml('), source.indexOf('function formatTime(')), scope);
vm.runInContext(source.slice(source.indexOf('function getFlagEmoji('), source.indexOf('// GITHUB UPDATE CHECK')), scope);
const subscriptionSource = fs.readFileSync(require.resolve('../public/subscriptions.js'), 'utf8');
vm.runInContext(subscriptionSource.slice(0, subscriptionSource.indexOf('let subscriptionEditRequest')), scope);

test('server counts use Russian singular, paucal and plural forms including teens', () => {
  for (const [count, noun] of [[0, 'серверов'], [1, 'сервер'], [2, 'сервера'], [4, 'сервера'], [5, 'серверов'],
    [11, 'серверов'], [12, 'серверов'], [14, 'серверов'], [21, 'сервер'], [22, 'сервера'], [101, 'сервер'], [112, 'серверов'], [199, 'серверов']]) {
    assert.equal(scope.serverNoun(count), noun);
  }
});

test('subscription status shows the update date and time and hides legacy exclusion controls', () => {
  const elements = new Map();
  scope.document = { getElementById: id => {
    if (!elements.has(id)) elements.set(id, { classList: { toggle() {} } });
    return elements.get(id);
  } };
  scope.appData = { subscriptions: [{ id: 's', name: 'Demo', source: 'https://example.com', count: 2, intervalHours: 24,
    excluded: [{ key: 'legacy' }], lastUpdatedAt: '2026-10-04T17:00:00Z' }] };
  scope.renderSubscriptions();
  const html = elements.get('subscriptions-list').innerHTML;
  assert.match(html, /Обновлено · 04\.10\.2026, \d{2}:\d{2}:\d{2}/);
  assert.match(html, /<strong>2<\/strong> сервера/);
  assert.match(html, /Редактировать/);
  assert.match(html, /Обновление подписки: раз в сутки/);
  assert.ok(!html.includes('Исключено'));
  assert.ok(!html.includes('Вернуть исключённые'));
  assert.equal(scope.subscriptionUpdatedLabel('invalid'), '');
});

test('provider flags take precedence over GeoIP and render once in the connection label', () => {
  const display = scope.getConnectionDisplay({ name: '🇫🇮 Finland', countryCode: 'DE', countryName: 'Germany', subscriptionId: 's' });
  assert.equal(display.flag, '🇫🇮');
  assert.equal(display.name, 'Finland');
  assert.match(display.countryTitle, /FI/);
  assert.equal(scope.getConnectionDisplay({ name: 'Manual', countryCode: 'DE' }).flag, '🇩🇪');
  assert.equal(scope.getFlagEmoji('12'), '');
});

test('untrusted subscription labels remain literal in inline delete actions', () => {
  for (const name of ['Normal name', '" onmouseover="alert(1)', "\\'); throw new Error('injected'); //", '<img src=x onerror=alert(1)>', 'Line\nbreak']) {
    const escaped = scope.escapeJs(name);
    assert.ok(!/["<>\n]/.test(escaped));
    const decoded = escaped.replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const result = Function(`return '${decoded}';`)();
    assert.equal(result, name);
  }
});
test('QR export retains Hysteria2 auth and VLESS TLS certificate pin, XHTTP settings and IPv6', () => {
  const hy = scope.getConnectionVlessUrl({ name: 'Demo', outboundContent: JSON.stringify({ outbounds: [{ protocol: 'hysteria', settings: { address: '2001:db8::1', port: 8443 }, streamSettings: { tlsSettings: { serverName: 'example.com', alpn: ['h3'] }, hysteriaSettings: { auth: 'user:password' } } }] }) });
  const url = new URL(hy);
  assert.equal(decodeURIComponent(url.username), 'user:password');
  assert.equal(url.hostname, '[2001:db8::1]');
  assert.equal(url.searchParams.get('alpn'), 'h3');
  const vless = scope.getConnectionVlessUrl({ name: 'Demo', outboundContent: JSON.stringify({ outbounds: [{ protocol: 'vless', settings: { vnext: [{ address: '2001:db8::1', port: 443, users: [{ id: 'test' }] }] }, streamSettings: { network: 'xhttp', security: 'tls', tlsSettings: { pinnedPeerCertSha256: 'test-pin' }, xhttpSettings: { path: '/test', mode: 'auto', host: 'example.com' } } }] }) });
  const v = new URL(vless);
  assert.equal(v.searchParams.get('pcs'), 'test-pin');
  assert.equal(v.searchParams.get('path'), '/test');
  assert.equal(v.hostname, '[2001:db8::1]');
});

test('subscription info handles unknown and unlimited traffic, expiry, clamps progress and escapes announcements', () => {
  assert.equal(scope.subscriptionBytes(60.9 * 1024 ** 3), '60,9 ГБ');
  assert.equal(scope.subscriptionBytes(0), '0 Б');
  assert.equal(scope.subscriptionInfoHtml({}), '');
  const html = scope.subscriptionInfoHtml({ upload: 0, download: 200, total: 100, expire: 1, title: '<img src=x>', description: '<script>alert(1)</script>' });
  assert.match(html, /aria-valuenow="100"/); assert.match(html, /Истекла/);
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img'));
  assert.match(scope.subscriptionInfoHtml({ total: 0, expire: 0 }), /Безлимит/);
  assert.match(scope.subscriptionInfoHtml({ total: 0 }), /Расход не указан/);
  assert.match(scope.subscriptionInfoHtml({ upload: 0, download: 0 }), /Лимит не указан/);
});

test('compact list filters LTE by explicit names, groups LTE first and preserves details', () => {
 const grid = { innerHTML: '' }; const elements = { 'connections-type-select': {}, 'connections-sort-select': {} };
 const ctx = { console, connectionsGrid: grid, connectionsCount: {}, connectionsBadge: {}, emptyConnectionsState: {classList:{toggle(){}}}, document:{getElementById:id=>elements[id]}, currentSort:'default', pingingConnectionIds:new Set(), getSortedConnections:list=>[...list], escapeHtml:scope.escapeHtml, escapeJs:scope.escapeJs, getConnectionDisplay:scope.getConnectionDisplay, formatNetworkName:()=> 'TCP', stripComments:x=>x, formatTime:x=>x, appData:{settings:{activeConnectionId:'normal'},routings:[],subscriptions:[],connections:[{id:'normal',name:'⚡ Германия',countryCode:'DE'},{id:'lte',name:'🇫🇮 🎮 LTE #1'},{id:'word',name:'Alternative'},{id:'renamed',name:'My server',subscriptionName:'LTE - Mobile'}]} };
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('let connectionTypeFilter'),source.indexOf('// Render Routings Grid')),ctx);
 assert.equal(ctx.isLteConnection({name:'Alternative'}),false);
 assert.equal(ctx.isLteConnection({name:'⚡ ⭐ Germany'}),false);
 assert.equal(ctx.isLteConnection({name:'LTE1'}),true);
 ctx.renderConnections();assert.ok(grid.innerHTML.indexOf('card-conn-lte')<grid.innerHTML.indexOf('card-conn-normal'));
 assert.match(grid.innerHTML,/country-flag-fi/);assert.match(grid.innerHTML,/Активировать/);assert.match(grid.innerHTML,/conn-details[^>]+hidden/);
 ctx.onConnectionTypeChange('lte');assert.ok(grid.innerHTML.includes('card-conn-renamed'));assert.ok(!grid.innerHTML.includes('card-conn-normal'));
 ctx.onConnectionTypeChange('regular');assert.ok(grid.innerHTML.includes('card-conn-normal'));assert.ok(!grid.innerHTML.includes('card-conn-lte'));
 ctx.onConnectionTypeChange('all');assert.ok(grid.innerHTML.includes('card-conn-lte'));
});

test('routing list preserves rule order, escapes values and protects merged profile',()=>{
 const grid={innerHTML:''};const ctx={console,escapeHtml:scope.escapeHtml,escapeJs:scope.escapeJs,stripComments:x=>x,routingsGrid:grid,routingsCount:{},routingsBadge:{},appData:{settings:{activeConnectionId:'c'},connections:[{id:'c',routingId:'merged'}],routings:[{id:'merged',name:'Всё через VPN кроме РФ',replacesSystemRouting:'routing_except_ru',content:JSON.stringify({routing:{rules:[{outboundTag:'block',domain:['<script>']},{outboundTag:'direct',ip:['geoip:private']}]}})}]}};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('const expandedRoutings'),source.indexOf('// Populate routing select')),ctx);ctx.renderRoutings();assert.ok(!grid.innerHTML.includes('deleteRouting('));assert.ok(grid.innerHTML.includes('Редактировать профиль'));assert.ok(grid.innerHTML.includes('Используется сейчас'));assert.ok(grid.innerHTML.includes('&lt;script&gt;'));assert.ok(grid.innerHTML.indexOf('Блокировать')<grid.innerHTML.indexOf('Напрямую'));assert.equal(ctx.routingAssignmentsLabel(334),'334 подключения');
});

test('empty saved failover pool stays empty instead of selecting every server',()=>{
 const part=source.slice(source.indexOf('    const savedPool ='),source.indexOf('    poolContainer.innerHTML ='));
 for(const pool of [[],['one']]){const ctx={af:{poolConnectionIds:pool},conns:[{id:'one'},{id:'two'}]};vm.createContext(ctx);assert.deepEqual(Array.from(vm.runInContext(part+'\nsavedPool',ctx)),pool);}
});


test('subscription editor loads the saved URL and ignores stale requests', async () => {
  const elements = new Map();
  const context = {appData:{subscriptions:[{id:'s',name:'Demo'}],routings:[],connections:[],settings:{}}, escapeHtml:x=>x,openModal(){},document:{getElementById(id){
    if(!elements.has(id)) elements.set(id,{value:'',reset(){},focus(){},classList:{contains(){return false;}}});
    return elements.get(id);
  }}};
  vm.createContext(context);
  vm.runInContext(subscriptionSource.slice(subscriptionSource.indexOf('let subscriptionEditRequest'), subscriptionSource.indexOf('async function subscriptionRequest')), context);
  let resolve;
  context.subscriptionRequest = () => new Promise(r => {resolve=r;});
  const pending = context.openSubscriptionModal('s');
  assert.equal(elements.get('subscription-save').disabled,true);
  resolve({url:'https://example.com/demo'});await pending;
  assert.equal(elements.get('subscription-url').value,'https://example.com/demo');
  assert.equal(elements.get('subscription-save').disabled,false);
  const stale=context.openSubscriptionModal('s');
  await context.openSubscriptionModal();resolve({url:'https://example.com/old'});await stale;
  assert.equal(elements.get('subscription-url').value,'');
  context.subscriptionRequest=async()=>{throw Error('offline');};
  await context.openSubscriptionModal('s');
  assert.equal(elements.get('subscription-save').disabled,true);
  assert.match(elements.get('subscription-form-error').textContent,/Не удалось загрузить/);
});
