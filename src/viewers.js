// Which chat WebSockets are open and visible, so we don't push "done" to someone already looking.
class Viewers {
  constructor() {
    this.map = new Map();
  }

  add(name, ws) {
    this.map.set(ws, { name, visible: true, endpoint: null });
  }

  update(ws, patch) {
    const viewer = this.map.get(ws);
    if (viewer) Object.assign(viewer, patch);
  }

  remove(ws) {
    this.map.delete(ws);
  }

  watchingEndpoints(name) {
    const endpoints = new Set();
    for (const v of this.map.values()) {
      if (v.name === name && v.visible && v.endpoint) endpoints.add(v.endpoint);
    }
    return endpoints;
  }

  // Closes every chat WebSocket registered for `name`, e.g. once its session has been
  // deleted: without this, an already-open chat never learns the session is gone (unlike
  // the terminal WS, which finds out from the pty exiting).
  closeSession(name, code, reason) {
    for (const [ws, v] of this.map) {
      if (v.name === name) ws.close(code, reason);
    }
  }
}

module.exports = { Viewers };
