'use strict';
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {atomicWrite}=require('./operations');
function restartService(initScript,{exists=fs.existsSync,exec=execFileSync}={}) {
  const shell=exists('/opt/bin/sh')?'/opt/bin/sh':'/bin/sh';
  return exec(shell,[initScript,'restart'],{timeout:30000,stdio:'pipe'});
}
async function install({root,stage,restart,healthy,status,rollbackOnly=false}) {
  const manifest=JSON.parse(fs.readFileSync(path.join(stage,'manifest.json'),'utf8'));
  const snapshot=path.join(stage,'rollback.json');
  if(!fs.existsSync(snapshot)) {
    if(rollbackOnly) throw Error('Резервная копия кода отсутствует.');
    const files=manifest.files.map(p=>({path:p,content:fs.existsSync(path.join(root,p))?fs.readFileSync(path.join(root,p)).toString('base64'):null}));
    atomicWrite(snapshot,JSON.stringify(files));
  }
  const restore=()=>{for(const f of JSON.parse(fs.readFileSync(snapshot,'utf8'))) {const target=path.join(root,f.path);if(f.content===null) {if(fs.existsSync(target)) fs.unlinkSync(target);} else atomicWrite(target,Buffer.from(f.content,'base64'));}};
  try {
    if(rollbackOnly) {restore();await restart();await status('rolled_back');return;}
    await status('installing');
    for(const p of manifest.files) atomicWrite(path.join(root,p),fs.readFileSync(path.join(stage,p)));
    await restart();
    if(!await healthy(manifest.version)) throw Error('Новая версия не прошла проверку запуска.');
    await status('complete');
  } catch(error) {
    try {restore();await restart();await status('rolled_back');}
    catch {await status('rollback_failed');throw Error('Автоматический откат не завершён. Используйте сохранённую копию кода.');}
    throw error;
  }
}
async function run(jobPath,rollbackOnly) {
  const job=JSON.parse(fs.readFileSync(jobPath,'utf8'));
  const status=state=>atomicWrite(path.join(job.dataDir,'update-status.json'),JSON.stringify({state,version:job.version,sha:job.sha,stage:job.stage,at:new Date().toISOString()}));
  const restart=()=>restartService(job.initScript);
  const healthy=async version=>{
    for(let attempt=0;attempt<20;attempt++) {
      try {const r=await fetch('http://127.0.0.1:'+job.port+'/api/version',{signal:AbortSignal.timeout(1500)});if(r.ok&&(await r.json()).version===version) return true;} catch {}
      await new Promise(r=>setTimeout(r,1000));
    }
    return false;
  };
  await new Promise(r=>setTimeout(r,1500));
  await install({...job,restart,healthy,status,rollbackOnly});
}
if(require.main===module) run(process.argv[2],process.argv[3]==='--rollback').catch(()=>{process.exitCode=1;});
module.exports={install,restartService};
