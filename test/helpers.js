const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { delay } = require('../src/util');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-'));
}

async function waitFor(check, { timeoutMs = 3000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await delay(intervalMs);
  }
  throw new Error('waitFor timed out');
}

function killTmuxServer(socket) {
  try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch {}
  // tmux leaves its socket file behind even after kill-server in some versions/timings;
  // clean it up so test runs don't accumulate socket files in the tmux tmpdir. Only ever
  // remove sockets that are clearly ours (the cm-test- prefix every test socket uses).
  if (!socket.startsWith('cm-test-')) return;
  const tmpBase = process.env.TMUX_TMPDIR || os.tmpdir();
  const socketPath = path.join(tmpBase, `tmux-${process.getuid()}`, socket);
  try { fs.unlinkSync(socketPath); } catch {}
}

const { EventEmitter } = require('node:events');

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
  }

  send(data) {
    this.sent.push(data);
  }

  close(code, reason) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closed = { code, reason };
    this.emit('close');
  }

  json() {
    return this.sent.map((d) => JSON.parse(d));
  }
}

module.exports = { tmpDir, waitFor, killTmuxServer, FakeWs };
