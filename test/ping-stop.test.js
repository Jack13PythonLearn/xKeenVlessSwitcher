const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

function harness(fetch) {
  const elements = new Map();
  const messages = [];
  const context = {
    isPingingAll: false, stopPingRequested: false, pingingConnectionIds: new Set(),
    appData: { connections: [{id:'a'}, {id:'b'}, {id:'c'}] }, fetch,
    document: {getElementById(id) {if (!elements.has(id)) elements.set(id, {}); return elements.get(id);}},
    renderConnections() {}, updateConnectionRow(){}, reorderConnectionRows(){}, showToast(message, type) {messages.push({message, type});}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function stopAllPing()'), source.indexOf('// ==============================================================================\n// ROUTING', source.indexOf('function stopAllPing()'))), context);
  return {context, elements, messages};
}
const ok = () => ({ok:true, json:async()=>({ping:42, status:'ok'})});

test('stop finishes the in-flight ping, preserves its result and never starts the remaining queue; restart works', async () => {
  let finish;
  const calls = [];
  const h = harness(url => {calls.push(url);return new Promise(resolve => {finish=resolve;});});
  const running = h.context.checkAllPing();
  assert.equal(h.elements.get('btn-ping-stop').hidden, false);
  h.context.stopAllPing();
  h.context.stopAllPing();
  await h.context.checkAllPing();
  assert.equal(calls.length, 1);
  assert.equal(h.elements.get('btn-ping-stop').disabled, true);
  finish(ok()); await running;
  assert.equal(calls.length, 1);
  assert.equal(h.context.appData.connections[0].lastPing, 42);
  assert.equal(h.context.appData.connections[1].lastPingStatus, undefined);
  assert.equal(h.context.isPingingAll, false);
  assert.equal(h.context.pingingConnectionIds.size, 0);
  assert.equal(h.elements.get('btn-ping-stop').hidden, true);
  assert.match(h.messages.at(-1).message, /остановлена.*1 из 3/);
  assert.ok(!h.messages.some(x=>x.type==='success'));
  h.context.fetch = async url => {calls.push(url);return ok();};
  await h.context.checkAllPing();
  assert.equal(calls.length, 4);
  assert.equal(h.messages.at(-1).type, 'success');
});

test('stop handles a failed in-flight request and returns controls to idle', async () => {
  let fail;
  const h = harness(() => new Promise((resolve,reject)=>{fail=reject;}));
  const running=h.context.checkAllPing();
  h.context.stopAllPing(); fail(new Error('Network error')); await running;
  assert.equal(h.context.appData.connections[0].lastPingStatus, 'unreachable');
  assert.equal(h.context.appData.connections[1].lastPingStatus, undefined);
  assert.equal(h.elements.get('btn-ping-all').disabled, false);
  assert.equal(h.context.isPingingAll, false);
  assert.match(h.messages.at(-1).message, /остановлена/);
});

test('empty list and a running individual check cannot create a bulk check', async () => {
  const h=harness(()=>{throw Error('Must not fetch');});
  h.context.pingingConnectionIds.add('a'); await h.context.checkAllPing();
  assert.equal(h.context.isPingingAll,false);
  h.context.pingingConnectionIds.clear();h.context.appData.connections=[];
  await h.context.checkAllPing(); assert.match(h.messages.at(-1).message,/Нет подключений/);
});
