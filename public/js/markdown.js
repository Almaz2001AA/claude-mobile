// Minimal Markdown parser for Claude's replies. Produces a plain-object tree that the chat view
// turns into DOM nodes with h(); nothing here is ever fed to innerHTML.
//
// Blocks: { t: 'p'|'heading'|'code'|'hr'|'quote'|'list'|'table', ... }
// Inlines: { t: 'text'|'code'|'strong'|'em'|'del'|'link'|'br', ... }

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^ {0,3}> ?/;
const ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const SAFE_URL_RE = /^(https?:|mailto:)/i;
const AUTOLINK_RE = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_~`]/;

const isBlank = (line) => !line.trim();
const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, '    ').length;

function isTableStart(lines, i) {
  return i + 1 < lines.length && lines[i].includes('|') && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-');
}

function startsBlock(lines, i) {
  const line = lines[i];
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line)
    || ITEM_RE.test(line) || isTableStart(lines, i);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '`') {
      inCode = !inCode;
      cur += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function parseTable(lines, i) {
  const head = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return left ? 'left' : null;
  });
  const rows = [];
  let j = i + 2;
  while (j < lines.length && !isBlank(lines[j]) && lines[j].includes('|')) {
    const cells = splitRow(lines[j]);
    rows.push(head.map((_, k) => parseInline(cells[k] || '')));
    j++;
  }
  return { block: { t: 'table', align, head: head.map((c) => parseInline(c)), rows }, next: j };
}

function parseList(lines, i) {
  const first = lines[i].match(ITEM_RE);
  const baseIndent = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let current = null;
  let contentIndent = 0;
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    const m = line.match(ITEM_RE);
    if (m && !HR_RE.test(line) && indentOf(m[1]) <= baseIndent + 1 && /\d/.test(m[2]) === ordered) {
      current = [m[3]];
      items.push(current);
      contentIndent = m[1].length + m[2].length + 1;
      j++;
      continue;
    }
    if (isBlank(line)) {
      // A blank line only continues the list when more of this list (or an item's body) follows.
      let k = j + 1;
      while (k < lines.length && isBlank(lines[k])) k++;
      if (k < lines.length && indentOf(lines[k]) > baseIndent) {
        current.push('');
        j++;
        continue;
      }
      const next = k < lines.length && lines[k].match(ITEM_RE);
      if (next && indentOf(next[1]) <= baseIndent + 1 && /\d/.test(next[2]) === ordered) {
        j = k;
        continue;
      }
      break;
    }
    if (indentOf(line) > baseIndent) {
      current.push(line.slice(Math.min(contentIndent, indentOf(line))));
      j++;
      continue;
    }
    // Lazy continuation of the item's paragraph.
    if (!startsBlock(lines, j)) {
      current.push(line.trim());
      j++;
      continue;
    }
    break;
  }
  return { block: { t: 'list', ordered, start, items: items.map((body) => parseBlocks(body)) }, next: j };
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1];
      const indent = indentOf(line);
      const body = [];
      i++;
      while (i < lines.length) {
        const close = lines[i].trim();
        if (close.startsWith(marker[0].repeat(marker.length)) && /^(`+|~+)$/.test(close)) {
          i++;
          break;
        }
        body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
        i++;
      }
      blocks.push({ t: 'code', lang: fence[2].toLowerCase(), text: body.join('\n') });
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({ t: 'heading', level: heading[1].length, c: parseInline(heading[2]) });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) body.push(lines[i++].replace(QUOTE_RE, ''));
      blocks.push({ t: 'quote', c: parseBlocks(body) });
      continue;
    }
    if (isTableStart(lines, i)) {
      const { block, next } = parseTable(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }
    if (ITEM_RE.test(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) para.push(lines[i++].trim());
    blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return blocks;
}

export function parseMarkdown(text) {
  return parseBlocks(String(text).replace(/\r\n?/g, '\n').split('\n'));
}

// Finds the closing delimiter for an emphasis run opened at `from`; the content must not start or
// end with whitespace, like CommonMark's flanking rules (simplified).
function findClose(s, delim, from) {
  if (/\s/.test(s[from] || ' ')) return -1;
  let k = from;
  while ((k = s.indexOf(delim, k)) !== -1) {
    if (k > from && !/\s/.test(s[k - 1]) && s[k - 1] !== '\\') {
      if (delim.length === 1 && s[k + 1] === delim) {
        k += 2;
        continue;
      }
      return k;
    }
    k += delim.length;
  }
  return -1;
}

export function parseInline(s) {
  const out = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  const push = (node) => {
    flush();
    out.push(node);
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && /[!-/:-@[-`{-~]/.test(s[i + 1])) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      const ticks = s.slice(i).match(/^`+/)[0];
      const end = s.indexOf(ticks, i + ticks.length);
      if (end !== -1) {
        let code = s.slice(i + ticks.length, end).replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        push({ t: 'code', v: code });
        i = end + ticks.length;
        continue;
      }
      text += ticks;
      i += ticks.length;
      continue;
    }
    if (ch === '[') {
      const m = s.slice(i).match(/^\[([^\]]*)\]\(\s*<?([^\s)>]*)>?(?:\s+"[^"]*")?\s*\)/);
      if (m && SAFE_URL_RE.test(m[2])) {
        push({ t: 'link', href: m[2], c: parseInline(m[1] || m[2]) });
        i += m[0].length;
        continue;
      }
    }
    if (ch === 'h' && (i === 0 || /[\s(]/.test(s[i - 1]))) {
      const m = s.slice(i).match(AUTOLINK_RE);
      if (m) {
        push({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] });
        i += m[0].length;
        continue;
      }
    }
    const pairs = [['**', 'strong'], ['__', 'strong'], ['~~', 'del'], ['*', 'em'], ['_', 'em']];
    let matched = false;
    for (const [delim, t] of pairs) {
      if (!s.startsWith(delim, i)) continue;
      // Underscores inside words (snake_case) are not emphasis.
      if (delim[0] === '_' && i > 0 && /\w/.test(s[i - 1])) continue;
      const end = findClose(s, delim, i + delim.length);
      if (end === -1) continue;
      if (delim[0] === '_' && /\w/.test(s[end + delim.length] || '')) continue;
      push({ t, c: parseInline(s.slice(i + delim.length, end)) });
      i = end + delim.length;
      matched = true;
      break;
    }
    if (matched) continue;
    text += ch;
    i++;
  }
  flush();
  return out;
}
