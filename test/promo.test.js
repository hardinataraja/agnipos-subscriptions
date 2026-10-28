'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { setup, call } = require('./helpers');
const promo = require('../lib/promo');

const FUTURE = '2027-06-01T00:00:00Z';
async function makeCampaign(ctx, id = 'komunitas-1') {
  const r = await call(ctx.h.adminCreateCampaign, { token: 'admin-uid', body: { campaignId: id, name: 'Komunitas', validUntil: FUTURE } });
  assert.strictEqual(r.code, 201, JSON.stringify(r.body));
  return r;
}
async function codes(ctx, id = 'komunitas-1') {
  const r = await call(ctx.h.adminPromoList, { method: 'GET', token: 'admin-uid', query: { campaignId: id } });
  return r.body.codes.map((c) => c.code);
}

test('generator: tepat 200 kode unik, format benar, tidak berurutan', () => {
  const c = promo.generateCodes(200);
  assert.strictEqual(c.length, 200);
  assert.strictEqual(new Set(c).size, 200);
  for (const x of c) assert.match(x, /^AGNI-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
});
test('normalisasi: huruf kecil, spasi, tanpa strip', () => {
  assert.strictEqual(promo.normalizeCode('  agni abcd-efgh jkmn '), 'AGNI-ABCD-EFGH-JKMN');
  assert.strictEqual(promo.normalizeCode('AGNI001'), null);
  assert.strictEqual(promo.normalizeCode(123), null);
});
test('enkripsi kode bisa dipulihkan; id dokumen adalah HMAC (bukan kode asli)', () => {
  const c = 'AGNI-ABCD-EFGH-JKMN';
  assert.strictEqual(promo.decryptCode(promo.encryptCode(c)), c);
  assert.ok(!promo.codeId(c).includes('ABCD'));
});
test('kampanye membuat tepat 200 kode; jumlah lain ditolak; id ganda ditolak', async () => {
  const ctx = setup();
  await makeCampaign(ctx);
  assert.strictEqual([...ctx.db.docs.keys()].filter((k) => k.startsWith('promoCodes/')).length, 200);
  assert.strictEqual((await codes(ctx)).length, 200);
  const bad = await call(ctx.h.adminCreateCampaign, { token: 'admin-uid', body: { campaignId: 'x-100', name: 'x', validUntil: FUTURE, count: 100 } });
  assert.strictEqual(bad.code, 400);
  const dup = await call(ctx.h.adminCreateCampaign, { token: 'admin-uid', body: { campaignId: 'komunitas-1', name: 'x', validUntil: FUTURE } });
  assert.strictEqual(dup.code, 409);
});
test('kode plaintext tidak tersimpan di Firestore', async () => {
  const ctx = setup(); await makeCampaign(ctx);
  const [one] = await codes(ctx);
  assert.ok(!JSON.stringify([...ctx.db.docs.entries()]).includes(one));
});
test('penukaran valid memberi Pro 2 bulan kalender dari sekarang', async () => {
  const ctx = setup(); await makeCampaign(ctx);
  const [code] = await codes(ctx);
  const r = await call(ctx.h.redeemPromo, { token: 'u1', body: { code: code.toLowerCase().replace(/-/g, ' ') } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.expiredAt, '2027-01-10T03:00:00.000Z');
  assert.strictEqual(r.body.subscription.status, 'active');
  const sub = ctx.db.docs.get('stores/s1/subscription/data');
  assert.strictEqual(sub.source, 'promo');
});
test('kode tidak valid ditolak; kode yang sudah dipakai ditolak', async () => {
  const ctx = setup(); await makeCampaign(ctx);
  const [code] = await codes(ctx);
  assert.strictEqual((await call(ctx.h.redeemPromo, { token: 'u1', body: { code: 'AGNI-AAAA-BBBB-CCCC' } })).code, 404);
  assert.strictEqual((await call(ctx.h.redeemPromo, { token: 'u1', body: { code: 'ngawur' } })).code, 404);
  assert.strictEqual((await call(ctx.h.redeemPromo, { token: 'u1', body: { code } })).code, 200);
  const again = await call(ctx.h.redeemPromo, { token: 'u2', body: { code } });
  assert.strictEqual(again.code, 409); assert.strictEqual(again.body.error, 'code_used');
});
test('dua request paralel dengan kode sama: hanya satu berhasil', async () => {
  const ctx = setup(); await makeCampaign(ctx);
  const [code] = await codes(ctx);
  const rs = await Promise.all([
    call(ctx.h.redeemPromo, { token: 'u1', body: { code } }),
    call(ctx.h.redeemPromo, { token: 'u2', body: { code } }),
    call(ctx.h.redeemPromo, { token: 'u1', body: { code } }),
  ]);
  assert.strictEqual(rs.filter((r) => r.code === 200).length, 1);
  const camp = ctx.db.docs.get('promoCampaigns/komunitas-1');
  assert.strictEqual(camp.redeemedCount, 1);
});
test('satu toko tidak bisa menukar dua kode dari kampanye yang sama', async () => {
  const ctx = setup(); await makeCampaign(ctx);
  const [a, b] = await codes(ctx);
  assert.strictEqual((await call(ctx.h.redeemPromo, { token: 'u1', body: { code: a } })).code, 200);
  const r = await call(ctx.h.redeemPromo, { token: 'u1', body: { code: b } });
  assert.strictEqual(r.body.error, 'already_redeemed_campaign');
  assert.strictEqual(ctx.db.docs.get(`promoCodes/${promo.codeId(b)}`).status, 'unused');
});
test('promo menambah dari expiredAt Pro aktif (tidak mengurangi sisa masa aktif)', async () => {
  const ctx = setup(); await makeCampaign(ctx);
  ctx.db.docs.set('stores/s1/subscription/data', { plan: 'pro', status: 'active', billing: 'yearly', expiredAt: new Date('2027-09-15T03:00:00Z'), startedAt: new Date('2026-09-15T03:00:00Z') });
  const [code] = await codes(ctx);
  const r = await call(ctx.h.redeemPromo, { token: 'u1', body: { code } });
  assert.strictEqual(r.body.expiredAt, '2027-11-15T03:00:00.000Z');
  assert.strictEqual(ctx.db.docs.get('stores/s1/subscription/data').startedAt.toISOString(), '2026-09-15T03:00:00.000Z');
});
test('Pro kedaluwarsa: promo mulai dari waktu aktivasi', async () => {
  const ctx = setup(); await makeCampaign(ctx);
  ctx.db.docs.set('stores/s1/subscription/data', { plan: 'pro', status: 'active', expiredAt: new Date('2026-10-01T00:00:00Z') });
  const [code] = await codes(ctx);
  assert.strictEqual((await call(ctx.h.redeemPromo, { token: 'u1', body: { code } })).body.expiredAt, '2027-01-10T03:00:00.000Z');
});
test('kampanye dinonaktifkan tidak menerima penukaran; kampanye lewat tanggal ditolak', async () => {
  const ctx = setup(); await makeCampaign(ctx);
  const [code] = await codes(ctx);
  assert.strictEqual((await call(ctx.h.adminDisableCampaign, { token: 'admin-uid', body: { campaignId: 'komunitas-1' } })).code, 200);
  assert.strictEqual((await call(ctx.h.redeemPromo, { token: 'u1', body: { code } })).body.error, 'campaign_inactive');
  const ctx2 = setup(); await makeCampaign(ctx2);
  const [c2] = await codes(ctx2);
  ctx2.clock.t = new Date('2027-07-01T00:00:00Z');
  assert.strictEqual((await call(ctx2.h.redeemPromo, { token: 'u1', body: { code: c2 } })).body.error, 'code_expired');
});
test('kasir (bukan admin toko) tidak boleh menukar; tanpa login ditolak', async () => {
  const ctx = setup(); await makeCampaign(ctx);
  const [code] = await codes(ctx);
  assert.strictEqual((await call(ctx.h.redeemPromo, { token: 'k1', body: { code } })).code, 403);
  assert.strictEqual((await call(ctx.h.redeemPromo, { body: { code } })).code, 401);
});
test('admin endpoint menolak non-admin dan tanpa token; CSV hanya untuk admin', async () => {
  const ctx = setup(); await makeCampaign(ctx);
  assert.strictEqual((await call(ctx.h.adminCreateCampaign, { token: 'u1', body: { campaignId: 'abc-1', name: 'x', validUntil: FUTURE } })).code, 403);
  assert.strictEqual((await call(ctx.h.adminPromoList, { method: 'GET', token: 'u1', query: { campaignId: 'komunitas-1', format: 'csv' } })).code, 403);
  assert.strictEqual((await call(ctx.h.adminPromoList, { method: 'GET', query: {} })).code, 401);
  assert.strictEqual((await call(ctx.h.adminDisableCampaign, { token: 'u1', body: { campaignId: 'komunitas-1' } })).code, 403);
  const csv = await call(ctx.h.adminPromoList, { method: 'GET', token: 'admin-uid', query: { campaignId: 'komunitas-1', format: 'csv' } });
  assert.strictEqual(csv.code, 200);
  assert.strictEqual(csv.body.trim().split('\n').length, 201); // header + 200
});
test('rate limit penukaran: percobaan ke-11 dalam 15 menit ditolak', async () => {
  const ctx = setup();
  let last;
  for (let i = 0; i < 11; i++) last = await call(ctx.h.redeemPromo, { token: 'u1', body: { code: 'AGNI-AAAA-BBBB-CCCC' } });
  assert.strictEqual(last.code, 429);
});
