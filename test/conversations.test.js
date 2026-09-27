const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hasConversation, encodeCwd } = require('../src/conversations');
const { tmpDir } = require('./helpers');

test('encodeCwd replaces every non alphanumeric character with a dash', () => {
  assert.equal(encodeCwd('/home/user/projects/app'), '-home-user-projects-app');
  assert.equal(encodeCwd('/a b_c.d'), '-a-b-c-d');
});

test('hasConversation is false when the projects root, the encoded folder, or any .jsonl file is missing', () => {
  const root = tmpDir();
  assert.equal(hasConversation('/home/user/projects/app', path.join(root, 'missing')), false);
  fs.mkdirSync(path.join(root, encodeCwd('/home/user/projects/app')), { recursive: true });
  assert.equal(hasConversation('/home/user/projects/app', root), false, 'folder exists but has no .jsonl files');
});

test('hasConversation is true once a .jsonl file exists for that folder', () => {
  const root = tmpDir();
  const cwd = '/home/user/projects/app';
  const dir = path.join(root, encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'not-a-conversation.txt'), '');
  assert.equal(hasConversation(cwd, root), false);
  fs.writeFileSync(path.join(dir, 'abc123.jsonl'), '');
  assert.equal(hasConversation(cwd, root), true);
});

test('hasConversation rejects non-string/empty cwd without throwing', () => {
  assert.equal(hasConversation('', tmpDir()), false);
  assert.equal(hasConversation(undefined, tmpDir()), false);
});
