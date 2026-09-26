import { h } from '../ui.js';
import { api } from '../api.js';

export function renderLogin(root) {
  const error = h('p', { class: 'error' });
  const input = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'current-password', placeholder: 'PIN', maxlength: '8' });
  const form = h('form', {
    class: 'login',
    onsubmit: async (event) => {
      event.preventDefault();
      error.textContent = '';
      try {
        await api('POST', '/api/login', { pin: input.value });
        location.hash = '#/';
      } catch (err) {
        error.textContent = err.message;
        input.value = '';
      }
    },
  }, h('h1', {}, 'Claude'), input, h('button', { type: 'submit', class: 'primary' }, 'Войти'), error);
  root.append(form);
  input.focus();
}
