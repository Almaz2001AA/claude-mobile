const { readJson, writeJson } = require('./config');

class Recent {
  constructor(file, max = 10) {
    this.file = file;
    this.max = max;
    this.items = readJson(file, []);
  }

  list() {
    return [...this.items];
  }

  add(cwd) {
    this.items = [cwd, ...this.items.filter((c) => c !== cwd)].slice(0, this.max);
    writeJson(this.file, this.items);
  }
}

module.exports = { Recent };
