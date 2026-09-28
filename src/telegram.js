const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { readJson, writeJson } = require('./config');
const { UserError } = require('./errors');

const DELAYS = [0, 5, 10, 30]; // minutes; 0 = off
const DEFAULT_DELAY = 10;
const CHANNEL_DIR = path.join(os.homedir(), '.claude', 'channels', 'telegram');

// Bot token and recipients come from the Claude Code Telegram channel's own config, so the
// same bot the user already talks to Claude through also delivers these reminders.
function readChannel({ envFile, accessFile }) {
  let token = null;
  try {
    const m = fs.readFileSync(envFile, 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
    if (m) token = m[1].trim().replace(/^["']|["']$/g, '');
  } catch {}
  const access = readJson(accessFile, {});
  const chatIds = Array.isArray(access.allowFrom) ? access.allowFrom.map(String).filter((id) => /^-?\d+$/.test(id)) : [];
  return { token, chatIds };
}

// Minimal JSON POST, optionally through an HTTP proxy (Telegram is often reachable only via
// one; global fetch ignores HTTPS_PROXY). `proxyEnv` on https.Agent needs Node 24.5+.
function postJson(url, init, proxy) {
  return new Promise((resolve, reject) => {
    const agent = proxy ? new https.Agent({ proxyEnv: { HTTPS_PROXY: proxy } }) : undefined;
    const req = https.request(url, {
      method: 'POST',
      agent,
      headers: { ...init.headers, 'content-length': Buffer.byteLength(init.body) },
      timeout: 15000,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on('timeout', () => req.destroy(new Error('Telegram не ответил вовремя')));
    req.on('error', reject);
    req.end(init.body);
  });
}

// Sends a Telegram copy of a "done"/"needs permission" notification when the user hasn't
// reacted within the configured delay: no further hook event from the session (a new prompt,
// a permission answer…) and the session's chat not opened in the app.
class TelegramNotifier {
  constructor({
    settingsFile,
    envFile = path.join(CHANNEL_DIR, '.env'),
    accessFile = path.join(CHANNEL_DIR, 'access.json'),
    viewers,
    origin = null,
    proxy = process.env.CLAUDE_MOBILE_TELEGRAM_PROXY || null,
    fetch = (url, init) => postJson(url, init, proxy),
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    Object.assign(this, { settingsFile, envFile, accessFile, viewers, origin, fetch, now, setTimer, clearTimer });
    this.pending = new Map(); // session name -> timer
  }

  settings() {
    const saved = readJson(this.settingsFile, {});
    return { delayMinutes: DELAYS.includes(saved.delayMinutes) ? saved.delayMinutes : DEFAULT_DELAY };
  }

  configured() {
    const { token, chatIds } = readChannel(this);
    return Boolean(token && chatIds.length);
  }

  setDelay(minutes) {
    if (!DELAYS.includes(minutes)) throw new UserError('Недопустимая задержка');
    writeJson(this.settingsFile, { ...readJson(this.settingsFile, {}), delayMinutes: minutes });
    if (minutes === 0) this.cancelAll();
    return this.settings();
  }

  cancel(name) {
    const timer = this.pending.get(name);
    if (timer) this.clearTimer(timer);
    this.pending.delete(name);
  }

  cancelAll() {
    for (const name of [...this.pending.keys()]) this.cancel(name);
  }

  // Called for every status change of a session; `notice` is { title, body } for events worth
  // a reminder and null otherwise. Any event means the previous reminder is moot.
  onEvent(name, notice) {
    this.cancel(name);
    const { delayMinutes } = this.settings();
    if (!notice || delayMinutes === 0) return;
    const since = this.now();
    const timer = this.setTimer(() => {
      this.pending.delete(name);
      if (this.viewers.seenSince(name, since)) return;
      this.send(this.format(name, notice)).catch((err) => console.error('telegram error:', err.message));
    }, delayMinutes * 60_000);
    timer.unref?.();
    this.pending.set(name, timer);
  }

  format(name, { title, body }) {
    const lines = [title, body];
    if (this.origin) lines.push(`${this.origin}/#/s/${name}/chat`);
    return lines.filter(Boolean).join('\n');
  }

  async send(text) {
    const { token, chatIds } = readChannel(this);
    if (!token || !chatIds.length) throw new UserError('Telegram-бот не настроен');
    for (const chatId of chatIds) {
      const res = await this.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      if (!res.ok) throw new UserError(`Telegram ответил ошибкой ${res.status}`, 502);
    }
  }
}

module.exports = { TelegramNotifier, DELAYS, readChannel };
