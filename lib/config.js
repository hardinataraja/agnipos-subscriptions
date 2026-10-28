'use strict';
// Sumber kebenaran harga & durasi. Klien TIDAK PERNAH menentukan harga.
// Harus sama dengan lib/core/constants.dart di aplikasi Flutter (hanya untuk tampilan).
const PLANS = Object.freeze({
  pro_monthly: Object.freeze({ id: 'pro_monthly', label: 'Pro Bulanan', price: 19000, months: 1, billing: 'monthly' }),
  pro_yearly: Object.freeze({ id: 'pro_yearly', label: 'Pro Tahunan', price: 199000, months: 12, billing: 'yearly' }),
});
const PROMO_MONTHS = 2;
const PROMO_CODES_PER_CAMPAIGN = 200;
const ORDER_REUSE_WINDOW_MS = 30 * 60 * 1000;
const HANDOFF_TTL_MS = 2 * 60 * 1000;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Environment variable ${name} belum diisi`);
  return v;
}
const isProduction = () => String(process.env.MIDTRANS_IS_PRODUCTION || 'false').toLowerCase() === 'true';
const midtransBase = () => (isProduction() ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com');
const snapBase = () => (isProduction() ? 'https://app.midtrans.com' : 'https://app.sandbox.midtrans.com');
const adminUids = () => (process.env.ADMIN_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const baseUrl = () => (process.env.SUBSCRIPTION_BASE_URL || '').replace(/\/+$/, '');

module.exports = { PLANS, PROMO_MONTHS, PROMO_CODES_PER_CAMPAIGN, ORDER_REUSE_WINDOW_MS, HANDOFF_TTL_MS,
  requireEnv, isProduction, midtransBase, snapBase, adminUids, baseUrl };
