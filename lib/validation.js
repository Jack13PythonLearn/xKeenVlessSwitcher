'use strict';
function validateIds(data) {
  for(const key of ['connections','routings','subscriptions','profiles']) {
    if(data[key]===undefined) continue;
    if(!Array.isArray(data[key]) || data[key].length>6000) throw Error('Некорректный список '+key);
    const seen=new Set();
    for(const item of data[key]) {
      if(!item || typeof item!=='object') throw Error('Некорректная запись '+key);
      if(item.id===undefined) continue; // Legacy imports assign an ID before saving.
      if(typeof item.id!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || seen.has(item.id)) throw Error('Недопустимый или повторяющийся идентификатор '+key);
      seen.add(item.id);
    }
  }
}
module.exports={validateIds};
