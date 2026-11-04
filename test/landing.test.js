'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

test('landing: tombol Kelola Langganan dan tautan footer (Admin, WhatsApp) ada', () => {
  assert.ok(/href="\/subscription\.html"[^>]*>\s*Kelola Langganan/.test(html));
  assert.ok(/href="\/admin-promo\.html"[^>]*>Admin</.test(html));
  assert.ok(html.includes('https://wa.me/6282111887939'));
  assert.ok(/WhatsApp Support/.test(html));
});
test('landing: Admin hanya di footer (bukan tombol mencolok di hero/navbar)', () => {
  const body = html.split('<footer')[0];
  assert.ok(!body.includes('admin-promo.html'));
});
test('landing: semua tautan internal menuju file yang ada dan semua #anchor punya target', () => {
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const h of hrefs) {
    if (h.startsWith('#')) assert.ok(ids.has(h.slice(1)), `anchor ${h}`);
    else if (h.startsWith('/')) {
      const f = h === '/' ? 'index.html' : h.slice(1);
      assert.ok(fs.existsSync(path.join(pub, f)), `file ${h}`);
    }
  }
});
test('landing: harga sesuai konfigurasi server', () => {
  const { PLANS } = require('../lib/config');
  const fmt = (n) => 'Rp' + n.toLocaleString('id-ID');
  assert.ok(html.includes(fmt(PLANS.pro_monthly.price)));
  assert.ok(html.includes(fmt(PLANS.pro_yearly.price)));
});
test('landing: tautan legal kosong secara default (tidak ada tautan rusak)', () => {
  assert.ok(/LINKS = \{ privacy: '', deleteAccount: '' \}/.test(html));
});
test('halaman langganan & admin menautkan logo ke beranda', () => {
  for (const f of ['subscription.html', 'admin-promo.html']) {
    assert.ok(fs.readFileSync(path.join(pub, f), 'utf8').includes('<a href="/" class="agni-brand'), f);
  }
});
