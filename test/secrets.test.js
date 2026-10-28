'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
// Pastikan tidak ada secret/kode promo aktif di file yang akan dipublikasikan.
const root = path.join(__dirname, '..');
function walk(d, out = []) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (f.name === 'node_modules' || f.name === '.git') continue;
    const p = path.join(d, f.name);
    f.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
test('tidak ada private key / server key / kode promo di source', () => {
  for (const f of walk(root)) {
    if (f.endsWith('package-lock.json') || f.includes(`${path.sep}test${path.sep}`)) continue;
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(t), f);
    assert.ok(!/(SB-)?Mid-server-[A-Za-z0-9_-]{10,}/.test(t), f);
    assert.ok(!/AGNI-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}/.test(t), `kode promo di ${f}`);
  }
});
test('.env.example tidak berisi nilai', () => {
  const lines = fs.readFileSync(path.join(root, '.env.example'), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l));
  assert.ok(lines.length >= 12);
  for (const l of lines) { const v = l.split('=')[1]; assert.ok(v === '' || v === 'false', l); }
});
test('frontend tidak memuat nama secret backend', () => {
  for (const f of fs.readdirSync(path.join(root, 'public')).filter((x) => x.endsWith('.html'))) {
    const t = fs.readFileSync(path.join(root, 'public', f), 'utf8');
    for (const s of ['MIDTRANS_SERVER_KEY', 'FIREBASE_PRIVATE_KEY', 'PROMO_ENC_KEY', 'PROMO_HMAC_SECRET']) assert.ok(!t.includes(s), `${f}: ${s}`);
  }
});
