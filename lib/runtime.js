'use strict';
// Merakit dependensi produksi sekali per instance serverless.
const fb = require('./firebase');
const { createHandlers } = require('./handlers');
let cached;
function handlers() {
  if (!cached) {
    cached = createHandlers({
      db: fb.db(), FieldValue: fb.FieldValue, fetch: (...a) => fetch(...a),
      auth: { verifyIdToken: (t) => fb.auth().verifyIdToken(t), createCustomToken: (u) => fb.auth().createCustomToken(u) },
    });
  }
  return cached;
}
module.exports = { handlers };
