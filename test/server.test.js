const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const { createApp } = require('../src/server');
const { SessionManager } = require('../src/sessions');
const { InputSender } = require('../src/input');
const { StatusStore } = require('../src/status');
const { Auth, hashPin } = require('../src/auth');
const { PushService } = require('../src/push');
const { Viewers } = require('../src/viewers');
const { Recent } = require('../src/recent');
const { QuickCommands } = require('../src/quick');
const { Favorites } = require('../src/favorites');
const { encodeCwd } = require('../src/conversations');
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
  status = new StatusStore({ file: path.join(dir, 'links.json'), projectsRoot: dir });
  const sender = { generateVAPIDKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }), setVapidDetails() {}, async sendNotification() {} };
  app = createApp({
    sessions,
    input: new InputSender({ sessions, enterDelayMs: 20 }),
    status,
    auth: new Auth({ pinHash: hashPin('123456'), secret: 'c'.repeat(64) }),
    push: new PushService({ vapidFile: path.join(dir, 'vapid.json'), subsFile: path.join(dir, 'subs.json'), sender }),
    viewers: new Viewers(),
    recent: new Recent(path.join(dir, 'recent.json')),
    quick: new QuickCommands(path.join(dir, 'quick.json')),
    favorites: new Favorites(path.join(dir, 'favorites.json')),
    paths: { uploads: path.join(dir, 'uploads') },
    hookSecret: SECRET,
    publicDir,
    vendorFiles: { 'xterm.css': path.join(dir, 'xterm.css') },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

test.after(() => {
  app.close();
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
  const good = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ pin: '123456' }) });
  assert.equal(good.status, 200);
  const setCookie = good.headers.get('set-cookie');
  assert.match(setCookie, /^cm_auth=\d+\.[0-9a-f]+; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=2592000$/);
  cookie = setCookie.split(';')[0];
  assert.deepEqual(await (await call('GET', '/api/me')).json(), { ok: true });
});

test('state-changing /api requests need a matching Origin when one is sent, but a missing Origin is allowed', async () => {
  const noOrigin = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ pin: '0000' }) });
  assert.notEqual(noOrigin.status, 403, 'no Origin header at all (curl, tests) is allowed through');

  const sameOrigin = await fetch(`${base}/api/login`, { method: 'POST', headers: { origin: base }, body: JSON.stringify({ pin: '0000' }) });
  assert.notEqual(sameOrigin.status, 403);

  const foreign = await fetch(`${base}/api/login`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ pin: '123456' }) });
  assert.equal(foreign.status, 403);

  // A GET is not state-changing, so a foreign Origin doesn't matter there.
  const getForeign = await fetch(`${base}/api/me`, { headers: { cookie, origin: 'https://evil.example' } });
  assert.notEqual(getForeign.status, 403);

  const foreignDelete = await call('DELETE', '/api/sessions/nope', undefined, { origin: 'https://evil.example' });
  assert.equal(foreignDelete.status, 403);
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

test('quick commands: defaults, save, validation and reset', async () => {
  const defaults = await (await call('GET', '/api/quick')).json();
  assert.equal(defaults.length, 6);
  assert.deepEqual(defaults[0], { label: 'Продолжай', text: 'продолжай' });

  const saved = await (await call('PUT', '/api/quick', { items: [{ label: 'Стоп', text: 'esc' }] })).json();
  assert.deepEqual(saved, [{ label: 'Стоп', text: 'esc' }]);
  assert.deepEqual(await (await call('GET', '/api/quick')).json(), saved);

  assert.equal((await call('PUT', '/api/quick', { items: [{ label: '', text: 'x' }] })).status, 400);

  const reset = await (await call('PUT', '/api/quick', { reset: true })).json();
  assert.deepEqual(reset, defaults);
});

test('favorites: save, validation, open creates a resumed session, and open of a running one does not recreate it', async () => {
  const cwd = tmpDir();
  assert.equal((await call('POST', '/api/favorites/fav1/open')).status, 404);

  const saved = await (await call('PUT', '/api/favorites', { items: [{ name: 'fav1', cwd }] })).json();
  assert.deepEqual(saved, [{ name: 'fav1', cwd }]);
  assert.deepEqual(await (await call('GET', '/api/favorites')).json(), saved);

  assert.equal((await call('PUT', '/api/favorites', { items: [{ name: 'Bad Name', cwd }] })).status, 400);
  assert.equal((await call('PUT', '/api/favorites', { items: [{ name: 'fav1', cwd: '/nope/not/here' }] })).status, 400);

  // `cat` (the shared test claudeCmd) doesn't understand --continue, which sessions.create
  // appends for resume:true, so open() here uses its own SessionManager whose command
  // tolerates (and ignores) a trailing argument, keeping the pane alive to observe.
  const resumeSessions = new SessionManager({ socket, claudeCmd: "sh -c 'cat' x" });
  const favApp = createApp({
    sessions: resumeSessions,
    input: new InputSender({ sessions: resumeSessions, enterDelayMs: 20 }),
    status,
    auth: new Auth({ pinHash: hashPin('123456'), secret: 'c'.repeat(64) }),
    push: new PushService({ vapidFile: path.join(dir, 'vapid3.json'), subsFile: path.join(dir, 'subs3.json'), sender: { generateVAPIDKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }), setVapidDetails() {}, async sendNotification() {} } }),
    viewers: new Viewers(),
    recent: new Recent(path.join(dir, 'recent3.json')),
    quick: new QuickCommands(path.join(dir, 'quick3.json')),
    favorites: new Favorites(path.join(dir, 'favorites3.json')),
    paths: { uploads: path.join(dir, 'uploads3') },
    hookSecret: SECRET,
    publicDir: path.join(dir, 'public'),
    vendorFiles: { 'xterm.css': path.join(dir, 'xterm.css') },
  });
  await new Promise((resolve) => favApp.server.listen(0, '127.0.0.1', resolve));
  const favBase = `http://127.0.0.1:${favApp.server.address().port}`;
  const favCall = (method, url, body) => fetch(`${favBase}${url}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  assert.deepEqual(await (await favCall('PUT', '/api/favorites', { items: [{ name: 'fav1', cwd }] })).json(), [{ name: 'fav1', cwd }]);
  const opened = await (await favCall('POST', '/api/favorites/fav1/open')).json();
  assert.deepEqual(opened, { name: 'fav1', created: true });
  await waitFor(async () => (await resumeSessions.list()).some((s) => s.name === 'fav1'));

  const openedAgain = await (await favCall('POST', '/api/favorites/fav1/open')).json();
  assert.deepEqual(openedAgain, { name: 'fav1', created: false });

  await resumeSessions.kill('fav1');
  favApp.close();
});

test('POST /api/sessions with resume:true passes resume through to sessions.create, but only continues when a previous conversation exists', async () => {
  const projectsRoot = tmpDir();
  const resumeSessions = new SessionManager({
    socket,
    claudeCmd: "sh -c 'echo ARGS:\"$*\"; cat' x",
    projectsRoot,
  });
  const resumeApp = createApp({
    sessions: resumeSessions,
    input: new InputSender({ sessions: resumeSessions, enterDelayMs: 20 }),
    status,
    auth: new Auth({ pinHash: hashPin('123456'), secret: 'c'.repeat(64) }),
    push: new PushService({ vapidFile: path.join(dir, 'vapid2.json'), subsFile: path.join(dir, 'subs2.json'), sender: { generateVAPIDKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }), setVapidDetails() {}, async sendNotification() {} } }),
    viewers: new Viewers(),
    recent: new Recent(path.join(dir, 'recent2.json')),
    paths: { uploads: path.join(dir, 'uploads2') },
    hookSecret: SECRET,
    publicDir: path.join(dir, 'public'),
    vendorFiles: { 'xterm.css': path.join(dir, 'xterm.css') },
  });
  await new Promise((resolve) => resumeApp.server.listen(0, '127.0.0.1', resolve));
  const resumeBase = `http://127.0.0.1:${resumeApp.server.address().port}`;
  const resumeCall = (method, url, body) => fetch(`${resumeBase}${url}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const cwd = tmpDir();
  fs.mkdirSync(path.join(projectsRoot, encodeCwd(cwd)), { recursive: true });
  fs.writeFileSync(path.join(projectsRoot, encodeCwd(cwd), 'abc.jsonl'), '');
  assert.equal((await resumeCall('POST', '/api/sessions', { name: 'resumed', cwd, resume: true })).status, 201);
  await waitFor(async () => (await resumeSessions.capture('resumed')).includes('--continue'));
  assert.match(await resumeSessions.capture('resumed'), /ARGS:--continue/);

  assert.equal((await resumeCall('POST', '/api/sessions', { name: 'noresume', cwd, resume: false })).status, 201);
  await waitFor(async () => (await resumeSessions.capture('noresume')).includes('ARGS:'));
  assert.doesNotMatch(await resumeSessions.capture('noresume'), /--continue/);

  // A folder with no previous conversation must NOT get --continue even with resume:true:
  // that's exactly the "No conversation found to continue" crash this fixes.
  const freshCwd = tmpDir();
  assert.equal((await resumeCall('POST', '/api/sessions', { name: 'freshresume', cwd: freshCwd, resume: true })).status, 201);
  await waitFor(async () => (await resumeSessions.capture('freshresume')).includes('ARGS:'));
  assert.doesNotMatch(await resumeSessions.capture('freshresume'), /--continue/);

  await resumeSessions.kill('resumed');
  await resumeSessions.kill('noresume');
  await resumeSessions.kill('freshresume');
  resumeApp.close();
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

test('hook endpoint accepts a unix-domain-socket peer as "direct" (no remoteAddress at all, not an IP)', async () => {
  const unixApp = createApp({
    sessions: { exists: async () => true, baseArgs: () => [] },
    status,
    auth: new Auth({ pinHash: hashPin('123456'), secret: 'c'.repeat(64) }),
    viewers: new Viewers(),
    paths: { uploads: path.join(dir, 'uploads-unix') },
    hookSecret: SECRET,
    publicDir: path.join(dir, 'public'),
  });
  const sockPath = path.join(tmpDir(), 'hook.sock');
  await new Promise((resolve) => unixApp.server.listen(sockPath, resolve));
  const post = (headers, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sockPath, path: '/internal/hook', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
  const event = JSON.stringify({ tmuxSession: 'claude-x', event: { hook_event_name: 'Stop' } });
  assert.equal(await post({}, event), 403, 'still needs the secret');
  assert.equal(await post({ 'x-hook-secret': SECRET, 'x-forwarded-for': '1.2.3.4' }, event), 403, 'still rejects a forwarded call');
  assert.equal(await post({ 'x-hook-secret': SECRET }, event), 200);
  unixApp.close();
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

test('deleting a session closes any open chat WebSocket for it', async () => {
  await sessions.create('todelete', tmpDir());
  const chat = openWs('/ws/chat/todelete', { cookie, origin: base });
  await waitFor(() => chat.messages.some((m) => JSON.parse(m).type === 'history'));
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chat WS was not closed within 2s of deleting its session')), 2000);
    chat.ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal((await call('DELETE', '/api/sessions/todelete')).status, 200);
  assert.equal(await closed, 4004);
});

test('GET /api/sessions reports waiting_permission sessions as idle once the dialog is gone from the screen', async () => {
  const dialogSessions = new SessionManager({
    socket,
    // read -n1 consumes exactly the one key the "answer" sends below (no Enter needed),
    // then `clear` wipes the dialog off the visible screen, like Claude Code redrawing
    // after an answer — a plain `cat` would leave the dialog text sitting in the pane forever.
    claudeCmd: "printf 'Do you want to proceed?\\n\\u276f 1. Yes\\n  2. No\\n'; read -n1 x; clear; cat",
  });
  await dialogSessions.create('dialogsess', tmpDir());
  await waitFor(async () => (await dialogSessions.capture('dialogsess')).includes('2. No'));
  status.applyHook('claude-dialogsess', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs permission' });
  assert.equal(status.get('dialogsess').status, 'waiting_permission');

  let list = await (await call('GET', '/api/sessions')).json();
  let entry = list.find((s) => s.name === 'dialogsess');
  assert.equal(entry.status, 'waiting_permission', 'the dialog is really on screen');
  // The store itself must not have been touched by just reporting it.
  assert.equal(status.get('dialogsess').status, 'waiting_permission');

  // Answer it directly on the tmux pane (as if from the terminal, bypassing our API) so the
  // store is left stale at waiting_permission while the screen has moved on.
  await dialogSessions.tmux(['send-keys', '-t', dialogSessions.target('dialogsess'), '1']);
  await waitFor(async () => !(await dialogSessions.capture('dialogsess')).includes('Do you want to'));

  list = await (await call('GET', '/api/sessions')).json();
  entry = list.find((s) => s.name === 'dialogsess');
  assert.equal(entry.status, 'idle', 'no dialog on screen any more, so the API reports idle');
  assert.equal(entry.message, null);
  assert.equal(status.get('dialogsess').status, 'waiting_permission', 'the store itself is left untouched');

  await dialogSessions.kill('dialogsess');
});
