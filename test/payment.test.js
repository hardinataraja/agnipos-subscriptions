'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { setup, call, sig } = require('./helpers');

async function order(ctx, planId = 'pro_monthly', token = 'u1') {
  const r = await call(ctx.h.createOrder, { token, body: { planId } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  return r.body;
}
const notif = (o, extra = {}) => {
  const base = { order_id: o.orderId, status_code: '200', gross_amount: `${o.amount}.00`, transaction_status: 'settlement', fraud_status: 'accept', payment_type: 'qris' };
  return { ...base, ...extra };
};
function arm(ctx, o, extra = {}) { ctx.midtrans.statuses[o.orderId] = notif(o, extra); }
const hook = (ctx, o, extra = {}) => { const n = notif(o, extra); return call(ctx.h.webhook, { body: { ...n, signature_key: sig(n.order_id, n.status_code, n.gross_amount) } }); };

test('create-order: harga dari server, bukan klien', async () => {
  const ctx = setup();
  const r = await call(ctx.h.createOrder, { token: 'u1', body: { planId: 'pro_monthly', price: 1, amount: 1, months: 99 } });
  assert.strictEqual(r.body.amount, 19000);
  assert.strictEqual(ctx.midtrans.lastSnap.transaction_details.gross_amount, 19000);
  const y = await order(ctx, 'pro_yearly');
  assert.strictEqual(y.amount, 199000);
});
test('create-order: paket tidak dikenal/dimanipulasi ditolak', async () => {
  const ctx = setup();
  for (const planId of ['pro_free', '', undefined, '__proto__', 'constructor']) {
    assert.strictEqual((await call(ctx.h.createOrder, { token: 'u1', body: { planId } })).code, 400, String(planId));
  }
});
test('create-order: tanpa auth 401, token rusak 401, kasir 403', async () => {
  const ctx = setup();
  assert.strictEqual((await call(ctx.h.createOrder, { body: { planId: 'pro_monthly' } })).code, 401);
  assert.strictEqual((await call(ctx.h.createOrder, { headers: { authorization: 'Bearer palsu' }, body: { planId: 'pro_monthly' } })).code, 401);
  assert.strictEqual((await call(ctx.h.createOrder, { token: 'k1', body: { planId: 'pro_monthly' } })).code, 403);
  assert.strictEqual((await call(ctx.h.createOrder, { token: 'tidak-terdaftar', body: { planId: 'pro_monthly' } })).code, 403);
});
test('create-order: storeId diambil dari sesi, order terikat toko benar; order pending dipakai ulang', async () => {
  const ctx = setup();
  const a = await order(ctx);
  assert.strictEqual(ctx.db.docs.get(`subscriptionOrders/${a.orderId}`).storeId, 's1');
  const again = await call(ctx.h.createOrder, { token: 'u1', body: { planId: 'pro_monthly', storeId: 's2' } });
  assert.strictEqual(again.body.reused, true);
  assert.strictEqual(again.body.orderId, a.orderId);
  assert.strictEqual(ctx.midtrans.snapCalls, 1);
  const other = await order(ctx, 'pro_monthly', 'u2');
  assert.strictEqual(ctx.db.docs.get(`subscriptionOrders/${other.orderId}`).storeId, 's2');
});
test('create-order: gateway gagal -> order failed, tidak ada Pro', async () => {
  const ctx = setup(); ctx.midtrans.snapFail = true;
  const r = await call(ctx.h.createOrder, { token: 'u1', body: { planId: 'pro_monthly' } });
  assert.strictEqual(r.code, 502);
  assert.ok(![...ctx.db.docs.keys()].includes('stores/s1/subscription/data'));
  assert.ok([...ctx.db.docs.entries()].some(([k, v]) => k.startsWith('subscriptionOrders/') && v.status === 'failed'));
});
test('webhook: signature tidak valid ditolak dan tidak mengaktifkan Pro', async () => {
  const ctx = setup(); const o = await order(ctx); arm(ctx, o);
  const n = notif(o);
  const r = await call(ctx.h.webhook, { body: { ...n, signature_key: sig(n.order_id, n.status_code, n.gross_amount, 'KEY-LAIN') } });
  assert.strictEqual(r.code, 401);
  assert.ok(!ctx.db.docs.has('stores/s1/subscription/data'));
});
test('webhook: payload tidak lengkap 400; order tidak ada 404; method salah 405', async () => {
  const ctx = setup();
  assert.strictEqual((await call(ctx.h.webhook, { body: { order_id: 'x' } })).code, 400);
  const n = { order_id: 'AGNI-ZZZZZZ-deadbeef', status_code: '200', gross_amount: '19000.00' };
  assert.strictEqual((await call(ctx.h.webhook, { body: { ...n, signature_key: sig(n.order_id, '200', n.gross_amount) } })).code, 404);
  assert.strictEqual((await call(ctx.h.webhook, { method: 'GET' })).code, 405);
});
test('webhook: nominal tidak cocok -> 409 dan Pro tidak aktif', async () => {
  const ctx = setup(); const o = await order(ctx);
  ctx.midtrans.statuses[o.orderId] = notif(o, { gross_amount: '1000.00' });
  const n = notif(o, { gross_amount: '1000.00' });
  const r = await call(ctx.h.webhook, { body: { ...n, signature_key: sig(n.order_id, n.status_code, n.gross_amount) } });
  assert.strictEqual(r.code, 409);
  assert.ok(!ctx.db.docs.has('stores/s1/subscription/data'));
  assert.strictEqual(ctx.db.docs.get(`subscriptionOrders/${o.orderId}`).flag, 'amount_mismatch');
});
test('webhook: notifikasi palsu tapi Status API Midtrans bilang pending -> tidak aktif', async () => {
  const ctx = setup(); const o = await order(ctx);
  arm(ctx, o, { transaction_status: 'pending' });          // kebenaran di Midtrans
  const n = notif(o);                                       // klaim settlement (signature sah)
  const r = await call(ctx.h.webhook, { body: { ...n, signature_key: sig(n.order_id, n.status_code, n.gross_amount) } });
  assert.strictEqual(r.code, 200);
  assert.ok(!ctx.db.docs.has('stores/s1/subscription/data'));
  assert.strictEqual(ctx.db.docs.get(`subscriptionOrders/${o.orderId}`).status, 'pending');
});
test('webhook: status API tidak tersedia -> 503 (Midtrans kirim ulang), tidak aktif', async () => {
  const ctx = setup(); const o = await order(ctx); ctx.midtrans.statusFail = true;
  assert.strictEqual((await hook(ctx, o)).code, 503);
  assert.ok(!ctx.db.docs.has('stores/s1/subscription/data'));
});
test('webhook: settlement mengaktifkan Pro bulanan sekali; notifikasi berulang tidak memperpanjang', async () => {
  const ctx = setup(); const o = await order(ctx); arm(ctx, o);
  const r1 = await hook(ctx, o);
  assert.strictEqual(r1.body.result, 'activated');
  const sub = ctx.db.docs.get('stores/s1/subscription/data');
  assert.strictEqual(sub.plan, 'pro'); assert.strictEqual(sub.status, 'active');
  assert.strictEqual(sub.expiredAt.toISOString(), '2026-12-10T03:00:00.000Z');
  for (let i = 0; i < 3; i++) assert.strictEqual((await hook(ctx, o)).body.result, 'already_processed');
  assert.strictEqual(ctx.db.docs.get('stores/s1/subscription/data').expiredAt.toISOString(), '2026-12-10T03:00:00.000Z');
});
test('webhook paralel (5x) untuk order yang sama -> hanya satu perpanjangan', async () => {
  const ctx = setup(); const o = await order(ctx, 'pro_yearly'); arm(ctx, o);
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => hook(ctx, o)));
  assert.strictEqual(rs.filter((r) => r.body.result === 'activated').length, 1);
  assert.strictEqual(ctx.db.docs.get('stores/s1/subscription/data').expiredAt.toISOString(), '2027-11-10T03:00:00.000Z');
});
test('perpanjangan saat Pro masih aktif menambah dari expiredAt; dua order berbeda -> dua perpanjangan', async () => {
  const ctx = setup();
  ctx.db.docs.set('stores/s1/subscription/data', { plan: 'pro', status: 'active', billing: 'monthly', expiredAt: new Date('2026-11-25T03:00:00Z'), startedAt: new Date('2026-10-25T03:00:00Z') });
  const o = await order(ctx); arm(ctx, o); await hook(ctx, o);
  assert.strictEqual(ctx.db.docs.get('stores/s1/subscription/data').expiredAt.toISOString(), '2026-12-25T03:00:00.000Z');
  assert.strictEqual(ctx.db.docs.get('stores/s1/subscription/data').startedAt.toISOString(), '2026-10-25T03:00:00.000Z');
});
test('Pro kedaluwarsa -> pembelian baru mulai dari waktu aktivasi', async () => {
  const ctx = setup();
  ctx.db.docs.set('stores/s1/subscription/data', { plan: 'pro', status: 'active', expiredAt: new Date('2026-10-01T00:00:00Z') });
  const o = await order(ctx); arm(ctx, o); await hook(ctx, o);
  assert.strictEqual(ctx.db.docs.get('stores/s1/subscription/data').expiredAt.toISOString(), '2026-12-10T03:00:00.000Z');
});
test('pending / failed / cancelled / expired tidak mengaktifkan Pro', async () => {
  for (const [ts, expected] of [['pending', 'pending'], ['deny', 'failed'], ['cancel', 'cancelled'], ['expire', 'expired'], ['failure', 'failed']]) {
    const ctx = setup(); const o = await order(ctx); arm(ctx, o, { transaction_status: ts });
    const r = await hook(ctx, o);
    assert.strictEqual(r.code, 200, ts);
    assert.ok(!ctx.db.docs.has('stores/s1/subscription/data'), ts);
    assert.strictEqual(ctx.db.docs.get(`subscriptionOrders/${o.orderId}`).status, expected, ts);
  }
});
test('capture dengan fraud challenge tidak aktif; capture accept aktif', async () => {
  const a = setup(); const oa = await order(a); arm(a, oa, { transaction_status: 'capture', fraud_status: 'challenge' }); await hook(a, oa);
  assert.ok(!a.db.docs.has('stores/s1/subscription/data'));
  const b = setup(); const ob = await order(b); arm(b, ob, { transaction_status: 'capture', fraud_status: 'accept' }); await hook(b, ob);
  assert.ok(b.db.docs.has('stores/s1/subscription/data'));
});
test('notifikasi expire/cancel terlambat setelah paid tidak mencabut/mengubah Pro', async () => {
  const ctx = setup(); const o = await order(ctx); arm(ctx, o); await hook(ctx, o);
  arm(ctx, o, { transaction_status: 'expire' }); await hook(ctx, o);
  assert.strictEqual(ctx.db.docs.get(`subscriptionOrders/${o.orderId}`).status, 'paid');
  assert.strictEqual(ctx.db.docs.get('stores/s1/subscription/data').status, 'active');
});
test('settlement terlambat setelah order ditandai expired tetap diaktifkan (uang sudah masuk)', async () => {
  const ctx = setup(); const o = await order(ctx);
  arm(ctx, o, { transaction_status: 'expire' }); await hook(ctx, o);
  arm(ctx, o, { transaction_status: 'settlement' }); await hook(ctx, o);
  assert.strictEqual(ctx.db.docs.get(`subscriptionOrders/${o.orderId}`).status, 'paid');
});
test('status: mengembalikan data toko sendiri; harga dari server; kasir boleh baca tapi canPurchase=false', async () => {
  const ctx = setup(); const o = await order(ctx); arm(ctx, o); await hook(ctx, o);
  const r = await call(ctx.h.status, { method: 'GET', token: 'u1' });
  assert.strictEqual(r.body.subscription.status, 'active');
  assert.strictEqual(r.body.subscription.daysLeft, 30);
  assert.deepStrictEqual(r.body.plans.map((p) => p.price), [19000, 199000]);
  assert.strictEqual(r.body.orders.length, 1);
  assert.ok(!JSON.stringify(r.body).includes('snap-'));       // snapToken tidak bocor
  const k = await call(ctx.h.status, { method: 'GET', token: 'k1' });
  assert.strictEqual(k.body.canPurchase, false);
  const s2 = await call(ctx.h.status, { method: 'GET', token: 'u2' });
  assert.strictEqual(s2.body.subscription.status, 'free');
  assert.strictEqual(s2.body.orders.length, 0);
  assert.strictEqual((await call(ctx.h.status, { method: 'GET' })).code, 401);
});
test('status: Pro kedaluwarsa dilaporkan expired, data tidak dihapus', async () => {
  const ctx = setup();
  ctx.db.docs.set('stores/s1/subscription/data', { plan: 'pro', status: 'active', expiredAt: new Date('2026-11-01T00:00:00Z') });
  ctx.db.docs.set('stores/s1/products/p1', { nama: 'Casing' });
  const r = await call(ctx.h.status, { method: 'GET', token: 'u1' });
  assert.strictEqual(r.body.subscription.status, 'expired');
  assert.strictEqual(r.body.subscription.plan, 'free');
  assert.ok(ctx.db.docs.has('stores/s1/products/p1'));
});
test('status?refresh: akses lintas toko ditolak 404; refresh mengaktifkan bila Midtrans settlement', async () => {
  const ctx = setup(); const o = await order(ctx); arm(ctx, o);
  assert.strictEqual((await call(ctx.h.status, { method: 'GET', token: 'u2', query: { refresh: o.orderId } })).code, 404);
  assert.strictEqual((await call(ctx.h.status, { method: 'GET', token: 'u1', query: { refresh: '../x' } })).code, 400);
  const r = await call(ctx.h.status, { method: 'GET', token: 'u1', query: { refresh: o.orderId } });
  assert.strictEqual(r.body.refreshResult, 'activated');
  assert.strictEqual(r.body.subscription.status, 'active');
});
test('handoff: kode sekali pakai, kedaluwarsa 2 menit, replay ditolak', async () => {
  const ctx = setup();
  const c = await call(ctx.h.handoffCreate, { token: 'u1' });
  const code = c.body.code;
  assert.ok(![...ctx.db.docs.keys()].some((k) => k.includes(code)));   // hanya hash tersimpan
  const r1 = await call(ctx.h.handoffRedeem, { body: { code } });
  assert.strictEqual(r1.body.customToken, 'custom-u1');
  assert.strictEqual((await call(ctx.h.handoffRedeem, { body: { code } })).code, 400);  // replay
  const c2 = (await call(ctx.h.handoffCreate, { token: 'u1' })).body.code;
  ctx.clock.t = new Date(ctx.clock.t.getTime() + 3 * 60 * 1000);
  assert.strictEqual((await call(ctx.h.handoffRedeem, { body: { code: c2 } })).code, 400);   // kedaluwarsa
  assert.strictEqual((await call(ctx.h.handoffRedeem, { body: { code: 'x' } })).code, 400);
  assert.strictEqual((await call(ctx.h.handoffCreate, {})).code, 401);
});
test('error server tidak membocorkan detail/stack', async () => {
  const ctx = setup();
  const orig = ctx.db.collectionGroup; ctx.db.collectionGroup = () => { throw new Error('SECRET-INTERNAL private_key'); };
  const origErr = console.error; console.error = () => {};
  const r = await call(ctx.h.status, { method: 'GET', token: 'u1' });
  console.error = origErr; ctx.db.collectionGroup = orig;
  assert.strictEqual(r.code, 500);
  assert.ok(!JSON.stringify(r.body).includes('SECRET'));
});
