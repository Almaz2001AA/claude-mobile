const test = require('node:test');
const assert = require('node:assert/strict');

// Minimal browser globals so the client module can run under node.
class FakeWs {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWs.CONNECTING;
    this.closedByClient = false;
    FakeWs.all.push(this);
  }
  close() {
    this.closedByClient = true;
    this.readyState = FakeWs.CLOSED;
  }
  send() {}
}
FakeWs.all = [];

function setup() {
  const listeners = { doc: {}, win: {} };
  const on = (bag) => (type, fn) => { bag[type] = fn; };
  const off = (bag) => (type) => { delete bag[type]; };
  FakeWs.all = [];
  globalThis.WebSocket = FakeWs;
  globalThis.location = { protocol: 'https:', host: 'h' };
  globalThis.document = { visibilityState: 'visible', addEventListener: on(listeners.doc), removeEventListener: off(listeners.doc) };
  globalThis.window = { addEventListener: on(listeners.win), removeEventListener: off(listeners.win) };
  return listeners;
}

const load = () => import('../public/js/ws.js');

function hideFor(listeners, ms, t) {
  document.visibilityState = 'hidden';
  listeners.doc.visibilitychange();
  t.mock.timers.tick(ms);
  document.visibilityState = 'visible';
  listeners.doc.visibilitychange();
}

test('reopens the socket after returning from a long background stay', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const listeners = setup();
  const { connectWs } = await load();
  const conn = connectWs('/ws/term/a', {});
  FakeWs.all[0].readyState = FakeWs.OPEN;

  hideFor(listeners, 1000, t);
  assert.equal(FakeWs.all.length, 1, 'a short switch keeps the socket');

  hideFor(listeners, 60_000, t);
  assert.equal(FakeWs.all.length, 2);
  assert.equal(FakeWs.all[0].closedByClient, true);
  assert.equal(FakeWs.all[0].onclose, null, 'the old socket must not schedule its own reconnect');
  assert.equal(FakeWs.all[1].url, 'wss://h/ws/term/a');

  conn.close();
  assert.equal(listeners.doc.visibilitychange, undefined);
  assert.equal(listeners.win.online, undefined);
});

test('does not reopen a session that ended, nor a connect in progress', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const listeners = setup();
  const { connectWs } = await load();
  connectWs('/ws/chat/a', {});
  hideFor(listeners, 100, t);
  assert.equal(FakeWs.all.length, 1, 'still CONNECTING: left alone');

  FakeWs.all[0].onclose({ code: 4004 });
  hideFor(listeners, 60_000, t);
  listeners.win.online();
  assert.equal(FakeWs.all.length, 1);
});
