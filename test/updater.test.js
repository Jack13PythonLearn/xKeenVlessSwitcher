const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createUpdater,allowed}=require('../lib/updater');const {install}=require('../lib/update-worker');
const hash=content=>crypto.createHash('sha1').update('blob '+Buffer.byteLength(content)+'\0').update(content).digest('hex');
test('public update checks and stages pinned files without credentials',async()=>{
 const f=fixture({token:false});
 try {
  const latest=await f.updater.latest();
  const prepared=await f.updater.prepare(latest.sha);
  assert.equal(fs.readFileSync(path.join(prepared.stage,'server.js'),'utf8'),f.files['server.js']);
  assert.ok(f.requests.every(r=>!r.options.headers?.Authorization));
  assert.equal(f.requests.filter(r=>r.url.startsWith('https://api.github.com/')).length,6);
  assert.ok(f.requests.filter(r=>r.url.startsWith('https://raw.githubusercontent.com/')).every(r=>r.url.includes('/'+f.sha+'/')&&r.options.redirect==='error'));
 } finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('public download rejects content that does not match the pinned Git hash',async()=>{
 const f=fixture({token:false,corrupt:true});
 try {await assert.rejects(f.updater.latest(),/Контрольная сумма/);}
 finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('anonymous API errors explain rate limits or repository access without requiring a token',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xkeen-public-errors-'));
 try {
  for(const status of [403,404,429]) {
   const updater=createUpdater({root:dir,dataDir:dir,repository:'owner/repo',fetchImpl:async()=>new Response('{}',{status,headers:status===403?{'x-ratelimit-remaining':'0'}:{}})});
   await assert.rejects(updater.latest(),status===404?/HTTP 404/:/Лимит запросов/);
  }
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('restart uses Entware shell on Keenetic and system shell otherwise',()=>{
 const {restartService}=require('../lib/update-worker');
 for(const entware of [true,false]) {
  const calls=[];
  restartService('/opt/etc/init.d/S99xkeen-switcher',{exists:p=>entware&&p==='/opt/bin/sh',exec:(...args)=>calls.push(args)});
  assert.equal(calls[0][0],entware?'/opt/bin/sh':'/bin/sh');
  assert.deepEqual(calls[0][1],['/opt/etc/init.d/S99xkeen-switcher','restart']);
 }
});
function fixture({token=true,corrupt=false}={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xkeen-update-test-'));if(token)fs.writeFileSync(path.join(dir,'github-token'),'synthetic-test-token');const files={'package.json':JSON.stringify({name:'xkeen-vless-switcher',version:'2.2.0',updateRepository:'owner/repo'}),'server.js':'console.log("demo")','public/index.html':'<html></html>','public/fonts/demo.woff2':'demo-font','lib/request-origin.js':'module.exports={};'};const sha='a'.repeat(40);const requests=[];const fetchImpl=async(url,options)=>{requests.push({url,options});if(url.startsWith("https://raw.githubusercontent.com/")){const p=url.split("/"+sha+"/")[1];assert.ok(p in files);return new Response(corrupt?"corrupted":files[p]);}let value;if(url.endsWith('/git/ref/heads/main'))value={object:{sha}};else if(url.endsWith('/git/commits/'+sha))value={tree:{sha:'b'.repeat(40)}};else if(url.includes('/git/trees/'))value={tree:Object.entries(files).map(([p,c])=>({path:p,type:'blob',mode:'100644',sha:hash(c),size:Buffer.byteLength(c)})).concat([{path:'public/fonts',type:'tree',mode:'040000',sha:'d'.repeat(40)}])};else {const c=Object.values(files).find(c=>url.endsWith(hash(c)));value={encoding:'base64',content:Buffer.from(c).toString('base64')};}return new Response(JSON.stringify(value));};return {dir,files,sha,requests,updater:createUpdater({root:dir,dataDir:dir,repository:'owner/repo',fetchImpl})};}
test('private update pins source SHA, verifies blob hashes and stages only application files',async()=>{const f=fixture();try{const latest=await f.updater.latest();assert.equal(latest.version,'2.2.0');await assert.rejects(f.updater.prepare('c'.repeat(40)),/Источник обновился/);const prepared=await f.updater.prepare(f.sha);assert.equal(fs.readFileSync(path.join(prepared.stage,'server.js'),'utf8'),f.files['server.js']);assert.ok(f.requests.every(r=>r.options.redirect==='error'&&r.options.headers.Authorization==='Bearer synthetic-test-token'));assert.ok(!JSON.stringify(latest).includes('synthetic-test-token'));}finally{fs.rmSync(f.dir,{recursive:true,force:true});}});
test('updater rejects traversal and private data paths',()=>{for(const p of ['../server.js','public/../data/profiles.json','data/admin-key','.git/config','lib//a.js'])assert.equal(allowed(p),false);});
test('failed new application startup restores code and preserves all user data',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xkeen-install-')),root=path.join(dir,'app'),stage=path.join(dir,'stage');fs.mkdirSync(root);fs.mkdirSync(stage);fs.writeFileSync(path.join(root,'server.js'),'old');fs.writeFileSync(path.join(root,'profiles.json'),'private-user-data');fs.writeFileSync(path.join(stage,'server.js'),'new');fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify({files:['server.js'],version:'2.2.0'}));let restarts=0;const states=[];try{await assert.rejects(install({root,stage,restart:()=>restarts++,healthy:()=>false,status:s=>states.push(s)}),/проверку запуска/);assert.equal(restarts,2);assert.equal(fs.readFileSync(path.join(root,'server.js'),'utf8'),'old');assert.equal(fs.readFileSync(path.join(root,'profiles.json'),'utf8'),'private-user-data');assert.deepEqual(states,['installing','rolled_back']);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('latest version includes its changelog section from the same pinned tree',async()=>{const f=fixture();try{f.files['CHANGELOG.md']='# История\n\n## 2.2.0\n\n- Кнопка проверки обновлений.\n- Исправление ошибки.\n\n## 2.1.13\n\n- Старые изменения.\n';const result=await f.updater.latest();assert.match(result.body,/Кнопка проверки/);assert.ok(!result.body.includes('Старые изменения'));assert.ok(!result.files.some(x=>x.path==='CHANGELOG.md'));}finally{fs.rmSync(f.dir,{recursive:true,force:true});}});
