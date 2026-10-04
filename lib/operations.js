'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createQueue() {
  let tail = Promise.resolve();
  return operation => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.new-' + crypto.randomBytes(8).toString('hex');
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

// Call under the common apply queue. Keep old files until restart and persistence succeed.
async function applyFiles({ files, validate = async () => {}, restart = async () => {}, persist = async () => {}, guard = () => {} }) {
  guard();
  if (new Set(files.map(f => path.resolve(f.path))).size !== files.length) throw Error('Пути конфигураций должны различаться.');
  const previous = files.map(f => ({ path: f.path, content: fs.existsSync(f.path) ? fs.readFileSync(f.path) : null }));
  await validate(files);
  guard();
  let changed = false;
  try {
    for (const file of files) { atomicWrite(file.path, file.content); changed = true; }
    await restart();
    guard();
    await persist();
  } catch (error) {
    if (changed) {
      try {
        for (const file of previous) {
          if (file.content !== null) atomicWrite(file.path, file.content);
          else if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        }
        await restart();
      } catch { throw Error('Применение не удалось; откат требует проверки службы.'); }
    }
    throw error;
  }
}
module.exports = { createQueue, atomicWrite, applyFiles };
