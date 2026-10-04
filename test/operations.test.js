const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {applyFiles,createQueue}=require('../lib/operations');
test('partial file failure rolls back the first file and does not persist active state',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xkeen-transaction-'));const a=path.join(dir,'out'),blocked=path.join(dir,'blocked');fs.writeFileSync(a,'old');fs.writeFileSync(blocked,'file');let saved=false;
  try {await assert.rejects(applyFiles({files:[{path:a,content:'new'},{path:path.join(blocked,'route'),content:'route'}],persist:()=>saved=true}));assert.equal(fs.readFileSync(a,'utf8'),'old');assert.equal(saved,false);}
  finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('restart or persistence failure restores both previous files',async()=>{
 for(const fail of ['restart','persist']) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xkeen-rollback-'));const a=path.join(dir,'out'),b=path.join(dir,'route');fs.writeFileSync(a,'old-out');fs.writeFileSync(b,'old-route');let calls=0;
  try {await assert.rejects(applyFiles({files:[{path:a,content:'new'},{path:b,content:'new'}],restart:async()=>{if(fail==='restart' && calls++===0)throw Error('restart failed');},persist:()=>{if(fail==='persist')throw Error('disk failure');}}));assert.equal(fs.readFileSync(a,'utf8'),'old-out');assert.equal(fs.readFileSync(b,'utf8'),'old-route');}
  finally {fs.rmSync(dir,{recursive:true,force:true});}
 }
});
test('validation or cancellation does not write target files',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xkeen-validate-'));const file=path.join(dir,'out');fs.writeFileSync(file,'old');
 try {await assert.rejects(applyFiles({files:[{path:file,content:'new'}],validate:()=>{throw Error('invalid');}}));assert.equal(fs.readFileSync(file,'utf8'),'old');}
 finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('apply queue serializes operations and remains usable after rejection',async()=>{const queue=createQueue(),order=[];await Promise.allSettled([queue(async()=>{order.push(1);await new Promise(r=>setTimeout(r,5));order.push(2);throw Error('failed');}),queue(async()=>order.push(3))]);assert.deepEqual(order,[1,2,3]);});
test('listener moves to a new port without exiting and rolls back occupied port',async()=>{
 const http=require('node:http'),{rebind}=require('../lib/listener');const server=http.createServer((q,r)=>r.end('ok'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const old=server.address().port;
 const blocker=http.createServer();await new Promise(r=>blocker.listen(0,'127.0.0.1',r));let rolled=false;
 try {await assert.rejects(rebind(server,blocker.address().port,'127.0.0.1',old,async()=>{rolled=true;}));assert.equal(rolled,true);assert.equal(server.address().port,old);await rebind(server,0,'127.0.0.1',old,()=>{});assert.equal(await(await fetch('http://127.0.0.1:'+server.address().port)).text(),'ok');}
 finally {server.closeAllConnections();await new Promise(r=>server.close(r));await new Promise(r=>blocker.close(r));}
});
