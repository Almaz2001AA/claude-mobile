import { api } from './api.js';

const PREFS_KEY = 'cm-push-prefs';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export async function getSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function getEndpoint() {
  try {
    return (await getSubscription())?.endpoint || null;
  } catch {
    return null;
  }
}

export function loadPrefs() {
  try {
    return { stop: true, permission: true, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { stop: true, permission: true };
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

function urlBase64ToUint8Array(base64) {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Must be called directly from a tap handler: iOS only shows the permission prompt for user gestures.
export async function enablePush(prefs) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Уведомления запрещены. Разрешите их в Настройках iPhone.');
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('GET', '/api/push/key');
  const sub = (await reg.pushManager.getSubscription())
    || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), prefs });
  savePrefs(prefs);
}

export async function updatePrefs(prefs) {
  savePrefs(prefs);
  const endpoint = await getEndpoint();
  if (endpoint) await api('POST', '/api/push/prefs', { endpoint, prefs });
}

export async function disablePush() {
  const sub = await getSubscription();
  if (!sub) return;
  await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
  await sub.unsubscribe();
}
