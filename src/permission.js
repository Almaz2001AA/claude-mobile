const QUESTION_RE = /Do you want to/i;
const OPTION_RE = /^[\s│|❯>]*(\d)\.\s+(.+?)[\s│|]*$/;
const BORDER_RE = /^[\s│|╭╮╰╯─┌┐└┘┃━]*$/;

// Reads Claude Code's permission prompt from a tmux screen dump. Uses the LAST "Do you want
// to" line on screen: Claude's own answer text can quote or repeat an earlier question, and
// only the most recent one can still be an active dialog.
function parsePermissionDialog(screen) {
  const lines = String(screen).split('\n');
  const start = lines.findLastIndex((line) => QUESTION_RE.test(line));
  if (start === -1) return null;
  const options = [];
  for (const line of lines.slice(start + 1)) {
    const m = line.match(OPTION_RE);
    if (m) {
      options.push({ key: m[1], label: m[2].trim() });
      continue;
    }
    // Stop as soon as a non-option, non-blank/border line follows the options: that means
    // we've walked past the dialog box into unrelated screen content (e.g. text below it).
    if (options.length > 0 && line.trim() !== '' && !BORDER_RE.test(line)) break;
  }
  if (options.length < 2 || options[0].key !== '1') return null;
  const question = lines[start].replace(/[│|❯]/g, '').trim();
  return { question, options };
}

module.exports = { parsePermissionDialog };
