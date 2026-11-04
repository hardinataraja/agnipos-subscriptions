'use strict';
// Merakit dependensi produksi sekali per instance serverless.
const fb = require('./firebase');
const { createHandlers } = require('./handlers');

let cached;
function real() {
  if (!cached) {
    cached = createHandlers({
      db: fb.db(), FieldValue: fb.FieldValue, fetch: (...a) => fetch(...a),
      auth: {
        verifyIdToken: (t) => fb.auth().verifyIdToken(t),
        createCustomToken: (u) => fb.auth().createCustomToken(u),
      },
    });
  }
  return cached;
}

// Jika inisialisasi gagal (env/kredensial salah), balas JSON yang jelas.
function handlers() {
  return new Proxy({}, {
    get: (_, name) => async (req, res) => {
      try {
        return await real()[name](req, res);
      } catch (e) {
        console.error('init_error', e && e.message ? e.message : 'unknown');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(500).json({
          ok: false,
          error: 'server_config_error',
          message: 'Konfigurasi server belum benar. Periksa environment variable Firebase di Vercel.',
        });
      }
    },
  });
}
module.exports = { handlers };
