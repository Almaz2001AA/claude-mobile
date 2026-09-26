const os = require('node:os');
const pty = require('node-pty');
const { PREFIX } = require('./sessions');
const { clampInt } = require('./util');

// One `tmux attach` per browser connection. Closing the socket only detaches; the session lives on.
function attachTerminal(ws, { sessions, name, cols, rows }) {
  const env = { ...process.env, TERM: 'xterm-256color' };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const term = pty.spawn('tmux', [...sessions.baseArgs(), 'attach-session', '-t', `=${PREFIX}${name}`], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: os.homedir(),
    env,
  });

  term.onData((data) => {
    if (ws.readyState === 1) ws.send(data);
  });
  term.onExit(() => {
    if (ws.readyState === 1) ws.close(4004, 'Сессия завершена');
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'in' && typeof msg.d === 'string') {
      term.write(msg.d);
    } else if (msg.t === 'resize') {
      term.resize(clampInt(msg.cols, 20, 400, 80), clampInt(msg.rows, 5, 200, 24));
    }
  });

  ws.on('close', () => {
    try {
      term.kill();
    } catch {}
  });
}

module.exports = { attachTerminal };
