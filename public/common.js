// Dipakai subscription.html & admin-promo.html. Tanpa secret: hanya konfigurasi publik dari /api/config.
(function () {
  'use strict';
  const FIREBASE_VER = '10.14.1';
  const load = (src) => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Gagal memuat ' + src)); document.head.appendChild(s); });
  const rupiah = (n) => 'Rp' + Number(n).toLocaleString('id-ID');
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Jakarta' }) + ' WIB' : '-';

  async function initFirebase() {
    const cfg = await (await fetch('/api/config')).json();
    if (!cfg.ok || !cfg.firebase.apiKey) throw new Error('Konfigurasi Firebase web belum diisi di server.');
    await load(`https://www.gstatic.com/firebasejs/${FIREBASE_VER}/firebase-app-compat.js`);
    await load(`https://www.gstatic.com/firebasejs/${FIREBASE_VER}/firebase-auth-compat.js`);
    firebase.initializeApp(cfg.firebase);
    return { cfg, auth: firebase.auth() };
  }
  async function api(auth, path, { method = 'GET', body } = {}) {
    const u = auth.currentUser;
    if (!u) throw new Error('Belum login');
    const token = await u.getIdToken();           // dikirim di header, tidak pernah di URL
    const res = await fetch(path, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return res;
  }
  async function apiJson(auth, path, opts) {
    const res = await api(auth, path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.message || 'Terjadi kesalahan. Coba lagi.'); e.code = data.error; e.status = res.status; throw e; }
    return data;
  }
  function mountLogin(auth, el, onError) {
    el.innerHTML = `
      <div class="mb-3"><label class="form-label">Email</label><input id="lg-email" type="email" class="form-control" autocomplete="username"></div>
      <div class="mb-3"><label class="form-label">Password</label><input id="lg-pass" type="password" class="form-control" autocomplete="current-password"></div>
      <button id="lg-btn" class="btn btn-agni w-100 mb-2">Masuk</button>
      <button id="lg-google" class="btn btn-outline-light w-100">Masuk dengan Google</button>`;
    const fail = (e) => onError(e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password' || e.code === 'auth/user-not-found' ? 'Email atau password salah.' : 'Gagal masuk. Coba lagi.');
    el.querySelector('#lg-btn').onclick = () => auth.signInWithEmailAndPassword(el.querySelector('#lg-email').value.trim(), el.querySelector('#lg-pass').value).catch(fail);
    el.querySelector('#lg-google').onclick = () => auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(fail);
  }
  window.Agni = { load, rupiah, fmtDate, initFirebase, api, apiJson, mountLogin };
})();
