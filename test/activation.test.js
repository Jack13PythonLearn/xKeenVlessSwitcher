const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xkeen-activation-'));
process.env.XKEEN_DATA_DIR = temp;
process.env.XKEEN_DISABLE_BACKGROUND = '1';
const app = require('../server');
let base;
before(async () => {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + app.server.address().port;
});
after(async () => {
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
  fs.rmSync(temp, {recursive:true, force:true});
});
function fixture() {
  const data = app.loadData();
  Object.assign(data.settings, {activeConnectionId:'old', outboundPath:path.join(temp,'out.json'), routingPath:path.join(temp,'route.json'), restartCommand:'echo restarted', statusCommand:'echo Xray is running'});
  Object.assign(data.settings.autoFailover, {enabled:true, primaryMode:'manual_active', preferredPrimaryId:'old'});
  data.connections = [
    {id:'old', name:'Old', outboundContent:'{"outbounds":[]}', routingId:'routing_all_vpn'},
    {id:'new', name:'New', outboundContent:'{"outbounds":[{"protocol":"freedom","tag":"direct"}]}', routingId:'routing_all_vpn', requiresActivation:true, lastPing:42, lastPingStatus:'ok'}
  ];
  fs.writeFileSync(data.settings.outboundPath, 'old-outbound');
  fs.writeFileSync(data.settings.routingPath, 'old-routing');
  app.saveData(data);
  return data;
}
async function activate() {
  const response = await fetch(base+'/api/connections/new/activate', {method:'POST'});
  return {status:response.status, body:await response.json()};
}
test('activation returns confirmed state and timings without waiting for a new ping; manual primary is saved', async () => {
  const original = fixture();
  const {status, body} = await activate();
  assert.equal(status,200);
  assert.equal(body.activeConnectionId,'new');
  assert.equal(body.serviceStatus.status,'running');
  assert.equal(body.pingResult,undefined);
  for(const key of ['queueMs','validationMs','writeMs','restartMs','restartCommandMs','statusMs','persistMs','totalMs']) assert.ok(Number.isFinite(body.timings[key]) && body.timings[key]>=0, key);
  const saved = app.loadData();
  assert.equal(saved.settings.activeConnectionId,'new');
  assert.equal(saved.settings.autoFailover.preferredPrimaryId,'new');
  assert.equal(saved.connections[1].requiresActivation,undefined);
  assert.equal(saved.connections[1].lastPing,42);
  assert.equal(fs.readFileSync(original.settings.outboundPath,'utf8'),original.connections[1].outboundContent);
});
test('invalid configuration cannot change active files or active state', async () => {
  const data = fixture(); data.connections[1].outboundContent = '{broken'; app.saveData(data);
  assert.equal((await activate()).status,400);
  assert.equal(app.loadData().settings.activeConnectionId,'old');
  assert.equal(fs.readFileSync(data.settings.outboundPath,'utf8'),'old-outbound');
});
test('failed restart rolls back files and does not report activation success', async () => {
  const data = fixture(); data.settings.restartCommand='exit 1'; app.saveData(data);
  assert.equal((await activate()).status,400);
  assert.equal(app.loadData().settings.activeConnectionId,'old');
  assert.equal(fs.readFileSync(data.settings.outboundPath,'utf8'),'old-outbound');
  assert.equal(fs.readFileSync(data.settings.routingPath,'utf8'),'old-routing');
});
test('stopped status after restart is still a failure and preserves the previous primary', async () => {
  const data = fixture(); data.settings.statusCommand='echo Xray is not running'; app.saveData(data);
  assert.equal((await activate()).status,400);
  assert.equal(app.loadData().settings.autoFailover.preferredPrimaryId,'old');
  assert.equal(fs.readFileSync(data.settings.outboundPath,'utf8'),'old-outbound');
});
test('compact API omits outbound for 1000 servers; details and full backup API remain complete',async()=>{
  const data=fixture();data.connections=Array.from({length:1000},(_,i)=>({...data.connections[1],id:'test_'+i,outboundContent:JSON.stringify({outbounds:[],description:'x'.repeat(1500)})}));app.saveData(data);
  const full=await (await fetch(base+'/api/data')).text();const compact=await(await fetch(base+'/api/data?compact=1')).text();
  assert.ok(compact.length<full.length/2);const list=JSON.parse(compact).connections;assert.equal(list.length,1000);assert.equal(list[0].outboundContent,undefined);assert.equal(list[0].outboundRevision.length,64);
  const detail=await(await fetch(base+'/api/connections/test_0')).json();assert.equal(detail.outboundContent,data.connections[0].outboundContent);
});
test('single ping updates health without rewriting profiles or last-good backup',async()=>{
  fixture();const file=path.join(temp,'profiles.json'),before=fs.readFileSync(file),last=fs.readFileSync(file+'.last-good');
  const res=await fetch(base+'/api/connections/new/ping',{method:'POST'});assert.equal(res.status,200);
  assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readFileSync(file+'.last-good'),last);
  assert.ok(app.loadData().connections.find(c=>c.id==='new').lastPingCheckedAt);
});
