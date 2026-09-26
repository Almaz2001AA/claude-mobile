const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../public/js/chat-model.js');

const user = (id, text) => ({ kind: 'user', id, text });
const tool = (id) => ({ kind: 'tool', id, name: 'Bash', summary: `⚙️ ${id}`, input: {} });
const result = (id, toolUseId, text, isError = false) => ({ kind: 'tool_result', id, toolUseId, text, isError });

test('reset + append attach results to tools and skip duplicates', async () => {
  const { ChatModel } = await load();
  const model = new ChatModel();
  model.reset({ items: [user('u1', 'hi'), tool('t1')], start: 3, available: true });
  model.append([result('r1', 't1', 'done'), user('u1', 'hi')]);
  assert.deepEqual(model.list.map((i) => i.id), ['u1', 't1']);
  assert.deepEqual(model.list[1].result, { text: 'done', isError: false });
  assert.equal(model.hasMore, true);
});

test('prepend adds older items in front and resolves orphan results', async () => {
  const { ChatModel } = await load();
  const model = new ChatModel();
  model.reset({ items: [result('r0', 't0', 'old result', true), user('u2', 'later')], start: 2, available: true });
  assert.deepEqual(model.list.map((i) => i.id), ['u2']);
  model.prepend({ items: [user('u0', 'first'), tool('t0')], start: 0 });
  assert.deepEqual(model.list.map((i) => i.id), ['u0', 't0', 'u2']);
  assert.deepEqual(model.list[1].result, { text: 'old result', isError: true });
  assert.equal(model.hasMore, false);
});

test('reset replaces everything and carries availability', async () => {
  const { ChatModel } = await load();
  const model = new ChatModel();
  model.append([user('x', 'x')]);
  model.reset({ items: [], start: 0, available: false });
  assert.deepEqual(model.list, []);
  assert.equal(model.available, false);
});

test('lastTool returns the most recent tool item', async () => {
  const { ChatModel } = await load();
  const model = new ChatModel();
  model.reset({ items: [tool('a'), user('u', 'x'), tool('b'), user('v', 'y')], start: 0, available: true });
  assert.equal(model.lastTool().id, 'b');
});
