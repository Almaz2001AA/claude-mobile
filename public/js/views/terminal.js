import { h } from '../ui.js';

export function renderTerminal(root) {
  root.append(h('p', { class: 'empty' }, 'Скоро'));
}
