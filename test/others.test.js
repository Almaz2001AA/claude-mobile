const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { listClaudeProcesses, findOthers } = require('../src/others');

// A fake /proc: <root>/stat with btime and one directory per process.
function fakeProc(root, procs) {
  fs.writeFileSync(path.join(root, 'stat'), 'cpu 1 2 3\nbtime 1000\n');
  for (const p of procs) {
    const dir = path.join(root, String(p.pid));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'comm'), `${p.comm || 'claude'}\n`);
    fs.symlinkSync(p.cwd, path.join(dir, 'cwd'));
    fs.writeFileSync(path.join(dir, 'environ'), ['HOME=/h', ...(p.pane ? [`TMUX_PANE=${p.pane}`] : [])].join('\0'));
    // starttime (field 22) = 500 ticks = 5s after boot; the comm contains a space and ')'.
    const fields = Array.from({ length: 50 }, () => '0');
    fields[18] = '500'; // field 22 = 19th after the state letter
    fs.writeFileSync(path.join(dir, 'stat'), `${p.pid} (cla ude)) S ${fields.join(' ')}`);
  }
}

const message = (type, agoMs) => JSON.stringify({ type, uuid: `${type}-${agoMs}`, timestamp: new Date(Date.now() - agoMs).toISOString() });

function setup({ procs, updatedAgoMs, panes = '', lines = [message('assistant', 1000)] }) {
  const dir = tmpDir();
  const procRoot = path.join(dir, 'proc');
  fs.mkdirSync(procRoot);
  fakeProc(procRoot, procs);
  const transcript = path.join(dir, 'projects', '-home-user-projects-site', 'conv.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`);
  const status = { get: () => ({ status: 'idle', transcriptPath: transcript, updatedAt: Date.now() - updatedAgoMs }) };
  const sessions = { tmux: async () => panes };
  return { procRoot, status, sessions };
}

test('listClaudeProcesses reads cwd, tmux pane and start time', async () => {
  const { procRoot } = setup({
    procs: [
      { pid: 11, cwd: '/home/user/projects/site', pane: '%3' },
      { pid: 12, cwd: '/home/user/projects/site' },
      { pid: 13, cwd: '/tmp', comm: 'bash' },
    ],
    updatedAgoMs: 0,
  });
  const procs = (await listClaudeProcesses(procRoot)).sort((a, b) => a.pid - b.pid);
  assert.deepEqual(procs, [
    { pid: 11, cwd: '/home/user/projects/site', pane: '%3', startedAt: 1_005_000 },
    { pid: 12, cwd: '/home/user/projects/site', pane: null, startedAt: 1_005_000 },
  ]);
});

test('reports Claude outside this session when the transcript moves without its hooks', async () => {
  const deps = setup({
    procs: [
      { pid: 11, cwd: '/home/user/projects/site', pane: '%3' }, // this session's own Claude
      { pid: 12, cwd: '/home/user/projects/site' }, // plain SSH, no tmux
      { pid: 14, cwd: '/home/user/projects/site', pane: '%7' }, // another app session
      { pid: 15, cwd: '/home/user/projects/site', pane: '%9' }, // a non-app tmux session
      { pid: 16, cwd: '/home/user/projects/app' }, // a different folder
    ],
    updatedAgoMs: 10 * 60_000,
    panes: '%3\tclaude-site\n%7\tclaude-site2\n%9\twork\n',
  });
  const others = (await findOthers({ name: 'site', ...deps })).sort((a, b) => a.pid - b.pid);
  assert.deepEqual(others.map(({ pid, where, session }) => ({ pid, where, session })), [
    { pid: 12, where: 'outside', session: null },
    { pid: 14, where: 'app', session: 'site2' },
    { pid: 15, where: 'tmux', session: 'work' },
  ]);
});

test('stays quiet while this session\'s own hooks are recent', async () => {
  const deps = setup({ procs: [{ pid: 12, cwd: '/home/user/projects/site' }], updatedAgoMs: 5_000 });
  assert.deepEqual(await findOthers({ name: 'site', ...deps }), []);
});

test('stays quiet when only this session\'s Claude runs in the folder', async () => {
  const deps = setup({ procs: [{ pid: 11, cwd: '/home/user/projects/site', pane: '%3' }], updatedAgoMs: 10 * 60_000, panes: '%3\tclaude-site\n' });
  assert.deepEqual(await findOthers({ name: 'site', ...deps }), []);
});

test('bookkeeping lines written by an idle Claude are not a conversation carrying on', async () => {
  const deps = setup({
    procs: [{ pid: 12, cwd: '/home/user/projects/site' }],
    updatedAgoMs: 10 * 60_000,
    lines: [message('assistant', 20 * 60_000), JSON.stringify({ type: 'cost-state', sessionId: 's' }), '{"type":"system","subtype":"away_summary"}'],
  });
  assert.deepEqual(await findOthers({ name: 'site', ...deps }), []);
});

test('ignores processes started after the last message and app sessions on another conversation', async () => {
  const deps = setup({
    procs: [
      { pid: 12, cwd: '/home/user/projects/site' },
      { pid: 14, cwd: '/home/user/projects/site', pane: '%7' },
    ],
    updatedAgoMs: 10 * 60_000,
    panes: '%7\tclaude-other\n',
  });
  const own = deps.status.get();
  deps.status = { get: (n) => (n === 'other' ? { transcriptPath: '/elsewhere.jsonl' } : own) };
  // The fake /proc boots at 1000s, so pushing btime to "now" makes pid 12 start after the message.
  fs.writeFileSync(path.join(deps.procRoot, 'stat'), `btime ${Math.floor(Date.now() / 1000)}\n`);
  assert.deepEqual(await findOthers({ name: 'site', ...deps }), []);
});

test('no transcript linked: nothing to compare', async () => {
  const status = { get: () => ({ status: 'idle' }) };
  assert.deepEqual(await findOthers({ name: 'site', status, sessions: {}, procRoot: '/nonexistent' }), []);
});
