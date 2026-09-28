// DOM rendering for parsed Markdown and diffs. Everything goes through h(), so text is never HTML.
import { h, toast } from './ui.js';
import { parseMarkdown } from './markdown.js';
import { foldContext, diffStats, parseUnified } from './diff.js';

function inlineNodes(nodes) {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text': return n.v;
      case 'br': return h('br');
      case 'code': return h('code', {}, n.v);
      case 'strong': return h('strong', {}, inlineNodes(n.c));
      case 'em': return h('em', {}, inlineNodes(n.c));
      case 'del': return h('del', {}, inlineNodes(n.c));
      case 'link': return h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer' }, inlineNodes(n.c));
      default: return null;
    }
  });
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано');
  } catch {
    toast('Не удалось скопировать');
  }
}

function codeBlock(block) {
  const unified = block.lang === 'diff' || block.lang === 'patch' ? parseUnified(block.text) : null;
  return h('div', { class: 'md-code' },
    h('div', { class: 'md-code-head' },
      h('span', {}, block.lang || 'код'),
      h('button', { onclick: () => copy(block.text) }, 'Копировать')),
    unified ? diffLines(unified) : h('pre', {}, block.text));
}

function blockNodes(blocks, tight = false) {
  return blocks.map((b) => {
    switch (b.t) {
      case 'p': return tight ? h('span', {}, inlineNodes(b.c)) : h('p', {}, inlineNodes(b.c));
      case 'heading': return h(`h${Math.min(b.level + 2, 6)}`, {}, inlineNodes(b.c));
      case 'hr': return h('hr');
      case 'code': return codeBlock(b);
      case 'quote': return h('blockquote', {}, blockNodes(b.c));
      case 'list': return h(b.ordered ? 'ol' : 'ul', { start: b.ordered && b.start !== 1 ? String(b.start) : null },
        b.items.map((item) => h('li', {}, blockNodes(item, item.length === 1 || item[1]?.t === 'list'))));
      case 'table': return h('div', { class: 'md-table' }, h('table', {},
        h('thead', {}, h('tr', {}, b.head.map((c, i) => h('th', { style: b.align[i] ? `text-align:${b.align[i]}` : null }, inlineNodes(c))))),
        h('tbody', {}, b.rows.map((row) => h('tr', {}, row.map((c, i) => h('td', { style: b.align[i] ? `text-align:${b.align[i]}` : null }, inlineNodes(c))))))));
      default: return null;
    }
  });
}

export function renderMarkdown(text) {
  return blockNodes(parseMarkdown(text));
}

const MARK = { add: '+', del: '-', ctx: ' ' };

export function diffLines(ops) {
  return h('div', { class: 'diff' }, ops.map((op) => {
    if (op.type === 'skip') return h('div', { class: 'dl skip' }, `⋯ ${op.count} без изменений`);
    if (op.type === 'hunk' || op.type === 'meta') return h('div', { class: `dl ${op.type}` }, op.text);
    return h('div', { class: `dl ${op.type}` }, h('span', { class: 'dm' }, MARK[op.type]), op.text || ' ');
  }));
}

export function diffView(ops, file) {
  const { added, removed } = diffStats(ops);
  return h('div', { class: 'diff-card' },
    h('div', { class: 'diff-head' },
      h('span', { class: 'diff-file' }, h('bdi', { dir: 'ltr' }, file || '')),
      h('span', { class: 'diff-stat' }, h('span', { class: 'add' }, `+${added}`), ' ', h('span', { class: 'del' }, `−${removed}`))),
    diffLines(foldContext(ops)));
}

// Plain tool output, coloured when it looks like `git diff`.
export function outputView(text) {
  const unified = parseUnified(text);
  return unified ? diffLines(unified) : h('pre', {}, text);
}
