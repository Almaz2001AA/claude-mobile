// Line diffs for Edit/MultiEdit cards and colouring of unified diffs (git diff output).
// Ops: { type: 'ctx'|'add'|'del', text } plus { type: 'skip', count } after folding.

const MAX_CELLS = 2_000_000;

const splitLines = (s) => (s === '' ? [] : String(s).replace(/\r\n?/g, '\n').split('\n'));

export function lineDiff(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const ops = a.slice(0, head).map((text) => ({ type: 'ctx', text }));
  if (midA.length * midB.length > MAX_CELLS) {
    ops.push(...midA.map((text) => ({ type: 'del', text })), ...midB.map((text) => ({ type: 'add', text })));
  } else {
    ops.push(...lcsOps(midA, midB));
  }
  ops.push(...a.slice(a.length - tail).map((text) => ({ type: 'ctx', text })));
  return ops;
}

function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  // lengths[i][j] = LCS length of a[i..] and b[j..], stored flat.
  const w = m + 1;
  const lengths = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * w + j] = a[i] === b[j]
        ? lengths[(i + 1) * w + j + 1] + 1
        : Math.max(lengths[(i + 1) * w + j], lengths[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (lengths[(i + 1) * w + j] >= lengths[i * w + j + 1]) {
      ops.push({ type: 'del', text: a[i++] });
    } else {
      ops.push({ type: 'add', text: b[j++] });
    }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] });
  while (j < m) ops.push({ type: 'add', text: b[j++] });
  return ops;
}

// Collapses runs of unchanged lines longer than 2*context+1 into a single 'skip' marker.
export function foldContext(ops, context = 3) {
  const out = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type !== 'ctx') {
      out.push(ops[i++]);
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j].type === 'ctx') j++;
    const keepHead = i === 0 ? 0 : context;
    const keepTail = j === ops.length ? 0 : context;
    if (j - i > keepHead + keepTail + 1) {
      out.push(...ops.slice(i, i + keepHead), { type: 'skip', count: j - i - keepHead - keepTail }, ...ops.slice(j - keepTail, j));
    } else {
      out.push(...ops.slice(i, j));
    }
    i = j;
  }
  return out;
}

export function diffStats(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added++;
    else if (op.type === 'del') removed++;
  }
  return { added, removed };
}

// Classifies each line of `git diff`-style output, or returns null when the text isn't one.
export function parseUnified(text) {
  const lines = splitLines(text);
  if (!lines.some((l) => /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(l))) return null;
  let inHunk = false;
  return lines.map((line) => {
    if (/^@@ /.test(line)) {
      inHunk = true;
      return { type: 'hunk', text: line };
    }
    if (/^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line)) {
      inHunk = false;
      return { type: 'meta', text: line };
    }
    if (inHunk && line.startsWith('+')) return { type: 'add', text: line.slice(1) };
    if (inHunk && line.startsWith('-')) return { type: 'del', text: line.slice(1) };
    if (inHunk && line.startsWith(' ')) return { type: 'ctx', text: line.slice(1) };
    return { type: 'meta', text: line };
  });
}
