const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCc } = require('./mailer');

test('parseCc splits by comma/semicolon/newline incl. Chinese separators', () => {
  assert.deepEqual(parseCc('a@x.com, b@x.com;c@x.com\nd@x.com，e@x.com； f@x.com '), [
    'a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com'
  ]);
  assert.deepEqual(parseCc(''), []);
  assert.deepEqual(parseCc(null), []);
});
