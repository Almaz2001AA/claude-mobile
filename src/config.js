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
    quick: path.join(base, 'quick.json'),
    favorites: path.join(base, 'favorites.json'),
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

// CLAUDE_MOBILE_LISTEN=unix:/path/to.sock switches the server to a unix domain socket
// instead of TCP on 127.0.0.1 — useful when another local user on the same host could
// otherwise reach the loopback TCP port (item 4c: PIN brute force from other local users).
function getListenTarget(env = process.env) {
  const spec = env.CLAUDE_MOBILE_LISTEN || '';
  if (spec.startsWith('unix:')) return { type: 'unix', path: spec.slice('unix:'.length) };
  return { type: 'tcp', port: getPort(env), host: '127.0.0.1' };
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
  return rotateSecret(file);
}

// Always writes a fresh secret, even if one already exists. Used by `set-pin` so that
// changing the PIN invalidates every previously issued cookie (logs out all devices).
function rotateSecret(file) {
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

// Starts `server` listening per `target` (from getListenTarget). For a unix socket: removes
// any stale socket file first (a crashed previous run leaves one behind, which otherwise
// makes listen() fail with EADDRINUSE), creates the parent dir private (0700), and chmods
// the socket to 0600 once bound so only this user can connect to it.
function listenOn(server, target, cb) {
  if (target.type === 'unix') {
    const dir = path.dirname(target.path);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdirSync's mode is only applied when it actually creates the directory; enforce it
    // even when the directory (e.g. ~/.local/state/claude-mobile) already existed.
    fs.chmodSync(dir, 0o700);
    try {
      fs.unlinkSync(target.path);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    server.listen(target.path, () => {
      fs.chmodSync(target.path, 0o600);
      cb?.();
    });
  } else {
    server.listen(target.port, target.host, cb);
  }
}

module.exports = { getPaths, getPort, getListenTarget, listenOn, readJson, writeJson, getOrCreateSecret, rotateSecret };
