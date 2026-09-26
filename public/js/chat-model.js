// Chat state for one session: ordered items, deduped by id, tool results folded into their tool calls.
export class ChatModel {
  constructor() {
    this.reset({ items: [], start: 0, available: true });
  }

  reset({ items, start = 0, available = true }) {
    this.list = [];
    this.index = new Map();
    this.orphans = new Map();
    this.start = start;
    this.available = available;
    this.append(items);
  }

  get hasMore() {
    return this.start > 0;
  }

  append(items) {
    for (const item of items) {
      const entry = this.add(item);
      if (entry) this.list.push(entry);
    }
  }

  prepend({ items, start }) {
    const front = [];
    for (const item of items) {
      const entry = this.add(item);
      if (entry) front.push(entry);
    }
    this.list = front.concat(this.list);
    this.start = start;
  }

  lastTool() {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].kind === 'tool') return this.list[i];
    }
    return null;
  }

  // Returns the new list entry, or null when the item was merged or already known.
  add(item) {
    if (item.kind === 'tool_result') {
      const res = { text: item.text, isError: item.isError };
      const target = this.index.get(item.toolUseId);
      if (target) target.result = res;
      else this.orphans.set(item.toolUseId, res);
      return null;
    }
    if (this.index.has(item.id)) return null;
    const entry = { ...item };
    if (entry.kind === 'tool' && this.orphans.has(entry.id)) {
      entry.result = this.orphans.get(entry.id);
      this.orphans.delete(entry.id);
    }
    this.index.set(entry.id, entry);
    return entry;
  }
}
