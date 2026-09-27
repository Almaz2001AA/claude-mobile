const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { UserError } = require('./errors');
const { hasConversation } = require('./conversations');

const PREFIX = 'claude-';
const NAME_RE = /^[a-z0-9-]{1,32}$/;

function validateName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new UserError('Имя: латиница в нижнем регистре, цифры и дефис, до 32 символов');
  }
  return name;
}

// The only place in the app that runs tmux. Arguments are passed as an array, never through a shell.
class SessionManager {
  constructor({ socket = null, claudeCmd = 'claude', projectsRoot } = {}) {
    this.socket = socket;
    this.claudeCmd = claudeCmd;
    this.projectsRoot = projectsRoot;
  }

  baseArgs() {
    return this.socket ? ['-L', this.socket] : [];
  }

  // Exact-match session target, shared by anything that needs `=claude-<name>` (no trailing pane colon).
  sessionTarget(name) {
    return `=${PREFIX}${validateName(name)}`;
  }

  // Exact-match pane target for a session.
  target(name) {
    return `${this.sessionTarget(name)}:`;
  }

  tmux(args, { input } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile('tmux', [...this.baseArgs(), ...args], { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout);
      });
      // tmux can exit (e.g. no server) before reading stdin; without this the EPIPE is an unhandled error.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }

  async list() {
    let out;
    try {
      out = await this.tmux(['list-sessions', '-F', '#{session_name}\t#{session_activity}\t#{pane_current_path}']);
    } catch (err) {
      if (/no server running|no sessions|error connecting/i.test(err.message)) return [];
      throw err;
    }
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .filter(([session]) => session.startsWith(PREFIX) && NAME_RE.test(session.slice(PREFIX.length)))
      .map(([session, activity, cwd]) => ({
        name: session.slice(PREFIX.length),
        activity: Number(activity) * 1000,
        cwd,
      }));
  }

  async exists(name) {
    try {
      await this.tmux(['has-session', '-t', this.sessionTarget(name)]);
      return true;
    } catch (err) {
      if (err instanceof UserError) throw err;
      return false;
    }
  }

  async create(name, cwd, { resume = false } = {}) {
    validateName(name);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new UserError('Укажите полный путь к папке');
    let stat = null;
    try { stat = fs.statSync(cwd); } catch {}
    if (!stat || !stat.isDirectory()) throw new UserError('Папка не найдена');
    if (await this.exists(name)) throw new UserError('Сессия с таким именем уже есть', 409);
    // `claude --continue` exits immediately with "No conversation found to continue" when the
    // folder has none on file yet, killing the session on the spot: only pass it when one exists.
    const doResume = resume && hasConversation(cwd, this.projectsRoot);
    const cmd = doResume ? `${this.claudeCmd} --continue` : this.claudeCmd;
    await this.tmux(['new-session', '-d', '-s', `${PREFIX}${name}`, '-c', cwd, cmd]);
  }

  async kill(name) {
    if (!(await this.exists(name))) throw new UserError('Сессия не найдена', 404);
    await this.tmux(['kill-session', '-t', this.sessionTarget(name)]);
  }

  capture(name) {
    return this.tmux(['capture-pane', '-p', '-t', this.target(name)]);
  }
}

module.exports = { SessionManager, validateName, PREFIX };
