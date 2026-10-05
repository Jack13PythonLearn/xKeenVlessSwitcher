'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
function build(root) {
  const files=['server.js','package.json'];
  function walk(relative) {
    for(const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true})) {
      if(entry.isSymbolicLink()) throw Error('Symlinks are not allowed in the runtime');
      const name=relative+'/'+entry.name;
      if(entry.isDirectory()) walk(name);else if(entry.isFile()) files.push(name);
    }
  }
  walk('lib');walk('public');files.sort();
  const chunks=[];let total=0;
  for(const name of files) {
    const content=fs.readFileSync(path.join(root,name)),header=Buffer.alloc(512),target='app/'+name;
    if(Buffer.byteLength(target)>100) throw Error('Tar path too long');
    header.write(target);header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116);
    header.write(content.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);
    header.fill(32,148,156);header.write('0',156);header.write('ustar\0',257);header.write('00',263);
    const checksum=header.reduce((sum,n)=>sum+n,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);
    chunks.push(header,content,Buffer.alloc((512-content.length%512)%512));total+=content.length;
  }
  chunks.push(Buffer.alloc(1024));
  const archive=zlib.gzipSync(Buffer.concat(chunks),{level:9});
  const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});
  fs.writeFileSync(path.join(dist,'runtime.tar.gz'),archive);
  fs.writeFileSync(path.join(dist,'runtime.sha256'),crypto.createHash('sha256').update(archive).digest('hex')+'\n');
  fs.writeFileSync(path.join(dist,'runtime-size.txt'),String(total)+'\n');
  return {files:files.length,runtimeBytes:total,archiveBytes:archive.length};
}
if(require.main===module) console.log(JSON.stringify(build(path.join(__dirname,'..'))));
module.exports={build};
