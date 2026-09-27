const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionManager, validateName } = require('../src/sessions');
const { UserError } = require('../src/errors');
const { tmpDir, waitFor, killTmuxServer } = require('./helpers');

const socket = `cm-test-${process.pid}-sessions`;
const sessions = new SessionManager({ socket, claudeCmd: 'cat' });

test.after(() => killTmuxServer(socket));

test('validateName accepts lowercase names and rejects the rest', () => {
  for (const ok of ['a', 'my-app', 'x1', 'a'.repeat(32)]) assert.equal(validateName(ok), ok);
  for (const bad of ['', 'A', 'a b', 'a/b', 'a;b', 'a'.repeat(33), 42, undefined]) {
    assert.throws(() => validateName(bad), UserError);
  }
});

test('list returns [] when no tmux server runs', async () => {
  assert.deepEqual(await sessions.list(), []);
});

test('create, list, exists, capture and kill a session', async () => {
  const dir = tmpDir();
  await sessions.create('demo', dir);
  const list = await sessions.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'demo');
  assert.equal(list[0].cwd, dir);
  assert.ok(list[0].activity > 0);
  assert.equal(await sessions.exists('demo'), true);
  assert.equal(await sessions.exists('dem'), false, 'no prefix matching');

  await sessions.tmux(['send-keys', '-t', sessions.target('demo'), '-l', 'ping']);
  await waitFor(async () => (await sessions.capture('demo')).includes('ping'));

  await sessions.kill('demo');
  assert.equal(await sessions.exists('demo'), false);
});

test('create rejects duplicates, missing folders and relative paths', async () => {
  const dir = tmpDir();
  await sessions.create('dup', dir);
  await assert.rejects(sessions.create('dup', dir), (err) => err instanceof UserError && err.status === 409);
  await assert.rejects(sessions.create('nodir', '/definitely/not/here'), UserError);
  await assert.rejects(sessions.create('rel', 'relative/path'), UserError);
  await sessions.kill('dup');
});

test('kill of a missing session is a 404 UserError', async () => {
  await assert.rejects(sessions.kill('ghost'), (err) => err instanceof UserError && err.status === 404);
});

test('list ignores tmux sessions without the claude- prefix', async () => {
  await sessions.tmux(['new-session', '-d', '-s', 'other', 'cat']);
  await sessions.create('mine', tmpDir());
  assert.deepEqual((await sessions.list()).map((s) => s.name), ['mine']);
  await sessions.tmux(['kill-session', '-t', '=other']);
  await sessions.kill('mine');
});

test('list ignores claude- sessions whose remainder is not a valid name', async () => {
  // A raw tmux session that merely starts with the prefix but whose suffix would fail
  // validateName (uppercase, punctuation, empty) must never surface through the API.
  await sessions.tmux(['new-session', '-d', '-s', 'claude-Bad Name', 'cat']);
  await sessions.create('mine2', tmpDir());
  assert.deepEqual((await sessions.list()).map((s) => s.name), ['mine2']);
  await sessions.tmux(['kill-session', '-t', '=claude-Bad Name']);
  await sessions.kill('mine2');
});

test('tmux() does not crash when tmux exits without reading stdin', async () => {
  // No server is running for this socket name, so the tmux client exits immediately;
  // feeding it a large stdin payload used to throw an unhandled EPIPE from the write.
  const lonely = new SessionManager({ socket: `cm-test-${process.pid}-epipe`, claudeCmd: 'cat' });
  await assert.rejects(lonely.tmux(['load-buffer', '-b', 'x', '-'], { input: 'y'.repeat(900000) }));
});
