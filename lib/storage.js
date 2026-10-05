'use strict';
const fs=require('node:fs'), path=require('node:path');
function bytes(dir) {
  if(!fs.existsSync(dir)) return 0;
  const stat=fs.lstatSync(dir); if(stat.isSymbolicLink()) return 0;
  return stat.isDirectory()?fs.readdirSync(dir).reduce((sum,p)=>sum+bytes(path.join(dir,p)),0):stat.size;
}
function available(dir) {
  if(!fs.statfsSync) return null;
  const stat=fs.statfsSync(dir); return Number(stat.bavail)*Number(stat.bsize);
}
function requireSpace(dir,needed,getAvailable=available) {
  const free=getAvailable(dir);
  if(free!==null && free<needed) throw Error('Недостаточно свободного места для обновления и отката. Нужно '+Math.ceil(needed/1048576)+' МиБ.');
}
function removeChild(root,name) {
  const target=path.resolve(root,name);
  if(path.dirname(target)!==path.resolve(root) || fs.lstatSync(target).isSymbolicLink()) return;
  fs.rmSync(target,{recursive:true,force:true});
}
// Keep the current rollback. Never clean while a worker may still be installing.
function cleanupStages(dataDir,now=Date.now()) {
  let state;
  try {state=JSON.parse(fs.readFileSync(path.join(dataDir,'update-status.json'),'utf8'));} catch {}
  if(state && !['complete','rolled_back'].includes(state.state)) return 0;
  const keep=state?.stage?path.resolve(state.stage):null;
  let removed=0;
  for(const name of fs.readdirSync(dataDir)) {
    if(!/^update-stage-[a-zA-Z0-9]+$/.test(name)) continue;
    const target=path.resolve(dataDir,name), stat=fs.lstatSync(target);
    if(stat.isSymbolicLink() || !stat.isDirectory() || target===keep) continue;
    // A recent stage without a published job may still be downloading.
    const finished=state && (fs.existsSync(path.join(target,'rollback.json')) || fs.existsSync(path.join(target,'rollback.json.gz')));
    if(now-stat.mtimeMs<24*3600000 && !finished) continue;
    if(!fs.existsSync(path.join(target,'manifest.json'))) {
      // Remove only recognisable interrupted downloads, not arbitrary directories.
      if(!fs.existsSync(path.join(target,'package.json'))) continue;
    }
    removed+=bytes(target); removeChild(dataDir,name);
  }
  return removed;
}
function trimLog(file,limit=256*1024) {
  if(!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size<=limit) return;
  // The service holds this inode open for append; truncate it in place.
  const fd=fs.openSync(file,'r+');
  try {
    const size=fs.fstatSync(fd).size, tail=Buffer.alloc(Math.min(limit>>1,size));
    fs.readSync(fd,tail,0,tail.length,size-tail.length);
    fs.ftruncateSync(fd,0);fs.writeSync(fd,tail,0,tail.length,0);
  } finally {fs.closeSync(fd);}
}
const legacy=['docs','test','screenshot.png','README.md','CHANGELOG.md','RELEASE_NOTES_v2.0.1.md'];
function cleanupLegacy(root) {
  for(const name of legacy) if(fs.existsSync(path.join(root,name))) removeChild(root,name);
}
module.exports={bytes,available,requireSpace,cleanupStages,trimLog,cleanupLegacy};
