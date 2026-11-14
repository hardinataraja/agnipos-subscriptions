'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROUTES, dispatch, pathOf } = require('../lib/router');
const { setup } = require('./helpers');

function fakeRes() {
  const r = { code: 200, body: undefined, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
function stubs() {
  const calls = [];
  const h = new Proxy({}, { get: (_, name) => async () => { calls.push(name); } });
  return { h, calls };
}

test('router: setiap rute mengarah ke handler yang benar', async () => {
  for (const [route, name] of Object.entries(ROUTES)) {
    const { h, calls } = stubs();
    await dispatch(h, { url: `/api/${route}` }, fakeRes());
    assert.deepStrictEqual(calls, [name], route);
  }
});
test('router: query string, garis miring akhir, dan encoding ditangani', async () => {
  for (const url of ['/api/subscription/status?refresh=AGNI-1', '/api/subscription/status/', '/api/subscription%2Fstatus']) {
    const { h, calls } = stubs();
    await dispatch(h, { url }, fakeRes());
    assert.deepStrictEqual(calls, ['status'], url);
  }
  assert.strictEqual(pathOf({ url: '/api/member/claim?x=1' }), 'member/claim');
});
test('router: path tidak dikenal 404 JSON (termasuk kunci prototype)', async () => {
  for (const url of ['/api/nope', '/api/', '/api', '/api/constructor', '/api/__proto__', '/api/subscription', '/api/admin/']) {
    const { h, calls } = stubs(); const res = fakeRes();
    await dispatch(h, { url }, res);
    assert.strictEqual(res.code, 404, url);
    assert.strictEqual(res.body.error, 'not_found');
    assert.deepStrictEqual(calls, []);
  }
});
test('router: semua nilai rute ada di handler nyata (tidak ada yang menggantung)', () => {
  const { h } = setup();
  for (const name of Object.values(ROUTES)) assert.strictEqual(typeof h[name], 'function', name);
});
test('router: hanya 2 file fungsi di api/ (batas Hobby 12 terjaga) dan config tetap ada', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'api')).sort();
  assert.deepStrictEqual(files, ['[...path].js', 'config.js']);
});
test('router: endpoint lama tetap terjangkau lewat URL yang sama', () => {
  const must = ['subscription/create-order', 'subscription/status', 'subscription/redeem-promo', 'midtrans/webhook',
    'auth/handoff-create', 'auth/handoff-redeem', 'admin/create-promo-campaign', 'admin/promo-list',
    'admin/disable-promo-campaign', 'admin/member-claim', 'member/claim'];
  for (const m of must) assert.ok(ROUTES[m], m);
});
