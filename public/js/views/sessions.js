import { h } from '../ui.js';

export function renderSessions(root) {
  root.append(h('p', { class: 'empty' }, 'Скоро'));
}
