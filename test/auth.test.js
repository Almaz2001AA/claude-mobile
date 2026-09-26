const test = require('node:test');
const assert = require('node:assert/strict');
const { Auth, hashPin, verifyPin, parseCookies, safeEqual } = require('../src/auth');

const SECRET = 'k'.repeat(64);

test('hashPin/verifyPin', () => {
  const stored = hashPin('1234');
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(verifyPin('1234', stored), true);
  assert.equal(verifyPin('4321', stored), false);
  assert.equal(verifyPin('1234', 'garbage'), false);
  assert.equal(verifyPin('1234', null), false);
  assert.throws(() => hashPin('12'), /PIN/);
  assert.throws(() => hashPin('abcd'), /PIN/);
});

test('login issues a token that verifies until it expires', () => {
  let now = 1000;
  const auth = new Auth({ pinHash: hashPin('2468'), secret: SECRET, now: () => now, ttlMs: 500 });
  const res = auth.login('2468');
  assert.equal(res.ok, true);
  assert.equal(auth.verify(res.token), true);
  now = 1600;
  assert.equal(auth.verify(res.token), false);
});

test('tampered or foreign tokens are rejected', () => {
  const auth = new Auth({ pinHash: hashPin('2468'), secret: SECRET });
  const { token } = auth.login('2468');
  const [exp, sig] = token.split('.');
  assert.equal(auth.verify(`${Number(exp) + 1000}.${sig}`), false);
  assert.equal(auth.verify('nonsense'), false);
  assert.equal(auth.verify(undefined), false);
  const other = new Auth({ pinHash: hashPin('2468'), secret: 'z'.repeat(64) });
  assert.equal(other.verify(token), false);
});

test('five wrong PINs lock login for 15 minutes', () => {
  let now = 0;
  const auth = new Auth({ pinHash: hashPin('2468'), secret: SECRET, now: () => now });
  for (let i = 0; i < 4; i++) assert.deepEqual(auth.login('0000'), { ok: false, error: 'Неверный PIN' });
  assert.equal(auth.login('0000').locked, true);
  assert.equal(auth.login('2468').locked, true, 'correct PIN is refused while locked');
  now = 15 * 60 * 1000 + 1;
  assert.equal(auth.login('2468').ok, true);
});

test('parseCookies and safeEqual', () => {
  assert.deepEqual(parseCookies('a=1; cm_auth=x.y; bad=%E0%A4%A'), { a: '1', cm_auth: 'x.y' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'ab'), false);
});
