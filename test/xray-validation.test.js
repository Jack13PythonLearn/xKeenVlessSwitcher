const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validationEnvironment, validateXrayFiles } = require('../lib/xray-validation');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xray-assets-test-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const configs=path.join(root,'configs'), dat=path.join(root,'dat');
  fs.mkdirSync(configs);fs.mkdirSync(dat);
  fs.writeFileSync(path.join(dat,'geoip.dat'),'test asset');
  const target=path.join(configs,'04_outbounds.json');
  fs.writeFileSync(target,'old outbound');
  fs.writeFileSync(path.join(configs,'03_inbounds.json'),'unchanged inbound');
  return {root, configs, dat, target};
}

test('validator finds the installed sibling dat directory and preserves environment variables', t => {
  const f=fixture(t), env={PATH:'test-path'};
  assert.deepEqual(validationEnvironment([f.target],env), {...env,XRAY_LOCATION_ASSET:f.dat});
  assert.deepEqual(env,{PATH:'test-path'});
});

test('explicit geodata environment takes precedence, including a missing custom path', t => {
  const f=fixture(t),env={XRAY_LOCATION_ASSET:path.join(f.root,'custom'),PATH:'test'};
  assert.deepEqual(validationEnvironment([f.target],env),env);
});

test('validation subprocess receives geodata and a private config copy; active files stay unchanged', async t => {
  const f=fixture(t);let temporary;
  await validateXrayFiles([{path:f.target,content:'candidate outbound'}],'xray',{env:{PATH:'test'},execute(binary,args,options,done){
    temporary=args[3];assert.equal(binary,'xray');assert.deepEqual(args.slice(0,3),['run','-test','-confdir']);
    assert.equal(fs.readFileSync(path.join(options.env.XRAY_LOCATION_ASSET,'geoip.dat'),'utf8'),'test asset');
    assert.equal(fs.readFileSync(path.join(temporary,'04_outbounds.json'),'utf8'),'candidate outbound');
    assert.equal(fs.readFileSync(path.join(temporary,'03_inbounds.json'),'utf8'),'unchanged inbound');
    done(null);
  }});
  assert.equal(fs.existsSync(temporary),false);
  assert.equal(fs.readFileSync(f.target,'utf8'),'old outbound');
});

test('failed validation cleans temporary files and leaves active configuration untouched', async t => {
  const f=fixture(t);let temporary;
  await assert.rejects(validateXrayFiles([{path:f.target,content:'bad candidate'}],'xray',{env:{},execute(binary,args,options,done){temporary=args[3];done(new Error('invalid'));}}),/Xray отклонил/);
  assert.equal(fs.existsSync(temporary),false);
  assert.equal(fs.readFileSync(f.target,'utf8'),'old outbound');
});
