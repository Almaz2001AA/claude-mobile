const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../public/js/diff.js');
const types = (ops) => ops.map((o) => (o.type === 'skip' ? `skip${o.count}` : `${o.type}:${o.text}`));

test('lineDiff marks removed, added and unchanged lines', async () => {
  const { lineDiff, diffStats } = await load();
  const ops = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(types(ops), ['ctx:a', 'del:b', 'add:B', 'ctx:c', 'ctx:d', 'add:e']);
  assert.deepEqual(diffStats(ops), { added: 2, removed: 1 });
});

test('lineDiff handles empty sides', async () => {
  const { lineDiff } = await load();
  assert.deepEqual(types(lineDiff('', 'x\ny')), ['add:x', 'add:y']);
  assert.deepEqual(types(lineDiff('x', '')), ['del:x']);
  assert.deepEqual(lineDiff('', ''), []);
});

test('foldContext collapses long unchanged runs but keeps context', async () => {
  const { lineDiff, foldContext } = await load();
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const after = [...before];
  after[10] = 'changed';
  const folded = foldContext(lineDiff(before.join('\n'), after.join('\n')), 2);
  assert.deepEqual(types(folded), ['skip8', 'ctx:l8', 'ctx:l9', 'del:l10', 'add:changed', 'ctx:l11', 'ctx:l12', 'skip7']);
});

test('huge inputs fall back to delete-all/add-all', async () => {
  const { lineDiff } = await load();
  const a = Array.from({ length: 2000 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 2000 }, (_, i) => `b${i}`).join('\n');
  const ops = lineDiff(a, b);
  assert.equal(ops.length, 4000);
  assert.equal(ops[0].type, 'del');
  assert.equal(ops[3999].type, 'add');
});

test('parseUnified classifies git diff output and rejects other text', async () => {
  const { parseUnified } = await load();
  const out = parseUnified('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new');
  assert.deepEqual(out.map((l) => l.type), ['meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add']);
  assert.equal(out[6].text, 'new');
  assert.equal(parseUnified('- just a list\n+ plus'), null);
});
