'use strict';
// Satu fungsi Vercel melayani semua endpoint (kecuali /api/config) agar jumlah fungsi
// tetap kecil (batas paket Hobby). URL endpoint TIDAK berubah.
const ROUTES = Object.freeze({
  'subscription/create-order': 'createOrder',
  'subscription/status': 'status',
  'subscription/redeem-promo': 'redeemPromo',
  'midtrans/webhook': 'webhook',
  'auth/handoff-create': 'handoffCreate',
  'auth/handoff-redeem': 'handoffRedeem',
  'admin/create-promo-campaign': 'adminCreateCampaign',
  'admin/promo-list': 'adminPromoList',
  'admin/disable-promo-campaign': 'adminDisableCampaign',
  'admin/member-claim': 'adminMemberClaim',
  'member/claim': 'memberClaim',
  'cabang/create': 'cabangCreate',
});

function pathOf(req) {
  let p = String(req.url || '').split('?')[0].replace(/^\/api\/?/, '').replace(/\/+$/, '');
  try { p = decodeURIComponent(p); } catch (_) { /* biarkan apa adanya */ }
  return p;
}

async function dispatch(h, req, res) {
  const p = pathOf(req);
  if (!Object.prototype.hasOwnProperty.call(ROUTES, p)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ ok: false, error: 'not_found', message: 'Endpoint tidak ditemukan.' });
  }
  return h[ROUTES[p]](req, res);
}
module.exports = { ROUTES, dispatch, pathOf };
