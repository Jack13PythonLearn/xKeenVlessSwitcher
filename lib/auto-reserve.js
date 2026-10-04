'use strict';

function createAutoReserve({loadData, saveData, health, activate, history, generation, now=Date.now}) {
  let running=false, nextCheck=0, scanOffset=0;
  async function tick() {
    if(running || now()<nextCheck) return;
    const data=loadData(), af=data.settings.autoFailover;
    if(!af?.enabled) return;
    const version=generation();
    const guard=()=>{if(generation()!==version || !loadData().settings.autoFailover?.enabled) throw Error('Проверка отменена: настройки изменились.');};
    running=true;
    nextCheck=now()+Math.max(10,af.checkIntervalSec||20)*1000;
    try {
      if(data.settings.failover?.enabled && data.settings.failover.state==='backup') {
        af.state='suspended';af.lastLog='Режим БС активен. Авто-резерв приостановлен.';guard();saveData(data);return;
      }
      const primaryId=af.primaryMode==='specific_id'?af.specificPrimaryId:(af.preferredPrimaryId||data.settings.activeConnectionId);
      const primary=data.connections.find(c=>c.id===primaryId);
      const active=data.connections.find(c=>c.id===data.settings.activeConnectionId);
      if(!primary || !active) {af.lastLog='Основное или активное подключение не найдено.';guard();saveData(data);return;}
      af.preferredPrimaryId=primaryId;
      af.lastCheckAt=new Date(now()).toISOString();
      const check=async c=>{guard();const result=await health(c,{timeout:2500,canaryUrl:af.canaryUrl});guard();return result;};
      const current=await check(active);
      const onBackup=active.id!==primaryId;
      if(onBackup && af.autoReturn) {
        const restored=await check(primary);
        af.consecutiveSuccesses=restored.ok?(af.consecutiveSuccesses||0)+1:0;
        if(af.consecutiveSuccesses>=(af.recoveryThreshold||3)) {
          await switchTo(primary,'switch_to_primary');return;
        }
      }
      af.consecutiveFails=current.ok?0:(af.consecutiveFails||0)+1;
      if(!onBackup) af.consecutiveSuccesses=0;
      if(current.ok) {
        af.state=onBackup?'backup':'normal';af.activeBackupId=onBackup?active.id:null;
        af.lastLog='Текущее подключение доступно.';guard();saveData(data);return;
      }
      if(af.consecutiveFails<(af.failThreshold||3)) {af.lastLog='Текущее подключение не отвечает; повторная проверка.';guard();saveData(data);return;}
      const ids=[...new Set(af.poolConnectionIds||[])];
      const candidates=ids.map(id=>data.connections.find(c=>c.id===id)).filter(c=>c && c.id!==active.id && c.id!==primaryId);
      const deadline=now()+30000;
      let best;
      const ordered=af.strategy==='priority_order'?candidates:candidates.slice(scanOffset%candidates.length).concat(candidates.slice(0,scanOffset%candidates.length));
      let scanned=0;
      for(const c of ordered) {
        if(now()>=deadline) break;
        scanned++;
        const result=await check(c);
        if(result.ok && (!best || result.latency<best.latency)) best={conn:c,latency:result.latency};
        if(best && af.strategy==='priority_order') break;
      }
      if(candidates.length && af.strategy!=='priority_order') scanOffset=(scanOffset+scanned)%candidates.length;
      if(best) await switchTo(best.conn,'switch_to_backup');
      else {af.lastLog=candidates.length?'За время проверки доступный резерв не найден.':'В выбранном пуле нет других резервов.';guard();saveData(data);}

      async function switchTo(conn,event) {
        guard();
        await activate(conn.id,data,true,guard);
        guard();
        af.state=conn.id===primaryId?'normal':'backup';
        af.activeBackupId=conn.id===primaryId?null:conn.id;
        af.consecutiveFails=0;af.consecutiveSuccesses=0;af.lastSwitchAt=new Date(now()).toISOString();
        af.lastLog=conn.id===primaryId?'Основной сервер восстановлен.':'Включён доступный резерв.';
        saveData(data);
        history({event,title:af.lastLog,fromName:active.name,toName:conn.name,reason:'Доступность проверена; конфигурация применена.'});
        nextCheck=now()+60000;
      }
    } finally {running=false;}
  }
  return {tick, reset(){nextCheck=0;}};
}
module.exports={createAutoReserve};
