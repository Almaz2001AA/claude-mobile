const DELAYS = [1000, 2000, 5000, 10000];
// iOS freezes a backgrounded PWA and its socket usually dies without a close event, so after
// this long in the background the socket is reopened on return instead of being trusted.
const RESUME_AFTER_MS = 5000;

// Reconnecting WebSocket. `path` may be a function so each reconnect can use fresh query params.
// onStatus receives 'open' | 'offline' | 'gone' (server closed with 4004: session ended).
export function connectWs(path, { onMessage, onStatus } = {}) {
  let ws = null;
  let attempt = 0;
  let closed = false;
  let timer = null;
  let hiddenAt = null;
  let gone = false;

  function open() {
    const p = typeof path === 'function' ? path() : path;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${p}`);
    ws.onopen = () => {
      attempt = 0;
      onStatus?.('open');
    };
    ws.onmessage = (event) => onMessage?.(event.data);
    ws.onclose = (event) => {
      if (closed) return;
      if (event.code === 4004) {
        gone = true;
        onStatus?.('gone');
        return;
      }
      onStatus?.('offline');
      timer = setTimeout(open, DELAYS[Math.min(attempt++, DELAYS.length - 1)]);
    };
  }

  // Drops the current socket (without triggering the delayed reconnect) and opens a new one now.
  function reopen() {
    clearTimeout(timer);
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
    }
    attempt = 0;
    open();
  }

  function onVisibility() {
    if (closed || gone) return;
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    // A socket still CONNECTING is a reconnect already under way; leave it alone.
    if (away >= RESUME_AFTER_MS || ws.readyState > WebSocket.OPEN) reopen();
  }

  function onOnline() {
    if (!closed && !gone) reopen();
  }

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);

  open();
  return {
    send(data) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    },
    close() {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      ws?.close();
    },
  };
}
