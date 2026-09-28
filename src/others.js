const fsp = require('node:fs/promises');
const path = require('node:path');
const { encodeCwd } = require('./conversations');
const { PREFIX, validateName } = require('./sessions');

const CLK_TCK = 100;
const TAIL_BYTES = 256 * 1024;

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function bootTimeMs(procRoot) {
  const stat = await readText(path.join(procRoot, 'stat'));
  const m = stat && stat.match(/^btime (\d+)$/m);
  return m ? Number(m[1]) * 1000 : null;
}

// Running Claude Code processes, from /proc: pid, cwd, the tmux pane they run in (if any)
// and when they started. Processes we can't inspect (another user's, already exited) are skipped.
async function listClaudeProcesses(procRoot = '/proc') {
  let entries;
  try {
    entries = await fsp.readdir(procRoot);
  } catch {
    return [];
  }
  const boot = await bootTimeMs(procRoot);
  const out = [];
  for (const pid of entries.filter((e) => /^\d+$/.test(e))) {
    const dir = path.join(procRoot, pid);
    const comm = await readText(path.join(dir, 'comm'));
    if (!comm || comm.trim() !== 'claude') continue;
    let cwd;
    try {
      cwd = await fsp.readlink(path.join(dir, 'cwd'));
    } catch {
      continue;
    }
    const environ = (await readText(path.join(dir, 'environ'))) || '';
    const paneVar = environ.split('\0').find((v) => v.startsWith('TMUX_PANE='));
    const stat = await readText(path.join(dir, 'stat'));
    // Field 22 (starttime, in clock ticks since boot); the command name before it may contain spaces.
    const ticks = stat ? Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]) : NaN;
    out.push({
      pid: Number(pid),
      cwd,
      pane: paneVar ? paneVar.slice('TMUX_PANE='.length) : null,
      startedAt: boot !== null && Number.isFinite(ticks) ? boot + (ticks / CLK_TCK) * 1000 : null,
    });
  }
  return out;
}

// Timestamp of the last user/assistant message in the transcript. Idle Claudes also append
// bookkeeping lines (cost-state, away_summary…) without any hook firing, so the file's mtime
// alone would raise false alarms.
async function lastMessageAt(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= (start > 0 ? 1 : 0); i--) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if ((entry.type === 'user' || entry.type === 'assistant') && !entry.isSidechain && entry.timestamp) {
        const ms = Date.parse(entry.timestamp);
        if (Number.isFinite(ms)) return ms;
      }
    }
    return null;
  } finally {
    await fh.close();
  }
}

async function paneSessions(sessions) {
  const map = new Map();
  try {
    const out = await sessions.tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}']);
    for (const line of out.split('\n').filter(Boolean)) {
      const [pane, session] = line.split('\t');
      map.set(pane, session);
    }
  } catch {
    // No tmux server: every process counts as outside tmux.
  }
  return map;
}

// Other Claude processes that are carrying on this session's conversation: the transcript keeps
// growing while this session's own hooks are silent, and a Claude outside this tmux session runs
// in the same project folder. Then the chat shows that other Claude's work, while the terminal
// and anything sent from the phone go to this session's Claude, which doesn't know about it.
async function findOthers({ name, status, sessions, procRoot = '/proc', graceMs = 60_000 }) {
  const entry = status.get(validateName(name));
  if (!entry.transcriptPath) return [];
  const since = (entry.updatedAt || 0) + graceMs;
  let last;
  try {
    // Cheap check first: most of the time the file hasn't changed since the last hook.
    if ((await fsp.stat(entry.transcriptPath)).mtimeMs <= since) return [];
    last = await lastMessageAt(entry.transcriptPath);
    if (!(last > since)) return [];
  } catch {
    return [];
  }

  const project = path.basename(path.dirname(entry.transcriptPath));
  const procs = (await listClaudeProcesses(procRoot)).filter((p) => encodeCwd(p.cwd) === project);
  if (!procs.length) return [];
  const panes = await paneSessions(sessions);
  const own = `${PREFIX}${name}`;
  return procs
    .map((p) => ({ ...p, session: p.pane ? panes.get(p.pane) || null : null }))
    .filter((p) => p.session !== own)
    // A process started after the latest message can't be the one that wrote it (e.g. a new,
    // unrelated conversation in the same folder).
    .filter((p) => p.startedAt === null || p.startedAt <= last)
    // Another app session is known to be on a different conversation when its hooks say so.
    .filter((p) => {
      if (!p.session || !p.session.startsWith(PREFIX)) return true;
      const linked = status.get(p.session.slice(PREFIX.length)).transcriptPath;
      return !linked || linked === entry.transcriptPath;
    })
    .map((p) => {
      // 'app': another session of this app; 'tmux': some other tmux session; 'outside': no tmux.
      if (!p.session) return { pid: p.pid, where: 'outside', session: null, startedAt: p.startedAt };
      if (p.session.startsWith(PREFIX)) return { pid: p.pid, where: 'app', session: p.session.slice(PREFIX.length), startedAt: p.startedAt };
      return { pid: p.pid, where: 'tmux', session: p.session, startedAt: p.startedAt };
    });
}

module.exports = { listClaudeProcesses, findOthers };
