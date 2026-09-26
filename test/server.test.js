const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { createApp } = require('../src/server');
const { SessionManager } = require('../src/sessions');
const { InputSender } = require('../src/input');
const { StatusStore } = require('../src/status');
const { Auth, hashPin } = require('../src/auth');
const { PushService } = require('../src/push');
const { Viewers } = require('../src/viewers');
const { Recent } = require('../src/recent');
const { tmpDir, waitFor, killTmuxServer } = require('./helpers');

const socket = `cm-test-${process.pid}-server`;
const SECRET = 'h'.repeat(64);
let base;
let app;
let sessions;
let status;
let cookie;
let dir;

test.before(async () => {
  dir = tmpDir();
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<title>Claude</title>');
  fs.writeFileSync(path.join(dir, 'xterm.css'), '.xterm{}');
  sessions = new SessionManager({ socket, claudeCmd: 'cat' });
  status = new StatusStore({ file: path.join(dir, 'links.json') });
  const sender = { generateVAPIDKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }), setVapidDetails() {}, async sendNotification() {} };
  app = createApp({
    sessions,
    input: new InputSender({ sessions, enterDelayMs: 20 }),
    status,
    auth: new Auth({ pinHash: hashPin('1234'), secret: 'c'.repeat(64) }),
    push: new PushService({ vapidFile: path.join(dir, 'vapid.json'), subsFile: path.join(dir, 'subs.json'), sender }),
    viewers: new Viewers(),
    recent: new Recent(path.join(dir, 'recent.json')),
    paths: { uploads: path.join(dir, 'uploads') },
    hookSecret: SECRET,
    publicDir,
    vendorFiles: { 'xterm.css': path.join(dir, 'xterm.css') },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

test.after(() => {
  app.server.close();
  killTmuxServer(socket);
});

const call = (method, url, body, headers = {}) => fetch(`${base}${url}`, {
  method,
  headers: { cookie, ...(body !== undefined && !(body instanceof Buffer) ? { 'content-type': 'application/json' } : {}), ...headers },
  body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
});

test('static files and vendor files are public', async () => {
  assert.equal(await (await fetch(`${base}/`)).text(), '<title>Claude</title>');
  assert.equal(await (await fetch(`${base}/vendor/xterm.css`)).text(), '.xterm{}');
  assert.equal((await fetch(`${base}/vendor/other.js`)).status, 404);
});

test('API requires login; wrong PIN is 401; right PIN sets a secure cookie', async () => {
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  const bad = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ pin: '0000' }) });
  assert.equal(bad.status, 401);
  const good = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ pin: '1234' }) });
  assert.equal(good.status, 200);
  const setCookie = good.headers.get('set-cookie');
  assert.match(setCookie, /^cm_auth=\d+\.[0-9a-f]+; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=2592000$/);
  cookie = setCookie.split(';')[0];
  assert.deepEqual(await (await call('GET', '/api/me')).json(), { ok: true });
});

test('create, list, type into and delete a session', async () => {
  const cwd = tmpDir();
  assert.equal((await call('POST', '/api/sessions', { name: 'web', cwd })).status, 201);
  assert.equal((await call('POST', '/api/sessions', { name: 'Bad Name', cwd })).status, 400);
  const list = await (await call('GET', '/api/sessions')).json();
  assert.deepEqual(list.map((s) => [s.name, s.cwd, s.status, s.hasTranscript]), [['web', cwd, 'idle', false]]);
  assert.deepEqual(await (await call('GET', '/api/recent-cwds')).json(), [cwd]);

  assert.equal((await call('POST', '/api/sessions/web/input', { text: 'hello tmux' })).status, 200);
  await waitFor(async () => (await sessions.capture('web')).includes('hello tmux'));
  assert.equal((await call('POST', '/api/sessions/web/key', { key: 'bogus' })).status, 400);
  assert.deepEqual(await (await call('GET', '/api/sessions/web/permission')).json(), { dialog: null });
  assert.equal((await call('POST', '/api/sessions/web/permission', { key: '1' })).status, 409);

  assert.equal((await call('DELETE', '/api/sessions/web')).status, 200);
  assert.equal((await call('DELETE', '/api/sessions/web')).status, 404);
  assert.equal((await call('GET', '/api/sessions/ghost/permission')).status, 404);
});

test('hook endpoint needs the secret and a direct loopback call, then drives status and history', async () => {
  const transcript = path.join(dir, 'h.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hi' } }) + '\n');
  const event = { tmuxSession: 'claude-hooked', event: { hook_event_name: 'SessionStart', transcript_path: transcript } };
  assert.equal((await fetch(`${base}/internal/hook`, { method: 'POST', body: JSON.stringify(event) })).status, 403);
  assert.equal((await fetch(`${base}/internal/hook`, { method: 'POST', headers: { 'x-hook-secret': SECRET, 'x-forwarded-for': '100.64.0.2' }, body: JSON.stringify(event) })).status, 403);
  assert.equal((await fetch(`${base}/internal/hook`, { method: 'POST', headers: { 'x-hook-secret': SECRET }, body: JSON.stringify(event) })).status, 200);
  assert.equal(status.get('hooked').transcriptPath, transcript);

  const history = await (await call('GET', '/api/sessions/hooked/history?limit=10')).json();
  assert.deepEqual(history.items.map((i) => i.text), ['hi']);
  assert.equal((await call('GET', '/api/sessions/nohistory/history')).status, 404);
});

test('upload stores the raw body', async () => {
  const res = await call('POST', '/api/sessions/web/upload?filename=shot.png', Buffer.from('PNGDATA'));
  assert.equal(res.status, 201);
  const { path: saved } = await res.json();
  assert.equal(fs.readFileSync(saved, 'utf8'), 'PNGDATA');
});

test('push subscription endpoints', async () => {
  assert.deepEqual(await (await call('GET', '/api/push/key')).json(), { key: 'PUB' });
  assert.equal((await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://p' }, prefs: { stop: false } })).status, 200);
  assert.equal((await call('POST', '/api/push/subscribe', { prefs: {} })).status, 400);
  assert.equal((await call('POST', '/api/push/prefs', { endpoint: 'https://p', prefs: { permission: false } })).status, 200);
  assert.equal((await call('POST', '/api/push/unsubscribe', { endpoint: 'https://p' })).status, 200);
});

function openWs(url, headers) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}${url}`, { headers });
  const messages = [];
  ws.on('message', (data) => messages.push(data.toString()));
  return { ws, messages, error: new Promise((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode))) };
}

test('WebSockets require the cookie and a same-origin Origin', async () => {
  await sessions.create('wstest', tmpDir());
  const noCookie = openWs('/ws/term/wstest', { origin: base });
  assert.equal(await noCookie.error, 403);
  const foreign = openWs('/ws/term/wstest', { cookie, origin: 'https://evil.example' });
  assert.equal(await foreign.error, 403);

  const term = openWs('/ws/term/wstest?cols=80&rows=24', { cookie, origin: base });
  await new Promise((resolve) => term.ws.on('open', resolve));
  term.ws.send(JSON.stringify({ t: 'in', d: 'via-ws\r' }));
  await waitFor(() => term.messages.join('').includes('via-ws'));
  term.ws.close();

  const chat = openWs('/ws/chat/wstest', { cookie, origin: base });
  await waitFor(() => chat.messages.some((m) => JSON.parse(m).type === 'history'));
  chat.ws.close();

  const missing = openWs('/ws/term/nosuch', { cookie, origin: base });
  const code = await new Promise((resolve) => missing.ws.on('close', resolve));
  assert.equal(code, 4004);
  await sessions.kill('wstest');
});
