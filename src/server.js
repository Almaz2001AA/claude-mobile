const http = require('node:http');
const { WebSocketServer } = require('ws');
const { UserError } = require('./errors');
const { clampInt } = require('./util');
const { sendJson, readJsonBody, serveFile, serveStatic } = require('./http');
const { parseCookies, safeEqual } = require('./auth');
const { saveUpload } = require('./uploads');
const { readHistory } = require('./transcript');
const { validateName } = require('./sessions');
const { attachTerminal } = require('./terminal');
const { attachChat } = require('./chat-socket');

const COOKIE = 'cm_auth';
const COOKIE_MAX_AGE = 30 * 24 * 3600;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const WS_PATH_RE = /^\/ws\/(term|chat)\/([a-z0-9-]{1,32})$/;

const authCookie = (value, maxAge) => `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

function createApp(deps) {
  const { sessions, input, status, auth, push, viewers, recent, paths, hookSecret, publicDir, vendorFiles = {}, allowedOrigin = null } = deps;
  const routes = [];
  const on = (method, pattern, handler, { open = false } = {}) => routes.push({ method, pattern, handler, open });
  const isAuthed = (req) => auth.verify(parseCookies(req.headers.cookie)[COOKIE]);
  const ok = (res) => sendJson(res, 200, { ok: true });

  on('POST', /^\/api\/login$/, async (req, res) => {
    const { pin } = await readJsonBody(req);
    const result = auth.login(String(pin ?? ''));
    if (!result.ok) return sendJson(res, result.locked ? 429 : 401, { error: result.error });
    res.setHeader('set-cookie', authCookie(result.token, COOKIE_MAX_AGE));
    ok(res);
  }, { open: true });

  on('POST', /^\/api\/logout$/, (req, res) => {
    res.setHeader('set-cookie', authCookie('', 0));
    ok(res);
  }, { open: true });

  on('GET', /^\/api\/me$/, (req, res) => ok(res));

  on('GET', /^\/api\/sessions$/, async (req, res) => {
    const list = await sessions.list();
    sendJson(res, 200, list.map((s) => {
      const st = status.get(s.name);
      return { ...s, status: st.status, message: st.message || null, hasTranscript: Boolean(st.transcriptPath) };
    }));
  });

  on('POST', /^\/api\/sessions$/, async (req, res) => {
    const { name, cwd } = await readJsonBody(req);
    await sessions.create(name, cwd);
    status.remove(name);
    recent.add(cwd);
    sendJson(res, 201, { ok: true });
  });

  on('DELETE', /^\/api\/sessions\/(?<name>[^/]+)$/, async (req, res, p) => {
    await sessions.kill(p.name);
    status.remove(p.name);
    ok(res);
  });

  on('GET', /^\/api\/recent-cwds$/, (req, res) => sendJson(res, 200, recent.list()));

  on('GET', /^\/api\/sessions\/(?<name>[^/]+)\/history$/, async (req, res, p, url) => {
    const st = status.get(validateName(p.name));
    if (!st.transcriptPath) throw new UserError('История недоступна', 404);
    const before = url.searchParams.has('before') ? clampInt(url.searchParams.get('before'), 0, Number.MAX_SAFE_INTEGER, 0) : undefined;
    const limit = clampInt(url.searchParams.get('limit'), 1, 500, 200);
    sendJson(res, 200, await readHistory(st.transcriptPath, { before, limit }));
  });

  on('POST', /^\/api\/sessions\/(?<name>[^/]+)\/input$/, async (req, res, p) => {
    const { text } = await readJsonBody(req);
    await input.sendText(p.name, text);
    ok(res);
  });

  on('POST', /^\/api\/sessions\/(?<name>[^/]+)\/key$/, async (req, res, p) => {
    const { key } = await readJsonBody(req);
    await input.sendKey(p.name, key);
    ok(res);
  });

  on('GET', /^\/api\/sessions\/(?<name>[^/]+)\/permission$/, async (req, res, p) => {
    sendJson(res, 200, { dialog: await input.readPermission(p.name) });
  });

  on('POST', /^\/api\/sessions\/(?<name>[^/]+)\/permission$/, async (req, res, p) => {
    const { key } = await readJsonBody(req);
    await input.answerPermission(p.name, String(key));
    ok(res);
  });

  on('POST', /^\/api\/sessions\/(?<name>[^/]+)\/upload$/, async (req, res, p, url) => {
    validateName(p.name);
    const file = await saveUpload(req, paths.uploads, { filename: url.searchParams.get('filename') || '' });
    sendJson(res, 201, { path: file });
  });

  on('GET', /^\/api\/push\/key$/, (req, res) => sendJson(res, 200, { key: push.publicKey }));

  on('POST', /^\/api\/push\/subscribe$/, async (req, res) => {
    const { subscription, prefs } = await readJsonBody(req);
    if (!subscription || typeof subscription.endpoint !== 'string') throw new UserError('Нет подписки');
    push.subscribe(subscription, prefs);
    ok(res);
  });

  on('POST', /^\/api\/push\/prefs$/, async (req, res) => {
    const { endpoint, prefs } = await readJsonBody(req);
    push.updatePrefs(endpoint, prefs);
    ok(res);
  });

  on('POST', /^\/api\/push\/unsubscribe$/, async (req, res) => {
    const { endpoint } = await readJsonBody(req);
    push.unsubscribe(endpoint);
    ok(res);
  });

  on('POST', /^\/internal\/hook$/, async (req, res) => {
    const direct = LOOPBACK.has(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];
    if (!direct || !safeEqual(req.headers['x-hook-secret'] || '', hookSecret)) return sendJson(res, 403, { error: 'forbidden' });
    const { tmuxSession, event } = await readJsonBody(req);
    if (typeof tmuxSession === 'string' && event && typeof event === 'object') status.applyHook(tmuxSession, event);
    ok(res);
  }, { open: true });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = url.pathname.match(route.pattern);
        if (!match) continue;
        if (!route.open && !isAuthed(req)) return sendJson(res, 401, { error: 'Нужен вход' });
        return await route.handler(req, res, match.groups || {}, url);
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/internal/')) {
        return sendJson(res, 404, { error: 'Не найдено' });
      }
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Метод не поддерживается' });
      const vendor = url.pathname.match(/^\/vendor\/([\w.-]+)$/);
      if (vendor) {
        if (vendorFiles[vendor[1]]) return serveFile(res, vendorFiles[vendor[1]]);
        return sendJson(res, 404, { error: 'Не найдено' });
      }
      return serveStatic(res, publicDir, url.pathname);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof UserError) return sendJson(res, err.status, { error: err.message });
      if (/can't find (session|pane|window)|no server running|error connecting|no current target/.test(err.message)) {
        return sendJson(res, 404, { error: 'Сессия не найдена' });
      }
      console.error(err);
      return sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return false;
    if (allowedOrigin) return origin === allowedOrigin;
    try {
      return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host);
    } catch {
      return false;
    }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  async function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    const match = url.pathname.match(WS_PATH_RE);
    if (!match || !isAuthed(req) || !originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const [, kind, name] = match;
    // Resolve existence *before* completing the handshake: once the client sees the
    // connection open it may send a message immediately, and if that await happened
    // inside the handleUpgrade callback the first message could arrive before
    // attachTerminal/attachChat had a chance to register its 'message' listener.
    const exists = await sessions.exists(name);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!exists) return ws.close(4004, 'Сессия не найдена');
      if (kind === 'term') {
        const cols = clampInt(url.searchParams.get('cols'), 20, 400, 80);
        const rows = clampInt(url.searchParams.get('rows'), 5, 200, 24);
        attachTerminal(ws, { sessions, name, cols, rows });
      } else {
        attachChat(ws, { name, status, viewers });
      }
    });
  }

  const server = http.createServer(handle);
  server.on('upgrade', handleUpgrade);
  return { server, handle };
}

module.exports = { createApp };
