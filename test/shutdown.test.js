const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const WebSocket = require('ws');
const { createApp } = require('../src/server');
const { Auth, hashPin } = require('../src/auth');
const { Viewers } = require('../src/viewers');
const { waitFor } = require('./helpers');

const SECRET = 'c'.repeat(64);
const auth = new Auth({ pinHash: hashPin('1234'), secret: SECRET });

// Lightweight fakes: these tests are about the HTTP/WS plumbing (crash guards, shutdown,
// heartbeat), not about tmux, so a real SessionManager/StatusStore would only add noise.
function fakeDeps(overrides = {}) {
  return {
    sessions: { exists: async () => true, baseArgs: () => [] },
    status: { get: () => ({ status: 'idle' }), on() {}, off() {} },
    viewers: new Viewers(),
    auth,
    publicDir: '/nonexistent',
    ...overrides,
  };
}

async function listen(app) {
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return app.server.address().port;
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

test('a client RST while handleUpgrade awaits sessions.exists() does not crash the process', () => {
  // Reproduced out-of-process: an unhandled 'error' event on the raw socket throws and
  // kills the whole node process, which would otherwise take this whole test run down too.
  const script = path.join(__dirname, 'fixtures', 'rst-during-upgrade.js');
  const res = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(res.status, 0, `child crashed:\n${res.stderr}`);
  assert.match(res.stdout, /still alive after RST/);
});

test('a WS frame over maxPayload does not crash the process, and the server keeps answering other requests', () => {
  const script = path.join(__dirname, 'fixtures', 'oversized-frame.js');
  const res = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(res.status, 0, `child crashed:\n${res.stderr}`);
  assert.match(res.stdout, /still alive after oversized frame/);
  assert.match(res.stdout, /http status after oversized frame: 401/);
});

test('close() terminates open WebSockets instead of waiting for them to disconnect on their own', async () => {
  const app = createApp(fakeDeps());
  const port = await listen(app);
  const cookie = `cm_auth=${auth.issue()}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/abc`, { headers: { cookie, origin: `http://127.0.0.1:${port}` } });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const start = Date.now();
  await withTimeout(
    new Promise((resolve) => app.close(resolve)),
    2000,
    'server did not finish closing within 2s with an open WS',
  );
  assert.ok(Date.now() - start < 2000, 'expected a fast close');
});

test('heartbeat terminates a WebSocket that stops answering pings, and leaves a responsive one alone', async () => {
  const app = createApp({ ...fakeDeps(), heartbeatIntervalMs: 40 });
  const port = await listen(app);
  const cookie = `cm_auth=${auth.issue()}`;
  const origin = `http://127.0.0.1:${port}`;

  const dead = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/abc`, { headers: { cookie, origin } });
  const alive = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/abc`, { headers: { cookie, origin } });
  try {
    await Promise.all([
      new Promise((resolve, reject) => { dead.on('open', resolve); dead.on('error', reject); }),
      new Promise((resolve, reject) => { alive.on('open', resolve); alive.on('error', reject); }),
    ]);
    assert.equal(app.wss.clients.size, 2);
    // Stop the "dead" client's socket from processing any more incoming frames, so the ws
    // library's normal auto-pong-on-ping never fires for it — simulating a phone that
    // dropped off the network without a clean close. Note: because the socket is paused,
    // the *client* side may never observe its own 'close' event (Node defers 'end' until
    // the paused stream is drained), so we assert on the server's own bookkeeping instead.
    dead._socket.pause();

    await waitFor(() => app.wss.clients.size === 1, { timeoutMs: 2000 });

    // The responsive client must survive several heartbeat cycles untouched.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(app.wss.clients.size, 1);
    assert.equal(alive.readyState, WebSocket.OPEN);
  } finally {
    alive.close();
    app.close();
  }
});
