const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Favorites } = require('../src/favorites');
const { UserError } = require('../src/errors');
const { tmpDir } = require('./helpers');

test('missing file starts empty', () => {
  const favorites = new Favorites(path.join(tmpDir(), 'missing', 'favorites.json'));
  assert.deepEqual(favorites.list(), []);
  assert.equal(favorites.get('x'), null);
});

test('save validates, persists and round-trips; get finds by name', () => {
  const file = path.join(tmpDir(), 'favorites.json');
  const favorites = new Favorites(file);
  const dir = tmpDir();
  const saved = favorites.save([{ name: 'work', cwd: dir }]);
  assert.deepEqual(saved, [{ name: 'work', cwd: dir }]);
  assert.deepEqual(new Favorites(file).list(), [{ name: 'work', cwd: dir }]);
  assert.deepEqual(favorites.get('work'), { name: 'work', cwd: dir });
});

test('a file holding valid JSON that is not an array falls back to [] instead of throwing', () => {
  for (const bad of ['{}', '"oops"', '42', 'null', 'false']) {
    const file = path.join(tmpDir(), 'favorites.json');
    fs.writeFileSync(file, bad);
    const favorites = new Favorites(file);
    assert.deepEqual(favorites.list(), [], `bad content: ${bad}`);
    assert.equal(favorites.get('x'), null);
  }
});

test('save rejects bad names, relative/missing cwd, duplicates and too many items', () => {
  const favorites = new Favorites(path.join(tmpDir(), 'favorites.json'));
  const dir = tmpDir();
  assert.throws(() => favorites.save('nope'), UserError);
  assert.throws(() => favorites.save([{ name: 'Bad Name', cwd: dir }]), UserError);
  assert.throws(() => favorites.save([{ name: 'ok', cwd: 'relative/path' }]), UserError);
  assert.throws(() => favorites.save([{ name: 'ok', cwd: '/definitely/not/here' }]), UserError);
  assert.throws(() => favorites.save([{ name: 'ok', cwd: dir }, { name: 'ok', cwd: dir }]), UserError);
  assert.throws(() => favorites.save(Array.from({ length: 31 }, (_, i) => ({ name: `n${i}`, cwd: dir }))), UserError);
});
