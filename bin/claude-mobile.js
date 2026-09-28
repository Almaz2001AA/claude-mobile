#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { execFileSync } = require('node:child_process');
const { getPaths, getListenTarget, listenOn, getOrCreateSecret, rotateSecret } = require('../src/config');
const { hashPin, Auth } = require('../src/auth');
const { installHooks } = require('../src/install-hooks');
const { SessionManager } = require('../src/sessions');
const { InputSender } = require('../src/input');
const { StatusStore } = require('../src/status');
const { PushService } = require('../src/push');
const { Viewers } = require('../src/viewers');
const { Recent } = require('../src/recent');
const { QuickCommands } = require('../src/quick');
const { Favorites } = require('../src/favorites');
const { wireNotifications } = require('../src/notifier');
const { TelegramNotifier } = require('../src/telegram');
const { createApp } = require('../src/server');

const ROOT = path.resolve(__dirname, '..');

function resolveClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const found = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch {}
  return path.join(os.homedir(), '.local', 'bin', 'claude');
}

function vendorFiles() {
  const nm = path.join(ROOT, 'node_modules');
  return {
    'xterm.mjs': path.join(nm, '@xterm', 'xterm', 'lib', 'xterm.mjs'),
    'xterm.css': path.join(nm, '@xterm', 'xterm', 'css', 'xterm.css'),
    'addon-fit.mjs': path.join(nm, '@xterm', 'addon-fit', 'lib', 'addon-fit.mjs'),
  };
}

function serve() {
  const paths = getPaths();
  if (!fs.existsSync(paths.pin)) {
    console.error('PIN не задан. Выполните: claude-mobile set-pin');
    process.exit(1);
  }
  const sessions = new SessionManager({ claudeCmd: resolveClaude(), socket: process.env.CLAUDE_MOBILE_TMUX_SOCKET || null });
  const status = new StatusStore({ file: paths.links });
  const push = new PushService({ vapidFile: paths.vapid, subsFile: paths.subscriptions });
  const viewers = new Viewers();
  const telegram = new TelegramNotifier({ settingsFile: paths.telegram, viewers, origin: process.env.CLAUDE_MOBILE_ORIGIN || null });
  wireNotifications({ status, push, viewers, telegram });
  const app = createApp({
    sessions,
    input: new InputSender({ sessions }),
    status,
    auth: new Auth({
      pinHash: fs.readFileSync(paths.pin, 'utf8').trim(),
      secret: getOrCreateSecret(paths.cookieSecret),
      // Picks up a PIN change or secret rotation (`claude-mobile set-pin`) on the fly: no
      // restart needed, checked cheaply (a stat) on every login/verify.
      pinFile: paths.pin,
      secretFile: paths.cookieSecret,
    }),
    push,
    viewers,
    telegram,
    recent: new Recent(paths.recent),
    quick: new QuickCommands(paths.quick),
    favorites: new Favorites(paths.favorites),
    paths,
    hookSecret: getOrCreateSecret(paths.hookSecret),
    publicDir: path.join(ROOT, 'public'),
    vendorFiles: vendorFiles(),
    allowedOrigin: process.env.CLAUDE_MOBILE_ORIGIN || null,
  });
  const target = getListenTarget();
  listenOn(app.server, target, () => {
    console.log(target.type === 'unix' ? `claude-mobile слушает unix:${target.path}` : `claude-mobile слушает http://127.0.0.1:${target.port}`);
  });
  const stop = () => {
    // Open WebSockets (a phone with a terminal or chat attached) would otherwise make
    // app.close() wait indefinitely; a 3s fallback guarantees the process still exits.
    setTimeout(() => process.exit(0), 3000).unref();
    app.close(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

async function setPin() {
  const paths = getPaths();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pin = (await rl.question('Новый PIN (6–8 цифр): ')).trim();
  rl.close();
  let hash;
  try {
    hash = hashPin(pin);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  fs.mkdirSync(paths.base, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.pin, hash, { mode: 0o600 });
  // Rotate the cookie-signing secret so every previously issued login cookie stops verifying:
  // changing the PIN logs out all devices, not just ones that log in again with the new PIN.
  rotateSecret(paths.cookieSecret);
  console.log('PIN сохранён. Все устройства разлогинены.');
  console.log('Работающий сервис подхватит новый PIN сам, при следующем входе — перезапуск не нужен.');
}

function doInstallHooks() {
  const paths = getPaths();
  getOrCreateSecret(paths.hookSecret);
  const settingsFile = process.env.CLAUDE_SETTINGS_FILE || path.join(os.homedir(), '.claude', 'settings.json');
  const { backup } = installHooks({ settingsFile });
  console.log(`Хуки добавлены в ${settingsFile}${backup ? ` (резервная копия: ${backup})` : ''}`);
  console.log('Их подхватят только новые сессии Claude.');
}

const commands = { serve, 'set-pin': setPin, 'install-hooks': doInstallHooks };
const command = commands[process.argv[2] || 'serve'];
if (!command) {
  console.error('Использование: claude-mobile serve | set-pin | install-hooks');
  process.exit(1);
}
Promise.resolve(command()).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
