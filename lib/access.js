'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const net=require('node:net');
const os=require('node:os');

function createAccess({dir, allowedHosts=[]}) {
  fs.mkdirSync(dir,{recursive:true});
  const keyPath=path.join(dir,'admin-key');
  if(!fs.existsSync(keyPath)) fs.writeFileSync(keyPath,crypto.randomBytes(32).toString('hex')+'\n',{mode:0o600,flag:'wx'});
  const key=fs.readFileSync(keyPath,'utf8').trim();
  if(key.length<32) throw Error('Файл admin-key повреждён. Восстановите ключ локально.');
  const hash=value=>crypto.createHash('sha256').update(String(value)).digest();
  const equal=value=>crypto.timingSafeEqual(hash(value),hash(key));
  const sessions=new Map(), attempts=new Map();
  function hostAllowed(req) {
    try {
      const host=new URL('http://'+req.headers.host).hostname.replace(/^\[|\]$/g,'').toLowerCase();
      return net.isIP(host)!==0 || ['localhost',os.hostname().toLowerCase(),...allowedHosts].includes(host);
    } catch {return false;}
  }
  function trustedOrigin(req) {
    if(!hostAllowed(req)) return false;
    if(!req.headers.origin) return true;
    try {const u=new URL(req.headers.origin);return ['http:','https:'].includes(u.protocol) && u.host===req.headers.host;} catch {return false;}
  }
  function authorized(req) {
    const bearer=/^Bearer (.+)$/.exec(req.headers.authorization||'');
    if(bearer && equal(bearer[1])) return true;
    const token=/(?:^|;\s*)xkeen_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
    return token && (sessions.get(token)||0)>Date.now();
  }
  function login(req,value) {
    const address=req.socket.remoteAddress;
    const now=Date.now();
    for(const [ip,item] of attempts) if(item.until<now) attempts.delete(ip);
    const attempt=attempts.get(address)||{count:0,until:now+60000};
    if(attempts.size>=1024 || ++attempt.count>10) throw Error('Слишком много попыток. Подождите минуту.');
    attempts.set(address,attempt);
    if(!equal(value)) throw Error('Неверный ключ доступа.');
    attempts.delete(address);
    for(const [token,expires] of sessions) if(expires<=now) sessions.delete(token);
    if(sessions.size>=256) sessions.delete(sessions.keys().next().value);
    const token=crypto.randomBytes(32).toString('hex');
    sessions.set(token,now+12*3600000);
    return 'xkeen_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'+(req.socket.encrypted?'; Secure':'');
  }
  function logout(req) {const token=/(?:^|;\s*)xkeen_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];if(token) sessions.delete(token);return 'xkeen_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';}
  return {keyPath,trustedOrigin,authorized,login,logout};
}
module.exports={createAccess};
