const CACHE = 'cm-shell-v3';
const SHELL = [
  '/', '/style.css', '/manifest.webmanifest', '/icon-192.png',
  '/js/app.js', '/js/api.js', '/js/ws.js', '/js/ui.js', '/js/push.js', '/js/chat-model.js',
  '/js/markdown.js', '/js/diff.js', '/js/rich.js', '/js/others.js',
  '/js/views/login.js', '/js/views/sessions.js', '/js/views/chat.js', '/js/views/terminal.js', '/js/views/settings.js',
  '/vendor/xterm.mjs', '/vendor/addon-fit.mjs', '/vendor/xterm.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first so updates appear immediately; the cache is only an offline fallback for the shell.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch {}
  event.waitUntil(self.registration.showNotification(data.title || 'Claude', {
    body: data.body || '',
    icon: '/icon-192.png',
    tag: data.title,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.length) {
      await windows[0].focus();
      windows[0].postMessage({ type: 'navigate', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
