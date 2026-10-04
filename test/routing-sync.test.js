const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {parseList, fetchSources, createRoutingSync, v2flyLists} = require('../lib/routing-sync');
function fixture() {
  let text='example.com\nfull:exact.example.com\n', fail=false, blobs=0;
  const hash=s=>crypto.createHash('sha1').update('blob '+Buffer.byteLength(s)+'\0'+s).digest('hex');
  const api=async path=>{
    if(fail)throw Error('Offline');
    const itdog=path.startsWith('itdoginfo/');
    const body=itdog?'outside.example.com\n':text;
    if(path.includes('/git/trees/'))return {tree:(itdog?['Russia/outside-raw.lst']:v2flyLists.map(n=>'data/'+n)).map(path=>({path,type:'blob',sha:hash(body)}))};
    blobs++;assert.ok(path.endsWith(hash(body)));
    return {encoding:'base64',content:Buffer.from(body).toString('base64')};
  };
  return {api,setText:x=>text=x,fail:()=>fail=true,blobs:()=>blobs};
}
function harness(f) {
  let clock=1000000000,applied=0;
  let state={settings:{},connections:[],routings:[{id:'merged',isSystem:false,replacesSystemRouting:'routing_except_ru',content:JSON.stringify({routing:{rules:[{type:'field',outboundTag:'direct',domain:['domain:example.com','full:exact.example.com','domain:outside.example.com','domain:manual.example.com']},{type:'field',outboundTag:'direct',ip:['geoip:private']}]}})}]};
  const manager=createRoutingSync({loadData:()=>structuredClone(state),saveData:d=>{state=structuredClone(d);return true;},api:f.api,now:()=>clock,apply:async()=>{applied++;}});
  return {manager,get:()=>state.routings[0],applied:()=>applied,advance:n=>clock+=n,edit:f=>f(state.routings[0])};
}
test('domain parser keeps match semantics and rejects invalid or empty source lists',()=>{
 assert.deepEqual(parseList('example.com @ads # note\nfull:exact.example.com\ninclude:vk',true),{domains:['domain:example.com','full:exact.example.com'],dependencies:['vk']});
 assert.deepEqual(parseList('yandex').domains,['domain:yandex']);
 for(const s of ['# empty','<html>','https://example.com','include:../../evil','example.com unexpected'])assert.throws(()=>parseList(s,true));
});
test('source versions skip blob downloads when selected files are unchanged',async()=>{
 const f=fixture();const a=await fetchSources({},f.api);const count=f.blobs();const old=Object.fromEntries(a.map(({id,unchanged,...x})=>[id,x]));
 const b=await fetchSources(old,f.api);assert.ok(b.every(s=>s.unchanged));assert.equal(f.blobs(),count);
});
test('sync replaces only managed domains, preserves manual and other rules, and reports no updates',async()=>{
 const f=fixture(),h=harness(f);const first=await h.manager.refresh();assert.equal(first.changed,false);assert.equal(h.applied(),0);
 const content=h.get().content;const second=await h.manager.refresh();assert.match(second.message,/Обновлений нет/);assert.equal(h.get().content,content);assert.equal(h.applied(),0);
 f.setText('new.example.com\n');const changed=await h.manager.refresh();assert.equal(changed.changed,true);assert.equal(h.applied(),1);
 const rules=JSON.parse(h.get().content).routing.rules;assert.deepEqual(rules[0].domain,['domain:manual.example.com','domain:new.example.com','domain:outside.example.com']);assert.deepEqual(rules[1].ip,['geoip:private']);
});
test('failed source check preserves last working content and versions',async()=>{
 const f=fixture(),h=harness(f);await h.manager.refresh();const before=h.get().content;const versions=JSON.stringify(h.get().domainSync.sources);f.fail();await assert.rejects(h.manager.refresh(),/Offline/);assert.equal(h.get().content,before);assert.equal(JSON.stringify(h.get().domainSync.sources),versions);assert.equal(h.get().domainSync.lastResult,'error');
});
test('weekly scheduling and concurrent clicks avoid duplicate checks',async()=>{
 const f=fixture(),h=harness(f);const a=h.manager.refresh(),b=h.manager.refresh();assert.equal(a,b);await a;const n=f.blobs();h.advance(6*86400000);await h.manager.tick();assert.equal(f.blobs(),n);f.setText('new.example.com');h.advance(86400000);await h.manager.tick();assert.equal(h.applied(),1);
});
test('user edits during download are not overwritten',async()=>{
 const f=fixture();let release;const wait=new Promise(r=>release=r);const api=async p=>{await wait;return f.api(p);};const h=harness({...f,api});const pending=h.manager.refresh();h.edit(r=>r.content=JSON.stringify({routing:{rules:[]}}));release();await assert.rejects(pending,/Профиль изменён/);assert.deepEqual(JSON.parse(h.get().content).routing.rules,[]);
});
test('failure of the second source does not commit the first source changes',async()=>{
 const f=fixture();let failSecond=false;const h=harness({...f,api:async p=>{if(failSecond&&p.startsWith('itdoginfo/'))throw Error('Second source failed');return f.api(p);}});
 await h.manager.refresh();const before=h.get().content,versions=JSON.stringify(h.get().domainSync.sources);f.setText('new.example.com');failSecond=true;await assert.rejects(h.manager.refresh(),/Second source/);assert.equal(h.get().content,before);assert.equal(JSON.stringify(h.get().domainSync.sources),versions);assert.equal(h.applied(),0);
});
test('source comments change version but do not restart or change domain semantics',async()=>{
 const f=fixture(),h=harness(f);await h.manager.refresh();const version=h.get().domainSync.sources.v2fly.version;f.setText('# updated comment\nexample.com\nfull:exact.example.com');const result=await h.manager.refresh();assert.equal(result.changed,false);assert.notEqual(h.get().domainSync.sources.v2fly.version,version);assert.equal(h.applied(),0);
});
test('manual source-domain removal remains excluded after source update',async()=>{
 const f=fixture(),h=harness(f);await h.manager.refresh();h.edit(r=>{const j=JSON.parse(r.content);j.routing.rules[0].domain=j.routing.rules[0].domain.filter(x=>x!=='domain:example.com');r.content=JSON.stringify(j);});f.setText('example.com\nfull:exact.example.com\nnew.example.com');await h.manager.refresh();assert.ok(!JSON.parse(h.get().content).routing.rules[0].domain.includes('domain:example.com'));
});
test('retry schedule waits six hours after a failed check',async()=>{
 const f=fixture();let calls=0,fail=false;const h=harness({...f,api:async p=>{calls++;if(fail)throw Error('Offline');return f.api(p);}});await h.manager.refresh();fail=true;await assert.rejects(h.manager.refresh());const n=calls;h.advance(5*3600000);await h.manager.tick();assert.equal(calls,n);h.advance(3600000);await assert.rejects(h.manager.tick());assert.ok(calls>n);
});
test('inserted rule does not receive or steal synchronized domains',async()=>{
 const f=fixture(),h=harness(f);await h.manager.refresh();h.edit(r=>{const j=JSON.parse(r.content);j.routing.rules.unshift({type:'field',outboundTag:'direct',domain:['domain:keep.example.com']});r.content=JSON.stringify(j);});const before=h.get().content;f.setText('new.example.com');try{await h.manager.refresh();}catch{}const rules=JSON.parse(h.get().content).routing.rules;assert.deepEqual(rules[0].domain,['domain:keep.example.com']);assert.ok(h.get().content===before || rules[1].domain.includes('domain:new.example.com'));
});
test('nested list versions are tracked, and removed includes stop contributing domains',async()=>{
 let nested='nested.example.com',include=true;
 const hash=s=>crypto.createHash('sha1').update('blob '+Buffer.byteLength(s)+'\0'+s).digest('hex');
 const api=async p=>{const files=p.startsWith('itdoginfo/')?{'Russia/outside-raw.lst':'outside.example.com'}:Object.fromEntries([...v2flyLists.map(n=>['data/'+n,'example.com'+(include?'\ninclude:test-child':'')]),...(include?[['data/test-child',nested]]:[])]);if(p.includes('/trees/'))return {tree:Object.entries(files).map(([path,s])=>({path,sha:hash(s),type:'blob'}))};const s=Object.values(files).find(s=>p.endsWith(hash(s)));assert.notEqual(s,undefined);return {encoding:'base64',content:Buffer.from(s).toString('base64')};};
 const state=a=>Object.fromEntries(a.map(({id,unchanged,...s})=>[id,s]));const a=await fetchSources({},api);assert.ok(a[0].domains.includes('domain:nested.example.com'));nested='changed.example.com';const b=await fetchSources(state(a),api);assert.equal(b[0].unchanged,false);assert.ok(b[0].domains.includes('domain:changed.example.com'));include=false;const c=await fetchSources(state(b),api);assert.deepEqual(c[0].domains,['domain:example.com']);
});
test('corrupt Git blob is rejected before updating rules',async()=>{
 const f=fixture();await assert.rejects(fetchSources({},async p=>{const r=await f.api(p);return p.includes('/blobs/')?{...r,content:Buffer.from('tampered.example.com').toString('base64')}:r;}),/Версия файла/);
});
