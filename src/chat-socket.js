const { readHistory, TranscriptTail } = require('./transcript');

function attachChat(ws, { name, status, viewers, historyLimit = 200, tailIntervalMs = 400 }) {
  let tail = null;
  let currentPath;
  let closed = false;
  // Bumped on every load() call so a slower, superseded call can tell it lost the race
  // even when it happens to target the same transcriptPath as the call that replaced it
  // (a plain "did the path change" check misses that case and leaks a second TranscriptTail).
  let generation = 0;
  const send = (msg) => {
    if (!closed && ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  async function load() {
    const gen = ++generation;
    if (tail) tail.stop();
    tail = null;
    currentPath = status.get(name).transcriptPath || null;
    const path = currentPath;
    if (!path) {
      send({ type: 'history', available: false, items: [], start: 0, offset: 0 });
      return;
    }
    const history = await readHistory(path, { limit: historyLimit });
    if (closed || gen !== generation) return;
    send({ type: 'history', available: true, ...history });
    tail = new TranscriptTail(path, { offset: history.offset, intervalMs: tailIntervalMs });
    tail.on('items', (items) => send({ type: 'items', items }));
    tail.start();
  }

  function onStatus(changed, entry) {
    if (changed !== name) return;
    send({ type: 'status', status: entry.status, message: entry.message || null });
    if ((entry.transcriptPath || null) !== currentPath) {
      load().catch((err) => send({ type: 'error', error: err.message }));
    }
  }

  status.on('change', onStatus);
  viewers.add(name, ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'visibility') {
      viewers.update(ws, { visible: Boolean(msg.visible), endpoint: typeof msg.endpoint === 'string' ? msg.endpoint : null });
    }
  });

  ws.on('close', () => {
    closed = true;
    status.off('change', onStatus);
    viewers.remove(ws);
    if (tail) tail.stop();
  });

  const initial = status.get(name);
  send({ type: 'status', status: initial.status, message: initial.message || null });
  load().catch((err) => send({ type: 'error', error: err.message }));
}

module.exports = { attachChat };
