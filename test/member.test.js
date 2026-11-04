'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { setup, call } = require('./helpers');
const promo = require('../lib/promo');

const FUTURE = '2027-06-01T00:00:00Z';
const PW = 'KomunitasKu-1';

async function ready(ctx, { open = true } = {}) {
  const r = await call(ctx.h.adminCreateCampaign, { token: 'admin-uid', body: { campaignId: 'komunitas-1', name: 'Komunitas BSS', validUntil: FUTURE } });
  assert.strictEqual(r.code, 201);
  if (open) {
    const e = await call(ctx.h.adminMemberClaim, { token: 'admin-uid', body: { campaignId: 'komunitas-1', enabled: true, password: PW } });
    assert.strictEqual(e.code, 200, JSON.stringify(e.body));
  }
}
const claim = (ctx, token, password) => call(ctx.h.memberClaim, { token, body: password === undefined ? {} : { password } });
function addStore(ctx, n) {
  ctx.db.docs.set(`stores/s${n}/staff/u${n}`, { uid: `u${n}`, role: 'admin', aktif: true, nama: `Owner ${n}`, email: `o${n}@x.id` });
}

test('admin: hanya admin aplikasi; password 8-64 karakter wajib saat membuka; password tidak tersimpan polos', async () => {
  const ctx = setup(); await ready(ctx, { open: false });
  assert.strictEqual((await call(ctx.h.adminMemberClaim, { token: 'u1', body: { campaignId: 'komunitas-1', enabled: true, password: PW } })).code, 403);
  assert.strictEqual((await call(ctx.h.adminMemberClaim, { body: { campaignId: 'komunitas-1', enabled: true, password: PW } })).code, 401);
  assert.strictEqual((await call(ctx.h.adminMemberClaim, { token: 'admin-uid', body: { campaignId: 'komunitas-1', enabled: true } })).code, 400);
  assert.strictEqual((await call(ctx.h.adminMemberClaim, { token: 'admin-uid', body: { campaignId: 'komunitas-1', enabled: true, password: 'pendek' } })).code, 400);
  assert.strictEqual((await call(ctx.h.adminMemberClaim, { token: 'admin-uid', body: { campaignId: 'nope', enabled: true, password: PW } })).code, 404);
  const ok = await call(ctx.h.adminMemberClaim, { token: 'admin-uid', body: { campaignId: 'komunitas-1', enabled: true, password: PW } });
  assert.strictEqual(ok.code, 200);
  assert.ok(!JSON.stringify([...ctx.db.docs.entries()]).includes(PW));
  const camp = ctx.db.docs.get('promoCampaigns/komunitas-1');
  assert.ok(camp.memberClaim.hash && camp.memberClaim.salt);
});

test('claim: tanpa login 401, kasir 403, akun tanpa toko 403', async () => {
  const ctx = setup(); await ready(ctx);
  assert.strictEqual((await call(ctx.h.memberClaim, { body: { password: PW } })).code, 401);
  assert.strictEqual((await claim(ctx, 'k1', PW)).code, 403);
  assert.strictEqual((await claim(ctx, 'orang-luar', PW)).code, 403);
});

test('claim: password salah ditolak dengan pesan umum; kampanye belum dibuka juga ditolak', async () => {
  const ctx = setup(); await ready(ctx);
  const bad = await claim(ctx, 'u1', 'salah-banget');
  assert.strictEqual(bad.code, 403); assert.strictEqual(bad.body.error, 'invalid_password');
  const ctx2 = setup(); await ready(ctx2, { open: false });
  assert.strictEqual((await claim(ctx2, 'u1', PW)).code, 403);
});

test('claim: password benar memberi satu kode valid; huruf besar/kecil dan spasi diabaikan', async () => {
  const ctx = setup(); await ready(ctx);
  const r = await claim(ctx, 'u1', `  ${PW.toLowerCase()} `);
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  const c = r.body.claims[0];
  assert.match(c.code, /^AGNI-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.strictEqual(c.status, 'unused');
  assert.strictEqual(c.campaign, 'Komunitas BSS');
  assert.strictEqual(c.remaining, 199); assert.strictEqual(c.total, 200);
  assert.ok(!JSON.stringify(r.body).includes('u1'));              // tidak membocorkan uid
  assert.ok(ctx.db.docs.has(`promoCodes/${promo.codeId(c.code)}`));
});

test('claim: idempoten per toko (kode yang sama, tidak mengurangi sisa); toko lain dapat kode berbeda', async () => {
  const ctx = setup(); await ready(ctx);
  const a1 = (await claim(ctx, 'u1', PW)).body.claims[0];
  const a2 = (await claim(ctx, 'u1', PW)).body.claims[0];
  assert.strictEqual(a1.code, a2.code); assert.strictEqual(a2.existing, true);
  const b = (await claim(ctx, 'u2', PW)).body.claims[0];
  assert.notStrictEqual(b.code, a1.code);
  assert.strictEqual(b.remaining, 198);
  assert.strictEqual(ctx.db.docs.get('promoCampaigns/komunitas-1').claimedCount, 2);
});

test('claim: 5 toko paralel mendapat 5 kode berbeda; 3 permintaan paralel dari toko sama = 1 klaim', async () => {
  const ctx = setup(); await ready(ctx);
  for (const n of [3, 4, 5]) addStore(ctx, n);
  const rs = await Promise.all(['u1', 'u2', 'u3', 'u4', 'u5'].map((u) => claim(ctx, u, PW)));
  assert.ok(rs.every((r) => r.code === 200));
  assert.strictEqual(new Set(rs.map((r) => r.body.claims[0].code)).size, 5);
  const ctx2 = setup(); await ready(ctx2);
  const same = await Promise.all([1, 2, 3].map(() => claim(ctx2, 'u1', PW)));
  assert.strictEqual(new Set(same.map((r) => r.body.claims[0].code)).size, 1);
  assert.strictEqual(ctx2.db.docs.get('promoCampaigns/komunitas-1').claimedCount, 1);
});

test('claim: kode habis -> 409', async () => {
  const ctx = setup(); await ready(ctx);
  for (const [k, v] of ctx.db.docs) if (k.startsWith('promoCodes/')) ctx.db.docs.set(k, { ...v, claimedByUid: 'x' });
  const r = await claim(ctx, 'u1', PW);
  assert.strictEqual(r.code, 409); assert.strictEqual(r.body.error, 'sold_out');
});

test('claim: kampanye dinonaktifkan atau lewat tanggal tidak bisa klaim baru, tetapi kode yang sudah diambil tetap terlihat', async () => {
  const ctx = setup(); await ready(ctx);
  const mine = (await claim(ctx, 'u1', PW)).body.claims[0];
  await call(ctx.h.adminDisableCampaign, { token: 'admin-uid', body: { campaignId: 'komunitas-1' } });
  assert.strictEqual((await claim(ctx, 'u2', PW)).code, 403);
  const list = await claim(ctx, 'u1');
  assert.strictEqual(list.body.claims[0].code, mine.code);
  assert.strictEqual(list.body.claims[0].campaignActive, false);
  const ctx2 = setup(); await ready(ctx2);
  ctx2.clock.t = new Date('2027-07-01T00:00:00Z');
  assert.strictEqual((await claim(ctx2, 'u1', PW)).code, 403);
});

test('admin mematikan pengambilan: klaim baru ditolak, password lama tidak berlaku', async () => {
  const ctx = setup(); await ready(ctx);
  await call(ctx.h.adminMemberClaim, { token: 'admin-uid', body: { campaignId: 'komunitas-1', enabled: false } });
  assert.strictEqual((await claim(ctx, 'u1', PW)).code, 403);
  assert.ok(!ctx.db.docs.get('promoCampaigns/komunitas-1').memberClaim.hash);
});

test('daftar (tanpa password): milik toko sendiri saja; status berubah menjadi redeemed setelah dipakai', async () => {
  const ctx = setup(); await ready(ctx);
  assert.deepStrictEqual((await claim(ctx, 'u1')).body.claims, []);
  const c = (await claim(ctx, 'u1', PW)).body.claims[0];
  await claim(ctx, 'u2', PW);
  const l1 = (await claim(ctx, 'u1')).body.claims;
  assert.strictEqual(l1.length, 1); assert.strictEqual(l1[0].code, c.code);
  assert.strictEqual((await claim(ctx, 'u2')).body.claims.length, 1);
  const rd = await call(ctx.h.redeemPromo, { token: 'u1', body: { code: c.code } });
  assert.strictEqual(rd.code, 200);                                   // kode hasil klaim bisa ditukar
  assert.strictEqual((await claim(ctx, 'u1')).body.claims[0].status, 'redeemed');
  assert.strictEqual((await claim(ctx, 'k1')).code, 403);
});

test('rate limit: percobaan password ke-11 dalam 15 menit ditolak 429', async () => {
  const ctx = setup(); await ready(ctx);
  let last;
  for (let i = 0; i < 11; i++) last = await claim(ctx, 'u1', `salah-${i}`);
  assert.strictEqual(last.code, 429);
});

test('daftar admin menampilkan jumlah diambil, status klaim, dan info pengambil per kode', async () => {
  const ctx = setup(); await ready(ctx);
  await claim(ctx, 'u1', PW);
  const camps = (await call(ctx.h.adminPromoList, { method: 'GET', token: 'admin-uid', query: {} })).body.campaigns;
  assert.strictEqual(camps[0].claimedCount, 1); assert.strictEqual(camps[0].memberClaimEnabled, true);
  const codes = (await call(ctx.h.adminPromoList, { method: 'GET', token: 'admin-uid', query: { campaignId: 'komunitas-1' } })).body.codes;
  assert.strictEqual(codes.filter((c) => c.claimedStoreId === 's1').length, 1);
  assert.ok(!JSON.stringify(camps).includes('"hash"'));               // hash password tidak ikut keluar
});
