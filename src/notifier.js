function wireNotifications({ status, push, viewers }) {
  status.on('change', (name, entry, eventName) => {
    const url = `/#/s/${name}/chat`;
    if (eventName === 'Stop') {
      push.notify('stop', { title: `✅ ${name}`, body: 'Claude закончил работу', url }, { skip: viewers.watchingEndpoints(name) })
        .catch((err) => console.error('push error:', err.message));
    } else if (eventName === 'Notification' && entry.status === 'waiting_permission') {
      push.notify('permission', { title: `⚠️ ${name}`, body: entry.message || 'Нужно разрешение', url })
        .catch((err) => console.error('push error:', err.message));
    }
  });
}

module.exports = { wireNotifications };
