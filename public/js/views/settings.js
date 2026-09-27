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

  const quickList = h('div', { class: 'item-list' });
  const quickLabelInput = h('input', { placeholder: 'Название', maxlength: '20' });
  const quickTextInput = h('input', { placeholder: 'Текст' });

  async function loadQuick() {
    try {
      renderQuick(await api('GET', '/api/quick'));
    } catch (err) {
      toast(err.message);
    }
  }

  function renderQuick(items) {
    quickList.replaceChildren(...(items.length ? items.map((item, index) => h('div', { class: 'item-row' },
      h('div', { class: 'item-info' },
        h('div', { class: 'item-label' }, item.label),
        h('div', { class: 'item-text' }, item.text)),
      h('button', { class: 'danger', onclick: () => deleteQuick(items, index) }, 'Удалить'))) : [h('p', { class: 'hint' }, 'Нет быстрых кнопок')]));
  }

  async function saveQuick(items) {
    try {
      renderQuick(await api('PUT', '/api/quick', { items }));
    } catch (err) {
      toast(err.message);
    }
  }

  function deleteQuick(items, index) {
    saveQuick(items.filter((_, i) => i !== index));
  }

  async function addQuickCmd() {
    const label = quickLabelInput.value.trim();
    const text = quickTextInput.value;
    if (!label || !text) return;
    try {
      const items = await api('GET', '/api/quick');
      renderQuick(await api('PUT', '/api/quick', { items: [...items, { label, text }] }));
      quickLabelInput.value = '';
      quickTextInput.value = '';
    } catch (err) {
      toast(err.message);
    }
  }

  async function resetQuick() {
    try {
      renderQuick(await api('PUT', '/api/quick', { reset: true }));
    } catch (err) {
      toast(err.message);
    }
  }

  const favList = h('div', { class: 'item-list' });

  async function loadFavorites() {
    try {
      renderFavorites(await api('GET', '/api/favorites'));
    } catch (err) {
      toast(err.message);
    }
  }

  function renderFavorites(items) {
    favList.replaceChildren(...(items.length ? items.map((fav) => h('div', { class: 'item-row' },
      h('div', { class: 'item-info' },
        h('div', { class: 'item-label' }, fav.name),
        h('div', { class: 'item-text' }, fav.cwd)),
      h('button', { class: 'danger', onclick: () => deleteFavorite(items, fav.name) }, 'Удалить'))) : [h('p', { class: 'hint' }, 'Нет избранных папок')]));
  }

  async function deleteFavorite(items, name) {
    try {
      renderFavorites(await api('PUT', '/api/favorites', { items: items.filter((f) => f.name !== name) }));
    } catch (err) {
      toast(err.message);
    }
  }

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
      h('h2', {}, 'Быстрые кнопки'),
      quickList,
      h('div', { class: 'quick-add' },
        quickLabelInput,
        quickTextInput,
        h('button', { onclick: addQuickCmd }, 'Добавить')),
      h('button', { class: 'wide', onclick: resetQuick }, 'Сбросить по умолчанию'),
      h('h2', {}, 'Избранные папки'),
      favList,
      h('button', {
        class: 'danger wide',
        onclick: async () => {
          await api('POST', '/api/logout').catch(() => {});
          location.hash = '#/login';
        },
      }, 'Выйти'))));

  refreshState();
  loadQuick();
  loadFavorites();
}
