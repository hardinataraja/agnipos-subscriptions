'use strict';
const crypto = require('crypto');
process.env.PROMO_HMAC_SECRET = 'test-hmac-secret-test-hmac-secret-123456';
process.env.PROMO_ENC_KEY = crypto.randomBytes(32).toString('hex');
process.env.MIDTRANS_SERVER_KEY = 'SB-Mid-server-TESTKEY';
process.env.MIDTRANS_IS_PRODUCTION = 'false';
process.env.ADMIN_UIDS = 'admin-uid';
const fake = require('./fakeFirestore');
const { FakeDb, FieldValue } = fake;
const { createHandlers } = require('../lib/handlers');

function sig(orderId, statusCode, gross, key = process.env.MIDTRANS_SERVER_KEY) {
  return crypto.createHash('sha512').update(`${orderId}${statusCode}${gross}${key}`).digest('hex');
}
function setup({ now = new Date('2026-11-10T03:00:00Z') } = {}) {
  const db = new FakeDb();
  const clock = { t: now };
  fake.clock = () => new Date(clock.t.getTime());
  db.docs.set('stores/s1/staff/u1', { uid: 'u1', role: 'admin', aktif: true, nama: 'Owner 1', email: 'o1@x.id' });
  db.docs.set('stores/s1/staff/k1', { uid: 'k1', role: 'kasir', aktif: true, nama: 'Kasir', email: 'k@x.id' });
  db.docs.set('stores/s2/staff/u2', { uid: 'u2', role: 'admin', aktif: true, nama: 'Owner 2', email: 'o2@x.id' });
  const midtrans = { statuses: {}, snapFail: false, snapCalls: 0, statusFail: false };
  const fetchMock = async (url, opts = {}) => {
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (url.includes('/snap/v1/transactions')) {
      midtrans.snapCalls++;
      if (midtrans.snapFail) return json(500, {});
      const b = JSON.parse(opts.body);
      midtrans.lastSnap = b;
      return json(201, { token: `snap-${b.transaction_details.order_id}`, redirect_url: 'https://app.sandbox.midtrans.com/snap/v4/redirection/x' });
    }
    const m = url.match(/\/v2\/([^/]+)\/status/);
    if (m) {
      if (midtrans.statusFail) return json(500, {});
      const s = midtrans.statuses[decodeURIComponent(m[1])];
      return s ? json(200, s) : json(404, {});
    }
    throw new Error('unexpected fetch ' + url);
  };
  const auth = {
    verifyIdToken: async (t) => { if (!t.startsWith('tok-')) throw new Error('bad'); return { uid: t.slice(4), email: `${t.slice(4)}@x.id` }; },
    createCustomToken: async (uid) => `custom-${uid}`,
  };
  const h = createHandlers({ db, FieldValue, fetch: fetchMock, auth, now: () => clock.t });
  return { db, h, midtrans, clock };
}
function mockRes() {
  const r = { code: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}
async function call(handler, { method = 'POST', token, body, query, headers = {} } = {}) {
  const res = mockRes();
  await handler({ method, headers: { ...(token ? { authorization: `Bearer tok-${token}` } : {}), ...headers }, body, query }, res);
  return res;
}
module.exports = { setup, call, sig, FieldValue };
