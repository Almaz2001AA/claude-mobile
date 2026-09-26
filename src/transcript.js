const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const MAX_CHARS = 4000;
const TAG_START_RE = /^\s*<[a-z][\w-]*[\s>]/i;

const truncate = (s, n = MAX_CHARS) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v) => (typeof v === 'string' ? v : '');

function toolSummary(name, input = {}) {
  const file = input.file_path ? path.basename(str(input.file_path)) : '';
  switch (name) {
    case 'Read': return `📄 Прочитал ${file}`;
    case 'Edit':
    case 'MultiEdit': return `✏️ Изменил ${file}`;
    case 'Write': return `📝 Записал ${file}`;
    case 'Bash': return `⚙️ ${truncate(str(input.command).split('\n')[0], 60)}`;
    case 'Grep': return `🔍 Поиск: ${truncate(str(input.pattern), 40)}`;
    case 'Glob': return `🔍 Файлы: ${truncate(str(input.pattern), 40)}`;
    case 'WebFetch': return `🌐 ${truncate(str(input.url), 50)}`;
    case 'WebSearch': return `🌐 ${truncate(str(input.query), 50)}`;
    case 'Agent':
    case 'Task': return `🤖 ${truncate(str(input.description) || 'Субагент', 50)}`;
    default: return `🔧 ${name}`;
  }
}

function trimInput(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' ? truncate(v) : v;
  return out;
}

function resultText(content) {
  if (typeof content === 'string') return truncate(content);
  if (Array.isArray(content)) return truncate(content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n'));
  return '';
}

function parseUser(entry, content, ts) {
  if (typeof content === 'string') {
    return TAG_START_RE.test(content) ? [] : [{ kind: 'user', id: entry.uuid, text: content, ts }];
  }
  if (!Array.isArray(content)) return [];
  const items = [];
  content.forEach((block, i) => {
    const id = `${entry.uuid}:${i}`;
    if (!block) return;
    if (block.type === 'text' && str(block.text) && !TAG_START_RE.test(block.text)) {
      items.push({ kind: 'user', id, text: block.text, ts });
    } else if (block.type === 'image') {
      items.push({ kind: 'user', id, text: '🖼 Изображение', ts });
    } else if (block.type === 'tool_result') {
      items.push({ kind: 'tool_result', id, toolUseId: block.tool_use_id, text: resultText(block.content), isError: Boolean(block.is_error), ts });
    }
  });
  return items;
}

function parseAssistant(entry, content, ts) {
  if (!Array.isArray(content)) return [];
  const items = [];
  content.forEach((block, i) => {
    if (!block) return;
    if (block.type === 'text' && str(block.text).trim()) {
      items.push({ kind: 'assistant', id: `${entry.uuid}:${i}`, text: block.text, ts });
    } else if (block.type === 'tool_use') {
      items.push({ kind: 'tool', id: block.id, name: block.name, summary: toolSummary(block.name, block.input), input: trimInput(block.input), ts });
    }
  });
  return items;
}

function parseEntry(entry) {
  if (!entry || typeof entry !== 'object' || entry.isSidechain || entry.isMeta) return [];
  const content = entry.message && entry.message.content;
  const ts = entry.timestamp || null;
  if (entry.type === 'user') return parseUser(entry, content, ts);
  if (entry.type === 'assistant') return parseAssistant(entry, content, ts);
  return [];
}

function parseLine(line) {
  try {
    return parseEntry(JSON.parse(line));
  } catch {
    return [];
  }
}

function parseChunk(buffer) {
  const items = [];
  for (const line of buffer.toString('utf8').split('\n')) {
    if (line.trim()) items.push(...parseLine(line));
  }
  return items;
}

// `offset` is the byte position after the last complete line, where a TranscriptTail should start.
async function readHistory(file, { before, limit = 200 } = {}) {
  const buf = await fsp.readFile(file);
  const offset = buf.lastIndexOf(10) + 1;
  const all = parseChunk(buf.subarray(0, offset));
  const end = before === undefined ? all.length : Math.max(0, Math.min(before, all.length));
  const start = Math.max(0, end - limit);
  return { items: all.slice(start, end), start, offset };
}

// Polls the file and emits 'items' for newly appended complete lines.
class TranscriptTail extends EventEmitter {
  constructor(file, { offset = 0, intervalMs = 400 } = {}) {
    super();
    this.file = file;
    this.offset = offset;
    this.intervalMs = intervalMs;
    this.partial = Buffer.alloc(0);
    this.timer = null;
    this.reading = false;
  }

  start() {
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    if (this.reading) return;
    this.reading = true;
    try {
      const { size } = await fsp.stat(this.file);
      if (size < this.offset) {
        this.offset = 0;
        this.partial = Buffer.alloc(0);
      }
      if (size === this.offset) return;
      const fh = await fsp.open(this.file, 'r');
      try {
        const buf = Buffer.alloc(size - this.offset);
        await fh.read(buf, 0, buf.length, this.offset);
        this.offset = size;
        const data = Buffer.concat([this.partial, buf]);
        const nl = data.lastIndexOf(10);
        if (nl === -1) {
          this.partial = data;
          return;
        }
        this.partial = data.subarray(nl + 1);
        const items = parseChunk(data.subarray(0, nl));
        if (items.length && this.timer) this.emit('items', items);
      } finally {
        await fh.close();
      }
    } catch {
      // Missing or unreadable file: try again on the next tick.
    } finally {
      this.reading = false;
    }
  }
}

module.exports = { parseEntry, parseLine, readHistory, TranscriptTail, toolSummary };
