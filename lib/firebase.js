'use strict';
const admin = require('firebase-admin');
const { requireEnv } = require('./config');

function app() {
  if (admin.apps.length) return admin.app();
  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId: requireEnv('FIREBASE_PROJECT_ID'),
      clientEmail: requireEnv('FIREBASE_CLIENT_EMAIL'),
      // Vercel menyimpan newline sebagai literal \n
      privateKey: requireEnv('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    }),
  });
}
module.exports = {
  db: () => { app(); return admin.firestore(); },
  auth: () => { app(); return admin.auth(); },
  FieldValue: admin.firestore.FieldValue,
};
