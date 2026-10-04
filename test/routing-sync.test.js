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
