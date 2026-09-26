const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { verifyPin } = require('../src/auth');
const { tmpDir, waitFor } = require('./helpers');

const CLI = path.resolve(__dirname, '..', 'bin', 'claude-mobile.js');
const run = (args, { env = {}, input } = {}) => spawnSync(process.execPath, [CLI, ...args], {
  env: { ...process.env, ...env }, input, encoding: 'utf8', timeout: 10000,
});

test('set-pin stores a hash; invalid PINs are refused', () => {
  const home = tmpDir();
  const res = run(['set-pin'], { env: { CLAUDE_MOBILE_HOME: home }, input: '2468\n' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(verifyPin('2468', fs.readFileSync(path.join(home, 'pin'), 'utf8').trim()), true);
  assert.notEqual(run(['set-pin'], { env: { CLAUDE_MOBILE_HOME: home }, input: 'ab\n' }).status, 0);
});

test('install-hooks writes hooks into the given settings file', () => {
  const home = tmpDir();
  const settings = path.join(home, 'settings.json');
  const res = run(['install-hooks'], { env: { CLAUDE_MOBILE_HOME: home, CLAUDE_SETTINGS_FILE: settings } });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.match(parsed.hooks.Stop[0].hooks[0].command, /notify\.js"$/);
  assert.ok(fs.existsSync(path.join(home, 'hook-secret')));
});

test('serve refuses to start without a PIN', () => {
  const res = run(['serve'], { env: { CLAUDE_MOBILE_HOME: tmpDir() } });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /set-pin/);
});

test('serve starts and answers on the configured port', async () => {
  const home = tmpDir();
  run(['set-pin'], { env: { CLAUDE_MOBILE_HOME: home }, input: '2468\n' });
  const port = 20000 + (process.pid % 20000);
  const child = spawn(process.execPath, [CLI, 'serve'], { env: { ...process.env, CLAUDE_MOBILE_HOME: home, CLAUDE_MOBILE_PORT: String(port) } });
  try {
    const res = await waitFor(() => fetch(`http://127.0.0.1:${port}/api/me`).catch(() => null), { timeoutMs: 5000 });
    assert.equal(res.status, 401);
  } finally {
    child.kill();
  }
});

test('unknown command prints usage', () => {
  const res = run(['wat']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /serve \| set-pin \| install-hooks/);
});
