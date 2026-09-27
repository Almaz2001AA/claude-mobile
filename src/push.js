const webpush = require('web-push');
const { readJson, writeJson } = require('./config');
const { UserError } = require('./errors');

// Apple rejects VAPID subjects on localhost-style domains, so default to a neutral mailto.
const DEFAULT_SUBJECT = process.env.CLAUDE_MOBILE_PUSH_SUBJECT || 'mailto:admin@example.com';

// The only hosts a real browser push subscription's endpoint can point at. Without this, the
// login-authenticated /api/push/subscribe endpoint would happily store (and later POST a
// VAPID-signed payload to) an arbitrary URL of the attacker's choosing -- an SSRF primitive.
const ALLOWED_PUSH_HOSTS = [
  'web.push.apple.com',
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'notify.windows.com',
];

function isAllowedPushEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  // Exact host, or a proper subdomain of it (a `.` boundary, not a bare suffix match: e.g.
  // "evilfcm.googleapis.com" must NOT count as ending with "fcm.googleapis.com").
  return ALLOWED_PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

function normalizePrefs(prefs) {
  return { stop: prefs?.stop !== false, permission: prefs?.permission !== false };
}

class PushService {
  constructor({ vapidFile, subsFile, subject = DEFAULT_SUBJECT, sender = webpush }) {
    this.subsFile = subsFile;
    this.sender = sender;
    let keys = readJson(vapidFile, null);
    if (!keys || !keys.publicKey) {
      keys = sender.generateVAPIDKeys();
      writeJson(vapidFile, keys);
    }
    sender.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    this.publicKey = keys.publicKey;
    this.subs = readJson(subsFile, []);
  }

  save() {
    writeJson(this.subsFile, this.subs);
  }

  subscribe(subscription, prefs) {
    if (!isAllowedPushEndpoint(subscription.endpoint)) throw new UserError('Недопустимый адрес push-подписки');
    this.subs = this.subs.filter((s) => s.subscription.endpoint !== subscription.endpoint);
    this.subs.push({ subscription, prefs: normalizePrefs(prefs) });
    this.save();
  }

  updatePrefs(endpoint, prefs) {
    const sub = this.subs.find((s) => s.subscription.endpoint === endpoint);
    if (!sub) throw new UserError('Подписка не найдена', 404);
    sub.prefs = normalizePrefs(prefs);
    this.save();
  }

  unsubscribe(endpoint) {
    this.subs = this.subs.filter((s) => s.subscription.endpoint !== endpoint);
    this.save();
  }

  // kind: 'stop' | 'permission'. Subscriptions the push service reports as gone are removed.
  async notify(kind, payload, { skip = new Set() } = {}) {
    const dead = new Set();
    const targets = this.subs.filter((s) => s.prefs[kind] && !skip.has(s.subscription.endpoint));
    await Promise.all(targets.map(async (s) => {
      try {
        await this.sender.sendNotification(s.subscription, JSON.stringify(payload), { TTL: 3600 });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) dead.add(s.subscription.endpoint);
        else console.error('push failed:', err.statusCode || err.message);
      }
    }));
    if (dead.size) {
      this.subs = this.subs.filter((s) => !dead.has(s.subscription.endpoint));
      this.save();
    }
  }
}

module.exports = { PushService, isAllowedPushEndpoint };
