const fs = require('node:fs');
const crypto = require('node:crypto');

// Only newly created PINs must be 6-8 digits (item 4): a PIN hash written before this change
// stays valid forever (verifyPin never re-validates the PIN's shape, only hashPin does for
// pins accepted from here on).
const PIN_RE = /^\d{6,8}$/;
const KEY_LEN = 32;

function hashPin(pin) {
  if (!PIN_RE.test(String(pin))) throw new Error('PIN должен состоять из 6–8 цифр');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, KEY_LEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPin(pin, stored) {
  if (typeof stored !== 'string') return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== KEY_LEN) return false;
  const actual = crypto.scryptSync(String(pin), Buffer.from(salt, 'hex'), KEY_LEN);
  return crypto.timingSafeEqual(actual, expected);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return out;
}

// Single-user PIN login. Tokens are stateless: "<expiry>.<hmac(expiry)>".
//
// Lockout escalates: each time the attempt limit is hit, the lock period doubles from
// lockMs (default 15 min) up to maxLockMs (default 24h), and resets back to lockMs on the
// next successful login. This slows down another local user (or anything else that can
// reach the loopback port) brute-forcing the PIN far more than a flat 15-minute lock.
//
// pinFile/secretFile (optional) let the server pick up a PIN change or secret rotation
// (`claude-mobile set-pin`) without a restart: login()/verify() stat() those files (cheap)
// and re-read them only when their mtime changed.
class Auth {
  constructor({
    pinHash, secret, pinFile = null, secretFile = null,
    now = Date.now, maxAttempts = 5, lockMs = 15 * 60 * 1000, maxLockMs = 24 * 3600 * 1000, ttlMs = 30 * 24 * 3600 * 1000,
  }) {
    this.pinHash = pinHash;
    this.secret = secret;
    this.pinFile = pinFile;
    this.secretFile = secretFile;
    this.now = now;
    this.maxAttempts = maxAttempts;
    this.lockMs = lockMs;
    this.maxLockMs = maxLockMs;
    this.ttlMs = ttlMs;
    this.failures = 0;
    this.lockedUntil = 0;
    this.nextLockMs = lockMs;
    this.pinMtime = this.pinFile ? this.statMtime(this.pinFile) : null;
    this.secretMtime = this.secretFile ? this.statMtime(this.secretFile) : null;
  }

  statMtime(file) {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  // Re-reads pin/secret from disk only if their file changed since we last looked.
  reload() {
    if (this.pinFile) {
      const mtime = this.statMtime(this.pinFile);
      if (mtime !== this.pinMtime) {
        try {
          this.pinHash = fs.readFileSync(this.pinFile, 'utf8').trim();
          this.pinMtime = mtime;
        } catch {}
      }
    }
    if (this.secretFile) {
      const mtime = this.statMtime(this.secretFile);
      if (mtime !== this.secretMtime) {
        try {
          this.secret = fs.readFileSync(this.secretFile, 'utf8').trim();
          this.secretMtime = mtime;
        } catch {}
      }
    }
  }

  login(pin) {
    this.reload();
    const now = this.now();
    if (now < this.lockedUntil) {
      return { ok: false, locked: true, error: `Слишком много попыток. Попробуйте через ${Math.ceil((this.lockedUntil - now) / 60000)} мин.` };
    }
    if (verifyPin(pin, this.pinHash)) {
      this.failures = 0;
      this.nextLockMs = this.lockMs;
      return { ok: true, token: this.issue() };
    }
    this.failures += 1;
    if (this.failures >= this.maxAttempts) {
      this.failures = 0;
      const lockMs = this.nextLockMs;
      this.lockedUntil = now + lockMs;
      this.nextLockMs = Math.min(lockMs * 2, this.maxLockMs);
      return { ok: false, locked: true, error: `Слишком много попыток. Попробуйте через ${Math.ceil(lockMs / 60000)} мин.` };
    }
    return { ok: false, error: 'Неверный PIN' };
  }

  sign(value) {
    return crypto.createHmac('sha256', this.secret).update(value).digest('hex');
  }

  issue() {
    const exp = String(this.now() + this.ttlMs);
    return `${exp}.${this.sign(exp)}`;
  }

  verify(token) {
    this.reload();
    if (typeof token !== 'string') return false;
    const [exp, sig] = token.split('.');
    if (!/^\d+$/.test(exp || '') || !sig || Number(exp) < this.now()) return false;
    return safeEqual(sig, this.sign(exp));
  }
}

module.exports = { Auth, hashPin, verifyPin, parseCookies, safeEqual };
