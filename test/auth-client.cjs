// Test-only HTTP client: read the key of the isolated fixture, never router credentials.
const fs=require('node:fs'),path=require('node:path');
const original=global.fetch;
global.fetch=(url,options={})=>{
  if(process.env.XKEEN_DATA_DIR && /^http:\/\/127\.0\.0\.1:\d+\//.test(String(url))) {
    const key=path.join(process.env.XKEEN_DATA_DIR,'admin-key');
    if(fs.existsSync(key)) options={...options,headers:{...options.headers,Authorization:'Bearer '+fs.readFileSync(key,'utf8').trim()}};
  }
  return original(url,options);
};
