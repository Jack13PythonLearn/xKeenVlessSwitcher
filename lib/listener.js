'use strict';
const net=require('node:net');
async function checkPort(port,host) {
  const probe=net.createServer();
  await new Promise((resolve,reject)=>{probe.once('error',()=>reject(Error('Новый порт недоступен.')));probe.listen(port,host,resolve);});
  await new Promise(r=>probe.close(r));
}
async function rebind(server,port,host,oldPort,rollback) {
  await new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections?.();});
  const listen=p=>new Promise((resolve,reject)=>{
    const error=e=>{server.removeListener('listening',ok);reject(e);};
    const ok=()=>{server.removeListener('error',error);resolve();};
    server.once('error',error);server.once('listening',ok);server.listen(p,host);
  });
  try {await listen(port);} catch(error) {let persistenceError;try {await rollback();} catch(e) {persistenceError=e;} await listen(oldPort);throw Error(persistenceError?'Прежний порт восстановлен, но сохранить его в настройках не удалось.':'Новый порт недоступен, восстановлен прежний.');}
}
module.exports={checkPort,rebind};
