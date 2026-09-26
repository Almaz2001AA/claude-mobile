const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { Recent } = require('../src/recent');
const { saveUpload } = require('../src/uploads');
const { UserError } = require('../src/errors');
const { tmpDir } = require('./helpers');

test('Recent keeps unique folders, newest first, capped and persisted', () => {
  const file = path.join(tmpDir(), 'recent.json');
  const recent = new Recent(file, 3);
  for (const dir of ['/a', '/b', '/a', '/c', '/d']) recent.add(dir);
  assert.deepEqual(recent.list(), ['/d', '/c', '/a']);
  assert.deepEqual(new Recent(file, 3).list(), ['/d', '/c', '/a']);
});

test('saveUpload writes the body with a safe name and extension', async () => {
  const dir = tmpDir();
  const file = await saveUpload(Readable.from([Buffer.from('hello')]), dir, { filename: 'Photo 1.JPG' });
  assert.equal(path.dirname(file), dir);
  assert.match(path.basename(file), /^\d{4}-\d{2}-\d{2}-[0-9a-f]{12}\.jpg$/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
});

test('saveUpload falls back to .bin for odd extensions', async () => {
  const file = await saveUpload(Readable.from([Buffer.from('x')]), tmpDir(), { filename: '../../etc/passwd;rm' });
  assert.match(file, /\.bin$/);
});

test('saveUpload rejects oversize and empty bodies and leaves no file', async () => {
  const dir = tmpDir();
  await assert.rejects(
    saveUpload(Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), dir, { filename: 'a.png', maxBytes: 10 }),
    (err) => err instanceof UserError && err.status === 413,
  );
  await assert.rejects(saveUpload(Readable.from([]), dir, { filename: 'a.png' }), UserError);
  assert.deepEqual(fs.readdirSync(dir), []);
});
