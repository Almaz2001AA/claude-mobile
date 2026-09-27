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
  const { sessions, input, status, auth, push, viewers, recent, quick, favorites, paths, hookSecret, publicDir, vendorFiles = {}, allowedOrigin = null, heartbeatIntervalMs = 30000 } = deps;
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
    const result = await Promise.all(list.map(async (s) => {
      const st = status.get(s.name);
      let statusValue = st.status;
      let message = st.message || null;
      if (statusValue === 'waiting_permission') {
        // The store can go stale: the user may have answered/dismissed the dialog (or
        // interrupted Claude) straight from the terminal, without going through our own
        // answerPermission endpoint. Re-check the live screen rather than trusting the
        // last hook event, but don't write the correction back — the hook is still the
        // source of truth and may legitimately flip this back to waiting shortly after.
        try {
          const dialog = await input.readPermission(s.name);
          if (!dialog) {
            statusValue = 'idle';
            message = null;
          }
        } catch {
          // Can't tell right now (tmux hiccup): report the last known status unchanged.
        }
      }
      return { ...s, status: statusValue, message, hasTranscript: Boolean(st.transcriptPath) };
    }));
    sendJson(res, 200, result);
  });

  on('POST', /^\/api\/sessions$/, async (req, res) => {
    const { name, cwd, resume } = await readJsonBody(req);
    await sessions.create(name, cwd, { resume: resume === true });
    status.remove(name);
    recent.add(cwd);
    sendJson(res, 201, { ok: true });
  });

  on('DELETE', /^\/api\/sessions\/(?<name>[^/]+)$/, async (req, res, p) => {
    await sessions.kill(p.name);
    status.remove(p.name);
    // The terminal WS learns the session is gone from its pty exiting; a chat WS has no
    // such signal on its own, so it would otherwise sit open forever believing the (now
    // deleted) session still exists.
    viewers.closeSession(p.name, 4004, 'Сессия завершена');
    ok(res);
  });

  on('GET', /^\/api\/recent-cwds$/, (req, res) => sendJson(res, 200, recent.list()));

  on('GET', /^\/api\/quick$/, (req, res) => sendJson(res, 200, quick.list()));

  on('PUT', /^\/api\/quick$/, async (req, res) => {
    const { items, reset } = await readJsonBody(req);
    sendJson(res, 200, reset === true ? quick.reset() : quick.save(items));
  });

  on('GET', /^\/api\/favorites$/, (req, res) => sendJson(res, 200, favorites.list()));

  on('PUT', /^\/api\/favorites$/, async (req, res) => {
    const { items } = await readJsonBody(req);
    sendJson(res, 200, favorites.save(items));
  });

  on('POST', /^\/api\/favorites\/(?<name>[^/]+)\/open$/, async (req, res, p) => {
    const name = validateName(p.name);
    const fav = favorites.get(name);
    if (!fav) throw new UserError('Избранное не найдено', 404);
    if (await sessions.exists(name)) return sendJson(res, 200, { name, created: false });
    await sessions.create(name, fav.cwd, { resume: true });
    status.remove(name);
    recent.add(fav.cwd);
    sendJson(res, 200, { name, created: true });
  });

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
        // CSRF guard for anything that changes state, login included: a cross-site page
        // can still make a simple GET, but a browser always attaches Origin to a state-
        // changing fetch/XHR, so a mismatched one is decisive. Requests without an Origin
        // header at all (curl, server-to-server, tests) are allowed through.
        if (req.method !== 'GET' && url.pathname.startsWith('/api/') && !originOkForHttp(req)) {
          return sendJson(res, 403, { error: 'Недопустимый Origin' });
        }
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

  function originMatches(req) {
    const origin = req.headers.origin;
    if (allowedOrigin) return origin === allowedOrigin;
    try {
      return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host);
    } catch {
      return false;
    }
  }

  // WebSocket upgrades come from a browser, which always sends Origin: require it, and require it to match.
  function originAllowed(req) {
    return Boolean(req.headers.origin) && originMatches(req);
  }

  // Plain HTTP requests (curl, server-to-server calls, tests) often carry no Origin header
  // at all; only reject when one is present and it doesn't match.
  function originOkForHttp(req) {
    return !req.headers.origin || originMatches(req);
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  // Every 30s, drop any WS that hasn't answered the previous ping: a phone that lost its
  // network without a clean close otherwise leaves its `tmux attach` pty and chat tail
  // running forever. Interval is injectable so tests don't have to wait 30s.
  let heartbeatTimer = null;
  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref();
  }

  async function handleUpgrade(req, socket, head) {
    // A client RST (or any other socket-level error) while we're still awaiting below must
    // not become an unhandled 'error' event and crash the process.
    socket.on('error', () => socket.destroy());
    try {
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
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        if (!exists) return ws.close(4004, 'Сессия не найдена');
        if (kind === 'term') {
          const cols = clampInt(url.searchParams.get('cols'), 20, 400, 80);
          const rows = clampInt(url.searchParams.get('rows'), 5, 200, 24);
          attachTerminal(ws, { sessions, name, cols, rows });
        } else {
          attachChat(ws, { name, status, viewers });
        }
      });
    } catch (err) {
      console.error(err);
      try { socket.destroy(); } catch {}
    }
  }

  const server = http.createServer(handle);
  server.on('upgrade', handleUpgrade);

  // Graceful shutdown: without forcing already-open WebSockets and keep-alive sockets
  // closed, server.close() waits for them to disconnect on their own, which can hang
  // indefinitely with a phone attached.
  function close(cb) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    for (const ws of wss.clients) ws.terminate();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(cb);
  }

  return { server, handle, wss, close };
}

module.exports = { createApp };
