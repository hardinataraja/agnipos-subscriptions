'use strict';
const { handlers } = require('../lib/runtime');
const { dispatch } = require('../lib/router');
module.exports = (req, res) => dispatch(handlers(), req, res);
