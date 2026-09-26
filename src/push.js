const webpush = require('web-push');
const { readJson, writeJson } = require('./config');
const { UserError } = require('./errors');

// Apple rejects VAPID subjects on localhost-style domains, so default to a neutral mailto.
const DEFAULT_SUBJECT = process.env.CLAUDE_MOBILE_PUSH_SUBJECT || 'mailto:admin@example.com';

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

module.exports = { PushService };
