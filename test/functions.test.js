'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');

const root = path.join(__dirname, '..');
function walk(d, out = []) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    f.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const apiFiles = () => walk(path.join(root, 'api')).map((f) => path.relative(root, f).split(path.sep).join('/')).sort();

test('fungsi Vercel: persis 12 file (batas Hobby) dan tidak ada nama bracket', () => {
  const f = apiFiles();
  assert.strictEqual(f.length, 12, f.join(', '));
  assert.ok(!f.some((x) => x.includes('[')), 'jangan pakai file catch-all [..] (tidak terbukti jalan di Vercel)');
});

test('setiap fungsi memanggil handler yang ada', () => {
  const { h } = setup();
  for (const f of apiFiles()) {
    if (f === 'api/config.js') continue;
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/handlers\(\)\.(\w+)\(/g)) assert.strictEqual(typeof h[m[1]], 'function', `${f} -> ${m[1]}`);
  }
});

test('rewrite /api/cabang/create menuju fungsi yang ada dengan __op=cabang-create', () => {
  const vj = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const rw = vj.rewrites.find((r) => r.source === '/api/cabang/create');
  assert.ok(rw, 'rewrite cabang hilang');
  const [dest, query] = rw.destination.split('?');
  assert.ok(fs.existsSync(path.join(root, dest.replace(/^\//, '') + '.js')), dest);
  assert.strictEqual(query, '__op=cabang-create');
  assert.ok(vj.rewrites.some((r) => r.source === '/subscription'));          // rewrite lama tetap
});

test('api/member/claim.js: __op=cabang-create -> cabangCreate; selain itu -> memberClaim', async () => {
  const calls = [];
  const stub = new Proxy({}, { get: (_, n) => async () => { calls.push(n); } });
  const rtPath = require.resolve('../lib/runtime');
  const claimPath = require.resolve('../api/member/claim.js');
  const prev = require.cache[rtPath];
  require.cache[rtPath] = { id: rtPath, filename: rtPath, loaded: true, exports: { handlers: () => stub } };
  delete require.cache[claimPath];
  try {
    const fn = require(claimPath);
    await fn({ query: { __op: 'cabang-create' } }, {});
    await fn({ query: {} }, {});
    await fn({}, {});
    await fn({ query: { __op: 'lain' } }, {});
    assert.deepStrictEqual(calls, ['cabangCreate', 'memberClaim', 'memberClaim', 'memberClaim']);
  } finally {
    if (prev) require.cache[rtPath] = prev; else delete require.cache[rtPath];
    delete require.cache[claimPath];
  }
});

test('package.json: engines.node dipin (bukan >=)', () => {
  const pj = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.strictEqual(pj.engines.node, '24.x');
});
