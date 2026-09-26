const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PushService } = require('../src/push');
const { Viewers } = require('../src/viewers');
const { wireNotifications } = require('../src/notifier');
const { readJson } = require('../src/config');
const { tmpDir } = require('./helpers');

function fakeSender() {
  return {
    sent: [],
    generateVAPIDKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }),
    setVapidDetails(subject, pub, priv) { this.vapid = { subject, pub, priv }; },
    async sendNotification(sub, payload) {
      if (sub.endpoint === 'https://gone') throw Object.assign(new Error('gone'), { statusCode: 410 });
      this.sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    },
  };
}

function newPush(dir = tmpDir(), sender = fakeSender()) {
  const push = new PushService({ vapidFile: path.join(dir, 'vapid.json'), subsFile: path.join(dir, 'subs.json'), sender });
  return { push, sender, dir };
}

test('VAPID keys are generated once and reused', () => {
  const { push, sender, dir } = newPush();
  assert.equal(push.publicKey, 'PUB');
  assert.equal(sender.vapid.priv, 'PRIV');
  const again = fakeSender();
  again.generateVAPIDKeys = () => { throw new Error('must not regenerate'); };
  assert.equal(newPush(dir, again).push.publicKey, 'PUB');
});

test('notify respects prefs and skip list, and drops dead subscriptions', async () => {
  const { push, sender, dir } = newPush();
  push.subscribe({ endpoint: 'https://a' }, { stop: true, permission: true });
  push.subscribe({ endpoint: 'https://b' }, { stop: false, permission: true });
  push.subscribe({ endpoint: 'https://gone' }, {});
  push.subscribe({ endpoint: 'https://a' }, { stop: true, permission: false }); // re-subscribe replaces

  await push.notify('stop', { title: 'x' });
  assert.deepEqual(sender.sent.map((s) => s.endpoint), ['https://a']);
  assert.deepEqual(readJson(path.join(dir, 'subs.json'), []).map((s) => s.subscription.endpoint), ['https://b', 'https://a']);

  sender.sent.length = 0;
  await push.notify('permission', { title: 'y' });
  assert.deepEqual(sender.sent.map((s) => s.endpoint), ['https://b']);

  sender.sent.length = 0;
  await push.notify('stop', { title: 'z' }, { skip: new Set(['https://a']) });
  assert.deepEqual(sender.sent, []);
});

test('updatePrefs and unsubscribe', () => {
  const { push } = newPush();
  push.subscribe({ endpoint: 'https://a' });
  push.updatePrefs('https://a', { stop: false });
  assert.deepEqual(push.subs[0].prefs, { stop: false, permission: true });
  assert.throws(() => push.updatePrefs('https://nope', {}), /не найдена/);
  push.unsubscribe('https://a');
  assert.equal(push.subs.length, 0);
});

test('Viewers tracks visible chat viewers per session', () => {
  const viewers = new Viewers();
  const ws1 = {}; const ws2 = {};
  viewers.add('a', ws1);
  viewers.add('a', ws2);
  viewers.update(ws1, { visible: true, endpoint: 'https://1' });
  viewers.update(ws2, { visible: false, endpoint: 'https://2' });
  assert.deepEqual([...viewers.watchingEndpoints('a')], ['https://1']);
  assert.deepEqual([...viewers.watchingEndpoints('b')], []);
  viewers.remove(ws1);
  assert.deepEqual([...viewers.watchingEndpoints('a')], []);
});

test('wireNotifications sends stop and permission pushes', () => {
  const status = new EventEmitter();
  const calls = [];
  const push = { notify: (kind, payload, opts) => { calls.push({ kind, payload, opts }); return Promise.resolve(); } };
  const viewers = new Viewers();
  const ws = {};
  viewers.add('a', ws);
  viewers.update(ws, { visible: true, endpoint: 'https://1' });
  wireNotifications({ status, push, viewers });

  status.emit('change', 'a', { status: 'idle' }, 'Stop');
  status.emit('change', 'a', { status: 'waiting_permission', message: 'Claude needs your permission to use Bash' }, 'Notification');
  status.emit('change', 'a', { status: 'working' }, 'PreToolUse');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, 'stop');
  assert.deepEqual(calls[0].payload, { title: '✅ a', body: 'Claude закончил работу', url: '/#/s/a/chat' });
  assert.deepEqual([...calls[0].opts.skip], ['https://1']);
  assert.equal(calls[1].kind, 'permission');
  assert.equal(calls[1].payload.body, 'Claude needs your permission to use Bash');
});
