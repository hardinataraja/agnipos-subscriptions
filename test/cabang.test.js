'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { setup, call } = require('./helpers');

const PRO = { plan: 'pro', status: 'active', billing: 'monthly', expiredAt: new Date('2027-01-01T00:00:00Z') };
function seed(ctx, { stores = ['s1'], pro = [], owner = 'u1' } = {}) {
  for (const id of stores) {
    ctx.db.docs.set(`stores/${id}`, { namaToko: `Toko ${id}`, ownerUid: owner, alamat: '', telepon: '', logoUrl: null });
    if (id === 's1') { /* staff s1/u1 sudah ada dari helper */ }
  }
  for (const id of pro) ctx.db.docs.set(`stores/${id}/subscription/data`, PRO);
}
const create = (ctx, token, nama) => call(ctx.h.cabangCreate, { token, body: { nama } });
const storeCount = (ctx, owner = 'u1') => [...ctx.db.docs.entries()].filter(([k, v]) => /^stores\/[^/]+$/.test(k) && v.ownerUid === owner).length;

test('cabang: tanpa login 401; metode salah 405', async () => {
  const ctx = setup(); seed(ctx, { pro: ['s1'] });
  assert.strictEqual((await call(ctx.h.cabangCreate, { body: { nama: 'Cabang B' } })).code, 401);
  assert.strictEqual((await call(ctx.h.cabangCreate, { method: 'GET', token: 'u1' })).code, 405);
});
test('cabang: bukan pemilik toko -> 403 not_owner', async () => {
  const ctx = setup(); seed(ctx, { pro: ['s1'] });
  const r = await create(ctx, 'k1', 'Cabang B');
  assert.strictEqual(r.code, 403); assert.strictEqual(r.body.error, 'not_owner');
});
test('cabang: pemilik Free ditolak (pro_required), tidak ada toko baru', async () => {
  const ctx = setup(); seed(ctx);
  const r = await create(ctx, 'u1', 'Cabang B');
  assert.strictEqual(r.code, 403); assert.strictEqual(r.body.error, 'pro_required');
  assert.strictEqual(storeCount(ctx), 1);
});
test('cabang: Pro kedaluwarsa ditolak; Pro non-aktif (status expired) ditolak', async () => {
  const ctx = setup(); seed(ctx);
  ctx.db.docs.set('stores/s1/subscription/data', { ...PRO, expiredAt: new Date('2026-11-01T00:00:00Z') });
  assert.strictEqual((await create(ctx, 'u1', 'Cabang B')).body.error, 'pro_required');
  ctx.db.docs.set('stores/s1/subscription/data', { ...PRO, status: 'expired' });
  assert.strictEqual((await create(ctx, 'u1', 'Cabang B')).body.error, 'pro_required');
});
test('cabang: pemilik Pro berhasil; dokumen toko & staf sesuai bentuk registrasi; cabang baru Free', async () => {
  const ctx = setup(); seed(ctx, { pro: ['s1'] });
  const r = await create(ctx, 'u1', '  Cabang   Mojosari  ');
  assert.strictEqual(r.code, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.nama, 'Cabang Mojosari'); assert.strictEqual(r.body.total, 2); assert.strictEqual(r.body.maxBranches, 5);
  const store = ctx.db.docs.get(`stores/${r.body.storeId}`);
  assert.deepStrictEqual(Object.keys(store).sort(), ['alamat', 'createdAt', 'logoUrl', 'namaToko', 'ownerUid', 'telepon']);
  assert.strictEqual(store.ownerUid, 'u1'); assert.strictEqual(store.namaToko, 'Cabang Mojosari');
  const staff = ctx.db.docs.get(`stores/${r.body.storeId}/staff/u1`);
  assert.strictEqual(staff.role, 'admin'); assert.strictEqual(staff.aktif, true); assert.strictEqual(staff.uid, 'u1');
  assert.strictEqual(staff.nama, 'Owner 1');                      // diambil dari dokumen staf yang ada
  assert.ok(!ctx.db.docs.has(`stores/${r.body.storeId}/subscription/data`));   // mulai Free
});
test('cabang: "salah satu cabang Pro" cukup (cabang yang dipakai Free, cabang lain Pro)', async () => {
  const ctx = setup(); seed(ctx, { stores: ['s1', 'sB'], pro: ['sB'] });
  assert.strictEqual((await create(ctx, 'u1', 'Cabang C')).code, 201);
});
test('cabang: batas total 5 (4 -> boleh jadi 5, 5 -> 409)', async () => {
  const ctx = setup(); seed(ctx, { stores: ['s1', 'sB', 'sC', 'sD'], pro: ['s1'] });
  const ok = await create(ctx, 'u1', 'Cabang kelima');
  assert.strictEqual(ok.code, 201); assert.strictEqual(ok.body.total, 5);
  const no = await create(ctx, 'u1', 'Cabang keenam');
  assert.strictEqual(no.code, 409); assert.strictEqual(no.body.error, 'branch_limit');
  assert.strictEqual(storeCount(ctx), 5);
});
test('cabang: permintaan paralel tidak melewati batas 5', async () => {
  const ctx = setup(); seed(ctx, { stores: ['s1', 'sB', 'sC', 'sD'], pro: ['s1'] });
  const rs = await Promise.all([1, 2, 3].map((i) => create(ctx, 'u1', `Paralel ${i}`)));
  assert.strictEqual(rs.filter((r) => r.code === 201).length, 1);
  assert.strictEqual(storeCount(ctx), 5);
});
test('cabang: validasi nama (kosong, 1 karakter, 61 karakter) -> 400', async () => {
  const ctx = setup(); seed(ctx, { pro: ['s1'] });
  for (const n of ['', ' ', 'A', 'x'.repeat(61), undefined]) assert.strictEqual((await create(ctx, 'u1', n)).code, 400, String(n));
  assert.strictEqual(storeCount(ctx), 1);
});
test('cabang: pemilik lain tidak terpengaruh (isolasi per pemilik)', async () => {
  const ctx = setup(); seed(ctx, { pro: ['s1'] });
  ctx.db.docs.set('stores/s2', { namaToko: 'Toko 2', ownerUid: 'u2' });
  assert.strictEqual((await create(ctx, 'u2', 'Cabang Z')).body.error, 'pro_required');   // Pro milik u1 tidak menular
  assert.strictEqual(storeCount(ctx, 'u2'), 1);
});
test('cabang: rate limit 5 permintaan per jam', async () => {
  const ctx = setup(); seed(ctx);
  let last;
  for (let i = 0; i < 6; i++) last = await create(ctx, 'u1', 'x');   // 400 tetap dihitung
  assert.strictEqual(last.code, 429);
});
