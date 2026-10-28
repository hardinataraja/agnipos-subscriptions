'use strict';
const crypto = require('crypto');
const sha256Hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const toDate = (v) => (!v ? null : typeof v.toDate === 'function' ? v.toDate() : v instanceof Date ? v : new Date(v));
const iso = (v) => { const d = toDate(v); return d && !isNaN(d) ? d.toISOString() : null; };
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8'), y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
module.exports = { sha256Hex, toDate, iso, safeEqualHex, HttpError };
