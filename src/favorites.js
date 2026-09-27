const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson } = require('./config');
const { UserError } = require('./errors');
const { validateName } = require('./sessions');

const MAX_ITEMS = 30;

function validateItems(items) {
  if (!Array.isArray(items)) throw new UserError('Некорректный список избранного');
  if (items.length > MAX_ITEMS) throw new UserError(`Не более ${MAX_ITEMS} избранных папок`);
  const seen = new Set();
  return items.map((item) => {
    const name = validateName(item && item.name);
    if (seen.has(name)) throw new UserError('Имена избранного должны быть уникальными');
    seen.add(name);
    const cwd = item && typeof item.cwd === 'string' ? item.cwd : '';
    if (!path.isAbsolute(cwd)) throw new UserError('Укажите полный путь к папке');
    let stat = null;
    try { stat = fs.statSync(cwd); } catch {}
    if (!stat || !stat.isDirectory()) throw new UserError('Папка не найдена');
    return { name, cwd };
  });
}

// Favorite folders, persisted the same way as Recent/QuickCommands.
class Favorites {
  constructor(file) {
    this.file = file;
    this.items = readJson(file, []);
  }

  list() {
    return [...this.items];
  }

  get(name) {
    return this.items.find((f) => f.name === name) || null;
  }

  save(items) {
    this.items = validateItems(items);
    writeJson(this.file, this.items);
    return this.list();
  }
}

module.exports = { Favorites };
