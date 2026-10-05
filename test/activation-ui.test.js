const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('node:fs').readFileSync(require.resolve('../public/app.js'),'utf8');
const deferred = () => {let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve};};
const response = body => ({ok:true,json:async()=>body});
function harness() {
  const activation=deferred(), ping=deferred(), calls=[], patched=[], messages=[];
  const ctx={activatingConnectionId:null, dataLoadSequence:0, isPingingAll:false, pingingConnectionIds:new Set(),
    appData:{settings:{activeConnectionId:'a'},connections:[{id:'a',outboundContent:'a'},{id:'b',outboundContent:'b',requiresActivation:true}]},
    fetch(url){calls.push(url); return url.endsWith('/activate')?activation.promise:ping.promise;},
    updateConnectionRow(id){patched.push(id);}, updateActivationButtons(){}, reorderConnectionRows(){}, renderRoutings(){}, updateServiceStatusUI(){},
    showToast(message,type){messages.push({message,type});}, async loadData(){ctx.reloads++;}, reloads:0};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('async function activateConnection('),source.indexOf('// Delete Connection')),ctx);
  vm.runInContext(source.slice(source.indexOf('async function checkConnectionPing('),source.indexOf('// Check all connections ping')),ctx);
  return {ctx,activation,ping,calls,patched,messages};
}
const success = () => response({activeConnectionId:'b', serviceStatus:{status:'running'},timings:{totalMs:250}});
test('activation shows success before background ping finishes, without fetching the full list; repeated clicks are ignored', async () => {
  const h=harness(); const pending=h.ctx.activateConnection('b');
  await h.ctx.activateConnection('a'); assert.equal(h.calls.length,1);
  assert.equal(h.ctx.appData.settings.activeConnectionId,'a');
  h.activation.resolve(success()); await pending;
  assert.equal(h.ctx.appData.settings.activeConnectionId,'b');
  assert.equal(h.ctx.appData.connections[1].requiresActivation,undefined);
  assert.equal(h.ctx.reloads,0);
  assert.equal(h.ctx.activatingConnectionId,null);
  assert.deepEqual(h.calls,['/api/connections/b/activate','/api/connections/b/ping']);
  assert.equal(h.ctx.pingingConnectionIds.has('b'),true);
  assert.ok(h.patched.includes('a') && h.patched.includes('b'));
  assert.ok(h.messages.some(m=>m.type==='success'));
  h.ping.resolve(response({ping:72,status:'ok'})); await new Promise(r=>setImmediate(r));
  assert.equal(h.ctx.appData.connections[1].lastPing,72);
  assert.equal(h.ctx.pingingConnectionIds.size,0);
});
test('activation failure unlocks controls, reloads authoritative state and never starts a ping', async () => {
  const h=harness(); const pending=h.ctx.activateConnection('b');
  h.activation.resolve({ok:false,json:async()=>({error:'Rejected'})}); await pending;
  assert.equal(h.ctx.appData.settings.activeConnectionId,'a');
  assert.equal(h.ctx.activatingConnectionId,null); assert.equal(h.ctx.reloads,1);
  assert.equal(h.calls.length,1); assert.equal(h.messages.at(-1).type,'error');
});
test('late ping after another activation cannot change the active connection', async () => {
  const h=harness(); const pending=h.ctx.activateConnection('b'); h.activation.resolve(success()); await pending;
  h.ctx.appData.settings.activeConnectionId='a';
  h.ping.resolve(response({ping:null,status:'unreachable'})); await new Promise(r=>setImmediate(r));
  assert.equal(h.ctx.appData.settings.activeConnectionId,'a');
  assert.equal(h.ctx.appData.connections[1].lastPingStatus,'unreachable');
  assert.equal(h.messages.filter(m=>m.type==='error').length,0);
});
test('ping result for an edited outbound is discarded and duplicate health requests are suppressed', async () => {
  const h=harness(); const pending=h.ctx.checkConnectionPing('b',{quiet:true});
  await h.ctx.checkConnectionPing('b',{quiet:true}); assert.equal(h.calls.length,1);
  h.ctx.appData.connections[1].outboundContent='edited';
  h.ping.resolve(response({ping:1,status:'ok'})); await pending;
  assert.equal(h.ctx.appData.connections[1].lastPing,undefined);
  assert.equal(h.ctx.pingingConnectionIds.size,0);
});
