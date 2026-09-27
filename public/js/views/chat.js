import { h, toast, sessionHeader } from '../ui.js';
import { api } from '../api.js';
import { connectWs } from '../ws.js';
import { ChatModel } from '../chat-model.js';
import { getEndpoint } from '../push.js';

const STATUS_TEXT = {
  working: '● Работает…',
  waiting_permission: '◐ Ждёт подтверждения',
  idle: '○ Свободна',
};

function toolDetails(item) {
  const input = item.input || {};
  let text;
  if (item.name === 'Bash') text = `$ ${input.command || ''}`;
  else if (item.name === 'Edit') text = `--- было\n${input.old_string || ''}\n+++ стало\n${input.new_string || ''}`;
  else if (item.name === 'Write') text = input.content || '';
  else text = JSON.stringify(input, null, 2);
  if (item.result) text += `\n\n${item.result.text}`;
  return text;
}

export function renderChat(root, { name }) {
  const model = new ChatModel();
  const expanded = new Set();
  let status = { status: 'idle', message: null };
  const base = `/api/sessions/${name}`;

  const statusLine = h('div', { class: 'status-line' });
  const offline = h('div', { class: 'offline', hidden: true }, 'Нет связи…');
  const messages = h('div', { class: 'messages' });
  const moreBtn = h('button', { class: 'more', onclick: loadMore }, 'Загрузить ещё');
  const permissionBox = h('div', { class: 'permission', hidden: true });
  const quickChips = h('div', { class: 'quick-chips' });
  const textarea = h('textarea', { rows: '1', placeholder: 'Сообщение…', oninput: autoGrow });
  const fileInput = h('input', { type: 'file', hidden: true, onchange: upload });

  root.append(h('div', { class: 'screen' },
    sessionHeader(name, 'chat'),
    statusLine,
    offline,
    messages,
    permissionBox,
    h('div', { class: 'composer' },
      quickChips,
      h('div', { class: 'composer-row' },
        h('button', { class: 'icon-btn', 'aria-label': 'Прикрепить файл', onclick: () => fileInput.click() }, '📎'),
        textarea,
        h('button', { class: 'icon-btn', 'aria-label': 'Отправить', onclick: send }, '➤')),
      h('div', { class: 'composer-row keys' },
        h('button', { onclick: () => key('escape') }, 'Esc'),
        h('button', { class: 'danger', onclick: () => key('escape') }, 'Стоп')),
      fileInput)));

  function autoGrow() {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }

  function itemView(item) {
    if (item.kind === 'user') return h('div', { class: 'bubble user' }, item.text);
    if (item.kind === 'assistant') return h('div', { class: 'bubble assistant' }, item.text);
    const open = expanded.has(item.id);
    const mark = item.result ? (item.result.isError ? ' ✗' : ' ✓') : ' …';
    return h('div', { class: 'tool' },
      h('button', {
        class: 'tool-head',
        onclick: () => {
          if (open) expanded.delete(item.id);
          else expanded.add(item.id);
          renderMessages();
        },
      }, `${open ? '▾' : '▸'} ${item.summary}${mark}`),
      open ? h('pre', { class: 'tool-body' }, toolDetails(item)) : null);
  }

  function renderMessages(forceBottom = false) {
    const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    if (!model.available) {
      messages.replaceChildren(h('p', { class: 'empty' }, 'История недоступна — используйте вкладку «Терминал». Она появится у сессий, запущенных после установки хуков.'));
      return;
    }
    messages.replaceChildren(...(model.hasMore ? [moreBtn] : []), ...model.list.map(itemView));
    if (forceBottom || nearBottom) messages.scrollTop = messages.scrollHeight;
  }

  function renderStatus() {
    statusLine.textContent = STATUS_TEXT[status.status] || STATUS_TEXT.idle;
  }

  async function loadMore() {
    try {
      const page = await api('GET', `${base}/history?before=${model.start}&limit=200`);
      const previousHeight = messages.scrollHeight;
      model.prepend(page);
      renderMessages();
      messages.scrollTop += messages.scrollHeight - previousHeight;
    } catch (err) {
      toast(err.message);
    }
  }

  async function refreshPermission() {
    if (status.status !== 'waiting_permission') {
      permissionBox.hidden = true;
      return;
    }
    try {
      const { dialog } = await api('GET', `${base}/permission`);
      if (!dialog || status.status !== 'waiting_permission') {
        permissionBox.hidden = true;
        return;
      }
      const tool = model.lastTool();
      // Element.replaceChildren stringifies non-Node arguments (null would render as the text "null"),
      // unlike h(), so falsy children must be filtered out before calling it directly.
      permissionBox.replaceChildren(...[
        h('div', { class: 'permission-title' }, `⚠️ ${status.message || dialog.question}`),
        tool ? h('pre', { class: 'tool-body' }, toolDetails({ ...tool, result: null })) : null,
        h('div', { class: 'permission-options' }, ...dialog.options.map((o) => h('button', {
          class: o.key === '1' ? 'primary' : '',
          onclick: () => answer(o.key),
        }, o.label))),
      ].filter(Boolean));
      permissionBox.hidden = false;
    } catch (err) {
      toast(err.message);
    }
  }

  async function answer(optionKey) {
    permissionBox.hidden = true;
    try {
      await api('POST', `${base}/permission`, { key: optionKey });
    } catch (err) {
      toast(err.message);
    }
  }

  async function sendText(text) {
    try {
      await api('POST', `${base}/input`, { text });
    } catch (err) {
      toast(err.message);
    }
  }

  async function send() {
    const text = textarea.value;
    if (!text.trim()) return;
    textarea.disabled = true;
    try {
      await api('POST', `${base}/input`, { text });
      textarea.value = '';
      autoGrow();
    } catch (err) {
      toast(err.message);
    } finally {
      textarea.disabled = false;
    }
  }

  async function loadQuickChips() {
    try {
      const items = await api('GET', '/api/quick');
      quickChips.replaceChildren(...items.map((item) => h('button', {
        class: 'chip',
        onclick: () => {
          if (item.text === '/clear' && !confirm('Очистить контекст Claude в этой сессии?')) return;
          sendText(item.text);
        },
      }, item.label)));
    } catch (err) {
      toast(err.message);
    }
  }
  loadQuickChips();

  async function key(keyName) {
    try {
      await api('POST', `${base}/key`, { key: keyName });
    } catch (err) {
      toast(err.message);
    }
  }

  async function upload() {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      toast('Загрузка…');
      const { path } = await api('POST', `${base}/upload?filename=${encodeURIComponent(file.name)}`, file);
      const sep = textarea.value && !textarea.value.endsWith(' ') ? ' ' : '';
      textarea.value = `${textarea.value}${sep}${path} `;
      autoGrow();
      textarea.focus();
    } catch (err) {
      toast(err.message);
    }
  }

  // Resolved once, when the socket opens, and cached: on iOS the page can freeze (screen
  // lock, app switch) right as visibilitychange/pagehide fires, and an unresolved
  // `await getEndpoint()` at that moment means the "not visible any more" message never
  // reaches the server, which then keeps believing the chat is visible and suppresses the
  // "done" push notification. Sending synchronously with whatever endpoint we already have
  // (even null, before push is enabled) is far more important than always being exact.
  let cachedEndpoint = null;

  const socket = connectWs(`/ws/chat/${name}`, {
    onMessage(raw) {
      const msg = JSON.parse(raw);
      if (msg.type === 'history') {
        model.reset(msg);
        renderMessages(true);
      } else if (msg.type === 'items') {
        model.append(msg.items);
        renderMessages();
      } else if (msg.type === 'status') {
        status = msg;
        renderStatus();
        refreshPermission();
      } else if (msg.type === 'error') {
        toast(msg.error);
      }
    },
    onStatus(state) {
      offline.hidden = state !== 'offline';
      if (state === 'open') {
        getEndpoint().then((endpoint) => {
          cachedEndpoint = endpoint;
          reportVisibility();
        });
      }
      if (state === 'gone') {
        toast('Сессия завершена');
        location.hash = '#/';
      }
    },
  });

  function reportVisibility() {
    socket.send({ type: 'visibility', visible: document.visibilityState === 'visible', endpoint: cachedEndpoint });
  }
  document.addEventListener('visibilitychange', reportVisibility);
  // visibilitychange doesn't fire on iOS when Safari is force-quit/backgrounded hard enough;
  // pagehide is the last reliable moment to tell the server "not visible any more".
  window.addEventListener('pagehide', reportVisibility);

  // The Notification hook can fire a moment before the dialog is drawn; keep checking while waiting.
  const permissionTimer = setInterval(() => {
    if (status.status === 'waiting_permission' && permissionBox.hidden) refreshPermission();
  }, 2000);

  renderStatus();

  return () => {
    clearInterval(permissionTimer);
    document.removeEventListener('visibilitychange', reportVisibility);
    window.removeEventListener('pagehide', reportVisibility);
    socket.close();
  };
}
