const { UserError } = require('./errors');
const { delay } = require('./util');
const { parsePermissionDialog } = require('./permission');

const KEYS = {
  escape: 'Escape',
  tab: 'Tab',
  enter: 'Enter',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  'ctrl-c': 'C-c',
};

class InputSender {
  constructor({ sessions, enterDelayMs = 150 }) {
    this.sessions = sessions;
    this.enterDelayMs = enterDelayMs;
  }

  async sendText(name, text) {
    if (typeof text !== 'string' || !text.trim()) throw new UserError('Пустое сообщение');
    const target = this.sessions.target(name);
    if (text.includes('\n')) {
      const buffer = `cm-${process.pid}-${Date.now()}`;
      await this.sessions.tmux(['load-buffer', '-b', buffer, '-'], { input: text });
      await this.sessions.tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', target]);
    } else {
      await this.sessions.tmux(['send-keys', '-t', target, '-l', '--', text]);
    }
    await delay(this.enterDelayMs);
    await this.sessions.tmux(['send-keys', '-t', target, 'Enter']);
  }

  async sendKey(name, key) {
    const tmuxKey = KEYS[key];
    if (!tmuxKey) throw new UserError('Неизвестная клавиша');
    await this.sessions.tmux(['send-keys', '-t', this.sessions.target(name), tmuxKey]);
  }

  async readPermission(name) {
    return parsePermissionDialog(await this.sessions.capture(name));
  }

  // Re-reads the screen right before pressing, so a stale button never answers a different dialog.
  async answerPermission(name, key) {
    const dialog = await this.readPermission(name);
    if (!dialog) throw new UserError('Диалог уже закрыт', 409);
    if (!dialog.options.some((o) => o.key === key)) throw new UserError('Нет такого варианта');
    await this.sessions.tmux(['send-keys', '-t', this.sessions.target(name), key]);
  }
}

module.exports = { InputSender, KEYS };
