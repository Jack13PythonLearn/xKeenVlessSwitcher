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
vm.runInContext(subscriptionSource.slice(0, subscriptionSource.indexOf('function openSubscriptionModal(')), scope);

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
