'use strict';
// Convert the original vendored CSS once; subsequent builds use the checked-in pack.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const root=path.join(__dirname,'..','public'),css=fs.readFileSync(path.join(root,'flags.css'),'utf8');
const matches=[...css.matchAll(/\.country-flag-([a-z]{2})\{background-image:url\("data:image\/svg\+xml;base64,([^"\)]+)"\);?\}/g)];
if(!matches.length) {console.log('Flags already packed.');process.exit(0);}
const index={},chunks=[];let offset=0;
for(const [,code,base64] of matches) {
  const svg=Buffer.from(base64,'base64'),compressed=zlib.gzipSync(svg,{level:9});
  index[code]={offset,length:compressed.length,hash:crypto.createHash('sha256').update(svg).digest('hex').slice(0,16)};
  chunks.push(compressed);offset+=compressed.length;
}
fs.writeFileSync(path.join(root,'flags.pack'),Buffer.concat(chunks));
fs.writeFileSync(path.join(root,'flags-index.json'),JSON.stringify(index));
fs.writeFileSync(path.join(root,'flags.css'),'/* flag-icons 7.5.0 — MIT, see flags-LICENSE.txt. Offline flags. */\n'+Object.entries(index).map(([code,e])=>`.country-flag-${code}{background-image:url("flags/${code}.svg?v=${e.hash}")}`).join('\n'));
console.log(JSON.stringify({flags:matches.length,packedBytes:offset}));
