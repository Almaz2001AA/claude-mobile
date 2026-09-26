const test = require('node:test');
const assert = require('node:assert/strict');
const { clampInt, delay } = require('../src/util');
const { UserError } = require('../src/errors');

test('clampInt clamps, parses and falls back', () => {
  assert.equal(clampInt('50', 20, 400, 80), 50);
  assert.equal(clampInt(5, 20, 400, 80), 20);
  assert.equal(clampInt(9999, 20, 400, 80), 400);
  assert.equal(clampInt('abc', 20, 400, 80), 80);
  assert.equal(clampInt(null, 20, 400, 80), 80);
});

test('delay resolves after the given time', async () => {
  const started = Date.now();
  await delay(30);
  assert.ok(Date.now() - started >= 25);
});

test('UserError carries an HTTP status', () => {
  assert.equal(new UserError('x').status, 400);
  assert.equal(new UserError('x', 404).status, 404);
  assert.ok(new UserError('x') instanceof Error);
});
