const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePermissionDialog } = require('../src/permission');

test('parses a boxed Bash permission dialog', () => {
  const screen = [
    '╭──────────────────────────────────────────╮',
    '│ Bash command                             │',
    '│   rm -rf build/                          │',
    '│ Do you want to proceed?                  │',
    '│ ❯ 1. Yes                                 │',
    "│   2. Yes, and don't ask again for rm     │",
    '│   3. No, and tell Claude what to do (esc)│',
    '╰──────────────────────────────────────────╯',
  ].join('\n');
  assert.deepEqual(parsePermissionDialog(screen), {
    question: 'Do you want to proceed?',
    options: [
      { key: '1', label: 'Yes' },
      { key: '2', label: "Yes, and don't ask again for rm" },
      { key: '3', label: 'No, and tell Claude what to do (esc)' },
    ],
  });
});

test('parses an unboxed edit dialog', () => {
  const screen = 'Do you want to make this edit to login.tsx?\n❯ 1. Yes\n  2. No\n';
  const d = parsePermissionDialog(screen);
  assert.equal(d.question, 'Do you want to make this edit to login.tsx?');
  assert.deepEqual(d.options.map((o) => o.key), ['1', '2']);
});

test('returns null when there is no dialog', () => {
  assert.equal(parsePermissionDialog('> hello\n1. first item of a list\n2. second'), null);
  assert.equal(parsePermissionDialog(''), null);
});

test('returns null when options do not start at 1', () => {
  assert.equal(parsePermissionDialog('Do you want to proceed?\n  2. No\n  3. Maybe'), null);
});
