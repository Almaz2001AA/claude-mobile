const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

// Claude Code stores each folder's conversations under ~/.claude/projects/<encoded>/*.jsonl,
// where <encoded> is the absolute cwd with every character that is not [A-Za-z0-9] replaced
// by '-' (e.g. /home/user/projects/app -> -home-user-projects-app). Verified against the real ~/.claude/projects.
function encodeCwd(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

// Whether Claude Code has a previous conversation on file for this folder. `claude --continue`
// exits immediately with "No conversation found to continue" when this is false, so callers
// that offer to "continue"/"resume" must check this first instead of assuming one exists.
function hasConversation(cwd, projectsRoot = DEFAULT_PROJECTS_ROOT) {
  if (typeof cwd !== 'string' || !cwd) return false;
  let entries;
  try {
    entries = fs.readdirSync(path.join(projectsRoot, encodeCwd(cwd)));
  } catch {
    return false;
  }
  return entries.some((name) => name.endsWith('.jsonl'));
}

module.exports = { hasConversation, encodeCwd, DEFAULT_PROJECTS_ROOT };
