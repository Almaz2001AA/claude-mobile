const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { tmpDir, waitFor } = require('./helpers');

// These tests run the real deploy/ensure-running.sh against a fully isolated $HOME (own
// TS_DIR/LOG_DIR/ENV_FILE) and a fake bin/claude-mobile.js, so they never touch the real
// deployment's ~/.config/claude-mobile, ~/.local/state/claude-mobile or its running service.
// The real tailscaled (already running on this host under the same OS user) is expected to
// match the script's own tailscaled-already-running check, so these deliberately don't
// exercise or assert on the tailscaled-start branch at all -- only the claude-mobile
// supervisor loop, which is fully independent of it.
const REAL_SCRIPT = path.resolve(__dirname, '..', 'deploy', 'ensure-running.sh');

// Copies the real script, tagging its embedded supervisor sub-shell with a random, one-off
// marker (a harmless `: "<marker>"` no-op) so this test's own wrapper process can later be
// found and killed with `pkill -f <marker>` WITHOUT ever risking matching the real, deployed
// supervisor loop -- which runs byte-identical script content, and so would otherwise be
// indistinguishable from a copy by process command line alone.
function setupFakeApp() {
  const appDir = tmpDir();
  fs.mkdirSync(path.join(appDir, 'deploy'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'bin'), { recursive: true });
  const script = path.join(appDir, 'deploy', 'ensure-running.sh');
  const marker = `TEST_MARKER_${crypto.randomBytes(8).toString('hex')}`;
  const content = fs.readFileSync(REAL_SCRIPT, 'utf8').replace(
    "setsid sh -c '\n",
    `setsid sh -c '\n  : "${marker}"\n`,
  );
  assert.notEqual(content, fs.readFileSync(REAL_SCRIPT, 'utf8'), 'marker injection point not found in the real script');
  fs.writeFileSync(script, content);
  fs.chmodSync(script, 0o755);
  return { appDir, script, marker };
}

// A stand-in for bin/claude-mobile.js: records each start (pid + CLAUDE_MOBILE_LISTEN) into
// markerDir/starts.log, then exits quickly so the restart loop actually loops within a test's
// lifetime instead of running forever like the real `serve`.
function fakeClaudeMobile(appDir, markerDir) {
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'bin', 'claude-mobile.js'), `
const fs = require('fs');
const path = require('path');
const dir = ${JSON.stringify(markerDir)};
fs.appendFileSync(path.join(dir, 'starts.log'), process.pid + ' ' + (process.env.CLAUDE_MOBILE_LISTEN || '(none)') + '\\n');
setTimeout(() => process.exit(0), 250);
`);
}

// A stand-in for a "legacy" claude-mobile.js: stays alive (like the real `serve`), unlike
// fakeClaudeMobile() above which exits quickly to exercise the restart loop.
function fakeLongRunningClaudeMobile(appDir, markerDir) {
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'bin', 'claude-mobile.js'), `
const fs = require('fs');
const path = require('path');
const dir = ${JSON.stringify(markerDir)};
fs.appendFileSync(path.join(dir, 'starts.log'), process.pid + ' ' + (process.env.CLAUDE_MOBILE_LISTEN || '(none)') + '\\n');
setInterval(() => {}, 1000);
`);
}

function startsLog(markerDir) {
  try {
    return fs.readFileSync(path.join(markerDir, 'starts.log'), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function runScript(script, home, envExtra = {}) {
  execFileSync(script, [], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, NODE: process.execPath, ...envExtra },
  });
}

// Kills this test's supervisor wrapper (by its unique marker: see setupFakeApp) and any
// currently-running fake claude-mobile.js (by its unique, per-test appDir path -- a real
// argv, unlike the wrapper's literal, unexpanded script text). Once the wrapper is dead it
// won't respawn anything, so an in-flight node/sleep child left behind exits on its own
// within a couple of seconds even without being killed directly.
function cleanup(appDir, marker) {
  try {
    execFileSync('pkill', ['-f', marker], { stdio: 'ignore' });
  } catch {}
  try {
    execFileSync('pkill', ['-f', appDir], { stdio: 'ignore' });
  } catch {}
}

test('the supervisor loop restarts claude-mobile.js repeatedly (crash/exit recovery)', async () => {
  const { appDir, script, marker } = setupFakeApp();
  const home = tmpDir();
  const markerDir = tmpDir();
  fakeClaudeMobile(appDir, markerDir);
  try {
    runScript(script, home);
    await waitFor(() => startsLog(markerDir).length >= 2, { timeoutMs: 6000 });
    assert.ok(startsLog(markerDir).length >= 2, 'claude-mobile.js was started more than once');
  } finally {
    cleanup(appDir, marker);
  }
});

test('a pre-existing, non-supervised claude-mobile.js process (started before this restart-loop mechanism, or by a different node path) is recognized and not duplicated', async () => {
  const { appDir, script, marker } = setupFakeApp();
  const home = tmpDir();
  const markerDir = tmpDir();
  fakeLongRunningClaudeMobile(appDir, markerDir);
  // Started directly, exactly the way the old (pre-restart-loop) script did: a bare node
  // process, no supervisor loop, no APP_LOCK held. This is also what a plain `node
  // bin/claude-mobile.js serve` (e.g. from an old shell) or a node started via a since-
  // upgraded/removed nvm path would look like.
  const legacy = spawn(process.execPath, [path.join(appDir, 'bin', 'claude-mobile.js'), 'serve'], { stdio: 'ignore' });
  try {
    await waitFor(() => startsLog(markerDir).length >= 1, { timeoutMs: 2000 });
    assert.equal(startsLog(markerDir).length, 1, 'only the legacy process has started so far');
    runScript(script, home);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(startsLog(markerDir).length, 1, 'ensure-running.sh must not start a second, port-clashing instance');
  } finally {
    legacy.kill('SIGKILL');
    cleanup(appDir, marker);
  }
});

test('a second invocation while the loop is still alive does not start a second loop', async () => {
  const { appDir, script, marker } = setupFakeApp();
  const home = tmpDir();
  const markerDir = tmpDir();
  fakeClaudeMobile(appDir, markerDir);
  try {
    runScript(script, home);
    await waitFor(() => startsLog(markerDir).length >= 1, { timeoutMs: 3000 });
    const before = startsLog(markerDir).length;
    runScript(script, home); // should see APP_LOCK already held and exit without spawning
    runScript(script, home);
    await new Promise((r) => setTimeout(r, 600));
    // Every start still comes from a single loop pacing itself at ~250ms run + 2s sleep, so a
    // second/third loop would show up as extra starts far above what one loop could produce
    // in this short a window (one loop: at most ~2-3 starts here).
    const after = startsLog(markerDir).length;
    assert.ok(after - before <= 3, `expected roughly one loop's worth of extra starts, got ${after - before}`);

    // Directly confirm there is exactly one flock holder on APP_LOCK.
    const lockFile = path.join(home, '.local', 'state', 'claude-mobile', 'claude-mobile.lock');
    await waitFor(() => fs.existsSync(lockFile));
    let heldByOne = true;
    try {
      // flock -n on an already-exclusively-locked file fails immediately; run it as a fresh
      // holder attempt to prove the file is indeed still locked by the running loop.
      execFileSync('flock', ['-n', lockFile, '-c', 'true']);
      heldByOne = false; // it would only succeed if nothing else holds the lock
    } catch {
      // expected: still locked by the running loop
    }
    assert.equal(heldByOne, true, 'APP_LOCK should still be held by the one running loop');
  } finally {
    cleanup(appDir, marker);
  }
});

test('CLAUDE_MOBILE_LISTEN from ~/.config/claude-mobile/env reaches claude-mobile.js', async () => {
  const { appDir, script, marker } = setupFakeApp();
  const home = tmpDir();
  const markerDir = tmpDir();
  fakeClaudeMobile(appDir, markerDir);
  fs.mkdirSync(path.join(home, '.config', 'claude-mobile'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'claude-mobile', 'env'), 'CLAUDE_MOBILE_LISTEN=unix:/tmp/whatever.sock\n');
  try {
    runScript(script, home);
    await waitFor(() => startsLog(markerDir).length >= 1, { timeoutMs: 3000 });
    assert.match(startsLog(markerDir)[0], /unix:\/tmp\/whatever\.sock/);
  } finally {
    cleanup(appDir, marker);
  }
});

test('log rotation: claude-mobile.log over 5 MiB is moved to .log.1 before the next start', async () => {
  const { appDir, script, marker } = setupFakeApp();
  const home = tmpDir();
  const markerDir = tmpDir();
  fakeClaudeMobile(appDir, markerDir);
  const logDir = path.join(home, '.local', 'state', 'claude-mobile');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'claude-mobile.log');
  fs.writeFileSync(logFile, Buffer.alloc(6 * 1024 * 1024, 'x'));
  try {
    runScript(script, home);
    await waitFor(() => fs.existsSync(`${logFile}.1`), { timeoutMs: 3000 });
    assert.ok(fs.statSync(`${logFile}.1`).size >= 6 * 1024 * 1024);
  } finally {
    cleanup(appDir, marker);
  }
});
