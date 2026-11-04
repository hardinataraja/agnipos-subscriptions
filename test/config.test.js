'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('baseUrl: toleran terhadap salah isi', () => {
  const { baseUrl } = require('../lib/config');
  const cases = [
    ['https://x.vercel.app', 'https://x.vercel.app'],
    ['https://x.vercel.app/', 'https://x.vercel.app'],
    ['https://x.vercel.app/subscription.html', 'https://x.vercel.app'],
    ['https://x.vercel.app/subscription', 'https://x.vercel.app'],
    ['  https://x.vercel.app/subscription.html/ ', 'https://x.vercel.app'],
    ['', ''],
  ];
  for (const [input, expected] of cases) {
    process.env.SUBSCRIPTION_BASE_URL = input;
    assert.strictEqual(baseUrl(), expected, JSON.stringify(input));
  }
});
