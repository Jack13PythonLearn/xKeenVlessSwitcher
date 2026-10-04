const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
const scope = { URLSearchParams, stripComments: x => x, console };
vm.createContext(scope);
vm.runInContext(source.slice(source.indexOf('function getConnectionVlessUrl('), source.indexOf('// Open QR Code Modal')), scope);
vm.runInContext(source.slice(source.indexOf('function escapeHtml('), source.indexOf('function formatTime(')), scope);

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
