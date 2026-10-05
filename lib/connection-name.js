'use strict';

// Early installations imported the active outbound under a placeholder name.
// Only that legacy record may inherit a subscription name; keep user names.
function connectionName(conn) {
  if (/^conn_default_/.test(conn.id || '') && /^default$/i.test(conn.name || '') &&
      conn.subscriptionId && typeof conn.subscriptionName === 'string' && conn.subscriptionName.trim()) {
    return conn.subscriptionName.trim();
  }
  return conn.name;
}

module.exports = { connectionName };
