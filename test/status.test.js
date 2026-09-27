const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { StatusStore } = require('../src/status');
const { readJson } = require('../src/config');
const { tmpDir } = require('./helpers');

// projectsRoot '/' accepts any absolute path so the pre-existing tests below (which use
// fake paths like '/t/s1.jsonl' purely to exercise the status transitions) keep working.
const newStore = () => new StatusStore({ file: path.join(tmpDir(), 'links.json'), projectsRoot: '/' });

test('unknown sessions are idle with no transcript', () => {
  assert.deepEqual(newStore().get('x'), { status: 'idle' });
});

test('SessionStart links the transcript; prompt and tools mean working; Stop means idle', () => {
  const store = newStore();
  store.applyHook('claude-a', { hook_event_name: 'SessionStart', session_id: 's1', transcript_path: '/t/s1.jsonl' });
  assert.equal(store.get('a').transcriptPath, '/t/s1.jsonl');
  assert.equal(store.get('a').status, 'idle');
  store.applyHook('claude-a', { hook_event_name: 'UserPromptSubmit', transcript_path: '/t/s1.jsonl' });
  assert.equal(store.get('a').status, 'working');
  store.applyHook('claude-a', { hook_event_name: 'Stop', transcript_path: '/t/s1.jsonl' });
  assert.equal(store.get('a').status, 'idle');
});

test('permission notifications set waiting_permission with the message', () => {
  const store = newStore();
  store.applyHook('claude-a', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.equal(store.get('a').status, 'waiting_permission');
  assert.equal(store.get('a').message, 'Claude needs your permission to use Bash');
  store.applyHook('claude-a', { hook_event_name: 'PostToolUse' });
  assert.equal(store.get('a').status, 'working');
  assert.equal(store.get('a').message, null);
});

test('older Notification payloads without a type are detected by message', () => {
  const store = newStore();
  store.applyHook('claude-a', { hook_event_name: 'Notification', message: 'Claude needs your permission to use Edit' });
  assert.equal(store.get('a').status, 'waiting_permission');
});

test('idle notifications and unknown events change nothing', () => {
  const store = newStore();
  assert.equal(store.applyHook('claude-a', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' }), null);
  assert.equal(store.applyHook('claude-a', { hook_event_name: 'Whatever' }), null);
  assert.equal(store.applyHook('not-ours', { hook_event_name: 'Stop' }), null);
});

test('emits change events and persists to disk', () => {
  const file = path.join(tmpDir(), 'links.json');
  const store = new StatusStore({ file, projectsRoot: '/' });
  const seen = [];
  store.on('change', (name, entry, eventName) => seen.push([name, entry.status, eventName]));
  store.applyHook('claude-b', { hook_event_name: 'SessionStart', transcript_path: '/t/b.jsonl' });
  assert.deepEqual(seen, [['b', 'idle', 'SessionStart']]);
  assert.equal(readJson(file, {}).b.transcriptPath, '/t/b.jsonl');
  assert.equal(new StatusStore({ file }).get('b').transcriptPath, '/t/b.jsonl');
});

test('applyHook accepts only an absolute .jsonl transcript_path inside the configured projects root', () => {
  const root = tmpDir();
  const store = new StatusStore({ file: path.join(tmpDir(), 'links.json'), projectsRoot: root });
  const valid = path.join(root, 'proj', 's1.jsonl');

  store.applyHook('claude-a', { hook_event_name: 'SessionStart', transcript_path: valid });
  assert.equal(store.get('a').transcriptPath, valid);

  // Status still applies even when the path is rejected; only the (untouched) link is kept.
  store.applyHook('claude-a', { hook_event_name: 'UserPromptSubmit', transcript_path: '/etc/passwd' });
  assert.equal(store.get('a').status, 'working');
  assert.equal(store.get('a').transcriptPath, valid, 'path outside the projects root is ignored');

  store.applyHook('claude-a', { hook_event_name: 'Stop', transcript_path: `${valid}.txt` });
  assert.equal(store.get('a').transcriptPath, valid, 'non-.jsonl path is ignored');

  store.applyHook('claude-a', { hook_event_name: 'Stop', transcript_path: 'relative/inside/but/relative.jsonl' });
  assert.equal(store.get('a').transcriptPath, valid, 'relative path is ignored');

  store.applyHook('claude-a', { hook_event_name: 'Stop', transcript_path: `${root}-sibling/escape.jsonl` });
  assert.equal(store.get('a').transcriptPath, valid, 'sibling directory sharing the root as a string prefix is ignored');
});

test('remove forgets a session', () => {
  const store = newStore();
  store.applyHook('claude-c', { hook_event_name: 'Stop', transcript_path: '/t/c.jsonl' });
  store.remove('c');
  assert.deepEqual(store.get('c'), { status: 'idle' });
});
