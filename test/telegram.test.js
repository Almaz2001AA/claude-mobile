const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { TelegramNotifier, readChannel } = require('../src/telegram');
const { Viewers } = require('../src/viewers');

function setup({ token = '123:abc', allowFrom = ['42'], delay } = {}) {
  const dir = tmpDir();
  const envFile = path.join(dir, '.env');
  const accessFile = path.join(dir, 'access.json');
  if (token) fs.writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=${token}\n`);
  fs.writeFileSync(accessFile, JSON.stringify({ allowFrom }));
  const settingsFile = path.join(dir, 'telegram.json');
  if (delay !== undefined) fs.writeFileSync(settingsFile, JSON.stringify({ delayMinutes: delay }));
  let clock = 1_000_000;
  const viewers = new Viewers({ now: () => clock });
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const timers = [];
  const tg = new TelegramNotifier({
    settingsFile, envFile, accessFile, viewers, origin: 'https://host', fetch,
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => { t.cleared = true; },
  });
  const fire = async () => {
    for (const t of timers.filter((x) => !x.cleared && !x.fired)) {
      t.fired = true;
      t.fn();
    }
    await new Promise((r) => setImmediate(r));
  };
  return { tg, viewers, sent, timers, fire, advance: (ms) => { clock += ms; } };
}

const done = { title: '✅ it', body: 'Claude закончил работу' };

test('sends the notice after the default 10 minutes when nobody reacted', async () => {
  const { tg, sent, timers, fire } = setup();
  tg.onEvent('it', done);
  assert.equal(timers[0].ms, 10 * 60_000);
  await fire();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.deepEqual(sent[0].body, { chat_id: '42', text: '✅ it\nClaude закончил работу\nhttps://host/#/s/it/chat', disable_web_page_preview: true });
});

test('a later event from the session (a reply, a permission answer) cancels the reminder', async () => {
  const { tg, sent, timers, fire } = setup();
  tg.onEvent('it', done);
  tg.onEvent('it', null);
  assert.equal(timers[0].cleared, true);
  await fire();
  assert.equal(sent.length, 0);
});

test('no reminder when the chat was opened in the app meanwhile', async () => {
  const { tg, viewers, sent, fire, advance } = setup();
  tg.onEvent('it', done);
  advance(60_000);
  const ws = {};
  viewers.add('it', ws);
  viewers.remove(ws);
  advance(60_000);
  await fire();
  assert.equal(sent.length, 0);
});

test('a chat opened before the event does not count', async () => {
  const { tg, viewers, sent, fire, advance } = setup();
  const ws = {};
  viewers.add('it', ws);
  viewers.remove(ws);
  advance(60_000);
  tg.onEvent('it', done);
  await fire();
  assert.equal(sent.length, 1);
});

test('delay setting: validated, persisted, 0 turns reminders off', async () => {
  const { tg, timers } = setup({ delay: 30 });
  assert.deepEqual(tg.settings(), { delayMinutes: 30 });
  assert.throws(() => tg.setDelay(7), /Недопустимая/);
  tg.onEvent('it', done);
  assert.deepEqual(tg.setDelay(0), { delayMinutes: 0 });
  assert.equal(timers[0].cleared, true, 'turning off drops pending reminders');
  tg.onEvent('it', done);
  assert.equal(timers.length, 1);
});

test('channel config: token and numeric chat ids; unconfigured send fails clearly', async () => {
  const { tg } = setup({ token: null });
  assert.equal(tg.configured(), false);
  await assert.rejects(tg.send('x'), /не настроен/);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.env'), 'OTHER=1\nTELEGRAM_BOT_TOKEN="9:zz"\n');
  fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify({ allowFrom: ['1', 'bad', 2] }));
  assert.deepEqual(readChannel({ envFile: path.join(dir, '.env'), accessFile: path.join(dir, 'access.json') }), { token: '9:zz', chatIds: ['1', '2'] });
});

test('a Telegram API error surfaces as a user-visible error', async () => {
  const { tg } = setup();
  tg.fetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(tg.send('x'), (err) => err.status === 502 && /401/.test(err.message));
});
