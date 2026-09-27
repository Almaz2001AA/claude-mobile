const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { getPaths, getPort, getListenTarget, listenOn, readJson, writeJson, getOrCreateSecret } = require('../src/config');
const { tmpDir } = require('./helpers');

test('getPaths honours CLAUDE_MOBILE_HOME and CLAUDE_MOBILE_UPLOADS', () => {
  const p = getPaths({ CLAUDE_MOBILE_HOME: '/x/cfg', CLAUDE_MOBILE_UPLOADS: '/x/up' });
  assert.equal(p.base, '/x/cfg');
  assert.equal(p.links, '/x/cfg/links.json');
  assert.equal(p.quick, '/x/cfg/quick.json');
  assert.equal(p.favorites, '/x/cfg/favorites.json');
  assert.equal(p.hookSecret, '/x/cfg/hook-secret');
  assert.equal(p.uploads, '/x/up');
});

test('getPort defaults to 8787', () => {
  assert.equal(getPort({}), 8787);
  assert.equal(getPort({ CLAUDE_MOBILE_PORT: '9000' }), 9000);
});

test('writeJson/readJson round-trip with private file mode', () => {
  const file = path.join(tmpDir(), 'nested', 'a.json');
  writeJson(file, { a: 1 });
  assert.deepEqual(readJson(file, null), { a: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('readJson returns fallback for missing or broken files', () => {
  const dir = tmpDir();
  assert.deepEqual(readJson(path.join(dir, 'none.json'), []), []);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
  assert.equal(readJson(path.join(dir, 'bad.json'), 7), 7);
});

test('getOrCreateSecret creates once and then reuses', () => {
  const file = path.join(tmpDir(), 'secret');
  const first = getOrCreateSecret(file);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(getOrCreateSecret(file), first);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('getListenTarget defaults to TCP on 127.0.0.1, and switches to a unix socket for CLAUDE_MOBILE_LISTEN=unix:...', () => {
  assert.deepEqual(getListenTarget({}), { type: 'tcp', port: 8787, host: '127.0.0.1' });
  assert.deepEqual(getListenTarget({ CLAUDE_MOBILE_PORT: '9000' }), { type: 'tcp', port: 9000, host: '127.0.0.1' });
  assert.deepEqual(getListenTarget({ CLAUDE_MOBILE_LISTEN: 'unix:/run/x.sock' }), { type: 'unix', path: '/run/x.sock' });
});

test('listenOn a unix socket: removes a stale socket file, creates a private parent dir, and chmods the socket to 0600', async () => {
  const dir = path.join(tmpDir(), 'nested');
  const sockPath = path.join(dir, 'http.sock');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sockPath, 'stale, not a real socket'); // simulates a leftover from a crashed run
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve, reject) => {
    listenOn(server, { type: 'unix', path: sockPath }, resolve);
    server.on('error', reject);
  });
  try {
    assert.equal(fs.statSync(sockPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ socketPath: sockPath, path: '/', method: 'GET' }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body, 'ok');
  } finally {
    server.close();
  }
});

test('listenOn TCP just listens on host:port', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => listenOn(server, { type: 'tcp', port: 0, host: '127.0.0.1' }, resolve));
  try {
    assert.ok(server.address().port > 0);
  } finally {
    server.close();
  }
});
