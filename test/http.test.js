const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { sendJson, readJsonBody, serveStatic } = require('../src/http');
const { tmpDir } = require('./helpers');

// Raw request so the path is sent exactly as written (fetch/URL would normalize %2e%2e away).
function rawStatus(base, rawPath) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    http.get({ host: hostname, port, path: rawPath }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('sendJson and readJsonBody', async () => {
  await withServer(async (req, res) => {
    try {
      sendJson(res, 200, { got: await readJsonBody(req, 20) });
    } catch (err) {
      sendJson(res, err.status, { error: err.message });
    }
  }, async (base) => {
    let res = await fetch(base, { method: 'POST', body: '{"a":1}' });
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await res.json(), { got: { a: 1 } });
    res = await fetch(base, { method: 'POST' });
    assert.deepEqual(await res.json(), { got: {} });
    res = await fetch(base, { method: 'POST', body: '{oops' });
    assert.equal(res.status, 400);
    res = await fetch(base, { method: 'POST', body: JSON.stringify({ long: 'x'.repeat(100) }) });
    assert.equal(res.status, 413);
  });
});

test('readJsonBody rejects valid JSON that is not a plain object', async () => {
  await withServer(async (req, res) => {
    try {
      sendJson(res, 200, { got: await readJsonBody(req) });
    } catch (err) {
      sendJson(res, err.status, { error: err.message });
    }
  }, async (base) => {
    for (const body of ['null', '42', '"hello"', '[1,2,3]', 'true']) {
      const res = await fetch(base, { method: 'POST', body });
      assert.equal(res.status, 400, body);
      assert.equal((await res.json()).error, 'Некорректный JSON');
    }
  });
});

test('serveStatic serves files with types and blocks traversal', async () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>');
  fs.mkdirSync(path.join(root, 'js'));
  fs.writeFileSync(path.join(root, 'js', 'app.js'), 'export {}');
  // Pass req.url raw: wrapping it in `new URL()` first would collapse %2e%2e dot-segments
  // during URL parsing itself, making the traversal payload below (and serveStatic's own
  // 403 guard) unreachable before it even gets there.
  await withServer((req, res) => serveStatic(res, root, req.url), async (base) => {
    let res = await fetch(`${base}/`);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await res.text(), '<h1>hi</h1>');
    res = await fetch(`${base}/js/app.js`);
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(`${base}/missing.js`)).status, 404);
    assert.equal(await rawStatus(base, '/%2e%2e/%2e%2e/etc/passwd'), 403);
    assert.equal(await rawStatus(base, '/%E0%A4%A'), 400);
  });
});
