const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function getPaths(env = process.env) {
  const base = env.CLAUDE_MOBILE_HOME || path.join(os.homedir(), '.config', 'claude-mobile');
  return {
    base,
    links: path.join(base, 'links.json'),
    recent: path.join(base, 'recent.json'),
    subscriptions: path.join(base, 'subscriptions.json'),
    vapid: path.join(base, 'vapid.json'),
    pin: path.join(base, 'pin'),
    hookSecret: path.join(base, 'hook-secret'),
    cookieSecret: path.join(base, 'cookie-secret'),
    uploads: env.CLAUDE_MOBILE_UPLOADS || path.join(os.homedir(), '.cache', 'claude-mobile', 'uploads'),
  };
}

function getPort(env = process.env) {
  return Number(env.CLAUDE_MOBILE_PORT || 8787);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Atomic write: a crash never leaves a half-written file behind.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function getOrCreateSecret(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {}
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

module.exports = { getPaths, getPort, readJson, writeJson, getOrCreateSecret };
