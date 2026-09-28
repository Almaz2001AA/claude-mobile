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

const now = new Date(2026, 8, 28, 10, 41, 7);

test('saveUpload keeps a readable name: date, time, original name, lowercase extension', async () => {
  const dir = tmpDir();
  const file = await saveUpload(Readable.from([Buffer.from('hello')]), dir, { filename: 'Фото 1.JPG', now });
  assert.equal(file, path.join(dir, '2026-09-28_10-41-07-Фото_1.jpg'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
});

test('saveUpload never overwrites: the same name twice gets a random suffix', async () => {
  const dir = tmpDir();
  const a = await saveUpload(Readable.from([Buffer.from('1')]), dir, { filename: 'image.jpg', now });
  const b = await saveUpload(Readable.from([Buffer.from('2')]), dir, { filename: 'image.jpg', now });
  assert.equal(path.basename(a), '2026-09-28_10-41-07-image.jpg');
  assert.match(path.basename(b), /^2026-09-28_10-41-07-image-[0-9a-f]{6}\.jpg$/);
  assert.equal(fs.readFileSync(a, 'utf8'), '1');
});

test('saveUpload strips path parts and odd characters; .bin for odd extensions', async () => {
  const dir = tmpDir();
  const file = await saveUpload(Readable.from([Buffer.from('x')]), dir, { filename: '../../etc/passwd;rm', now });
  assert.equal(path.dirname(file), dir);
  assert.equal(path.basename(file), '2026-09-28_10-41-07-passwd_rm.bin');
  const hidden = await saveUpload(Readable.from([Buffer.from('x')]), dir, { filename: '.bashrc', now });
  assert.equal(path.basename(hidden), '2026-09-28_10-41-07-bashrc.bin', 'never a hidden file');
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
