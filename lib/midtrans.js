'use strict';
const crypto = require('crypto');
const { midtransBase, snapBase, requireEnv } = require('./config');
const { safeEqualHex } = require('./util');

const authHeader = () => 'Basic ' + Buffer.from(requireEnv('MIDTRANS_SERVER_KEY') + ':').toString('base64');

// signature_key = SHA512(order_id + status_code + gross_amount + ServerKey)
function verifySignature(body, serverKey) {
  const expected = crypto.createHash('sha512')
    .update(`${body.order_id}${body.status_code}${body.gross_amount}${serverKey}`).digest('hex');
  return safeEqualHex(expected, String(body.signature_key || ''));
}

async function createSnapTransaction(fetchImpl, params) {
  const res = await fetchImpl(`${snapBase()}/snap/v1/transactions`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authHeader() },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error(`Midtrans Snap gagal (HTTP ${res.status})`);
  return { token: data.token, redirectUrl: data.redirect_url };
}

async function fetchTransactionStatus(fetchImpl, orderId) {
  const res = await fetchImpl(`${midtransBase()}/v2/${encodeURIComponent(orderId)}/status`, {
    headers: { Accept: 'application/json', Authorization: authHeader() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Midtrans status gagal (HTTP ${res.status})`);
  return data;
}
module.exports = { verifySignature, createSnapTransaction, fetchTransactionStatus };
