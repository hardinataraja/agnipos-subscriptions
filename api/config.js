'use strict';
const cfg = require('../lib/config');

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false });
  res.status(200).json({
    ok: true,
    firebase: {
      apiKey: process.env.FIREBASE_WEB_API_KEY || '',
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
      projectId: process.env.FIREBASE_PROJECT_ID || '',
    },
    midtrans: {
      clientKey: process.env.MIDTRANS_CLIENT_KEY || '',
      snapUrl: `${cfg.snapBase()}/snap/snap.js`,
      isProduction: cfg.isProduction(),
    },
  });
};
