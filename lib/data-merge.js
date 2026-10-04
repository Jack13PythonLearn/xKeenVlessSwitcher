'use strict';

// Apply only changes made since a request loaded its snapshot. Slow ping/GeoIP
// requests must not overwrite subscription imports or resurrect deleted servers.
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function mergeChanges(base, next, current) {
  if (equal(base, next)) return current;
  if (Array.isArray(base) && Array.isArray(next) && Array.isArray(current) &&
      [...base, ...next, ...current].every(x => object(x) && typeof x.id === 'string')) {
    const oldMap = new Map(base.map(x => [x.id, x]));
    const newMap = new Map(next.map(x => [x.id, x]));
    const result = current.filter(x => !oldMap.has(x.id) || newMap.has(x.id)).map(x =>
      oldMap.has(x.id) && newMap.has(x.id) ? mergeChanges(oldMap.get(x.id), newMap.get(x.id), x) : x);
    const ids = new Set(result.map(x => x.id));
    for (const item of next) if (!oldMap.has(item.id) && !ids.has(item.id)) { result.push(item); ids.add(item.id); }
    return result;
  }
  if (object(base) && object(next) && object(current)) {
    const result = { ...current };
    for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
      if (equal(base[key], next[key])) continue;
      if (!(key in next)) delete result[key];
      else result[key] = mergeChanges(base[key], next[key], current[key]);
    }
    return result;
  }
  return next;
}
module.exports = { mergeChanges };
