const QUESTION_RE = /Do you want to/i;
const OPTION_RE = /^[\s│|❯>]*(\d)\.\s+(.+?)[\s│|]*$/;

// Reads Claude Code's permission prompt from a tmux screen dump.
function parsePermissionDialog(screen) {
  const lines = String(screen).split('\n');
  const start = lines.findIndex((line) => QUESTION_RE.test(line));
  if (start === -1) return null;
  const options = [];
  for (const line of lines.slice(start + 1)) {
    const m = line.match(OPTION_RE);
    if (m) options.push({ key: m[1], label: m[2].trim() });
  }
  if (options.length < 2 || options[0].key !== '1') return null;
  const question = lines[start].replace(/[│|❯]/g, '').trim();
  return { question, options };
}

module.exports = { parsePermissionDialog };
