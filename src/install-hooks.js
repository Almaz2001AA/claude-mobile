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
  if (fs.existsSync(settingsFile)) {
    current = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    backup = `${settingsFile}.bak-${Date.now()}`;
    fs.copyFileSync(settingsFile, backup);
  }
  writeJson(settingsFile, mergeHooks(current, command));
  return { backup };
}

module.exports = { HOOK_EVENTS, hookCommand, mergeHooks, installHooks };
