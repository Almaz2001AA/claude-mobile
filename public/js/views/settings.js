import { h, toast } from '../ui.js';
import { api } from '../api.js';
import { pushSupported, isStandalone, getSubscription, enablePush, disablePush, updatePrefs, loadPrefs } from '../push.js';

export function renderSettings(root) {
  const prefs = loadPrefs();
  const state = h('p', { class: 'hint' });
  const stopBox = h('input', { type: 'checkbox' });
  const permissionBox = h('input', { type: 'checkbox' });
  stopBox.checked = prefs.stop;
  permissionBox.checked = prefs.permission;
  const currentPrefs = () => ({ stop: stopBox.checked, permission: permissionBox.checked });

  const enableBtn = h('button', {
    class: 'primary wide',
    onclick: async () => {
      try {
        await enablePush(currentPrefs());
        toast('Уведомления включены');
      } catch (err) {
        toast(err.message);
      }
      refreshState();
    },
  }, 'Включить уведомления');

  const disableBtn = h('button', {
    class: 'wide',
    onclick: async () => {
      try {
        await disablePush();
      } catch (err) {
        toast(err.message);
      }
      refreshState();
    },
  }, 'Выключить уведомления');

  const onPrefChange = () => updatePrefs(currentPrefs()).catch((err) => toast(err.message));
  stopBox.addEventListener('change', onPrefChange);
  permissionBox.addEventListener('change', onPrefChange);

  async function refreshState() {
    if (!pushSupported()) {
      state.textContent = isStandalone()
        ? 'Это устройство не поддерживает уведомления (нужна iOS 16.4 или новее).'
        : 'Чтобы включить уведомления, откройте сайт в Safari → «Поделиться» → «На экран Домой» и запустите приложение с экрана Домой.';
      enableBtn.hidden = true;
      disableBtn.hidden = true;
      return;
    }
    const sub = await getSubscription().catch(() => null);
    state.textContent = sub ? 'Уведомления включены на этом устройстве.' : 'Уведомления выключены.';
    enableBtn.hidden = Boolean(sub);
    disableBtn.hidden = !sub;
  }

  root.append(h('div', { class: 'screen' },
    h('header', { class: 'bar' },
      h('a', { href: '#/', class: 'icon-btn', 'aria-label': 'Назад' }, '‹'),
      h('h1', {}, 'Настройки')),
    h('div', { class: 'scroll settings' },
      h('h2', {}, 'Уведомления'),
      state,
      h('label', { class: 'check' }, stopBox, 'Claude закончил работу'),
      h('label', { class: 'check' }, permissionBox, 'Нужно подтверждение'),
      enableBtn,
      disableBtn,
      h('button', {
        class: 'danger wide',
        onclick: async () => {
          await api('POST', '/api/logout').catch(() => {});
          location.hash = '#/login';
        },
      }, 'Выйти'))));

  refreshState();
}
