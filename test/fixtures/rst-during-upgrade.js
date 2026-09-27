// Regression fixture for the handleUpgrade crash guard (run out-of-process by
// shutdown.test.js): a client that resets its socket while the server is still awaiting
// sessions.exists() must not take the whole process down with an unhandled 'error' event.
const net = require('node:net');
const { createApp } = require('../../src/server');
const { Auth, hashPin } = require('../../src/auth');

const auth = new Auth({ pinHash: hashPin('1234'), secret: 'c'.repeat(64) });
// sessions.exists() resolves slowly, giving the RST time to land while handleUpgrade awaits it.
const sessions = { exists: () => new Promise((resolve) => setTimeout(() => resolve(true), 300)), baseArgs: () => [] };
const status = { get: () => ({ status: 'idle' }), on() {}, off() {} };
const viewers = { add() {}, remove() {}, update() {} };
const app = createApp({ sessions, status, viewers, auth, publicDir: '/nonexistent' });

app.server.listen(0, '127.0.0.1', () => {
  const port = app.server.address().port;
  const token = auth.issue();
  const sock = net.connect(port, '127.0.0.1', () => {
    sock.write(
      `GET /ws/chat/abc HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\n` +
      `Cookie: cm_auth=${token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    setTimeout(() => sock.resetAndDestroy(), 50);
  });
  setTimeout(() => {
    console.log('still alive after RST');
    app.close(() => process.exit(0));
  }, 800);
});
