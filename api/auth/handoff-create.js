'use strict';
const { handlers } = require('../../lib/runtime');
module.exports = (req, res) => handlers().handoffCreate(req, res);
