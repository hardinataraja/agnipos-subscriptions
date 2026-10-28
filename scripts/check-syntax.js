'use strict';
// Cek sintaks seluruh fungsi Vercel & lib, memastikan setiap api/*.js bisa di-require dan mengekspor fungsi.
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
let bad = 0;
function walk(d, o = []) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (f.name === 'node_modules') continue; const p = path.join(d, f.name); f.isDirectory() ? walk(p, o) : o.push(p); } return o; }
for (const f of walk(path.join(root, 'api')).concat(walk(path.join(root, 'lib')))) {
  try { new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }); } catch (e) { bad++; console.error('SYNTAX', f, e.message); }
}
for (const f of walk(path.join(root, 'api'))) {
  try { const m = require(f); if (typeof m !== 'function') { bad++; console.error('NOT FUNCTION', f); } } catch (e) { bad++; console.error('LOAD', f, e.message); }
}
// vercel.json valid
JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
// inline script di HTML valid
for (const f of fs.readdirSync(path.join(root, 'public')).filter((x) => x.endsWith('.html'))) {
  const t = fs.readFileSync(path.join(root, 'public', f), 'utf8');
  for (const m of t.matchAll(/<script>([\s\S]*?)<\/script>/g)) { try { new vm.Script(m[1]); } catch (e) { bad++; console.error('HTML SCRIPT', f, e.message); } }
}
console.log(bad ? `GAGAL: ${bad} masalah` : 'OK: sintaks & muat semua fungsi API, vercel.json, script HTML valid');
process.exit(bad ? 1 : 0);
