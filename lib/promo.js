'use strict';
const crypto = require('crypto');
const { requireEnv, PROMO_MONTHS } = require('./config');
const { toDate } = require('./util');
const { subRef, computeNewExpiry, isActive } = require('./subscription');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // tanpa I L O 0 1
const BODY_LEN = 12;

function randomBody() {
  let s = '';
  for (let i = 0; i < BODY_LEN; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
const format = (b) => `AGNI-${b.slice(0, 4)}-${b.slice(4, 8)}-${b.slice(8, 12)}`;

// Huruf besar/kecil, spasi, dan tanda hubung diabaikan.
function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const c = input.toUpperCase().replace(/[\s\-_]/g, '');
  if (!c.startsWith('AGNI')) return null;
  const body = c.slice(4);
  if (body.length !== BODY_LEN) return null;
  for (const ch of body) if (!ALPHABET.includes(ch)) return null;
  return format(body);
}
function generateCodes(n) {
  const set = new Set();
  while (set.size < n) set.add(format(randomBody()));
  return [...set];
}
const hmacKey = () => requireEnv('PROMO_HMAC_SECRET');
const codeId = (canonical) => crypto.createHmac('sha256', hmacKey()).update(canonical).digest('hex');
const encKey = () => {
  const k = requireEnv('PROMO_ENC_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error('PROMO_ENC_KEY harus 64 karakter hex (32 byte)');
  return Buffer.from(k, 'hex');
};
// Enkripsi AES-256-GCM agar admin bisa mengekspor ulang kode (hash saja tidak bisa dipulihkan).
function encryptCode(code) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(code, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}
function decryptCode(blob) {
  const [iv, tag, ct] = blob.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

async function createCampaign(db, FieldValue, { campaignId, name, validUntil, adminUid, count, now }) {
  const codes = generateCodes(count);
  const campRef = db.collection('promoCampaigns').doc(campaignId);
  const batch = db.batch();
  batch.create(campRef, { name, status: 'active', totalCodes: count, redeemedCount: 0, durationMonths: PROMO_MONTHS,
    validFrom: now, validUntil, createdBy: adminUid, createdAt: FieldValue.serverTimestamp() });
  for (const code of codes) {
    batch.create(db.collection('promoCodes').doc(codeId(code)), {
      campaignId, codeEnc: encryptCode(code), status: 'unused', durationMonths: PROMO_MONTHS,
      createdAt: FieldValue.serverTimestamp(), redeemedAt: null, redeemedByUid: null, redeemedStoreId: null });
  }
  await batch.commit(); // gagal = tidak ada yang tertulis (campaignId sudah ada -> ALREADY_EXISTS)
  return codes.length;
}

// Penukaran atomik: kode, kampanye, redemption per-toko, dan subscription dalam SATU transaksi.
async function redeem(db, FieldValue, { code, uid, storeId, now }) {
  const canonical = normalizeCode(code);
  if (!canonical) return { ok: false, error: 'invalid_code' };
  const cRef = db.collection('promoCodes').doc(codeId(canonical));
  return db.runTransaction(async (tx) => {
    const cSnap = await tx.get(cRef);
    if (!cSnap.exists) return { ok: false, error: 'invalid_code' };
    const c = cSnap.data();
    const campRef = db.collection('promoCampaigns').doc(c.campaignId);
    const redRef = db.collection('promoRedemptions').doc(`${c.campaignId}__${storeId}`);
    const [campSnap, redSnap, sSnap] = await Promise.all([tx.get(campRef), tx.get(redRef), tx.get(subRef(db, storeId))]);
    if (c.status === 'redeemed') return { ok: false, error: 'code_used' };
    if (c.status !== 'unused' || !campSnap.exists || campSnap.data().status !== 'active') return { ok: false, error: 'campaign_inactive' };
    const camp = campSnap.data();
    const until = toDate(camp.validUntil);
    if (until && until.getTime() <= now.getTime()) return { ok: false, error: 'code_expired' };
    if (redSnap.exists) return { ok: false, error: 'already_redeemed_campaign' };

    const cur = sSnap.exists ? sSnap.data() : null;
    const expiry = computeNewExpiry(cur, now, c.durationMonths || PROMO_MONTHS);
    const wasActive = isActive(cur, now);
    tx.update(cRef, { status: 'redeemed', redeemedAt: now, redeemedByUid: uid, redeemedStoreId: storeId });
    tx.create(redRef, { campaignId: c.campaignId, codeId: cRef.id, uid, storeId, redeemedAt: now, grantedUntil: expiry });
    tx.update(campRef, { redeemedCount: (camp.redeemedCount || 0) + 1 });
    tx.set(subRef(db, storeId), {
      plan: 'pro', billing: 'promo', status: 'active', expiredAt: expiry,
      startedAt: wasActive ? cur.startedAt : now, orderId: null, source: 'promo', promoCampaignId: c.campaignId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ok: true, expiredAt: expiry };
  });
}

module.exports = { normalizeCode, generateCodes, codeId, encryptCode, decryptCode, createCampaign, redeem, ALPHABET };
