const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { tmpDir, waitFor, killTmuxServer } = require('./helpers');

const CC_BIN = path.resolve(__dirname, '..', 'bin', 'cc');
const socket = `cm-test-${process.pid}-cc`;

let home;
let fakeBinDir;

test.before(() => {
  home = tmpDir();
  fakeBinDir = tmpDir();
  // A stand-in for the real `claude` binary: echoes its args (so the test can see whether
  // --continue was appended) then keeps the pane alive with `cat`, like the real CLI would.
  const fakeClaude = path.join(fakeBinDir, 'claude');
  fs.writeFileSync(fakeClaude, '#!/bin/sh\necho FAKE "$@"; cat\n');
  fs.chmodSync(fakeClaude, 0o755);
});

test.after(() => killTmuxServer(socket));

function runCc(args, envExtra = {}) {
  return execFileSync(CC_BIN, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      CLAUDE_MOBILE_HOME: home,
      CC_TMUX_SOCKET: socket,
      CC_NO_ATTACH: '1',
      ...envExtra,
    },
  });
}

function tmuxCapture(session) {
  return execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-t', `=${session}:`], { encoding: 'utf8' });
}

function tmuxHasSession(session) {
  try {
    execFileSync('tmux', ['-L', socket, 'has-session', '-t', `=${session}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function writeFavorites(items) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'favorites.json'), JSON.stringify(items));
}

test('cc <name> resolves a favorite folder and runs claude --continue by default', async () => {
  const cwd = tmpDir();
  writeFavorites([{ name: 'proj', cwd }]);
  runCc(['proj']);
  assert.ok(tmuxHasSession('claude-proj'));
  await waitFor(async () => tmuxCapture('claude-proj').includes('FAKE'));
  assert.match(tmuxCapture('claude-proj'), /FAKE --continue/);
  const pwdOut = execFileSync('tmux', ['-L', socket, 'list-panes', '-t', '=claude-proj', '-F', '#{pane_current_path}'], { encoding: 'utf8' }).trim();
  assert.equal(pwdOut, fs.realpathSync(cwd));
  execFileSync('tmux', ['-L', socket, 'kill-session', '-t', '=claude-proj']);
});

test('cc <path> uses the directory itself when it is not a favorite, naming the session from its basename', async () => {
  const cwd = tmpDir();
  const base = path.basename(cwd).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 32);
  writeFavorites([]);
  runCc([cwd]);
  assert.ok(tmuxHasSession(`claude-${base}`));
  await waitFor(async () => tmuxCapture(`claude-${base}`).includes('FAKE'));
  assert.match(tmuxCapture(`claude-${base}`), /FAKE --continue/);
  execFileSync('tmux', ['-L', socket, 'kill-session', '-t', `=claude-${base}`]);
});

test('cc -n starts a fresh conversation without --continue', async () => {
  const cwd = tmpDir();
  writeFavorites([{ name: 'freshone', cwd }]);
  runCc(['-n', 'freshone']);
  await waitFor(async () => tmuxCapture('claude-freshone').includes('FAKE'));
  const pane = tmuxCapture('claude-freshone');
  assert.match(pane, /FAKE\s*\n/);
  assert.doesNotMatch(pane, /--continue/);
  execFileSync('tmux', ['-L', socket, 'kill-session', '-t', '=claude-freshone']);
});

test('cc <unknown> fails with a clear error and a non-zero exit', () => {
  writeFavorites([]);
  assert.throws(() => runCc(['definitely-not-a-favorite-or-path']), (err) => {
    assert.notEqual(err.status, 0);
    assert.match(err.stderr.toString(), /Не найдено: definitely-not-a-favorite-or-path/);
    return true;
  });
});

test('cc does not recreate an already-running session', async () => {
  const cwd = tmpDir();
  writeFavorites([{ name: 'already', cwd }]);
  runCc(['already']);
  await waitFor(async () => tmuxCapture('claude-already').includes('FAKE'));
  runCc(['already']); // second call: session already exists, must not spawn claude again
  await new Promise((r) => setTimeout(r, 200));
  const pane = tmuxCapture('claude-already');
  assert.equal(pane.match(/FAKE/g).length, 1, 'claude was only launched once');
  execFileSync('tmux', ['-L', socket, 'kill-session', '-t', '=claude-already']);
});

test('cc actually execs tmux attach-session (not a shell function) when not already inside tmux', async () => {
  const cwd = tmpDir();
  writeFavorites([{ name: 'attachme', cwd }]);
  const wrapperDir = tmpDir();
  const log = path.join(wrapperDir, 'log');
  const realTmux = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
  const wrapper = path.join(wrapperDir, 'tmux');
  // Logs every invocation; fakes a successful `attach-session` (no real TTY in tests) and
  // otherwise execs the real tmux so session creation still actually happens.
  fs.writeFileSync(wrapper, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${log}"`,
    'for a in "$@"; do',
    '  if [ "$a" = "attach-session" ]; then',
    '    exit 0',
    '  fi',
    'done',
    `exec "${realTmux}" "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(wrapper, 0o755);

  execFileSync(CC_BIN, ['attachme'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${wrapperDir}:${fakeBinDir}:${process.env.PATH}`,
      CLAUDE_MOBILE_HOME: home,
      CC_TMUX_SOCKET: socket,
      // Deliberately no CC_NO_ATTACH: this exercises the real (non-test-shortcut) attach path.
    },
  });
  const logged = fs.readFileSync(log, 'utf8').trim().split('\n');
  const attachLine = logged.find((l) => l.includes('attach-session'));
  assert.ok(attachLine, `expected an attach-session call, got:\n${logged.join('\n')}`);
  assert.match(attachLine, /attach-session -t =claude-attachme/);
  execFileSync('tmux', ['-L', socket, 'kill-session', '-t', '=claude-attachme']);
});

test('cc falls back to a hash-based name for a folder whose basename sanitizes to nothing', async () => {
  const parent = tmpDir();
  const cwd = path.join(parent, '日本語');
  fs.mkdirSync(cwd);
  writeFavorites([]);
  runCc([cwd]);
  const out = runCc(['ls']);
  const match = out.match(/^(d-[0-9a-f]{8})\s+/m);
  assert.ok(match, `expected a d-<hash> session name in:\n${out}`);
  execFileSync('tmux', ['-L', socket, 'kill-session', '-t', `=claude-${match[1]}`]);
});

test('cc warns to stderr when an existing session was started in a different folder', async () => {
  const cwd1 = tmpDir();
  const cwd2 = tmpDir();
  writeFavorites([{ name: 'moved', cwd: cwd1 }]);
  runCc(['moved']);
  await waitFor(async () => tmuxCapture('claude-moved').includes('FAKE'));
  writeFavorites([{ name: 'moved', cwd: cwd2 }]);
  const res = spawnSync(CC_BIN, ['moved'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, CLAUDE_MOBILE_HOME: home, CC_TMUX_SOCKET: socket, CC_NO_ATTACH: '1' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /другой папке/);
  execFileSync('tmux', ['-L', socket, 'kill-session', '-t', '=claude-moved']);
});

test('cc -n on an already-running session attaches instead of silently starting a new conversation', async () => {
  const cwd = tmpDir();
  writeFavorites([{ name: 'alreadyn', cwd }]);
  runCc(['alreadyn']);
  await waitFor(async () => tmuxCapture('claude-alreadyn').includes('FAKE'));
  const res = spawnSync(CC_BIN, ['-n', 'alreadyn'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, CLAUDE_MOBILE_HOME: home, CC_TMUX_SOCKET: socket, CC_NO_ATTACH: '1' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /флаг -n проигнорирован/);
  const pane = tmuxCapture('claude-alreadyn');
  assert.equal(pane.match(/FAKE/g).length, 1, 'claude was only launched once');
  execFileSync('tmux', ['-L', socket, 'kill-session', '-t', '=claude-alreadyn']);
});

test('cc ls lists claude-* sessions with their name and path', async () => {
  const cwd = tmpDir();
  writeFavorites([{ name: 'listed', cwd }]);
  runCc(['listed']);
  await waitFor(async () => tmuxCapture('claude-listed').includes('FAKE'));
  const out = runCc(['ls']);
  assert.match(out, /listed/);
  assert.match(out, new RegExp(fs.realpathSync(cwd).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  execFileSync('tmux', ['-L', socket, 'kill-session', '-t', '=claude-listed']);
});
