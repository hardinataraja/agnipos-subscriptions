'use strict';
// Perhitungan bulan KALENDER dalam zona waktu tetap WIB (UTC+7, tanpa DST).
// Hari yang tidak ada di bulan tujuan dijepit ke hari terakhir bulan itu
// (31 Jan + 1 bulan = 28/29 Feb).
const WIB_MS = 7 * 3600 * 1000;

function daysInMonth(y, m0) { return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate(); }

function addCalendarMonths(date, months) {
  const s = new Date(date.getTime() + WIB_MS);
  const y = s.getUTCFullYear(), m = s.getUTCMonth(), d = s.getUTCDate();
  const total = m + months;
  const ty = y + Math.floor(total / 12);
  const tm = ((total % 12) + 12) % 12;
  const day = Math.min(d, daysInMonth(ty, tm));
  const t = Date.UTC(ty, tm, day, s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds(), s.getUTCMilliseconds());
  return new Date(t - WIB_MS);
}
module.exports = { addCalendarMonths };
