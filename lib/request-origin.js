'use strict';
const net=require('node:net');
const os=require('node:os');

// Reject cross-site browser requests without requiring a login for LAN clients.
function trustedOrigin(req) {
  try {
    const host=new URL('http://'+req.headers.host).hostname.replace(/^\[|\]$/g,'').toLowerCase();
    const allowedHosts=(process.env.XKEEN_ALLOWED_HOSTS||'').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean);
    if(!net.isIP(host) && !['localhost',os.hostname().toLowerCase(),...allowedHosts].includes(host)) return false;
    if(!req.headers.origin) return true;
    const origin=new URL(req.headers.origin);
    return ['http:','https:'].includes(origin.protocol) && origin.host===req.headers.host;
  } catch {return false;}
}
module.exports={trustedOrigin};
