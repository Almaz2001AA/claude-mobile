const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getPaths, getPort, readJson, writeJson, getOrCreateSecret } = require('../src/config');
const { tmpDir } = require('./helpers');

test('getPaths honours CLAUDE_MOBILE_HOME and CLAUDE_MOBILE_UPLOADS', () => {
  const p = getPaths({ CLAUDE_MOBILE_HOME: '/x/cfg', CLAUDE_MOBILE_UPLOADS: '/x/up' });
  assert.equal(p.base, '/x/cfg');
  assert.equal(p.links, '/x/cfg/links.json');
  assert.equal(p.hookSecret, '/x/cfg/hook-secret');
  assert.equal(p.uploads, '/x/up');
});

test('getPort defaults to 8787', () => {
  assert.equal(getPort({}), 8787);
  assert.equal(getPort({ CLAUDE_MOBILE_PORT: '9000' }), 9000);
});

test('writeJson/readJson round-trip with private file mode', () => {
  const file = path.join(tmpDir(), 'nested', 'a.json');
  writeJson(file, { a: 1 });
  assert.deepEqual(readJson(file, null), { a: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('readJson returns fallback for missing or broken files', () => {
  const dir = tmpDir();
  assert.deepEqual(readJson(path.join(dir, 'none.json'), []), []);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
  assert.equal(readJson(path.join(dir, 'bad.json'), 7), 7);
});

test('getOrCreateSecret creates once and then reuses', () => {
  const file = path.join(tmpDir(), 'secret');
  const first = getOrCreateSecret(file);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(getOrCreateSecret(file), first);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
