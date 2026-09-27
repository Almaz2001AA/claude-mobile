const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
const { mergeHooks, installHooks, HOOK_EVENTS } = require('../src/install-hooks');
const { tmpDir, waitFor, killTmuxServer } = require('./helpers');

const NOTIFY = path.resolve(__dirname, '..', 'hooks', 'notify.js');
const socket = `cm-test-${process.pid}-hooks`;
test.after(() => killTmuxServer(socket));

test('mergeHooks adds every event once and keeps existing hooks', () => {
  const existing = { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } };
  const merged = mergeHooks(existing, 'CMD');
  assert.equal(merged.theme, 'dark');
  for (const event of HOOK_EVENTS) {
    const commands = merged.hooks[event].flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(commands.includes('CMD'), event);
  }
  assert.equal(merged.hooks.Stop.length, 2);
  assert.equal(merged.hooks.PreToolUse[0].matcher, '*');
  assert.deepEqual(mergeHooks(merged, 'CMD'), merged, 'idempotent');
  assert.equal(existing.hooks.Stop.length, 1, 'input not mutated');
});

test('installHooks backs up the old settings and refuses broken JSON', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark' }));
  installHooks({ settingsFile: file, command: 'CMD' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).theme, 'dark');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('settings.json.bak-')));

  fs.writeFileSync(file, '{broken');
  assert.throws(() => installHooks({ settingsFile: file, command: 'CMD' }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('installHooks writes through a symlinked settings file instead of replacing the link', () => {
  const dir = tmpDir();
  const real = path.join(dir, 'real-settings.json');
  const link = path.join(dir, 'settings.json');
  fs.writeFileSync(real, JSON.stringify({ theme: 'dark' }));
  fs.symlinkSync(real, link);

  const { backup } = installHooks({ settingsFile: link, command: 'CMD' });

  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the settings.json path is still a symlink');
  assert.equal(fs.realpathSync(link), real, 'still points at the real file');
  const written = JSON.parse(fs.readFileSync(real, 'utf8'));
  assert.equal(written.theme, 'dark');
  assert.ok(written.hooks.Stop[0].hooks.some((h) => h.command === 'CMD'));
  assert.ok(backup.startsWith(real), 'backup is made of the real file, not the link');
  assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8')).theme, 'dark');
});

test('notify.js exits quietly outside tmux', () => {
  const env = { ...process.env };
  delete env.TMUX;
  const res = spawnSync(process.execPath, [NOTIFY], { input: '{"hook_event_name":"Stop"}', env, timeout: 5000 });
  assert.equal(res.status, 0);
});

test('notify.js inside a claude- tmux session posts the event with the session name', async () => {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'hook-secret'), 's'.repeat(64));
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, secret: req.headers['x-hook-secret'], body: JSON.parse(body) });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const fixture = path.join(home, 'event.json');
  fs.writeFileSync(fixture, JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    transcript_path: '/t/s1.jsonl',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_response: { stdout: 'x'.repeat(500000) },
  }));
  execFileSync('tmux', [
    '-L', socket, 'new-session', '-d', '-s', 'claude-hooktest',
    '-e', `CLAUDE_MOBILE_HOME=${home}`,
    '-e', `CLAUDE_MOBILE_PORT=${server.address().port}`,
    `${process.execPath} ${NOTIFY} < ${fixture}; sleep 5`,
  ]);
  await waitFor(() => received.length === 1, { timeoutMs: 5000 });
  assert.equal(received[0].url, '/internal/hook');
  assert.equal(received[0].secret, 's'.repeat(64));
  assert.equal(received[0].body.tmuxSession, 'claude-hooktest');
  // Only the whitelisted subset travels over the wire: the huge tool_response (and other
  // PostToolUse fields) never leaves the box.
  assert.deepEqual(received[0].body.event, {
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    transcript_path: '/t/s1.jsonl',
  });
  server.close();
});
