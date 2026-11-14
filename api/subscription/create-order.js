'use strict';
const { handlers } = require('../../lib/runtime');
module.exports = (req, res) => handlers().createOrder(req, res);
