'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib'),crypto=require('node:crypto'),http=require('node:http');
const {cleanupStages,requireSpace,trimLog}=require('../lib/storage');
const {createHealthStore}=require('../lib/health-store');
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'xkeen-perf-'));
function stage(dir,name) {const p=path.join(dir,'update-stage-'+name);fs.mkdirSync(p);fs.writeFileSync(path.join(p,'manifest.json'),'{}');return p;}
test('cleanup keeps current rollback, recent downloads and user data, removes completed older copies',()=>{
 const dir=temp();try {
  const keep=stage(dir,'keep'),old=stage(dir,'old'),recent=stage(dir,'recent');
  fs.writeFileSync(path.join(old,'rollback.json'),'[]');fs.writeFileSync(path.join(dir,'profiles.json'),'private');
  fs.writeFileSync(path.join(dir,'update-status.json'),JSON.stringify({state:'complete',stage:keep}));
  assert.ok(cleanupStages(dir)>0);assert.equal(fs.existsSync(old),false);assert.ok(fs.existsSync(keep));assert.ok(fs.existsSync(recent));assert.equal(fs.readFileSync(path.join(dir,'profiles.json'),'utf8'),'private');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('cleanup never runs while an update or a failed rollback needs attention',()=>{
 const dir=temp();try {const old=stage(dir,'old');fs.writeFileSync(path.join(old,'rollback.json'),'[]');for(const state of ['prepared','installing','rollback_failed']) {fs.writeFileSync(path.join(dir,'update-status.json'),JSON.stringify({state}));cleanupStages(dir,Date.now()+7*86400000);assert.ok(fs.existsSync(old));}}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('abandoned download is removed after one day, unrelated directories remain',()=>{
 const dir=temp();try {const old=stage(dir,'old');fs.mkdirSync(path.join(dir,'my-backups'));cleanupStages(dir,Date.now()+2*86400000);assert.equal(fs.existsSync(old),false);assert.ok(fs.existsSync(path.join(dir,'my-backups')));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('insufficient update space is rejected before writing staged code',()=>{assert.throws(()=>requireSpace('.',200,()=>100),/Недостаточно/);assert.doesNotThrow(()=>requireSpace('.',200,()=>201));assert.doesNotThrow(()=>requireSpace('.',200,()=>null));});
test('log trimming preserves the latest output and keeps the open append handle usable',()=>{
 const dir=temp(),file=path.join(dir,'service.log');try {fs.writeFileSync(file,'a'.repeat(4000)+'TAIL');const fd=fs.openSync(file,'a');trimLog(file,1024);fs.writeSync(fd,'NEXT');fs.closeSync(fd);assert.ok(fs.statSync(file).size<=1024);assert.ok(fs.readFileSync(file,'utf8').endsWith('TAILNEXT'));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('532 health changes share a single compact write and survive reload without storing credentials',()=>{
 const dir=temp(),file=path.join(dir,'health.json');try {const store=createHealthStore(file);const conns=Array.from({length:532},(_,i)=>({id:'c'+i,outboundContent:'private-token-'+i,lastPing:i,lastPingStatus:'ok'}));for(const c of conns)store.set(c);assert.equal(fs.existsSync(file),false);store.flush();assert.ok(!fs.readFileSync(file,'utf8').includes('private-token'));const reloaded=createHealthStore(file);const data={connections:conns.map(({lastPing,lastPingStatus,...c})=>c)};reloaded.overlay(data);assert.equal(data.connections[531].lastPing,531);reloaded.flush();}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('stale health cannot attach to an edited outbound and removed IDs are pruned',()=>{
 const dir=temp(),file=path.join(dir,'health.json');try {const store=createHealthStore(file);store.set({id:'a',outboundContent:'old',lastPing:1});store.set({id:'deleted',lastPing:2});const d={connections:[{id:'a',outboundContent:'new'}]};store.overlay(d);assert.equal(d.connections[0].lastPing,undefined);store.prune(d.connections);store.flush();assert.equal(JSON.parse(fs.readFileSync(file)).deleted,undefined);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('every packed flag is independently decodable and matches its resource hash',()=>{
 const root=path.join(__dirname,'..','public'),index=JSON.parse(fs.readFileSync(path.join(root,'flags-index.json'))),pack=fs.readFileSync(path.join(root,'flags.pack'));
 assert.equal(Object.keys(index).length,257);
 for(const e of Object.values(index)) {const svg=zlib.gunzipSync(pack.subarray(e.offset,e.offset+e.length));assert.match(svg.toString(),/<svg/);assert.equal(crypto.createHash('sha256').update(svg).digest('hex').slice(0,16),e.hash);}
 assert.ok(pack.length<600000);
});
test('static resources support conditional caching, gzip and flag requests without exposing the pack',async()=>{
 const root=path.join(__dirname,'..','public'),handler=require('../lib/static-files').createStaticHandler(root,'2.4.0',{'.css':'text/css'});
 const server=http.createServer((q,r)=>handler(q,r).catch(e=>r.destroy(e)));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try {const css=await fetch(base+'/flags.css?v=2.4.0');assert.match(css.headers.get('cache-control'),/immutable/);assert.equal(css.headers.get('content-encoding'),'gzip');const etag=css.headers.get('etag');await css.text();assert.equal((await fetch(base+'/flags.css',{headers:{'If-None-Match':etag}})).status,304);const flag=await fetch(base+'/flags/de.svg',{headers:{'Accept-Encoding':'identity'}});assert.match(await flag.text(),/<svg/);assert.equal(flag.headers.get('content-encoding'),null);assert.equal((await fetch(base+'/flags.pack')).status,404);assert.equal((await fetch(base+'/flags/zz.svg')).status,404);}finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('successful update keeps compressed rollback, removes staged payload and supports manual rollback',async()=>{
 const {install}=require('../lib/update-worker'),dir=temp(),root=path.join(dir,'app'),st=path.join(dir,'stage');fs.mkdirSync(root);fs.mkdirSync(st);fs.writeFileSync(path.join(root,'server.js'),'old');fs.writeFileSync(path.join(st,'server.js'),'new');fs.writeFileSync(path.join(st,'manifest.json'),JSON.stringify({files:['server.js'],version:'2.4.0'}));
 try {await install({root,stage:st,restart:()=>{},healthy:()=>true,status:()=>{}});assert.equal(fs.readFileSync(path.join(root,'server.js'),'utf8'),'new');assert.equal(fs.existsSync(path.join(st,'server.js')),false);assert.ok(fs.existsSync(path.join(st,'rollback.json.gz')));await install({root,stage:st,restart:()=>{},healthy:()=>true,status:()=>{},rollbackOnly:true});assert.equal(fs.readFileSync(path.join(root,'server.js'),'utf8'),'old');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('runtime archive is deterministic and contains only runtime files',()=>{
 const dir=temp();try {for(const d of ['lib','public','docs','data'])fs.mkdirSync(path.join(dir,d));for(const p of ['server.js','package.json','lib/a.js','public/index.html','docs/private.txt','data/profiles.json'])fs.writeFileSync(path.join(dir,p),p);const {build}=require('../scripts/build-runtime');build(dir);const first=fs.readFileSync(path.join(dir,'dist/runtime.tar.gz'));build(dir);assert.deepEqual(fs.readFileSync(path.join(dir,'dist/runtime.tar.gz')),first);const tar=zlib.gunzipSync(first);assert.ok(tar.includes(Buffer.from('app/server.js')));assert.ok(!tar.includes(Buffer.from('private.txt')));assert.ok(!tar.includes(Buffer.from('profiles.json')));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('three consecutive upgrades retain exactly one usable rollback and preserve user data',async()=>{
 const {install}=require('../lib/update-worker'),dir=temp(),root=path.join(dir,'app'),data=path.join(dir,'data');fs.mkdirSync(root);fs.mkdirSync(data);fs.writeFileSync(path.join(root,'server.js'),'v0');fs.writeFileSync(path.join(data,'profiles.json'),'user-data');
 try {let current;for(let i=1;i<=3;i++){current=stage(data,'run'+i);fs.writeFileSync(path.join(current,'server.js'),'v'+i);fs.writeFileSync(path.join(current,'manifest.json'),JSON.stringify({files:['server.js'],version:String(i)}));await install({root,stage:current,dataDir:data,restart:()=>{},healthy:()=>true,status:state=>fs.writeFileSync(path.join(data,'update-status.json'),JSON.stringify({state,stage:current}))});assert.equal(fs.readdirSync(data).filter(n=>n.startsWith('update-stage-')).length,1);}await install({root,stage:current,restart:()=>{},healthy:()=>true,status:()=>{},rollbackOnly:true});assert.equal(fs.readFileSync(path.join(root,'server.js'),'utf8'),'v2');assert.equal(fs.readFileSync(path.join(data,'profiles.json'),'utf8'),'user-data');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
