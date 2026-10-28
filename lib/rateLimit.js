'use strict';
const { sha256Hex, HttpError } = require('./util');
// Pembatas berbasis Firestore (state in-memory tidak andal di serverless).
async function rateLimit(db, key, limit, windowMs, now) {
  const ref = db.collection('rateLimits').doc(sha256Hex(key));
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = s.exists ? s.data() : null;
    const fresh = !d || now.getTime() - d.windowStart >= windowMs;
    const count = fresh ? 1 : d.count + 1;
    if (!fresh && count > limit) throw new HttpError(429, 'rate_limited', 'Terlalu banyak permintaan. Coba lagi nanti.');
    tx.set(ref, { count, windowStart: fresh ? now.getTime() : d.windowStart });
  });
}
module.exports = { rateLimit };
