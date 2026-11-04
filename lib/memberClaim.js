'use strict';
// Pengambilan kode promo oleh member komunitas (opsi B): satu toko = satu kode per kampanye.
const crypto = require('crypto');
const { HttpError, iso, toDate } = require('./util');
const { decryptCode } = require('./promo');

const SCRYPT = { N: 16384 };
// Huruf besar/kecil dan spasi tepi diabaikan agar member tidak gagal karena salah ketik.
const norm = (p) => String(p || '').trim().toLowerCase();

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(norm(password), salt, 32, SCRYPT);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}
function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const got = crypto.scryptSync(norm(password), Buffer.from(rec.salt, 'base64'), 32, SCRYPT);
  const exp = Buffer.from(rec.hash, 'base64');
  return exp.length === got.length && crypto.timingSafeEqual(exp, got);
}

// Cari kampanye yang dibuka untuk member dan cocok dengan password. Password mengidentifikasi kampanye.
async function findCampaignByPassword(db, password, now) {
  const snap = await db.collection('promoCampaigns').where('memberClaim.enabled', '==', true).get();
  let found = null;
  for (const d of snap.docs) {
    const c = d.data();
    const until = toDate(c.validUntil);
    const open = c.status === 'active' && (!until || until.getTime() > now.getTime());
    // Semua kandidat tetap diverifikasi agar waktu respons tidak membocorkan kecocokan.
    const ok = verifyPassword(password, c.memberClaim);
    if (ok && open && !found) found = { id: d.id, ...c };
  }
  return found;
}

function view(campId, camp, code, claim, claimedCount, now = new Date()) {
  const until = toDate(camp.validUntil);
  return {
    campaignId: campId,
    campaign: camp.name,
    code: decryptCode(code.codeEnc),
    status: code.status === 'redeemed' ? 'redeemed' : 'unused',
    claimedAt: iso(claim.claimedAt),
    validUntil: iso(camp.validUntil),
    campaignActive: camp.status === 'active' && (!until || until.getTime() > now.getTime()),
    total: camp.totalCodes,
    remaining: Math.max(0, (camp.totalCodes || 0) - (claimedCount || 0)),
  };
}

// Ambil (atau tampilkan kembali) kode milik toko ini. Atomik; permintaan paralel tidak mendapat kode yang sama.
async function claim(db, { campaignId, uid, storeId, now }) {
  const campRef = db.collection('promoCampaigns').doc(campaignId);
  const claimRef = db.collection('promoClaims').doc(`${campaignId}__${storeId}`);
  return db.runTransaction(async (tx) => {
    const [campSnap, claimSnap] = await Promise.all([tx.get(campRef), tx.get(claimRef)]);
    if (!campSnap.exists) throw new HttpError(403, 'invalid_password', 'Password tidak valid atau kampanye belum dibuka.');
    const camp = campSnap.data();
    if (claimSnap.exists) {
      const cl = claimSnap.data();
      const codeSnap = await tx.get(db.collection('promoCodes').doc(cl.codeId));
      return { existing: true, ...view(campaignId, camp, codeSnap.data(), cl, camp.claimedCount, now) };
    }
    const until = toDate(camp.validUntil);
    if (camp.status !== 'active' || !camp.memberClaim || camp.memberClaim.enabled !== true || (until && until.getTime() <= now.getTime())) {
      throw new HttpError(403, 'invalid_password', 'Password tidak valid atau kampanye belum dibuka.');
    }
    const q = await tx.get(db.collection('promoCodes').where('campaignId', '==', campaignId).where('status', '==', 'unused'));
    const free = q.docs.filter((d) => !d.data().claimedByUid);
    if (!free.length) throw new HttpError(409, 'sold_out', 'Kode promo sudah habis diambil.');
    const pick = free[crypto.randomInt(free.length)];
    const rec = { campaignId, codeId: pick.id, uid, storeId, claimedAt: now };
    tx.update(pick.ref, { claimedByUid: uid, claimedStoreId: storeId, claimedAt: now });
    tx.create(claimRef, rec);
    const count = (camp.claimedCount || 0) + 1;
    tx.update(campRef, { claimedCount: count });
    return { existing: false, ...view(campaignId, camp, pick.data(), rec, count, now) };
  });
}

// Daftar kode yang sudah diambil toko ini (tanpa password).
async function listForStore(db, storeId, now = new Date()) {
  const snap = await db.collection('promoClaims').where('storeId', '==', storeId).get();
  const out = [];
  for (const d of snap.docs) {
    const cl = d.data();
    const [campSnap, codeSnap] = await Promise.all([
      db.collection('promoCampaigns').doc(cl.campaignId).get(),
      db.collection('promoCodes').doc(cl.codeId).get(),
    ]);
    if (!campSnap.exists || !codeSnap.exists) continue;
    const camp = campSnap.data();
    out.push(view(cl.campaignId, camp, codeSnap.data(), cl, camp.claimedCount, now));
  }
  return out.sort((a, b) => String(b.claimedAt).localeCompare(String(a.claimedAt)));
}

module.exports = { hashPassword, verifyPassword, findCampaignByPassword, claim, listForStore };
