'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {atomicWrite}=require('./operations');
const fields=['lastPing','lastPingStatus','lastPingError','lastPingType','lastPingCheckedAt','countryCode','countryName'];
const fingerprint=conn=>crypto.createHash('sha256').update(conn.outboundContent||'').digest('hex');
function createHealthStore(file,{delay=30000}={}) {
  let entries=Object.create(null),timer=null,dirty=false;
  try {const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved && typeof saved==='object' && !Array.isArray(saved)) Object.assign(entries,saved);} catch {}
  function flush() {
    if(timer) clearTimeout(timer);timer=null;
    if(!dirty) return;
    atomicWrite(file,JSON.stringify(entries));dirty=false;
  }
  function set(conn) {
    const value={fingerprint:fingerprint(conn)};
    for(const key of fields) if(conn[key]!==undefined) value[key]=conn[key];
    if(JSON.stringify(entries[conn.id])===JSON.stringify(value)) return;
    entries[conn.id]=value;dirty=true;
    if(!timer) {timer=setTimeout(()=>{try {flush();}catch {}},delay);timer.unref?.();}
  }
  function overlay(data) {
    for(const conn of data.connections) {
      const entry=entries[conn.id];
      if(entry?.fingerprint===fingerprint(conn)) for(const key of fields) if(entry[key]!==undefined) conn[key]=entry[key];
    }
    return data;
  }
  function prune(connections) {
    const ids=new Set(connections.map(c=>c.id));
    for(const id of Object.keys(entries)) if(!ids.has(id)) {delete entries[id];dirty=true;}
  }
  return {set,overlay,flush,prune};
}
module.exports={createHealthStore,fingerprint};
