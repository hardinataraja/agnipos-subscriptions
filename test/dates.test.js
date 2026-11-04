'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { addCalendarMonths } = require('../lib/dates');

test('bulan kalender biasa', () => {
  assert.strictEqual(addCalendarMonths(new Date('2026-11-10T03:00:00Z'), 1).toISOString(), '2026-12-10T03:00:00.000Z');
});
test('31 Jan + 1 bulan dijepit ke 28 Feb (non-kabisat)', () => {
  // 31 Jan 2027 10:00 WIB = 03:00Z
  assert.strictEqual(addCalendarMonths(new Date('2027-01-31T03:00:00Z'), 1).toISOString(), '2027-02-28T03:00:00.000Z');
});
test('kabisat: 31 Jan 2028 + 1 bulan = 29 Feb 2028', () => {
  assert.strictEqual(addCalendarMonths(new Date('2028-01-31T03:00:00Z'), 1).toISOString(), '2028-02-29T03:00:00.000Z');
});
test('12 bulan = tahun berikutnya, dan 29 Feb -> 28 Feb', () => {
  assert.strictEqual(addCalendarMonths(new Date('2026-11-10T03:00:00Z'), 12).toISOString(), '2027-11-10T03:00:00.000Z');
  assert.strictEqual(addCalendarMonths(new Date('2028-02-29T03:00:00Z'), 12).toISOString(), '2029-02-28T03:00:00.000Z');
});
test('lintas tahun dan 2 bulan promo', () => {
  assert.strictEqual(addCalendarMonths(new Date('2026-11-30T03:00:00Z'), 2).toISOString(), '2027-01-30T03:00:00.000Z');
});
test('batas hari memakai WIB (17:30Z tgl 31 = 00:30 WIB tgl 1)', () => {
  // 2026-12-31T17:30Z = 2027-01-01 00:30 WIB; +1 bulan = 1 Feb 00:30 WIB = 2027-01-31T17:30Z
  assert.strictEqual(addCalendarMonths(new Date('2026-12-31T17:30:00Z'), 1).toISOString(), '2027-01-31T17:30:00.000Z');
});
