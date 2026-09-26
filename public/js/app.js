import { h } from './ui.js';
import { api } from './api.js';
import { renderLogin } from './views/login.js';
import { renderSessions } from './views/sessions.js';
import { renderChat } from './views/chat.js';
import { renderTerminal } from './views/terminal.js';
import { renderSettings } from './views/settings.js';

const root = document.getElementById('app');
const VIEWS = { login: renderLogin, sessions: renderSessions, chat: renderChat, terminal: renderTerminal, settings: renderSettings };
let cleanup = null;
let renderId = 0;

function parseRoute(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'login') return { view: 'login' };
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 's' && parts[1]) return { view: parts[2] === 'term' ? 'terminal' : 'chat', name: decodeURIComponent(parts[1]) };
  return { view: 'sessions' };
}

async function render() {
  const id = ++renderId;
  cleanup?.();
  cleanup = null;
  root.replaceChildren();
  const route = parseRoute(location.hash);
  if (route.view !== 'login') {
    try {
      await api('GET', '/api/me');
    } catch (err) {
      if (id !== renderId || err.status === 401) return; // api() already redirected to #/login
      root.replaceChildren(h('div', { class: 'screen' },
        h('p', { class: 'empty' }, err.message),
        h('button', { class: 'primary wide', onclick: render }, 'Повторить')));
      return;
    }
  }
  if (id !== renderId) return;
  cleanup = VIEWS[route.view](root, route) || null;
}

// iOS doesn't shrink 100dvh when the keyboard opens; track the visual viewport instead.
function syncHeight() {
  const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${height}px`);
  window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener('resize', syncHeight);
window.addEventListener('resize', syncHeight);
syncHeight();

window.addEventListener('hashchange', render);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'navigate') location.hash = new URL(event.data.url, location.origin).hash;
  });
}

render();
