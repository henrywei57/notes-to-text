// Turns Tesseract's line boxes back into Markdown: bullets, nesting depth,
// headings, and lines that were only split because the slide wrapped them.

// Glyphs that are only ever bullets, so no space is needed after them.
const STRONG_MARKER = /^[•·◦▪▫■□●○◆◇►▸▹▶➢➤➔➜→⇒✓✔✗☐☑❖✦✧]\s*/;
// Markers that could also be ordinary text, so they need a space after them.
// "o", "e", "©" and friends are what OCR usually turns a round bullet into.
const WEAK_MARKER = /^(?:[-–—*+>»«¢©®°¤oe]|(\d{1,2})[.)]|([a-zA-Z]|[ivx]{1,4}|[IVX]{1,4})[.)])\s+(?![=<>+*/^])(?=\S)/;

const MAX_DEPTH = 5;

export function blocksToMarkdown(blocks, { joiner = ' ' } = {}) {
  const lines = collectLines(blocks ?? []);
  if (!lines.length) return '';

  const medH = median(lines.map((l) => l.h));
  const tol = Math.max(6, medH * 0.8);
  assignColumns(lines, tol);

  const cols = new Map();
  for (const l of lines) {
    let col = cols.get(l.col);
    if (!col) cols.set(l.col, (col = { right: -Infinity, bulletXs: [] }));
    col.right = Math.max(col.right, l.x1);
    if (l.marker) col.bulletXs.push(l.x0);
  }
  for (const col of cols.values()) col.levelOf = levelFinder(col.bulletXs, tol);

  const items = [];
  let cur = null;
  for (const l of lines) {
    const col = cols.get(l.col);
    if (cur && continues(cur, l, col, medH, tol)) {
      cur.text = joinText(cur.text, l.text, joiner);
      cur.last = l;
      cur.hSum += l.h;
      cur.n++;
      continue;
    }
    cur = l.marker
      ? { type: 'li', level: col.levelOf(l.x0), num: l.marker.num, text: l.marker.rest, x0: l.x0, textX: l.textX }
      : { type: 'p', text: l.text, x0: l.x0, textX: l.x0 };
    Object.assign(cur, { col: l.col, last: l, hSum: l.h, n: 1 });
    items.push(cur);
  }

  markHeadings(items, medH);
  return render(items);
}

export function toPlainText(md) {
  return md
    .split('\n')
    .map((line) => {
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) return heading[1];
      const bullet = line.match(/^(\s*)[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/);
      if (bullet) return `${bullet[1]}• ${bullet[2]}`;
      if (/^\s*-{3,}\s*$/.test(line)) return '';
      return line;
    })
    .join('\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    // Italic notes like *(margin: ...)* and *[Diagram: ...]*, but not c*g(n).
    .replace(/(^|\s)\*([([][^*\n]*[)\]])\*/g, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collectLines(blocks) {
  const lines = [];
  blocks.forEach((block, blockIndex) => {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const words = trimTrailingJunk(line.words ?? []);
        const text = cleanText(words.length ? words.map((w) => w.text).join(' ') : line.text);
        if (!text || isNoise(text, line.confidence)) continue;

        const { x0, y0, x1, y1 } = line.bbox;
        // Row height tracks font size better than the box, which grows with descenders.
        const h = line.rowAttributes?.row_height || y1 - y0;
        const marker = parseMarker(text);

        let textX = x0;
        if (marker) {
          const markerIsOwnWord = words.length > 1 && cleanText(words[0].text) === marker.raw;
          textX = markerIsOwnWord ? words[1].bbox.x0 : x0 + h * 1.2;
        }
        const first = words[0]?.bbox;
        const firstW = first ? first.x1 - first.x0 : h * 2;

        lines.push({ text, marker, x0, y0, x1, y1, h, textX, firstW, block: blockIndex });
      }
    }
  });
  return lines;
}

function parseMarker(text) {
  let m = text.match(STRONG_MARKER);
  if (m && m[0].length < text.length) {
    return { num: null, raw: m[0].trim(), rest: text.slice(m[0].length) };
  }
  m = text.match(WEAK_MARKER);
  if (!m) return null;
  const raw = m[0].trim();
  const rest = text.slice(m[0].length);
  // "a)" and "iv." stay in the text: Markdown only numbers lists with digits.
  return { num: m[1] ?? null, raw, rest: m[2] ? `${raw} ${rest}` : rest };
}

// Blocks that overlap horizontally belong to the same column, so a two-column
// slide doesn't turn its right-hand bullets into deeply nested ones.
function assignColumns(lines, tol) {
  const boxes = new Map();
  for (const l of lines) {
    const box = boxes.get(l.block);
    if (box) {
      box.x0 = Math.min(box.x0, l.x0);
      box.x1 = Math.max(box.x1, l.x1);
    } else {
      boxes.set(l.block, { x0: l.x0, x1: l.x1 });
    }
  }
  const ids = [...boxes.keys()];
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    while (parent.get(id) !== id) id = parent.get(id);
    return id;
  };
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = boxes.get(ids[i]);
      const b = boxes.get(ids[j]);
      if (a.x0 < b.x1 - tol && b.x0 < a.x1 - tol) parent.set(find(ids[i]), find(ids[j]));
    }
  }
  for (const l of lines) l.col = find(l.block);
}

// Groups bullet x-positions into indentation levels.
function levelFinder(xs, tol) {
  const anchors = [];
  for (const x of [...xs].sort((a, b) => a - b)) {
    const last = anchors[anchors.length - 1];
    if (last && x - last.max <= tol) last.max = x;
    else anchors.push({ min: x, max: x });
  }
  return (x) => {
    const i = anchors.findIndex((a) => x <= a.max + tol / 2);
    return Math.min(MAX_DEPTH, i < 0 ? anchors.length - 1 : i);
  };
}

function continues(cur, l, col, medH, tol) {
  if (l.marker || l.col !== cur.col) return false;
  const prev = cur.last;
  const gap = l.y0 - prev.y1;
  if (gap > medH * 0.9 || gap < -medH * 0.5) return false;
  if (Math.abs(l.h - prev.h) > Math.max(l.h, prev.h) * 0.35) return false;
  // A line only wraps when the next word wouldn't have fit on it.
  const wrapped = prev.x1 + l.firstW >= col.right - medH;
  if (!wrapped) return false;
  if (Math.abs(l.x0 - cur.textX) < tol) return true;
  return cur.type === 'li' && l.x0 > cur.x0 + tol * 0.5 && l.x0 < cur.textX + tol * 2;
}

function markHeadings(items, medH) {
  items.forEach((it, i) => {
    if (it.type !== 'p' || it.text.length > 120) return;
    const h = it.hSum / it.n;
    if (h >= medH * 1.9) {
      it.type = 'h';
      it.depth = 1;
    } else if (h >= medH * 1.3) {
      it.type = 'h';
      it.depth = 2;
    } else if (i === 0 && items[1]?.type === 'li' && it.text.length <= 70 && !/[.;,]$/.test(it.text)) {
      // A short first line sitting on top of a list is almost always the slide title.
      it.type = 'h';
      it.depth = 2;
    }
  });
}

function render(items) {
  const out = [];
  const offsets = [];
  let prevType = null;
  let listLevel = -1;
  for (const it of items) {
    if (it.type === 'li') {
      if (prevType && prevType !== 'li') out.push('');
      const level = Math.min(it.level, listLevel + 1);
      const marker = it.num ? `${it.num}.` : '-';
      const indent = level === 0 ? 0 : offsets[level - 1];
      out.push(`${' '.repeat(indent)}${marker} ${it.text}`);
      offsets.length = level;
      offsets[level] = indent + marker.length + 1;
      listLevel = level;
    } else {
      if (out.length) out.push('');
      out.push(it.text);
      if (it.type === 'h') listLevel = -1;
    }
    prevType = it.type;
  }
  return out.join('\n').trim();
}

function cleanText(s) {
  return (s ?? '')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/\s+/g, ' ')
    .replace(/^([|¦]\s*)+/, '')
    .replace(/(\s*[|¦])+$/, '')
    .trim();
}

// Shadows and page edges often leave a short, low-confidence "word" at the end of a line.
function trimTrailingJunk(words) {
  const kept = [...words];
  while (kept.length > 1) {
    const last = kept[kept.length - 1];
    if (last.confidence >= 45 || last.text.trim().length > 3) break;
    kept.pop();
  }
  return kept;
}

function isNoise(text, confidence) {
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  return confidence < 40 && !/[\p{L}\p{N}]{2}/u.test(text);
}

function joinText(a, b, joiner) {
  if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
  return a + joiner + b;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
