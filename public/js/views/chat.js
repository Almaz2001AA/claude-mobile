import { h } from '../ui.js';

export function renderChat(root) {
  root.append(h('p', { class: 'empty' }, 'Скоро'));
}
