const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { QuickCommands, DEFAULTS } = require('../src/quick');
const { UserError } = require('../src/errors');
const { tmpDir } = require('./helpers');

test('defaults to the built-in list when the file is missing, without writing it', () => {
  const file = path.join(tmpDir(), 'missing', 'quick.json');
  const quick = new QuickCommands(file);
  assert.deepEqual(quick.list(), DEFAULTS);
  assert.equal(require('node:fs').existsSync(file), false);
});

test('save validates, persists and round-trips', () => {
  const file = path.join(tmpDir(), 'quick.json');
  const quick = new QuickCommands(file);
  const saved = quick.save([{ label: 'Стоп', text: 'esc' }]);
  assert.deepEqual(saved, [{ label: 'Стоп', text: 'esc' }]);
  assert.deepEqual(new QuickCommands(file).list(), [{ label: 'Стоп', text: 'esc' }]);
});

test('save rejects bad shapes', () => {
  const quick = new QuickCommands(path.join(tmpDir(), 'quick.json'));
  assert.throws(() => quick.save('nope'), UserError);
  assert.throws(() => quick.save([{ label: '', text: 'x' }]), UserError);
  assert.throws(() => quick.save([{ label: 'x'.repeat(21), text: 'x' }]), UserError);
  assert.throws(() => quick.save([{ label: 'ok', text: '' }]), UserError);
  assert.throws(() => quick.save([{ label: 'ok', text: 'x'.repeat(2001) }]), UserError);
  assert.throws(() => quick.save(Array.from({ length: 31 }, () => ({ label: 'a', text: 'b' }))), UserError);
});

test('reset restores the defaults and persists them', () => {
  const file = path.join(tmpDir(), 'quick.json');
  const quick = new QuickCommands(file);
  quick.save([{ label: 'x', text: 'y' }]);
  assert.deepEqual(quick.reset(), DEFAULTS);
  assert.deepEqual(new QuickCommands(file).list(), DEFAULTS);
});
