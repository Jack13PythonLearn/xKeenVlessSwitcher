const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
function setup(fetchImpl) {
 const elements=new Map(),messages=[],modals=[];
 const context={appData:{version:'2.2.2',updateRepository:'owner/repo'},AbortController,setTimeout,clearTimeout,console,
 fetch:fetchImpl,showToast:(...a)=>messages.push(a),openAppUpdateModal:()=>modals.push('open'),
 document:{getElementById:id=>{if(!elements.has(id)){const classes=new Set(['hidden']);elements.set(id,{textContent:'',disabled:false,setAttribute(){},removeAttribute(){},classList:{add:c=>classes.add(c),toggle:(c,hide)=>hide?classes.add(c):classes.delete(c),contains:c=>classes.has(c)}});}return elements.get(id);}}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('let updateCheckRan'),source.indexOf('function openAppUpdateModal()')),context);
 vm.runInContext(source.slice(source.indexOf('function isNewerVersion(')),context);
 return {context,elements,messages,modals};
}
const release=version=>({ok:true,json:async()=>({tag_name:'v'+version,sha:'a'.repeat(40),body:'Изменения'})});
test('version click always rechecks source and reports no updates',async()=>{let requests=0;const h=setup(async(url,opts)=>{requests++;assert.equal(url,'/api/app/latest');assert.equal(opts.cache,'no-store');return release('2.2.2');});await h.context.checkAppUpdate();await h.context.checkAppUpdate();assert.equal(requests,2);assert.equal(h.messages[1][0],'Установлена последняя версия');assert.equal(h.modals.length,0);assert.equal(h.elements.get('app-version-text').textContent,'v2.2.2');});
test('manual newer-version check opens review dialog without requesting installation',async()=>{const urls=[];const h=setup(async url=>{urls.push(url);return release('2.2.3');});await h.context.checkForUpdates('2.2.2');assert.equal(h.modals.length,0);await h.context.checkAppUpdate();assert.deepEqual(urls,['/api/app/latest','/api/app/latest']);assert.equal(h.modals.length,1);assert.equal(h.elements.get('app-update-group').classList.contains('hidden'),false);});
test('missing token error is visible on click and retry remains possible',async()=>{let calls=0;const h=setup(async()=>++calls===1?{ok:false,json:async()=>({error:'Настройте токен GitHub'})}:release('2.2.2'));await h.context.checkAppUpdate();assert.equal(h.messages[0][0],'Настройте токен GitHub');assert.equal(h.elements.get('app-version-badge').disabled,false);await h.context.checkAppUpdate();assert.equal(h.messages[1][0],'Установлена последняя версия');});
test('manual request joins an in-flight automatic check',async()=>{let finish,calls=0;const h=setup(()=>{calls++;return new Promise(r=>finish=r);});const a=h.context.checkForUpdates('2.2.2');const b=h.context.checkAppUpdate();assert.equal(h.elements.get('app-version-badge').disabled,true);finish(release('2.2.3'));await Promise.all([a,b]);assert.equal(calls,1);assert.equal(h.modals.length,1);assert.equal(h.elements.get('app-version-badge').disabled,false);});
test('failed or malformed response cannot leave an old update available',async()=>{let calls=0;const h=setup(async()=>++calls===1?release('2.2.3'):{ok:true,json:async()=>({tag_name:'invalid'})});await h.context.checkAppUpdate();await h.context.checkAppUpdate();assert.equal(h.elements.get('app-update-group').classList.contains('hidden'),true);assert.equal(h.modals.length,1);assert.match(h.messages[0][0],/некорректную/);});
test('timeout displays a retry message and restores the version button',async()=>{const h=setup(async()=>{const e=Error('timeout');e.name='AbortError';throw e;});await h.context.checkAppUpdate();assert.match(h.messages[0][0],/Попробуйте ещё раз/);assert.equal(h.elements.get('app-version-badge').disabled,false);});
