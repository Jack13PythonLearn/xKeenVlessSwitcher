'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
function createStaticHandler(root,version,mime) {
  let flags;
  const gzip=req=>(req.headers['accept-encoding']||'').split(',').some(part=>/^\s*gzip\b/i.test(part) && !/;\s*q=0(?:\.0*)?\s*$/i.test(part));
  return async (req,res) => {
    const url=new URL(req.url,'http://localhost');
    const flag=/^\/flags\/([a-z]{2})\.svg$/.exec(url.pathname);
    if(flag) {
      flags ||= JSON.parse(await fs.promises.readFile(path.join(root,'flags-index.json'),'utf8'));
      const entry=flags[flag[1]];
      if(!entry) {res.writeHead(404);return res.end();}
      res.setHeader('Content-Type','image/svg+xml');res.setHeader('Vary','Accept-Encoding');
      res.setHeader('Cache-Control',url.searchParams.get('v')===entry.hash?'public, max-age=31536000, immutable':'no-cache');
      res.setHeader('ETag','"'+entry.hash+'"');
      if(req.headers['if-none-match']==='"'+entry.hash+'"') {res.writeHead(304);return res.end();}
      const fd=await fs.promises.open(path.join(root,'flags.pack'),'r');
      let content=Buffer.alloc(entry.length);
      try {const {bytesRead}=await fd.read(content,0,entry.length,entry.offset);if(bytesRead!==entry.length) throw Error('Incomplete flag');}finally{await fd.close();}
      if(gzip(req)) res.setHeader('Content-Encoding','gzip');else content=zlib.gunzipSync(content);
      return res.end(content);
    }
    const relative=url.pathname==='/'?'index.html':url.pathname.slice(1);
    const file=path.resolve(root,relative);
    if(!file.startsWith(path.resolve(root)+path.sep) || /(?:flags\.pack|flags-index\.json)$/.test(file)) {res.writeHead(404);return res.end();}
    let stat;try {stat=await fs.promises.stat(file);}catch {res.writeHead(404);return res.end();}
    if(!stat.isFile()) {res.writeHead(404);return res.end();}
    const ext=path.extname(file).toLowerCase(),etag='"'+version+'-'+stat.size+'-'+Math.floor(stat.mtimeMs)+'"';
    res.setHeader('Content-Type',mime[ext]||'application/octet-stream');res.setHeader('ETag',etag);
    res.setHeader('Cache-Control',ext!=='.html' && url.searchParams.get('v')===version?'public, max-age=31536000, immutable':'no-cache');
    res.setHeader('Vary','Accept-Encoding');
    if(req.headers['if-none-match']===etag) {res.writeHead(304);return res.end();}
    const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());
    if(gzip(req) && /\.(css|js|html|svg)$/.test(file)) {res.setHeader('Content-Encoding','gzip');const zip=zlib.createGzip();zip.on('error',()=>res.destroy());stream.pipe(zip).pipe(res);} else stream.pipe(res);
  };
}
module.exports={createStaticHandler};
