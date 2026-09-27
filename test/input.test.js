const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionManager } = require('../src/sessions');
const { InputSender } = require('../src/input');
const { UserError } = require('../src/errors');
const { tmpDir, waitFor, killTmuxServer } = require('./helpers');

const socket = `cm-test-${process.pid}-input`;
const sessions = new SessionManager({ socket, claudeCmd: 'cat' });
const input = new InputSender({ sessions, enterDelayMs: 20 });

test.after(() => killTmuxServer(socket));

const screenHas = (name, text) => waitFor(async () => (await sessions.capture(name)).includes(text));

test('sendText types a single line and presses Enter', async () => {
  await sessions.create('one', tmpDir());
  await input.sendText('one', '-x hello');
  // cat echoes the typed line, then prints it again after Enter.
  await waitFor(async () => (await sessions.capture('one')).split('-x hello').length === 3);
  await sessions.kill('one');
});

test('sendText pastes multi-line text', async () => {
  await sessions.create('multi', tmpDir());
  await input.sendText('multi', 'line one\nline two');
  await screenHas('multi', 'line two');
  await sessions.kill('multi');
});

test('sendText routes long single-line text through load-buffer/paste-buffer instead of a send-keys argv (avoids spawn E2BIG)', async () => {
  // A real tmux round-trip can't distinguish the two mechanisms by terminal output (both
  // end up typed), and a payload big enough to actually trip E2BIG is slow to capture from
  // a wrapped terminal screen. Assert on the tmux subcommands issued instead.
  const calls = [];
  const fakeSessions = {
    target: () => 'target',
    tmux: async (args) => { calls.push(args[0]); return ''; },
  };
  const fakeInput = new InputSender({ sessions: fakeSessions, enterDelayMs: 0 });
  await fakeInput.sendText('x', 'z'.repeat(4096));
  assert.deepEqual(calls, ['send-keys', 'send-keys'], 'exactly at the threshold still uses send-keys');

  calls.length = 0;
  await fakeInput.sendText('x', 'z'.repeat(4097));
  assert.deepEqual(calls, ['load-buffer', 'paste-buffer', 'send-keys'], 'over the threshold pastes via a buffer');
});

test('sendText rejects empty text', async () => {
  await assert.rejects(input.sendText('whatever', '   '), UserError);
});

test('sendKey maps names to tmux keys and rejects unknown ones', async () => {
  await sessions.create('keys', tmpDir());
  await input.sendKey('keys', 'enter');
  await assert.rejects(input.sendKey('keys', 'rm -rf'), UserError);
  await sessions.kill('keys');
});

test('answerPermission sends the digit when a dialog is on screen', async () => {
  const dialogSessions = new SessionManager({
    socket,
    claudeCmd: "printf 'Do you want to proceed?\\n❯ 1. Yes\\n  2. No\\n'; cat",
  });
  const dialogInput = new InputSender({ sessions: dialogSessions, enterDelayMs: 20 });
  await dialogSessions.create('perm', tmpDir());
  await screenHas('perm', '2. No');
  const dialog = await dialogInput.readPermission('perm');
  assert.deepEqual(dialog.options.map((o) => o.key), ['1', '2']);
  await assert.rejects(dialogInput.answerPermission('perm', '7'), UserError);
  await dialogInput.answerPermission('perm', '1');
  await dialogSessions.kill('perm');
});

test('answerPermission refuses when no dialog is shown', async () => {
  await sessions.create('nodialog', tmpDir());
  await assert.rejects(input.answerPermission('nodialog', '1'), (err) => err.status === 409);
  await sessions.kill('nodialog');
});
