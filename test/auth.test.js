const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Auth, hashPin, verifyPin, parseCookies, safeEqual } = require('../src/auth');
const { tmpDir } = require('./helpers');

const SECRET = 'k'.repeat(64);

test('hashPin/verifyPin', () => {
  const stored = hashPin('123456');
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(verifyPin('123456', stored), true);
  assert.equal(verifyPin('654321', stored), false);
  assert.equal(verifyPin('123456', 'garbage'), false);
  assert.equal(verifyPin('123456', null), false);
  assert.throws(() => hashPin('12'), /PIN/);
  assert.throws(() => hashPin('abcd'), /PIN/);
  // New PINs must be 6-8 digits; a 4-digit PIN can no longer be *created*...
  assert.throws(() => hashPin('1234'), /PIN/);
  // ...but a hash created before this change (a pre-existing 4-digit PIN) must still verify:
  // rejecting it would lock existing users out on upgrade.
  const legacyStored = 'a'.repeat(32) + ':' + require('node:crypto').scryptSync('1234', Buffer.from('a'.repeat(32), 'hex'), 32).toString('hex');
  assert.equal(verifyPin('1234', legacyStored), true);
});

test('login issues a token that verifies until it expires', () => {
  let now = 1000;
  const auth = new Auth({ pinHash: hashPin('246800'), secret: SECRET, now: () => now, ttlMs: 500 });
  const res = auth.login('246800');
  assert.equal(res.ok, true);
  assert.equal(auth.verify(res.token), true);
  now = 1600;
  assert.equal(auth.verify(res.token), false);
});

test('tampered or foreign tokens are rejected', () => {
  const auth = new Auth({ pinHash: hashPin('246800'), secret: SECRET });
  const { token } = auth.login('246800');
  const [exp, sig] = token.split('.');
  assert.equal(auth.verify(`${Number(exp) + 1000}.${sig}`), false);
  assert.equal(auth.verify('nonsense'), false);
  assert.equal(auth.verify(undefined), false);
  const other = new Auth({ pinHash: hashPin('246800'), secret: 'z'.repeat(64) });
  assert.equal(other.verify(token), false);
});

test('five wrong PINs lock login for 15 minutes', () => {
  let now = 0;
  const auth = new Auth({ pinHash: hashPin('246800'), secret: SECRET, now: () => now });
  for (let i = 0; i < 4; i++) assert.deepEqual(auth.login('000000'), { ok: false, error: 'Неверный PIN' });
  assert.equal(auth.login('000000').locked, true);
  assert.equal(auth.login('246800').locked, true, 'correct PIN is refused while locked');
  now = 15 * 60 * 1000 + 1;
  assert.equal(auth.login('246800').ok, true);
});

test('lockout escalates (doubles) on repeated lockouts and resets to the base period after a success', () => {
  let now = 0;
  const auth = new Auth({ pinHash: hashPin('246800'), secret: SECRET, now: () => now, lockMs: 1000, maxLockMs: 5000 });
  const failFive = () => { for (let i = 0; i < 5; i++) auth.login('000000'); };

  failFive();
  assert.equal(auth.login('246800').locked, true, 'still within the first (1s) lock');
  now += 1001; // first lock over
  failFive(); // this 5th failure re-locks, at double the period (2s)
  now += 1001;
  assert.equal(auth.login('246800').locked, true, 'still locked: the 2nd lock period is longer than 1s');
  now += 1001; // 2s total since the 2nd lock started
  assert.equal(auth.login('246800').ok, true, 'unlocked once the doubled (2s) period has passed');

  // A successful login resets the escalation back to the base period.
  failFive();
  now += 1001;
  assert.equal(auth.login('246800').ok, true, 'back to the base 1s lock, not the escalated one');
});

test('lockout period is capped at maxLockMs', () => {
  let now = 0;
  const auth = new Auth({ pinHash: hashPin('246800'), secret: SECRET, now: () => now, lockMs: 1000, maxLockMs: 2000 });
  const failFive = () => { for (let i = 0; i < 5; i++) auth.login('000000'); };
  failFive(); // lock #1: 1000ms, escalates to 2000ms
  now += 1001;
  failFive(); // lock #2: 2000ms, escalates to min(4000, 2000) = 2000ms (capped)
  now += 1999;
  assert.equal(auth.login('246800').locked, true, 'lock #2 lasts the capped 2000ms, not less');
  now += 2;
  failFive(); // lock #3: still capped at 2000ms, not 4000ms
  now += 2001;
  assert.equal(auth.login('246800').ok, true, 'lock #3 did not exceed the cap');
});

test('parseCookies and safeEqual', () => {
  assert.deepEqual(parseCookies('a=1; cm_auth=x.y; bad=%E0%A4%A'), { a: '1', cm_auth: 'x.y' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'ab'), false);
});

test('login/verify hot-reload the PIN hash and cookie secret when their files change (no restart needed after set-pin)', () => {
  const dir = tmpDir();
  const pinFile = path.join(dir, 'pin');
  const secretFile = path.join(dir, 'cookie-secret');
  fs.writeFileSync(pinFile, hashPin('111111'));
  fs.writeFileSync(secretFile, SECRET);
  const auth = new Auth({ pinHash: fs.readFileSync(pinFile, 'utf8').trim(), secret: fs.readFileSync(secretFile, 'utf8').trim(), pinFile, secretFile });

  assert.equal(auth.login('111111').ok, true);

  // Simulate `claude-mobile set-pin`: new PIN hash + rotated secret, written a moment later
  // so the mtime actually changes.
  fs.writeFileSync(pinFile, hashPin('222222'));
  fs.writeFileSync(secretFile, 'z'.repeat(64));
  fs.utimesSync(pinFile, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
  fs.utimesSync(secretFile, new Date(Date.now() + 1000), new Date(Date.now() + 1000));

  assert.equal(auth.login('111111').ok, false, 'old PIN no longer works once the file changed');
  const res = auth.login('222222');
  assert.equal(res.ok, true, 'new PIN works without restarting the process');

  // The rotated secret must actually be in effect: a token issued before the rotation no
  // longer verifies (this is also what "changing the PIN logs out all devices" relies on).
  const secretBefore = SECRET;
  const staleAuth = new Auth({ pinHash: hashPin('222222'), secret: secretBefore });
  const staleToken = staleAuth.issue();
  assert.equal(auth.verify(staleToken), false);
  assert.equal(auth.verify(res.token), true);
});
