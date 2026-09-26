const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseLine, readHistory, TranscriptTail, toolSummary } = require('../src/transcript');
const { tmpDir, waitFor } = require('./helpers');

const line = (obj) => JSON.stringify(obj);
const USER = line({ type: 'user', uuid: 'u1', timestamp: 't1', message: { role: 'user', content: 'добавь проверку' } });
const META = line({ type: 'user', uuid: 'u2', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill' }] } });
const COMMAND = line({ type: 'user', uuid: 'u3', message: { role: 'user', content: '<command-name>/clear</command-name>' } });
const THINK = line({ type: 'assistant', uuid: 'a0', message: { content: [{ type: 'thinking', thinking: '' }] } });
const TEXT = line({ type: 'assistant', uuid: 'a1', timestamp: 't2', message: { content: [{ type: 'text', text: 'Сейчас посмотрю.' }] } });
const TOOL = line({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/src/login.tsx', old_string: 'a', new_string: 'b' } }] } });
const RESULT = line({ type: 'user', uuid: 'u4', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }], is_error: false }] } });
const SIDECHAIN = line({ type: 'assistant', uuid: 'a3', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } });
const OTHER = line({ type: 'file-history-snapshot', snapshot: {} });

test('parseLine maps user, assistant, tool_use and tool_result', () => {
  assert.deepEqual(parseLine(USER), [{ kind: 'user', id: 'u1', text: 'добавь проверку', ts: 't1' }]);
  assert.deepEqual(parseLine(TEXT), [{ kind: 'assistant', id: 'a1:0', text: 'Сейчас посмотрю.', ts: 't2' }]);
  const [tool] = parseLine(TOOL);
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.id, 'toolu_1');
  assert.equal(tool.summary, '✏️ Изменил login.tsx');
  assert.equal(tool.input.new_string, 'b');
  assert.deepEqual(parseLine(RESULT), [{ kind: 'tool_result', id: 'u4:0', toolUseId: 'toolu_1', text: 'ok', isError: false, ts: null }]);
});

test('parseLine hides meta, commands, thinking, sidechains, other types and garbage', () => {
  for (const hidden of [META, COMMAND, THINK, SIDECHAIN, OTHER, '{broken', '', 'null', '42']) {
    assert.deepEqual(parseLine(hidden), [], hidden);
  }
});

test('toolSummary covers common tools and falls back to the name', () => {
  assert.equal(toolSummary('Read', { file_path: '/a/b.js' }), '📄 Прочитал b.js');
  assert.equal(toolSummary('Bash', { command: 'npm test\nsecond line' }), '⚙️ npm test');
  assert.equal(toolSummary('Grep', { pattern: 'foo' }), '🔍 Поиск: foo');
  assert.equal(toolSummary('mcp__x__y', {}), '🔧 mcp__x__y');
});

test('long tool inputs and results are truncated', () => {
  const big = 'x'.repeat(10000);
  const [tool] = parseLine(line({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 't', name: 'Write', input: { file_path: '/f', content: big } }] } }));
  assert.ok(tool.input.content.length <= 4000);
  const [res] = parseLine(line({ type: 'user', uuid: 'u', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: big }] } }));
  assert.ok(res.text.length <= 4000);
});

test('readHistory returns the last N items, their start index and the byte offset', async () => {
  const file = path.join(tmpDir(), 's.jsonl');
  fs.writeFileSync(file, [USER, META, TEXT, TOOL, RESULT].join('\n') + '\n' + '{"type":"user","partial');
  const all = await readHistory(file, { limit: 200 });
  assert.deepEqual(all.items.map((i) => i.kind), ['user', 'assistant', 'tool', 'tool_result']);
  assert.equal(all.start, 0);
  assert.equal(all.offset, fs.readFileSync(file).lastIndexOf(10) + 1, 'offset stops before the partial line');

  const last2 = await readHistory(file, { limit: 2 });
  assert.deepEqual(last2.items.map((i) => i.kind), ['tool', 'tool_result']);
  assert.equal(last2.start, 2);

  const earlier = await readHistory(file, { before: 2, limit: 200 });
  assert.deepEqual(earlier.items.map((i) => i.kind), ['user', 'assistant']);
  assert.equal(earlier.start, 0);
});

test('TranscriptTail emits items for appended complete lines, including split UTF-8', async () => {
  const file = path.join(tmpDir(), 't.jsonl');
  fs.writeFileSync(file, USER + '\n');
  const tail = new TranscriptTail(file, { offset: fs.statSync(file).size, intervalMs: 20 });
  const got = [];
  tail.on('items', (items) => got.push(...items));
  tail.start();
  const bytes = Buffer.from(TEXT + '\n');
  const cut = bytes.indexOf(Buffer.from('посмотрю')) + 1; // split inside a Cyrillic character
  fs.appendFileSync(file, bytes.subarray(0, cut));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(got.length, 0, 'incomplete line is not emitted');
  fs.appendFileSync(file, bytes.subarray(cut));
  await waitFor(() => got.length === 1);
  assert.equal(got[0].text, 'Сейчас посмотрю.');
  tail.stop();
});

test('TranscriptTail tolerates a missing file', async () => {
  const tail = new TranscriptTail(path.join(tmpDir(), 'missing.jsonl'), { intervalMs: 10 });
  tail.start();
  await new Promise((r) => setTimeout(r, 40));
  tail.stop();
});
