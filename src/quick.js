const { readJson, writeJson } = require('./config');
const { UserError } = require('./errors');

const MAX_ITEMS = 30;

const DEFAULTS = [
  { label: 'Продолжай', text: 'продолжай' },
  { label: 'Да', text: 'да' },
  { label: '/compact', text: '/compact' },
  { label: '/clear', text: '/clear' },
  { label: '/cost', text: '/cost' },
  { label: '/context', text: '/context' },
];

function validateItems(items) {
  if (!Array.isArray(items)) throw new UserError('Некорректный список быстрых команд');
  if (items.length > MAX_ITEMS) throw new UserError(`Не более ${MAX_ITEMS} быстрых команд`);
  return items.map((item) => {
    const label = item && typeof item.label === 'string' ? item.label.trim() : '';
    const text = item && typeof item.text === 'string' ? item.text : '';
    if (label.length < 1 || label.length > 20) throw new UserError('Название: от 1 до 20 символов');
    if (text.length < 1 || text.length > 2000) throw new UserError('Текст: от 1 до 2000 символов');
    return { label, text };
  });
}

// Server-stored quick-command chips shown above the chat composer. Same JSON-file
// persistence pattern as Recent, with validation on write (Recent has none to validate).
class QuickCommands {
  constructor(file) {
    this.file = file;
    // A missing file (readJson's null fallback) falls back to the defaults; so does a file
    // that somehow holds valid-but-wrong-shaped JSON (an object, a string, ...) instead of an
    // array -- otherwise list()'s `[...this.items]` throws on the next request.
    const stored = readJson(file, null);
    this.items = Array.isArray(stored) ? stored : DEFAULTS.map((d) => ({ ...d }));
  }

  list() {
    return [...this.items];
  }

  save(items) {
    this.items = validateItems(items);
    writeJson(this.file, this.items);
    return this.list();
  }

  reset() {
    return this.save(DEFAULTS.map((d) => ({ ...d })));
  }
}

module.exports = { QuickCommands, DEFAULTS };
