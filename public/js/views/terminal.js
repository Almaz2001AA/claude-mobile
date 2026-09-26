import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { h, sessionHeader } from '../ui.js';
import { connectWs } from '../ws.js';

const KEYS = [['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['^C', '\x03'], ['⏎', '\r']];
const FONT_KEY = 'cm-font-size';

function loadFontSize() {
  try {
    return Number(localStorage.getItem(FONT_KEY)) || 13;
  } catch {
    return 13;
  }
}

function saveFontSize(size) {
  try {
    localStorage.setItem(FONT_KEY, String(size));
  } catch {}
}

export function renderTerminal(root, { name }) {
  const container = h('div', { class: 'terminal' });
  const offline = h('div', { class: 'offline', hidden: true }, 'Нет связи…');
  const term = new Terminal({
    fontSize: loadFontSize(),
    fontFamily: 'Menlo, monospace',
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#1c1b1a' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  // pointerdown.preventDefault keeps focus (and the iOS keyboard) on the terminal while tapping keys.
  const keyButton = (label, onPress) => h('button', { onpointerdown: (e) => e.preventDefault(), onclick: onPress }, label);
  const keybar = h('div', { class: 'keybar' },
    ...KEYS.map(([label, seq]) => keyButton(label, () => sendInput(seq))),
    keyButton('A-', () => setFont(-1)),
    keyButton('A+', () => setFont(1)));

  root.append(h('div', { class: 'screen' }, sessionHeader(name, 'term'), offline, container, keybar));
  term.open(container);
  fit.fit();

  const socket = connectWs(() => `/ws/term/${name}?cols=${term.cols}&rows=${term.rows}`, {
    onMessage: (data) => term.write(data),
    onStatus(state) {
      offline.hidden = state !== 'offline';
      if (state === 'gone') term.write('\r\n\x1b[33m[Сессия завершена]\x1b[0m\r\n');
    },
  });

  function sendInput(data) {
    socket.send({ t: 'in', d: data });
  }

  function refit() {
    fit.fit();
    socket.send({ t: 'resize', cols: term.cols, rows: term.rows });
  }

  function setFont(delta) {
    term.options.fontSize = Math.min(24, Math.max(8, term.options.fontSize + delta));
    saveFontSize(term.options.fontSize);
    refit();
  }

  term.onData(sendInput);
  window.addEventListener('resize', refit);
  window.visualViewport?.addEventListener('resize', refit);
  term.focus();

  return () => {
    window.removeEventListener('resize', refit);
    window.visualViewport?.removeEventListener('resize', refit);
    socket.close();
    term.dispose();
  };
}
