const DELAYS = [1000, 2000, 5000, 10000];

// Reconnecting WebSocket. `path` may be a function so each reconnect can use fresh query params.
// onStatus receives 'open' | 'offline' | 'gone' (server closed with 4004: session ended).
export function connectWs(path, { onMessage, onStatus } = {}) {
  let ws = null;
  let attempt = 0;
  let closed = false;
  let timer = null;

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
        onStatus?.('gone');
        return;
      }
      onStatus?.('offline');
      timer = setTimeout(open, DELAYS[Math.min(attempt++, DELAYS.length - 1)]);
    };
  }

  open();
  return {
    send(data) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    },
    close() {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
