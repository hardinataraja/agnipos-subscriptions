'use strict';
const { addCalendarMonths } = require('./dates');
const { toDate } = require('./util');

const subRef = (db, storeId) => db.collection('stores').doc(storeId).collection('subscription').doc('data');

function isActive(sub, now) {
  const exp = sub && toDate(sub.expiredAt);
  return !!(sub && sub.plan === 'pro' && sub.status === 'active' && exp && exp.getTime() > now.getTime());
}
// Pro aktif -> tambah dari expiredAt saat ini; selain itu dari waktu aktivasi.
function computeNewExpiry(sub, now, months) {
  const base = isActive(sub, now) ? toDate(sub.expiredAt) : now;
  return addCalendarMonths(base, months);
}
function effectiveStatus(sub, now) {
  if (!sub || sub.plan !== 'pro') return 'free';
  return isActive(sub, now) ? 'active' : 'expired';
}

// Petakan status Midtrans -> status internal order.
function mapMidtransStatus(p) {
  const t = p.transaction_status, f = p.fraud_status;
  if (t === 'settlement') return 'paid';
  if (t === 'capture') return f === 'challenge' ? 'pending' : f === 'deny' ? 'failed' : 'paid';
  if (t === 'pending' || t === 'authorize') return 'pending';
  if (t === 'deny' || t === 'failure') return 'failed';
  if (t === 'cancel') return 'cancelled';
  if (t === 'expire') return 'expired';
  if (t === 'refund' || t === 'partial_refund' || t === 'chargeback' || t === 'partial_chargeback') return 'refunded';
  return 'pending';
}

function parseAmount(v) { const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; }

// Terapkan hasil status Midtrans (sudah diverifikasi) ke order + subscription,
// secara atomik dan idempoten. `paid` hanya sekali per order.
async function applyMidtransResult(db, orderId, payload, now, FieldValue) {
  const orderRef = db.collection('subscriptionOrders').doc(orderId);
  return db.runTransaction(async (tx) => {
    const oSnap = await tx.get(orderRef);
    if (!oSnap.exists) return { result: 'order_not_found' };
    const order = oSnap.data();
    const next = mapMidtransStatus(payload);
    const histEntry = { at: now.toISOString(), midtransStatus: String(payload.transaction_status || ''), internal: next };
    const history = (order.history || []).concat([histEntry]).slice(-30);

    if (parseAmount(payload.gross_amount) !== order.amount) {
      tx.update(orderRef, { flag: 'amount_mismatch', history, updatedAt: FieldValue.serverTimestamp() });
      return { result: 'amount_mismatch' };
    }
    if (order.status === 'paid') {
      // Sudah diaktifkan: notifikasi ulang/terlambat tidak boleh memperpanjang lagi.
      if (next === 'refunded') tx.update(orderRef, { flag: 'refund_review', history, updatedAt: FieldValue.serverTimestamp() });
      return { result: 'already_processed', status: 'paid' };
    }
    if (next !== 'paid') {
      tx.update(orderRef, { status: next, midtransStatus: payload.transaction_status || null,
        paymentType: payload.payment_type || order.paymentType || null, history, updatedAt: FieldValue.serverTimestamp() });
      return { result: 'updated', status: next };
    }
    const sRef = subRef(db, order.storeId);
    const sSnap = await tx.get(sRef);
    const cur = sSnap.exists ? sSnap.data() : null;
    const expiry = computeNewExpiry(cur, now, order.months);
    const wasActive = isActive(cur, now);
    tx.set(sRef, {
      plan: 'pro', billing: order.billing, status: 'active', expiredAt: expiry,
      startedAt: wasActive ? cur.startedAt : now, lastPaidAt: now, orderId, source: 'midtrans',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.update(orderRef, { status: 'paid', paidAt: now, activatedAt: now, grantedUntil: expiry,
      midtransStatus: payload.transaction_status || null, paymentType: payload.payment_type || null,
      history, updatedAt: FieldValue.serverTimestamp() });
    return { result: 'activated', status: 'paid', expiredAt: expiry };
  });
}

module.exports = { subRef, isActive, computeNewExpiry, effectiveStatus, mapMidtransStatus, applyMidtransResult, parseAmount };
