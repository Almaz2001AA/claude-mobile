const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../public/js/markdown.js');
const text = (v) => ({ t: 'text', v });

test('paragraphs keep single newlines as line breaks', async () => {
  const { parseMarkdown } = await load();
  assert.deepEqual(parseMarkdown('one\ntwo\n\nthree'), [
    { t: 'p', c: [text('one'), { t: 'br' }, text('two')] },
    { t: 'p', c: [text('three')] },
  ]);
});

test('inline emphasis, code, strike and escapes', async () => {
  const { parseInline } = await load();
  assert.deepEqual(parseInline('**bold** and *it* `a*b*` ~~x~~ \\*lit\\*'), [
    { t: 'strong', c: [text('bold')] }, text(' and '), { t: 'em', c: [text('it')] }, text(' '),
    { t: 'code', v: 'a*b*' }, text(' '), { t: 'del', c: [text('x')] }, text(' *lit*'),
  ]);
});

test('snake_case and lone asterisks stay literal', async () => {
  const { parseInline } = await load();
  assert.deepEqual(parseInline('my_var_name and 2 * 3 * 4'), [text('my_var_name and 2 * 3 * 4')]);
});

test('only http(s)/mailto links become links; bare URLs are autolinked', async () => {
  const { parseInline } = await load();
  assert.deepEqual(parseInline('[a](https://x.io/p) [b](javascript:alert(1)) see https://ex.com/a.'), [
    { t: 'link', href: 'https://x.io/p', c: [text('a')] },
    text(' [b](javascript:alert(1)) see '),
    { t: 'link', href: 'https://ex.com/a', c: [text('https://ex.com/a')] },
    text('.'),
  ]);
});

test('headings, rules, fenced code with language', async () => {
  const { parseMarkdown } = await load();
  assert.deepEqual(parseMarkdown('## Title ##\n---\n```JS\nconst a = 1;\n\n**not bold**\n```\nafter'), [
    { t: 'heading', level: 2, c: [text('Title')] },
    { t: 'hr' },
    { t: 'code', lang: 'js', text: 'const a = 1;\n\n**not bold**' },
    { t: 'p', c: [text('after')] },
  ]);
});

test('unclosed fence runs to the end', async () => {
  const { parseMarkdown } = await load();
  assert.deepEqual(parseMarkdown('```\nx\ny'), [{ t: 'code', lang: '', text: 'x\ny' }]);
});

test('nested and ordered lists', async () => {
  const { parseMarkdown } = await load();
  const blocks = parseMarkdown('3. first\n   - sub a\n   - sub b\n4. second\n\ntail');
  assert.equal(blocks.length, 2);
  const list = blocks[0];
  assert.equal(list.t, 'list');
  assert.equal(list.ordered, true);
  assert.equal(list.start, 3);
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.items[0][0], { t: 'p', c: [text('first')] });
  assert.equal(list.items[0][1].t, 'list');
  assert.equal(list.items[0][1].items.length, 2);
  assert.deepEqual(list.items[1], [{ t: 'p', c: [text('second')] }]);
  assert.deepEqual(blocks[1], { t: 'p', c: [text('tail')] });
});

test('list items separated by blank lines stay one list', async () => {
  const { parseMarkdown } = await load();
  const blocks = parseMarkdown('- a\n\n- b\n- c');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].items.length, 3);
});

test('tables with alignment, escaped pipes and pipes in code', async () => {
  const { parseMarkdown } = await load();
  const [table] = parseMarkdown('| A | B |\n|:--|--:|\n| 1 | `x|y` |\n| a\\|b |');
  assert.equal(table.t, 'table');
  assert.deepEqual(table.align, ['left', 'right']);
  assert.deepEqual(table.head, [[text('A')], [text('B')]]);
  assert.deepEqual(table.rows, [
    [[text('1')], [{ t: 'code', v: 'x|y' }]],
    [[text('a|b')], []],
  ]);
});

test('blockquotes parse their contents', async () => {
  const { parseMarkdown } = await load();
  assert.deepEqual(parseMarkdown('> **hi**\n> there'), [
    { t: 'quote', c: [{ t: 'p', c: [{ t: 'strong', c: [text('hi')] }, { t: 'br' }, text('there')] }] },
  ]);
});
