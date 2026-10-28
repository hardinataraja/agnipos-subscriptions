'use strict';
const crypto = require('crypto');
const cfg = require('./config');
const { HttpError, iso, toDate, sha256Hex } = require('./util');
const { subRef, effectiveStatus, applyMidtransResult, isActive } = require('./subscription');
const { verifySignature, createSnapTransaction, fetchTransactionStatus } = require('./midtrans');
const promo = require('./promo');
const { rateLimit } = require('./rateLimit');

const ADMIN_ROLES = ['admin', 'pemilik'];
const ORDER_ID_RE = /^AGNI-[0-9A-Z]{6,12}-[0-9a-f]{8}$/;

// deps: { db, auth:{verifyIdToken, createCustomToken}, FieldValue, fetch, now }
function createHandlers(deps) {
  const { db, FieldValue } = deps;
  const now = () => (deps.now ? deps.now() : new Date());

  // ---------- helpers ----------
  const wrap = (fn, methods) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!methods.includes(req.method)) { res.setHeader('Allow', methods.join(', ')); throw new HttpError(405, 'method_not_allowed', 'Metode tidak diizinkan'); }
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ ok: false, error: e.code, message: e.message });
      console.error('handler_error', e && e.code ? e.code : '', e && e.message ? e.message : 'unknown'); // tanpa token/secret/stack
      return res.status(500).json({ ok: false, error: 'server_error', message: 'Terjadi gangguan server. Coba lagi nanti.' });
    }
  };
  const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

  async function authenticate(req, { requireStoreAdmin = false } = {}) {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) throw new HttpError(401, 'unauthenticated', 'Sesi tidak valid. Silakan login ulang.');
    let decoded;
    try { decoded = await deps.auth.verifyIdToken(h.slice(7)); }
    catch (_) { throw new HttpError(401, 'unauthenticated', 'Sesi berakhir. Silakan login ulang.'); }
    const uid = decoded.uid;
    const q = await db.collectionGroup('staff').where('uid', '==', uid).limit(1).get();
    if (q.empty) throw new HttpError(403, 'no_store', 'Akun ini belum terdaftar di toko mana pun.');
    const doc = q.docs[0];
    const staff = doc.data();
    const storeId = doc.ref.parent.parent.id; // storeId dari data tepercaya, bukan dari klien
    if (staff.aktif === false || staff.aktif === 'false') throw new HttpError(403, 'inactive', 'Akun dinonaktifkan.');
    const isAdmin = ADMIN_ROLES.includes(staff.role);
    if (requireStoreAdmin && !isAdmin) throw new HttpError(403, 'forbidden', 'Hanya admin toko yang dapat melakukan ini.');
    return { uid, email: decoded.email || staff.email || '', storeId, role: staff.role, isAdmin, nama: staff.nama || '' };
  }
  async function authenticateAppAdmin(req) {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) throw new HttpError(401, 'unauthenticated', 'Sesi tidak valid.');
    let decoded;
    try { decoded = await deps.auth.verifyIdToken(h.slice(7)); }
    catch (_) { throw new HttpError(401, 'unauthenticated', 'Sesi berakhir.'); }
    if (!cfg.adminUids().includes(decoded.uid)) throw new HttpError(403, 'forbidden', 'Tidak berwenang.');
    return { uid: decoded.uid };
  }

  const publicOrder = (id, o) => ({ orderId: id, planId: o.planId, plan: o.planLabel, amount: o.amount, status: o.status,
    createdAt: iso(o.createdAt), paidAt: iso(o.paidAt), grantedUntil: iso(o.grantedUntil), paymentType: o.paymentType || null });

  async function subscriptionView(storeId) {
    const t = now();
    const snap = await subRef(db, storeId).get();
    const s = snap.exists ? snap.data() : null;
    const exp = s && toDate(s.expiredAt);
    const status = effectiveStatus(s, t);
    return { plan: status === 'active' ? 'pro' : 'free', status, billing: s ? s.billing || null : null, source: s ? s.source || null : null,
      startedAt: s ? iso(s.startedAt) : null, expiredAt: exp ? iso(exp) : null,
      daysLeft: status === 'active' ? Math.max(0, Math.ceil((exp.getTime() - t.getTime()) / 86400000)) : 0 };
  }

  // Ambil status resmi dari Midtrans (server key) lalu terapkan.
  async function syncOrderWithMidtrans(orderId) {
    let st;
    try { st = await fetchTransactionStatus(deps.fetch, orderId); }
    catch (_) { throw new HttpError(503, 'midtrans_unavailable', 'Belum bisa memeriksa pembayaran. Coba lagi sebentar.'); }
    if (String(st.order_id) !== orderId) throw new HttpError(502, 'mismatch', 'Data pembayaran tidak cocok.');
    return applyMidtransResult(db, orderId, st, now(), FieldValue);
  }

  // ---------- public config ----------
  const config = wrap(async (req, res) => {
    res.status(200).json({ ok: true,
      firebase: { apiKey: process.env.FIREBASE_WEB_API_KEY || '', authDomain: process.env.FIREBASE_AUTH_DOMAIN || '', projectId: process.env.FIREBASE_PROJECT_ID || '' },
      midtrans: { clientKey: process.env.MIDTRANS_CLIENT_KEY || '', snapUrl: `${cfg.snapBase()}/snap/snap.js`, isProduction: cfg.isProduction() },
    });
  }, ['GET']);

  // ---------- create-order ----------
  const createOrder = wrap(async (req, res) => {
    const me = await authenticate(req, { requireStoreAdmin: true });
    await rateLimit(db, `create-order:${me.uid}`, 10, 3600 * 1000, now());
    const pid = String(body(req).planId || '');
    const plan = Object.prototype.hasOwnProperty.call(cfg.PLANS, pid) ? cfg.PLANS[pid] : null; // hanya planId yang dipercaya; harga dari server
    if (!plan) throw new HttpError(400, 'invalid_plan', 'Paket tidak valid.');

    // Pakai ulang order pending (plan sama) yang masih segar, hindari order ganda.
    const pend = await db.collection('subscriptionOrders').where('storeId', '==', me.storeId).where('status', '==', 'pending').get();
    for (const d of pend.docs) {
      const o = d.data();
      const created = toDate(o.createdAt);
      if (o.planId === plan.id && o.snapToken && created && now().getTime() - created.getTime() < cfg.ORDER_REUSE_WINDOW_MS) {
        return res.status(200).json({ ok: true, reused: true, orderId: d.id, snapToken: o.snapToken, redirectUrl: o.redirectUrl || null, amount: o.amount, plan: plan.label });
      }
    }
    const orderId = `AGNI-${now().getTime().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex')}`;
    const orderRef = db.collection('subscriptionOrders').doc(orderId);
    await orderRef.create({ orderId, storeId: me.storeId, uid: me.uid, planId: plan.id, planLabel: plan.label, billing: plan.billing,
      months: plan.months, amount: plan.price, status: 'created', source: 'midtrans', sandbox: !cfg.isProduction(),
      createdAt: FieldValue.serverTimestamp(), history: [] });
    let snap;
    try {
      const base = cfg.baseUrl();
      snap = await createSnapTransaction(deps.fetch, {
        transaction_details: { order_id: orderId, gross_amount: plan.price },
        item_details: [{ id: plan.id, price: plan.price, quantity: 1, name: `AgniPos ${plan.label}` }],
        customer_details: { first_name: (me.nama || 'Pengguna').slice(0, 40), email: me.email || undefined },
        callbacks: base ? { finish: `${base}/subscription.html?order=${orderId}` } : undefined,
      });
    } catch (e) {
      await orderRef.update({ status: 'failed', failReason: 'snap_create_failed', updatedAt: FieldValue.serverTimestamp() });
      throw new HttpError(502, 'payment_gateway_error', 'Gagal membuat pembayaran. Coba lagi nanti.');
    }
    await orderRef.update({ status: 'pending', snapToken: snap.token, redirectUrl: snap.redirectUrl || null, updatedAt: FieldValue.serverTimestamp() });
    res.status(200).json({ ok: true, orderId, snapToken: snap.token, redirectUrl: snap.redirectUrl || null, amount: plan.price, plan: plan.label });
  }, ['POST']);

  // ---------- status ----------
  const status = wrap(async (req, res) => {
    const me = await authenticate(req);
    const refresh = req.query && req.query.refresh ? String(req.query.refresh) : '';
    let refreshResult = null;
    if (refresh) {
      if (!ORDER_ID_RE.test(refresh)) throw new HttpError(400, 'invalid_order', 'ID pesanan tidak valid.');
      const o = await db.collection('subscriptionOrders').doc(refresh).get();
      if (!o.exists || o.data().storeId !== me.storeId) throw new HttpError(404, 'order_not_found', 'Pesanan tidak ditemukan.'); // tidak bocorkan lintas toko
      if (['created', 'pending', 'failed', 'expired'].includes(o.data().status)) {
        try { refreshResult = (await syncOrderWithMidtrans(refresh)).result; } catch (e) { if (!(e instanceof HttpError)) throw e; refreshResult = 'unavailable'; }
      }
    }
    const subscription = await subscriptionView(me.storeId);
    const oq = await db.collection('subscriptionOrders').where('storeId', '==', me.storeId).orderBy('createdAt', 'desc').limit(10).get();
    res.status(200).json({ ok: true, subscription, canPurchase: me.isAdmin, refreshResult,
      orders: oq.docs.filter((d) => d.data().status !== 'created').map((d) => publicOrder(d.id, d.data())),
      plans: Object.values(cfg.PLANS).map((p) => ({ id: p.id, label: p.label, price: p.price, months: p.months })),
      promo: { months: cfg.PROMO_MONTHS } });
  }, ['GET']);

  // ---------- redeem-promo ----------
  const redeemPromo = wrap(async (req, res) => {
    const me = await authenticate(req, { requireStoreAdmin: true });
    await rateLimit(db, `redeem:${me.uid}`, 10, 15 * 60 * 1000, now());
    const r = await promo.redeem(db, FieldValue, { code: body(req).code, uid: me.uid, storeId: me.storeId, now: now() });
    if (!r.ok) {
      const msg = { invalid_code: 'Kode promo tidak valid.', code_used: 'Kode promo sudah digunakan.', campaign_inactive: 'Kampanye promo tidak aktif.',
        code_expired: 'Kode promo sudah kedaluwarsa.', already_redeemed_campaign: 'Toko ini sudah pernah memakai kode dari kampanye ini.' }[r.error];
      throw new HttpError(r.error === 'invalid_code' ? 404 : 409, r.error, msg);
    }
    res.status(200).json({ ok: true, subscription: await subscriptionView(me.storeId), expiredAt: iso(r.expiredAt) });
  }, ['POST']);

  // ---------- Midtrans webhook ----------
  const webhook = wrap(async (req, res) => {
    const b = body(req);
    for (const k of ['order_id', 'status_code', 'gross_amount', 'signature_key']) {
      if (typeof b[k] !== 'string' || !b[k]) throw new HttpError(400, 'bad_request', 'Payload tidak valid.');
    }
    if (!verifySignature(b, cfg.requireEnv('MIDTRANS_SERVER_KEY'))) throw new HttpError(401, 'invalid_signature', 'Signature tidak valid.');
    const exists = await db.collection('subscriptionOrders').doc(b.order_id).get();
    if (!exists.exists) throw new HttpError(404, 'order_not_found', 'Order tidak ditemukan.');
    // Jangan percaya isi notifikasi saja: konfirmasi ke Status API Midtrans.
    let st;
    try { st = await fetchTransactionStatus(deps.fetch, b.order_id); }
    catch (_) { throw new HttpError(503, 'midtrans_unavailable', 'Verifikasi tertunda.'); } // Midtrans akan mengirim ulang
    if (String(st.order_id) !== b.order_id) throw new HttpError(400, 'mismatch', 'Order tidak cocok.');
    const r = await applyMidtransResult(db, b.order_id, st, now(), FieldValue);
    if (r.result === 'amount_mismatch') throw new HttpError(409, 'amount_mismatch', 'Nominal tidak cocok.');
    res.status(200).json({ ok: true, result: r.result });
  }, ['POST']);

  // ---------- handoff Flutter -> web ----------
  const handoffCreate = wrap(async (req, res) => {
    const me = await authenticate(req);
    await rateLimit(db, `handoff-create:${me.uid}`, 20, 3600 * 1000, now());
    const code = crypto.randomBytes(32).toString('base64url');
    await db.collection('handoffCodes').doc(sha256Hex(code)).create({ uid: me.uid, used: false,
      expiresAt: new Date(now().getTime() + cfg.HANDOFF_TTL_MS), createdAt: FieldValue.serverTimestamp() });
    res.status(200).json({ ok: true, code, expiresInSec: cfg.HANDOFF_TTL_MS / 1000 });
  }, ['POST']);

  const handoffRedeem = wrap(async (req, res) => {
    const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
    await rateLimit(db, `handoff-redeem:${ip}`, 30, 15 * 60 * 1000, now());
    const code = String(body(req).code || '');
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(code)) throw new HttpError(400, 'invalid_code', 'Tautan kedaluwarsa. Buka ulang dari aplikasi.');
    const ref = db.collection('handoffCodes').doc(sha256Hex(code));
    const uid = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const d = s.exists ? s.data() : null;
      if (!d || d.used || toDate(d.expiresAt).getTime() <= now().getTime()) return null;
      tx.update(ref, { used: true, usedAt: now() }); // sekali pakai -> cegah replay
      return d.uid;
    });
    if (!uid) throw new HttpError(400, 'invalid_code', 'Tautan kedaluwarsa. Buka ulang dari aplikasi.');
    res.status(200).json({ ok: true, customToken: await deps.auth.createCustomToken(uid) });
  }, ['POST']);

  // ---------- admin promo ----------
  const adminCreateCampaign = wrap(async (req, res) => {
    const admin = await authenticateAppAdmin(req);
    const b = body(req);
    const campaignId = String(b.campaignId || '');
    if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(campaignId)) throw new HttpError(400, 'invalid_campaign_id', 'campaignId: huruf kecil/angka/strip, 3-41 karakter.');
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'invalid_name', 'Nama kampanye wajib diisi.');
    const validUntil = new Date(b.validUntil);
    if (isNaN(validUntil) || validUntil.getTime() <= now().getTime()) throw new HttpError(400, 'invalid_valid_until', 'validUntil harus tanggal di masa depan.');
    if (b.count !== undefined && b.count !== cfg.PROMO_CODES_PER_CAMPAIGN) throw new HttpError(400, 'invalid_count', `Jumlah kode harus tepat ${cfg.PROMO_CODES_PER_CAMPAIGN}.`);
    try {
      const n = await promo.createCampaign(db, FieldValue, { campaignId, name, validUntil, adminUid: admin.uid, count: cfg.PROMO_CODES_PER_CAMPAIGN, now: now() });
      res.status(201).json({ ok: true, campaignId, totalCodes: n });
    } catch (e) {
      if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) throw new HttpError(409, 'campaign_exists', 'campaignId sudah dipakai.');
      throw e;
    }
  }, ['POST']);

  const adminDisableCampaign = wrap(async (req, res) => {
    await authenticateAppAdmin(req);
    const id = String(body(req).campaignId || '');
    const ref = db.collection('promoCampaigns').doc(id || '_');
    const s = await ref.get();
    if (!id || !s.exists) throw new HttpError(404, 'not_found', 'Kampanye tidak ditemukan.');
    await ref.update({ status: 'disabled', disabledAt: now() }); // kode yang sudah ditukar tidak berubah
    res.status(200).json({ ok: true });
  }, ['POST']);

  const csvCell = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) || /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

  const adminPromoList = wrap(async (req, res) => {
    await authenticateAppAdmin(req);
    const q = req.query || {};
    if (!q.campaignId) {
      const cs = await db.collection('promoCampaigns').get();
      return res.status(200).json({ ok: true, campaigns: cs.docs.map((d) => { const c = d.data(); return { campaignId: d.id, name: c.name, status: c.status,
        totalCodes: c.totalCodes, redeemedCount: c.redeemedCount, validUntil: iso(c.validUntil), createdAt: iso(c.createdAt) }; }) });
    }
    const camp = await db.collection('promoCampaigns').doc(String(q.campaignId)).get();
    if (!camp.exists) throw new HttpError(404, 'not_found', 'Kampanye tidak ditemukan.');
    let qs = db.collection('promoCodes').where('campaignId', '==', String(q.campaignId));
    if (q.status === 'unused' || q.status === 'redeemed') qs = qs.where('status', '==', q.status);
    const snap = await qs.get();
    const codes = snap.docs.map((d) => { const c = d.data(); return { code: promo.decryptCode(c.codeEnc), status: c.status,
      redeemedAt: iso(c.redeemedAt), redeemedByUid: c.redeemedByUid || null, redeemedStoreId: c.redeemedStoreId || null }; })
      .sort((a, b) => a.code.localeCompare(b.code));
    if (q.format === 'csv') {
      const rows = ['no,code,status,redeemedAt,redeemedByUid,redeemedStoreId'].concat(codes.map((c, i) =>
        [i + 1, c.code, c.status, c.redeemedAt, c.redeemedByUid, c.redeemedStoreId].map(csvCell).join(',')));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="promo-${String(q.campaignId).replace(/[^a-z0-9-]/g, '')}.csv"`);
      return res.status(200).send(rows.join('\n') + '\n');
    }
    res.status(200).json({ ok: true, campaign: { campaignId: camp.id, ...JSON.parse(JSON.stringify(camp.data(), (k, v) => (v && v.toDate ? v.toDate().toISOString() : v))) }, codes });
  }, ['GET']);

  return { config, createOrder, status, redeemPromo, webhook, handoffCreate, handoffRedeem, adminCreateCampaign, adminDisableCampaign, adminPromoList };
}
module.exports = { createHandlers };
