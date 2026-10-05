'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

function validationEnvironment(configPaths, env = process.env) {
  if (env.XRAY_LOCATION_ASSET) return { ...env };
  const parents = [...new Set(configPaths.map(file => path.dirname(file)))];
  const candidates = [...parents.flatMap(dir => [path.join(dir, 'dat'), path.join(path.dirname(dir), 'dat')]),
    '/opt/etc/xray/dat', '/opt/share/xray', '/usr/local/share/xray', '/usr/share/xray'];
  const assets = candidates.find(dir => {
    try { return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).some(name => name.endsWith('.dat')); }
    catch { return false; }
  });
  return assets ? { ...env, XRAY_LOCATION_ASSET: assets } : { ...env };
}

// Validate a private copy with the same geodata directory as the installed Xray.
// Neither the active configuration files nor the running service are changed.
async function validateXrayFiles(files, binary, { env = process.env, execute = execFile } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xkeen-validate-'));
  try {
    const parents = [...new Set(files.map(file => path.dirname(file.path)))];
    for (const parent of parents) if (fs.existsSync(parent)) {
      for (const name of fs.readdirSync(parent).filter(name => name.endsWith('.json'))) {
        const dest = path.join(dir, name);
        fs.copyFileSync(path.join(parent, name), dest);
        fs.chmodSync(dest, 0o600);
      }
    }
    for (const file of files) fs.writeFileSync(path.join(dir, path.basename(file.path)), file.content, { mode: 0o600 });
    await new Promise((resolve, reject) => execute(binary, ['run', '-test', '-confdir', dir], {
      timeout: 10000,
      env: validationEnvironment(files.map(file => file.path), env)
    }, error => error ? reject(Error('Xray отклонил конфигурацию.')) : resolve()));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { validationEnvironment, validateXrayFiles };
