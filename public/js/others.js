// Warning banner for when another Claude (outside this tmux session) is carrying on this
// session's conversation. Polls /api/sessions/<name>/others; see src/others.js on the server.
import { h } from './ui.js';
import { api } from './api.js';

const POLL_MS = 15000;

function where(o) {
  if (o.where === 'app') return `в сессии «${o.session}»`;
  if (o.where === 'tmux') return `в tmux-сессии «${o.session}»`;
  return 'без tmux (SSH с ПК)';
}

function when(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const today = new Date().toDateString() === d.toDateString();
  return `, с ${today ? '' : `${d.toLocaleDateString('ru-RU')} `}${time}`;
}

export function othersText(others) {
  const list = others.map((o) => `${where(o)}${when(o.startedAt)}`).join('; ');
  return `Разговор ведёт другой Claude — ${list}. Claude этой сессии не знает новых сообщений.`;
}

const HINT = 'Чат показывает работу того Claude, а терминал и сообщения отсюда идут в Claude этой сессии, который не знает последних сообщений. Чтобы работать здесь: выйдите из того Claude (/exit), затем в терминале этой сессии перезапустите claude --continue.';

// Returns { el, get(), stop() }; `onChange` runs after the banner is shown or hidden.
export function watchOthers(name, onChange) {
  let others = [];
  const text = h('span');
  const hint = h('div', { class: 'others-hint', hidden: true }, HINT);
  const more = h('span', { class: 'others-more' }, ' Подробнее');
  const el = h('div', {
    class: 'others-warning',
    hidden: true,
    onclick: () => {
      hint.hidden = !hint.hidden;
      more.textContent = hint.hidden ? ' Подробнее' : ' Скрыть';
      onChange?.();
    },
  }, '⚠️ ', text, more, hint);

  async function check() {
    try {
      const res = await api('GET', `/api/sessions/${name}/others`);
      const next = Array.isArray(res.others) ? res.others : [];
      const changed = JSON.stringify(next) !== JSON.stringify(others);
      others = next;
      if (!changed) return;
      text.textContent = others.length ? othersText(others) : '';
      el.hidden = !others.length;
      onChange?.();
    } catch {
      // Transient network errors: keep whatever we showed last.
    }
  }

  function onVisible() {
    if (document.visibilityState === 'visible') check();
  }

  const timer = setInterval(check, POLL_MS);
  document.addEventListener('visibilitychange', onVisible);
  check();

  return {
    el,
    get: () => others,
    stop() {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
