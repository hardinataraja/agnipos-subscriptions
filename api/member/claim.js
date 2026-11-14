'use strict';
const { handlers } = require('../../lib/runtime');
// Fungsi ini juga melayani POST /api/cabang/create lewat rewrite di vercel.json
// (?__op=cabang-create) agar jumlah fungsi tetap 12 (batas paket Hobby).
module.exports = (req, res) => {
  const op = req.query && req.query.__op;
  return op === 'cabang-create' ? handlers().cabangCreate(req, res) : handlers().memberClaim(req, res);
};
