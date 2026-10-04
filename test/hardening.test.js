const {test,after,before}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'xkeen-secure-'));
process.env.XKEEN_DATA_DIR=temp;
process.env.XKEEN_DISABLE_BACKGROUND='1';
const app=require('../server');
let base,key;
before(async()=>{await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;key=fs.readFileSync(path.join(temp,'admin-key'),'utf8').trim();const d=app.loadData();d.settings.restartCommand='';app.saveData(d);});
after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));fs.rmSync(temp,{recursive:true,force:true});});
const call=(p,body,headers={})=>fetch(base+p,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
test('API requires authentication and rejects foreign origin even with an admin credential',async()=>{
  assert.equal((await fetch(base+'/api/data')).status,401);
  assert.equal((await call('/api/settings',{statusCommand:'echo forbidden'},{Origin:'https://untrusted.example'})).status,403);
  assert.equal((await call('/api/data')).status,200);
  const status=await new Promise((resolve,reject)=>{const req=require('node:http').get(base+'/api/data',{headers:{Host:'rebind.example',Authorization:'Bearer '+key}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(status,403);
});
test('login issues HttpOnly SameSite session; key is absent from data and backup',async()=>{
  assert.equal((await call('/api/auth/login',{key:'wrong'})).status,403);
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
  const cookie=login.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
  assert.equal((await fetch(base+'/api/data',{headers:{Cookie:cookie.split(';')[0]}})).status,200);
  const data=await(await call('/api/data')).text();assert.ok(!data.includes(key));
  const backup=Buffer.from(await(await call('/api/backup/export')).arrayBuffer());assert.ok(!backup.includes(Buffer.from(key)));
});
test('empty pool remains empty when disabled and cannot be enabled through either API',async()=>{
  let d=app.loadData();d.settings.autoFailover.poolConnectionIds=[];app.saveData(d);
  assert.equal((await call('/api/autofailover/toggle',{enabled:false})).status,200);
  assert.deepEqual(app.loadData().settings.autoFailover.poolConnectionIds,[]);
  assert.equal((await call('/api/autofailover/toggle',{enabled:true})).status,400);
  assert.equal((await call('/api/autofailover/settings',{enabled:true,poolConnectionIds:[]})).status,400);
});
test('disk write failure is an API error and retains persisted settings',async()=>{
  const old=app.loadData().settings.statusCommand;
  const rename=fs.renameSync;
  fs.renameSync=(from,to)=>{if(to===path.join(temp,'profiles.json'))throw Error('simulated disk failure');return rename(from,to);};
  try {const response=await call('/api/settings',{statusCommand:'unsaved'});assert.ok(response.status>=400);assert.equal(app.loadData().settings.statusCommand,old);}
  finally {fs.renameSync=rename;}
});
test('corrupt database fails closed and is not replaced by a settings request',async()=>{
  const file=path.join(temp,'profiles.json'),original=fs.readFileSync(file);
  try {fs.writeFileSync(file,'{broken');assert.throws(()=>app.loadData(),/повреждена/);assert.ok((await call('/api/settings',{statusCommand:'new'})).status>=400);assert.equal(fs.readFileSync(file,'utf8'),'{broken');}
  finally {fs.writeFileSync(file,original);}
});
test('backup IDs cannot inject HTML or inline scripts or duplicate another connection',async()=>{
  const original=fs.readFileSync(path.join(temp,'profiles.json'),'utf8');
  for(const connections of [[{id:"x' onclick='bad",outboundContent:'{}'}],[{id:'same'},{id:'same'}]]) {
    const response=await call('/api/backup/restore',{connections});assert.ok(response.status>=400);
    assert.equal(fs.readFileSync(path.join(temp,'profiles.json'),'utf8'),original);
  }
});
test('oversized HTTP body is rejected before settings are changed',async()=>{
  const original=fs.readFileSync(path.join(temp,'profiles.json'),'utf8');
  const status=await new Promise((resolve,reject)=>{const req=require('node:http').request(base+'/api/settings',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Length':17*1024*1024}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(status,413);assert.equal(fs.readFileSync(path.join(temp,'profiles.json'),'utf8'),original);
});
test('saving valid settings keeps an independent last-good database',async()=>{const previous=fs.readFileSync(path.join(temp,'profiles.json'),'utf8');const d=app.loadData();d.settings.statusCommand='test-last-good';app.saveData(d);assert.equal(fs.readFileSync(path.join(temp,'profiles.json.last-good'),'utf8'),previous);});
test('negative service status is not mistaken for running',()=>{for(const stdout of ['Xray is not running','Служба не работает','Xray не запущен','inactive'])assert.equal(app.evaluateServiceStatus({stdout,code:0,success:true}),'stopped');assert.equal(app.evaluateServiceStatus({stdout:'Xray is running',code:0,success:true}),'running');});
test('ZIP expansion and entry count limits reject bombs without changing the database',()=>{
 const name=Buffer.from('profiles.json'),compressed=require('node:zlib').deflateRawSync(Buffer.alloc(17*1024*1024,32));
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(name.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(8,10);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(17*1024*1024,24);central.writeUInt16LE(name.length,28);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,10);end.writeUInt32LE(local.length+name.length+compressed.length,16);
 const archive=Buffer.concat([local,name,compressed,central,name,end]);assert.throws(()=>app.parseZipBuffer(archive),/превышает/);
 central.writeUInt32LE(1,24);assert.throws(()=>app.parseZipBuffer(Buffer.concat([local,name,compressed,central,name,end])),/лимит/);
 end.writeUInt16LE(6001,10);assert.throws(()=>app.parseZipBuffer(Buffer.concat([local,name,compressed,central,name,end])),/много файлов/);
});
test('logout revokes session immediately',async()=>{const login=await call('/api/auth/login',{key});const cookie=login.headers.get('set-cookie').split(';')[0];const response=await fetch(base+'/api/auth/logout',{method:'POST',headers:{Cookie:cookie}});assert.equal(response.status,200);assert.equal((await fetch(base+'/api/data',{headers:{Cookie:cookie}})).status,401);});
