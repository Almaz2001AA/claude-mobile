// Which chat WebSockets are open and visible, so we don't push "done" to someone already looking.
class Viewers {
  constructor({ now = Date.now } = {}) {
    this.map = new Map();
    this.now = now;
    // name -> last time a visible chat for it was open (for "did the user look since…").
    this.lastSeen = new Map();
  }

  add(name, ws) {
    this.map.set(ws, { name, visible: true, endpoint: null });
    this.lastSeen.set(name, this.now());
  }

  update(ws, patch) {
    const viewer = this.map.get(ws);
    if (!viewer) return;
    Object.assign(viewer, patch);
    if (viewer.visible) this.lastSeen.set(viewer.name, this.now());
  }

  // True when the chat for `name` is visible right now or was shown at or after `since`.
  seenSince(name, since) {
    for (const v of this.map.values()) {
      if (v.name === name && v.visible) return true;
    }
    return (this.lastSeen.get(name) ?? -Infinity) >= since;
  }

  remove(ws) {
    const viewer = this.map.get(ws);
    if (viewer?.visible) this.lastSeen.set(viewer.name, this.now());
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
