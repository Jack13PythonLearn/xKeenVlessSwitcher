const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
test('merged profile keeps domain rules after rename, repeated load and save',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'routing-persist-'));
 try { const script=`const assert=require('node:assert/strict');const app=require('./server');const d=app.loadData();const rules=[{type:'field',outboundTag:'direct',domain:Array.from({length:807},(_,i)=>'domain:demo'+i+'.example')}];d.routings.unshift({id:'merged',name:'Всё через VPN кроме РФ',isSystem:false,replacesSystemRouting:'routing_except_ru',content:JSON.stringify({routing:{rules}})});d.connections=[{id:'test',name:'Test',routingId:'merged',outboundContent:'{}'}];d.subscriptions=[];app.saveData(d);for(let i=0;i<3;i++){const loaded=app.loadData();const r=loaded.routings.find(r=>r.id==='merged');assert.ok(r);assert.equal(r.isSystem,false);assert.equal(JSON.parse(r.content).routing.rules[0].domain.length,807);assert.equal(loaded.connections[0].routingId,'merged');assert.equal(loaded.routings.length,2);app.saveData(loaded);}console.log('ok');`;
 assert.match(execFileSync(process.execPath,['-e',script],{cwd:path.join(__dirname,'..'),env:{...process.env,XKEEN_DATA_DIR:dir,XKEEN_DISABLE_BACKGROUND:'1'},encoding:'utf8'}),/ok/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
