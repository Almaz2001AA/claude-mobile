const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SessionManager } = require('../src/sessions');
const { StatusStore } = require('../src/status');
const { Viewers } = require('../src/viewers');
const { attachTerminal } = require('../src/terminal');
const { attachChat } = require('../src/chat-socket');
const { tmpDir, waitFor, killTmuxServer, FakeWs } = require('./helpers');

const socket = `cm-test-${process.pid}-sockets`;
const sessions = new SessionManager({ socket, claudeCmd: 'cat' });
test.after(() => killTmuxServer(socket));

const USER = JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'привет' } });
const TEXT = JSON.stringify({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'Здравствуйте' }] } });

test('terminal: keystrokes reach tmux, output comes back, session end closes with 4004', async () => {
  await sessions.create('term', tmpDir());
  const ws = new FakeWs();
  attachTerminal(ws, { sessions, name: 'term', cols: 80, rows: 24 });
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'in', d: 'abc\r' })));
  await waitFor(() => ws.sent.join('').includes('abc'));
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'resize', cols: 60, rows: 20 })));
  ws.emit('message', Buffer.from('not json'));
  await sessions.kill('term');
  await waitFor(() => ws.closed);
  assert.equal(ws.closed.code, 4004);
});

test('terminal: closing the socket detaches without killing the session', async () => {
  await sessions.create('keep', tmpDir());
  const ws = new FakeWs();
  attachTerminal(ws, { sessions, name: 'keep', cols: 80, rows: 24 });
  await waitFor(() => ws.sent.length > 0);
  ws.close(1000);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await sessions.exists('keep'), true);
  await sessions.kill('keep');
});

function chatSetup() {
  const dir = tmpDir();
  const status = new StatusStore({ file: path.join(dir, 'links.json'), projectsRoot: dir });
  const viewers = new Viewers();
  const transcript = path.join(dir, 's1.jsonl');
  fs.writeFileSync(transcript, USER + '\n');
  return { dir, status, viewers, transcript };
}

test('chat: sends status + history, then live items and status changes', async () => {
  const { status, viewers, transcript } = chatSetup();
  status.applyHook('claude-c', { hook_event_name: 'SessionStart', transcript_path: transcript });
  const ws = new FakeWs();
  attachChat(ws, { name: 'c', status, viewers, tailIntervalMs: 20 });
  await waitFor(() => ws.json().some((m) => m.type === 'history'));
  const [first, history] = ws.json();
  assert.deepEqual(first, { type: 'status', status: 'idle', message: null });
  assert.equal(history.available, true);
  assert.deepEqual(history.items.map((i) => i.text), ['привет']);

  fs.appendFileSync(transcript, TEXT + '\n');
  await waitFor(() => ws.json().some((m) => m.type === 'items'));
  assert.equal(ws.json().find((m) => m.type === 'items').items[0].text, 'Здравствуйте');

  status.applyHook('claude-c', { hook_event_name: 'UserPromptSubmit', transcript_path: transcript });
  assert.deepEqual(ws.json().at(-1), { type: 'status', status: 'working', message: null });

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'visibility', visible: true, endpoint: 'https://e' })));
  assert.deepEqual([...viewers.watchingEndpoints('c')], ['https://e']);

  ws.close(1000);
  assert.deepEqual([...viewers.watchingEndpoints('c')], []);
  const count = ws.sent.length;
  fs.appendFileSync(transcript, TEXT.replace('a1', 'a2') + '\n');
  status.applyHook('claude-c', { hook_event_name: 'Stop', transcript_path: transcript });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ws.sent.length, count, 'nothing is sent after close');
});

test('chat: without a transcript says unavailable, then loads it once SessionStart arrives', async () => {
  const { status, viewers, transcript } = chatSetup();
  const ws = new FakeWs();
  attachChat(ws, { name: 'late', status, viewers, tailIntervalMs: 20 });
  await waitFor(() => ws.json().some((m) => m.type === 'history'));
  assert.equal(ws.json().find((m) => m.type === 'history').available, false);

  status.applyHook('claude-late', { hook_event_name: 'SessionStart', transcript_path: transcript });
  await waitFor(() => ws.json().filter((m) => m.type === 'history').length === 2);
  const reloaded = ws.json().filter((m) => m.type === 'history')[1];
  assert.equal(reloaded.available, true);
  assert.deepEqual(reloaded.items.map((i) => i.text), ['привет']);
  ws.close(1000);
});

test('chat: overlapping load() calls never leave two TranscriptTails running', async () => {
  const { dir, status, viewers } = chatSetup();
  const p1 = path.join(dir, 'p1.jsonl');
  const p2 = path.join(dir, 'p2.jsonl');
  fs.writeFileSync(p1, USER + '\n');
  fs.writeFileSync(p2, USER + '\n');
  const ws = new FakeWs();
  attachChat(ws, { name: 'race', status, viewers, tailIntervalMs: 20 });

  // Fire three status changes back-to-back, synchronously, so their load() calls all start
  // before any of their readHistory() reads resolve: p1 -> p2 -> p1. Without a generation
  // guard, both loads that target p1 (the first and the last) can independently decide they
  // "won" and each spin up its own TranscriptTail for the same file.
  status.applyHook('claude-race', { hook_event_name: 'SessionStart', transcript_path: p1 });
  status.applyHook('claude-race', { hook_event_name: 'SessionStart', transcript_path: p2 });
  status.applyHook('claude-race', { hook_event_name: 'SessionStart', transcript_path: p1 });

  await waitFor(() => ws.json().filter((m) => m.type === 'history' && m.available).length >= 1);
  // Give any stray, superseded load() calls a chance to finish and (if buggy) send their
  // own extra 'history' / spin up their own tail.
  await new Promise((r) => setTimeout(r, 150));
  const historyMsgs = ws.json().filter((m) => m.type === 'history' && m.available);
  assert.equal(historyMsgs.length, 1, 'only the winning load() sends a history message');

  const before = ws.json().filter((m) => m.type === 'items').length;
  fs.appendFileSync(p1, TEXT + '\n');
  await waitFor(() => ws.json().filter((m) => m.type === 'items').length > before);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ws.json().filter((m) => m.type === 'items').length, before + 1, 'exactly one tail is watching p1, not two');
  ws.close(1000);
});

test('chat: ignores status changes of other sessions', async () => {
  const { status, viewers } = chatSetup();
  const ws = new FakeWs();
  attachChat(ws, { name: 'one', status, viewers, tailIntervalMs: 20 });
  await waitFor(() => ws.json().some((m) => m.type === 'history'));
  const count = ws.sent.length;
  status.applyHook('claude-two', { hook_event_name: 'Stop' });
  assert.equal(ws.sent.length, count);
  ws.close(1000);
});
