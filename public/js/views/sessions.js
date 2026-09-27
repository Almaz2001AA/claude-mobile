import { h, toast, formatAgo } from '../ui.js';
import { api } from '../api.js';

const STATUS = {
  working: { icon: '●', label: 'Работает…', cls: 'working' },
  waiting_permission: { icon: '◐', label: 'Нужно подтверждение', cls: 'waiting' },
  idle: { icon: '○', label: 'Свободна', cls: 'idle' },
};
const SWIPE_WIDTH = 96;

function suggestName(dir) {
  const last = dir.split('/').filter(Boolean).pop() || '';
  return last.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

// Swipe left reveals the "Закрыть" button; a tap on an open row closes it instead of navigating.
function enableSwipe(wrap, card) {
  let startX = 0;
  let dx = 0;
  card.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    dx = 0;
    card.style.transition = 'none';
  }, { passive: true });
  card.addEventListener('touchmove', (e) => {
    dx = e.touches[0].clientX - startX;
    const base = wrap.classList.contains('open') ? -SWIPE_WIDTH : 0;
    card.style.transform = `translateX(${Math.min(0, Math.max(-SWIPE_WIDTH, base + dx))}px)`;
  }, { passive: true });
  card.addEventListener('touchend', () => {
    card.style.transition = '';
    card.style.transform = '';
    if (dx < -40) wrap.classList.add('open');
    else if (dx > 40) wrap.classList.remove('open');
  });
  card.addEventListener('click', (e) => {
    if (Math.abs(dx) > 10) {
      e.preventDefault();
    } else if (wrap.classList.contains('open')) {
      e.preventDefault();
      wrap.classList.remove('open');
    }
    dx = 0;
  });
}

export function renderSessions(root) {
  const list = h('div', { class: 'session-list' });
  let stopped = false;

  root.append(h('div', { class: 'screen' },
    h('header', { class: 'bar' },
      h('h1', {}, 'Сессии'),
      h('a', { class: 'icon-btn', href: '#/settings', 'aria-label': 'Настройки' }, '⚙️')),
    h('div', { class: 'scroll' }, list, h('button', { class: 'primary wide', onclick: openCreate }, '+ Новая сессия'))));

  async function refresh() {
    try {
      const sessions = await api('GET', '/api/sessions');
      if (stopped) return;
      list.replaceChildren(...(sessions.length ? sessions.map(row) : [h('p', { class: 'empty' }, 'Нет запущенных сессий')]));
    } catch (err) {
      if (err.status !== 401) toast(err.message);
    }
  }

  function row(s) {
    const st = STATUS[s.status] || STATUS.idle;
    const close = h('button', {
      class: 'danger swipe-action',
      onclick: async () => {
        if (!confirm(`Закрыть сессию «${s.name}»? Claude в ней будет остановлен.`)) return;
        try {
          await api('DELETE', `/api/sessions/${s.name}`);
          refresh();
        } catch (err) {
          toast(err.message);
        }
      },
    }, 'Закрыть');
    const card = h('a', { class: `session ${st.cls}`, href: `#/s/${s.name}/chat` },
      h('div', { class: 'session-title' }, h('span', { class: 'dot' }, st.icon), ' ', s.name),
      h('div', { class: 'session-cwd' }, s.cwd),
      h('div', { class: 'session-meta' }, `${st.label} · ${formatAgo(s.activity)}`));
    const wrap = h('div', { class: 'swipe' }, close, card);
    enableSwipe(wrap, card);
    return wrap;
  }

  function openCreate() {
    const noAuto = { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' };
    const nameInput = h('input', { placeholder: 'my-app', ...noAuto });
    const cwdInput = h('input', { placeholder: '/home/user/projects/…', ...noAuto });
    const chips = h('div', { class: 'chips' });
    const resumeInput = h('input', { type: 'checkbox' });
    const error = h('p', { class: 'error' });
    const dialog = h('dialog', { class: 'sheet' },
      h('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = '';
          const name = nameInput.value.trim();
          try {
            await api('POST', '/api/sessions', { name, cwd: cwdInput.value.trim(), resume: resumeInput.checked });
            dialog.close();
            location.hash = `#/s/${name}/chat`;
          } catch (err) {
            error.textContent = err.message;
          }
        },
      },
      h('h2', {}, 'Новая сессия'),
      h('label', {}, 'Имя (латиница, цифры, дефис)', nameInput),
      h('label', {}, 'Папка', cwdInput),
      chips,
      h('label', { class: 'check' }, resumeInput, 'Продолжить последний разговор в этой папке'),
      error,
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => dialog.close() }, 'Отмена'),
        h('button', { type: 'submit', class: 'primary' }, 'Создать'))));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    api('GET', '/api/recent-cwds').then((dirs) => {
      chips.replaceChildren(...dirs.map((dir) => h('button', {
        type: 'button',
        class: 'chip',
        onclick: () => {
          cwdInput.value = dir;
          if (!nameInput.value) nameInput.value = suggestName(dir);
        },
      }, dir)));
    }).catch(() => {});
  }

  const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
  document.addEventListener('visibilitychange', onVisible);
  const timer = setInterval(refresh, 3000);
  refresh();

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
