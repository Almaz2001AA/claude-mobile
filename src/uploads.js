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

// The client's file name reduced to something safe to put on disk: letters (any script),
// digits, dot, dash and underscore; no path parts, no leading dot.
function safeBase(filename) {
  const base = path.basename(String(filename).replace(/\\/g, '/'), path.extname(String(filename)));
  return base.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+/, '').slice(0, 60);
}

function stamp(now) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

// Streams a raw request body to `dir`. The client sends the file as the body, name in ?filename=.
// Saved as <date>_<time>-<original name><ext>; iPhone often names every photo "image.jpg",
// hence the time prefix, plus a short random suffix if that name is somehow taken already.
async function saveUpload(req, dir, { filename = '', maxBytes = MAX_BYTES, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = safeBase(filename);
  const stem = `${stamp(now)}${base ? `-${base}` : ''}`;
  let file = path.join(dir, `${stem}${safeExt(filename)}`);
  if (fs.existsSync(file)) file = path.join(dir, `${stem}-${crypto.randomBytes(3).toString('hex')}${safeExt(filename)}`);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) cb(new UserError(`Файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`, 413));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(file, { mode: 0o600, flags: 'wx' }));
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
