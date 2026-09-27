const fs = require('node:fs');
const path = require('node:path');
const { writeJson } = require('./config');

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

function hookCommand(nodeBin = process.execPath, script = path.resolve(__dirname, '..', 'hooks', 'notify.js')) {
  return `"${nodeBin}" "${script}"`;
}

function mergeHooks(settings, command) {
  const next = structuredClone(settings || {});
  next.hooks = next.hooks || {};
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const present = groups.some((g) => Array.isArray(g.hooks) && g.hooks.some((h) => h.command === command));
    if (!present) {
      const group = { hooks: [{ type: 'command', command, timeout: 5 }] };
      if (TOOL_EVENTS.has(event)) group.matcher = '*';
      groups.push(group);
    }
    next.hooks[event] = groups;
  }
  return next;
}

// Throws on unparseable settings instead of overwriting them.
function installHooks({ settingsFile, command = hookCommand() }) {
  let current = {};
  let backup = null;
  // If settingsFile is a symlink (Claude Code's settings.json is sometimes managed this way,
  // e.g. dotfiles synced across machines), write through to the real file instead of
  // replacing the link itself with a plain file.
  let target = settingsFile;
  try {
    target = fs.realpathSync(settingsFile);
  } catch {
    // Doesn't exist yet, or a broken link: fall back to the given path as-is.
  }
  if (fs.existsSync(target)) {
    current = JSON.parse(fs.readFileSync(target, 'utf8'));
    backup = `${target}.bak-${Date.now()}`;
    fs.copyFileSync(target, backup);
  }
  writeJson(target, mergeHooks(current, command));
  return { backup };
}

module.exports = { HOOK_EVENTS, hookCommand, mergeHooks, installHooks };
