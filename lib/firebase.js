'use strict';
const admin = require('firebase-admin');
const { requireEnv } = require('./config');

// Toleran terhadap format umum saat menempel ke Vercel:
// tanda kutip pembungkus, "\n" literal, atau baris baru asli.
function normalizeKey(raw) {
  let k = String(raw).trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1);
  }
  return k.replace(/\\n/g, '\n').trim() + '\n';
}

function app() {
  if (admin.apps.length) return admin.app();
  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId: requireEnv('FIREBASE_PROJECT_ID'),
      clientEmail: requireEnv('FIREBASE_CLIENT_EMAIL'),
      privateKey: normalizeKey(requireEnv('FIREBASE_PRIVATE_KEY')),
    }),
  });
}
module.exports = {
  db: () => { app(); return admin.firestore(); },
  auth: () => { app(); return admin.auth(); },
  FieldValue: admin.firestore.FieldValue,
};
