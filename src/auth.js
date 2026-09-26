const crypto = require('node:crypto');

const PIN_RE = /^\d{4,8}$/;
const KEY_LEN = 32;

function hashPin(pin) {
  if (!PIN_RE.test(String(pin))) throw new Error('PIN должен состоять из 4–8 цифр');
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
class Auth {
  constructor({ pinHash, secret, now = Date.now, maxAttempts = 5, lockMs = 15 * 60 * 1000, ttlMs = 30 * 24 * 3600 * 1000 }) {
    this.pinHash = pinHash;
    this.secret = secret;
    this.now = now;
    this.maxAttempts = maxAttempts;
    this.lockMs = lockMs;
    this.ttlMs = ttlMs;
    this.failures = 0;
    this.lockedUntil = 0;
  }

  login(pin) {
    const now = this.now();
    const locked = { ok: false, locked: true, error: 'Слишком много попыток. Попробуйте через 15 минут.' };
    if (now < this.lockedUntil) return locked;
    if (verifyPin(pin, this.pinHash)) {
      this.failures = 0;
      return { ok: true, token: this.issue() };
    }
    this.failures += 1;
    if (this.failures >= this.maxAttempts) {
      this.failures = 0;
      this.lockedUntil = now + this.lockMs;
      return locked;
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
    if (typeof token !== 'string') return false;
    const [exp, sig] = token.split('.');
    if (!/^\d+$/.test(exp || '') || !sig || Number(exp) < this.now()) return false;
    return safeEqual(sig, this.sign(exp));
  }
}

module.exports = { Auth, hashPin, verifyPin, parseCookies, safeEqual };
