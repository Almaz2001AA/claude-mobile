const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { UserError } = require('./errors');

const MAX_BYTES = 20 * 1024 * 1024;

function safeExt(filename) {
  const ext = path.extname(String(filename)).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '.bin';
}

// Streams a raw request body to `dir`. The client sends the file as the body, name in ?filename=.
async function saveUpload(req, dir, { filename = '', maxBytes = MAX_BYTES } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${date}-${crypto.randomBytes(6).toString('hex')}${safeExt(filename)}`);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) cb(new UserError(`Файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`, 413));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(file, { mode: 0o600 }));
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err instanceof UserError ? err : new UserError('Не удалось сохранить файл', 500);
  }
  if (size === 0) {
    fs.rmSync(file, { force: true });
    throw new UserError('Пустой файл');
  }
  return file;
}

module.exports = { saveUpload };
