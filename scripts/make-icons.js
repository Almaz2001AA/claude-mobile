// Writes simple PNG app icons (orange ring on dark background) without extra dependencies.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BG = [0x1c, 0x1b, 0x1a];
const FG = [0xd9, 0x77, 0x57];

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function icon(size) {
  const center = size / 2;
  const radius = size * 0.3;
  const width = size * 0.09;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3); // leading 0 = "no filter"
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      row.set(Math.abs(d - radius) < width / 2 ? FG : BG, 1 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.resolve(__dirname, '..', 'public');
fs.mkdirSync(out, { recursive: true });
for (const size of [180, 192, 512]) fs.writeFileSync(path.join(out, `icon-${size}.png`), icon(size));
console.log('icons written to', out);
