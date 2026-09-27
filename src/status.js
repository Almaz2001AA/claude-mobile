const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { readJson, writeJson } = require('./config');
const { PREFIX } = require('./sessions');

function isPermissionNotification(event) {
  if (event.notification_type) return event.notification_type === 'permission_prompt';
  return /permission/i.test(event.message || '');
}

// Per-session status and tmux→transcript link, fed by Claude Code hook events.
// Emits 'change' (name, entry, hookEventName).
class StatusStore extends EventEmitter {
  constructor({ file, projectsRoot = path.join(os.homedir(), '.claude', 'projects') } = {}) {
    super();
    this.file = file;
    this.projectsRoot = projectsRoot;
    this.data = readJson(file, {});
  }

  // Hook events come from a script that runs as the same OS user, but treat the path it
  // sends as untrusted input: only accept an absolute .jsonl path inside the configured
  // projects root, so nothing else on disk can be pointed at as a "transcript" to read.
  isValidTranscriptPath(transcriptPath) {
    if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return false;
    if (!path.isAbsolute(transcriptPath)) return false;
    const resolvedRoot = path.resolve(this.projectsRoot);
    const root = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
    return path.resolve(transcriptPath).startsWith(root);
  }

  get(name) {
    return this.data[name] || { status: 'idle' };
  }

  applyHook(tmuxSession, event) {
    if (typeof tmuxSession !== 'string' || !tmuxSession.startsWith(PREFIX)) return null;
    const name = tmuxSession.slice(PREFIX.length);
    const next = { status: 'idle', ...this.data[name], updatedAt: Date.now() };
    switch (event.hook_event_name) {
      case 'SessionStart':
        next.sessionId = event.session_id;
        next.status = 'idle';
        next.message = null;
        break;
      case 'UserPromptSubmit':
      case 'PreToolUse':
      case 'PostToolUse':
        next.status = 'working';
        next.message = null;
        break;
      case 'Notification':
        if (!isPermissionNotification(event)) return null;
        next.status = 'waiting_permission';
        next.message = event.message || '';
        break;
      case 'Stop':
        next.status = 'idle';
        next.message = null;
        break;
      default:
        return null;
    }
    // An invalid path is silently ignored (the status update itself still applies) rather
    // than rejecting the whole hook event: a broken/foreign transcript_path shouldn't stop
    // the session's working/idle/waiting_permission state from updating.
    if (event.transcript_path && this.isValidTranscriptPath(event.transcript_path)) {
      next.transcriptPath = event.transcript_path;
    }
    this.data[name] = next;
    writeJson(this.file, this.data);
    this.emit('change', name, next, event.hook_event_name);
    return next;
  }

  remove(name) {
    if (!(name in this.data)) return;
    delete this.data[name];
    writeJson(this.file, this.data);
  }
}

module.exports = { StatusStore };
