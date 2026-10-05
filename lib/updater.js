'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {atomicWrite}=require('./operations');
const allowed=p=>/^(server\.js|package\.json|lib\/[\w./-]+\.(?:js|json)|public\/[\w./-]+)$/.test(p) && !p.split('/').some(x=>x==='..'||x==='.') && !p.includes('//');
function createUpdater({root,dataDir,repository,fetchImpl=fetch}) {
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Error('Репозиторий обновлений не настроен.');
  const tokenFile=path.join(dataDir,'github-token');
  const token=fs.existsSync(tokenFile)?fs.readFileSync(tokenFile,'utf8').trim():'';
  async function readResponse(response) {
    if(!response.ok) {
      if(response.status===429 || (response.status===403 && response.headers.get('x-ratelimit-remaining')==='0')) throw Error('Лимит запросов GitHub исчерпан. Повторите проверку позже.');
      throw Error('GitHub не предоставил обновление (HTTP '+response.status+'). Проверьте доступность репозитория'+(token?' и права токена.':'.'));
    }
    let size=0,chunks=[];
    for await(const chunk of response.body) {size+=chunk.length;if(size>12*1024*1024) throw Error('Ответ GitHub слишком большой.');chunks.push(Buffer.from(chunk));}
    return Buffer.concat(chunks);
  }
  async function api(suffix) {
    const headers={Accept:'application/vnd.github+json'};
    if(token) headers.Authorization='Bearer '+token;
    const response=await fetchImpl('https://api.github.com/repos/'+repository+suffix,{redirect:'error',headers,signal:AbortSignal.timeout(15000)});
    return JSON.parse((await readResponse(response)).toString('utf8'));
  }
  async function blob(sha,commitSha,filePath) {
    let content;
    if(!token) {
      const url='https://raw.githubusercontent.com/'+repository+'/'+commitSha+'/'+filePath.split('/').map(encodeURIComponent).join('/');
      content=await readResponse(await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(15000)}));
    } else {
      const item=await api('/git/blobs/'+sha);
      if(item.encoding!=='base64' || typeof item.content!=='string') throw Error('Некорректный файл обновления.');
      content=Buffer.from(item.content,'base64');
    }
    const actual=crypto.createHash('sha1').update('blob '+content.length+'\0').update(content).digest('hex');
    if(actual!==sha) throw Error('Контрольная сумма обновления не совпадает.');
    return content;
  }
  async function latest() {
    const ref=await api('/git/ref/heads/main'),sha=ref.object?.sha;
    if(!/^[a-f0-9]{40}$/.test(sha||'')) throw Error('GitHub вернул некорректную версию источника.');
    const commit=await api('/git/commits/'+sha);
    if(!/^[a-f0-9]{40}$/.test(commit.tree?.sha||'')) throw Error('Некорректное дерево обновления.');
    const tree=await api('/git/trees/'+commit.tree.sha+'?recursive=1');
    if(tree.truncated || !Array.isArray(tree.tree) || tree.tree.length>6000) throw Error('Список файлов обновления неполон.');
    const files=tree.tree.filter(x=>allowed(x.path) && !(x.type==='tree'&&x.mode==='040000'));
    if(files.some(x=>x.type!=='blob'||x.mode!=='100644'||!Number.isSafeInteger(x.size)||x.size>8*1024*1024||!/^[a-f0-9]{40}$/.test(x.sha))) throw Error('Недопустимый файл обновления.');
    const pkg=files.find(x=>x.path==='package.json');if(!pkg) throw Error('Нет package.json.');
    const metadata=JSON.parse((await blob(pkg.sha,sha,pkg.path)).toString());
    if(metadata.name!=='xkeen-vless-switcher'||!/^\d+\.\d+\.\d+$/.test(metadata.version)||metadata.updateRepository!==repository) throw Error('Обновление предназначено для другого приложения.');
    let notes = '';
    const changelog = tree.tree.find(file => file.path === 'CHANGELOG.md');
    if (changelog && changelog.type === 'blob' && changelog.mode === '100644' && changelog.size <= 512 * 1024 && /^[a-f0-9]{40}$/.test(changelog.sha)) {
      const content = (await blob(changelog.sha,sha,changelog.path)).toString('utf8');
      const sections = content.split(/^##\s+/m).slice(1);
      const section = sections.find(text => text.split(/\r?\n/, 1)[0].trim().replace(/^v/, '') === metadata.version);
      if (section) notes = section.replace(/^[^\n]*\n/, '').trim().slice(0, 12000);
    }
    return {sha,files,version:metadata.version,tag_name:'v'+metadata.version,html_url:'https://github.com/'+repository+'/commit/'+sha,body:notes || 'Список изменений для этой версии не указан. Коммит: '+sha.slice(0,12)};
  }
  async function prepare(expectedSha) {
    const release=await latest();
    if(release.sha!==expectedSha) throw Error('Источник обновился. Повторите проверку версии.');
    if(release.files.reduce((sum,f)=>sum+f.size,0)>32*1024*1024) throw Error('Обновление превышает 32 МиБ.');
    const stage=fs.mkdtempSync(path.join(dataDir,'update-stage-'));
    try {
      for(const item of release.files) {const content=await blob(item.sha,release.sha,item.path);if(content.length!==item.size) throw Error('Размер файла не совпадает.');atomicWrite(path.join(stage,item.path),content);}
      for(const required of ['server.js','public/index.html','lib/request-origin.js']) if(!fs.existsSync(path.join(stage,required))) throw Error('Обновление неполное.');
      for(const item of release.files.filter(f=>f.path.endsWith('.js'))) execFileSync(process.execPath,['--check',path.join(stage,item.path)],{timeout:10000,stdio:'pipe'});
      const manifest={version:release.version,sha:release.sha,files:release.files.map(x=>x.path)};
      atomicWrite(path.join(stage,'manifest.json'),JSON.stringify(manifest));
      return {stage,...manifest};
    } catch(error) {fs.rmSync(stage,{recursive:true,force:true});throw error;}
  }
  return {latest,prepare};
}
module.exports={createUpdater,allowed};
