// Regression fixture for the WS error guard (run out-of-process by shutdown.test.js): a
// client frame over maxPayload must not take the whole process down with an unhandled
// 'error' event on the WebSocket instance.
const WebSocket = require('ws');
const { createApp } = require('../../src/server');
const { Auth, hashPin } = require('../../src/auth');

const auth = new Auth({ pinHash: hashPin('123456'), secret: 'c'.repeat(64) });
const sessions = { exists: async () => true, baseArgs: () => [] };
const status = { get: () => ({ status: 'idle' }), on() {}, off() {} };
const viewers = { add() {}, remove() {}, update() {} };
const app = createApp({ sessions, status, viewers, auth, publicDir: '/nonexistent' });

app.server.listen(0, '127.0.0.1', () => {
  const port = app.server.address().port;
  const token = auth.issue();
  const cookie = `cm_auth=${token}`;
  const origin = `http://127.0.0.1:${port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/abc`, { headers: { cookie, origin } });
  ws.on('error', () => {}); // the server drops the connection; the client sees this too
  ws.on('open', () => {
    ws.send('x'.repeat(2 * 1024 * 1024)); // over the 1MB maxPayload
  });
  setTimeout(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/me`);
      console.log('http status after oversized frame:', res.status);
      console.log('still alive after oversized frame');
    } catch (err) {
      console.error('fetch failed after oversized frame:', err);
      process.exitCode = 1;
    }
    app.close(() => process.exit());
  }, 500);
});
