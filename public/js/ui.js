// Tiny DOM helper. Children are always inserted as text or nodes, never as HTML.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

let toastTimer;
export function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

export function formatAgo(ms) {
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return new Date(ms).toLocaleDateString('ru-RU');
}

export function sessionHeader(name, active) {
  return h('header', { class: 'bar' },
    h('a', { href: '#/', class: 'icon-btn', 'aria-label': 'Назад' }, '‹'),
    h('h1', {}, name),
    h('nav', { class: 'tabs' },
      h('a', { href: `#/s/${name}/chat`, class: active === 'chat' ? 'active' : '' }, 'Чат'),
      h('a', { href: `#/s/${name}/term`, class: active === 'term' ? 'active' : '' }, 'Терминал')));
}
