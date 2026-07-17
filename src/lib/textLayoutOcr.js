'use strict';

const { recognizeLayout } = require('./ocrWorker');

// --- generic 1D helpers -------------------------------------------------

function otsuThreshold1D(values) {
  const sorted = [...values].sort((a, b) => a - b);
  let best = { t: sorted[0] || 0, score: -1 };
  for (let i = 1; i < sorted.length; i += 1) {
    const t = (sorted[i - 1] + sorted[i]) / 2;
    const below = sorted.slice(0, i);
    const above = sorted.slice(i);
    if (!below.length || !above.length) continue;
    const meanB = below.reduce((a, b) => a + b, 0) / below.length;
    const meanA = above.reduce((a, b) => a + b, 0) / above.length;
    const wB = below.length / sorted.length;
    const wA = above.length / sorted.length;
    const between = wB * wA * (meanA - meanB) ** 2;
    if (between > best.score) best = { t, score: between };
  }
  return best.t;
}

function center(w) {
  return (w.bbox.y0 + w.bbox.y1) / 2;
}

// A lone "|" (or similar bar/quote glyph) is almost always Tesseract
// misreading a faint vertical grid line as a character rather than real
// content - and because it sits right at the boundary between two cells'
// text, it bridges them into what looks like one word. Treated as a
// forced column break instead of literal text.
const LINE_ARTIFACT_RE = /^[|!,'"'`｜]+$/;
const LINE_ARTIFACT_TRIM_RE = /^[|!,'"'`｜]+|[|!,'"'`｜]+$/g;

// --- word extraction -----------------------------------------------------

function collectWords(data) {
  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const word of line.words || []) {
          if (!word.text.trim()) continue;
          words.push({ text: word.text, bbox: word.bbox, conf: word.confidence });
        }
      }
    }
  }
  return words;
}

// --- row reconstruction --------------------------------------------------

function bootstrapPitch(sorted) {
  const rows = [];
  let current = null;
  let lastCenter = null;
  for (const w of sorted) {
    const c = center(w);
    if (current && (c - lastCenter) <= 12) current.words.push(w);
    else { current = { words: [w] }; rows.push(current); }
    lastCenter = c;
  }
  const centers = rows.map((r) => r.words.reduce((s, w) => s + center(w), 0) / r.words.length);
  const gaps = [];
  for (let i = 1; i < centers.length; i += 1) {
    const g = centers[i] - centers[i - 1];
    if (g < 45) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 25;
}

/**
 * Groups words into rows by tracking an expected row rhythm (pitch)
 * established from the clearly-separated rows, rather than dividing any
 * one dense cluster by raw pixel width - this is what lets tightly packed
 * rows (small photo, small font) separate cleanly even where individual
 * character bounding boxes visually overlap between adjacent rows.
 */
function groupRows(words) {
  const sorted = [...words].sort((a, b) => center(a) - center(b));
  const pitch = bootstrapPitch(sorted);

  const rows = [];
  let current = null;
  for (const w of sorted) {
    const c = center(w);
    if (current === null) {
      current = { words: [w], center: c };
      rows.push(current);
      continue;
    }
    if (Math.abs(c - current.center) <= pitch * 0.5) {
      current.words.push(w);
      current.center = (current.center * (current.words.length - 1) + c) / current.words.length;
    } else {
      current = { words: [w], center: c };
      rows.push(current);
    }
  }
  return { rows, pitch };
}

function rowStats(row) {
  const y0 = Math.min(...row.words.map((w) => w.bbox.y0));
  const y1 = Math.max(...row.words.map((w) => w.bbox.y1));
  const xMin = Math.min(...row.words.map((w) => w.bbox.x0));
  const xMax = Math.max(...row.words.map((w) => w.bbox.x1));
  const avgConf = row.words.reduce((s, w) => s + w.conf, 0) / row.words.length;
  return {
    y0, y1, xMin, xMax, span: xMax - xMin, wordCount: row.words.length, avgConf,
  };
}

/**
 * Finds the table's own row range within the (possibly much larger) set
 * of detected text rows, so photo/screenshot chrome above or below the
 * table (a toolbar, a sheet-tab bar) is excluded automatically instead of
 * relying on fixed pixel bounds. A genuine data row spans a good chunk of
 * the table's width; a title row is much narrower (its text doesn't fill
 * the merged cell it sits in) so it is recovered separately by extending
 * the confirmed range by a strictly rhythm-matched single step.
 */
function findTableRowRange(stats, pitch) {
  const maxSpan = Math.max(...stats.map((s) => s.span));
  const isTableRow = (s) => s.span >= maxSpan * 0.25 && s.avgConf >= 40 && s.wordCount >= 2;

  let best = { start: -1, end: -1, len: 0 };
  let runStart = -1;
  for (let i = 0; i <= stats.length; i += 1) {
    const ok = i < stats.length && isTableRow(stats[i]);
    if (ok && runStart === -1) runStart = i;
    if (!ok && runStart !== -1) {
      const len = i - runStart;
      if (len > best.len) best = { start: runStart, end: i - 1, len };
      runStart = -1;
    }
  }
  if (best.start === -1) return null;

  let { start, end } = best;
  const MAX_EXTEND = 2;
  for (let step = 0; step < MAX_EXTEND && start > 0; step += 1) {
    const gap = (stats[start].y0 + stats[start].y1) / 2 - (stats[start - 1].y0 + stats[start - 1].y1) / 2;
    if (stats[start - 1].avgConf >= 50 && gap >= pitch * 0.7 && gap <= pitch * 1.3) start -= 1;
    else break;
  }
  for (let step = 0; step < MAX_EXTEND && end < stats.length - 1; step += 1) {
    const gap = (stats[end + 1].y0 + stats[end + 1].y1) / 2 - (stats[end].y0 + stats[end].y1) / 2;
    if (stats[end + 1].avgConf >= 50 && gap >= pitch * 0.7 && gap <= pitch * 1.3) end += 1;
    else break;
  }
  return { start, end };
}

// --- block (cell-candidate) grouping within a row -------------------------

function groupBlocksInRow(rowWords, gapThreshold) {
  const sorted = [...rowWords].sort((a, b) => a.bbox.x0 - b.bbox.x0);
  const blocks = [];
  let forceBreak = false;
  for (const w of sorted) {
    if (LINE_ARTIFACT_RE.test(w.text)) { forceBreak = true; continue; }
    const last = blocks[blocks.length - 1];
    if (!forceBreak && last && w.bbox.x0 - last.x1 <= gapThreshold) {
      last.text += w.text;
      last.x1 = Math.max(last.x1, w.bbox.x1);
    } else {
      blocks.push({ text: w.text, x0: w.bbox.x0, x1: w.bbox.x1 });
    }
    forceBreak = false;
  }
  blocks.forEach((b) => { b.text = b.text.replace(LINE_ARTIFACT_TRIM_RE, ''); });
  return blocks.filter((b) => b.text.length > 0);
}

// --- column detection ------------------------------------------------------

function clusterValues(values, gapThreshold) {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters = [];
  let current = null;
  for (const v of sorted) {
    if (current && v - current.last <= gapThreshold) { current.vals.push(v); current.last = v; } else {
      current = { vals: [v], last: v };
      clusters.push(current);
    }
  }
  return clusters.map((c) => Math.round(c.vals.reduce((a, b) => a + b, 0) / c.vals.length));
}

function detectColumns(rowsWithBlocks) {
  const counts = rowsWithBlocks.map((r) => r.blocks.length);
  const freq = new Map();
  for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
  let modalCount = 0;
  let bestFreq = 0;
  for (const [c, f] of freq) if (f > bestFreq) { bestFreq = f; modalCount = c; }

  const typicalRows = rowsWithBlocks.filter((r) => Math.abs(r.blocks.length - modalCount) <= 1);
  const allX0 = typicalRows.flatMap((r) => r.blocks.map((b) => b.x0));
  if (!allX0.length) return [0];
  return clusterValues(allX0, 45);
}

function assignColumns(blocks, colStarts, tableRight) {
  const numCols = colStarts.length;
  const bounds = [...colStarts, tableRight];
  const maxIdx = numCols - 1;

  // Process left-to-right and keep a running "next free column" so two
  // blocks can never claim the same column - the bucket boundaries alone
  // don't guarantee that (a row-number block and the name block right
  // after it can both land in column 0 if they're close together).
  const sortedBlocks = [...blocks].sort((a, b) => a.x0 - b.x0);
  let nextFree = 0;
  const assigned = [];
  for (const b of sortedBlocks) {
    let c0 = 0;
    for (let i = 0; i < numCols; i += 1) if (b.x0 >= bounds[i] - 20) c0 = i;
    // Clamp into the last free column rather than dropping the block if
    // the row has run out of distinct columns - keeps the text visible
    // (as a harmless overlap in the final cell) instead of silently
    // losing content.
    c0 = Math.min(maxIdx, Math.max(c0, nextFree));
    let c1 = c0;
    for (let i = c0; i < numCols; i += 1) if (b.x1 > bounds[i + 1] - 20) c1 = i + 1;
    c1 = Math.min(maxIdx, c1);
    assigned.push({
      text: b.text, r: 0, c: c0, colSpan: c1 - c0 + 1, rowSpan: 1,
    });
    nextFree = c1 + 1;
  }
  return assigned;
}

/**
 * Reconstructs a table's row/column structure and cell text directly from
 * a single whole-image OCR pass, by clustering word positions - rather
 * than detecting printed grid lines, which a photographed screen's glare,
 * tilt, or JPEG blur can make too faint/broken to find reliably. Text is
 * usually the highest-contrast content in the photo, so this is far more
 * robust for the common failure modes of real-world table photos.
 *
 * Returns null if no plausible table structure was found.
 */
async function reconstructTableFromText(imagePath) {
  const { data } = await recognizeLayout(imagePath);
  const allWords = collectWords(data);
  const words = allWords.filter((w) => w.conf >= 35);
  if (words.length < 6) return null;

  const { rows, pitch } = groupRows(words);
  const stats = rows.map(rowStats);
  const range = findTableRowRange(stats, pitch);
  if (!range) return null;

  const tableRows = [];
  for (let i = range.start; i <= range.end; i += 1) {
    tableRows.push({ words: rows[i].words, blocks: groupBlocksInRow(rows[i].words, 25) });
  }

  const colStarts = detectColumns(tableRows);
  const tableRight = Math.max(...tableRows.flatMap((r) => r.blocks.map((b) => b.x1)), 0) + 10;

  const cells = [];
  tableRows.forEach((row, r) => {
    const assigned = assignColumns(row.blocks, colStarts, tableRight);
    assigned.forEach((cell) => cells.push({ ...cell, r }));
  });

  return {
    numRows: tableRows.length,
    numCols: colStarts.length,
    cells,
  };
}

module.exports = { reconstructTableFromText, collectWords, groupRows };
