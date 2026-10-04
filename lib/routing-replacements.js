'use strict';

// A user profile may replace the built-in Russian bypass profile after merging.
// Keep this explicit so unrelated custom profiles never hide a system preset.
function applyRoutingReplacements(data) {
  const target = data.routings.find(r => !r.isSystem && r.id !== 'routing_except_ru' &&
    r.replacesSystemRouting === 'routing_except_ru');
  if (!target) return data;
  data.routings = data.routings.filter(r => r.id !== 'routing_except_ru');
  for (const item of [...(data.connections || []), ...(data.subscriptions || [])]) {
    if (item.routingId === 'routing_except_ru') item.routingId = target.id;
  }
  return data;
}

module.exports = { applyRoutingReplacements };
