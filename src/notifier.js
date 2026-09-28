function wireNotifications({ status, push, viewers, telegram = null }) {
  status.on('change', (name, entry, eventName) => {
    const url = `/#/s/${name}/chat`;
    let notice = null;
    if (eventName === 'Stop') {
      notice = { title: `✅ ${name}`, body: 'Claude закончил работу' };
      push.notify('stop', { ...notice, url }, { skip: viewers.watchingEndpoints(name) })
        .catch((err) => console.error('push error:', err.message));
    } else if (eventName === 'Notification' && entry.status === 'waiting_permission') {
      notice = { title: `⚠️ ${name}`, body: entry.message || 'Нужно разрешение' };
      push.notify('permission', { ...notice, url })
        .catch((err) => console.error('push error:', err.message));
    }
    // Every event restarts (or clears) the delayed Telegram copy for this session.
    telegram?.onEvent(name, notice);
  });
}

module.exports = { wireNotifications };
