const fs = require('node:fs');
const path = require('node:path');
const { UserError } = require('./errors');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    // Keep draining an oversized body instead of destroying the socket, so the 413 still reaches the client.
    req.on('data', (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooBig = true;
        reject(new UserError('Слишком большой запрос', 413));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!chunks.length) return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(new UserError('Некорректный JSON'));
      }
      // Route handlers destructure fields off the body; null, numbers, strings and arrays
      // would otherwise pass this step and blow up later as a 500 instead of a clean 400.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(new UserError('Некорректный JSON'));
      }
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

function serveFile(res, file) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(res, rootDir, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const root = path.resolve(rootDir);
  const file = path.resolve(root, `.${rel}`);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  serveFile(res, file);
}

module.exports = { sendJson, readJsonBody, serveFile, serveStatic };
