'use strict';

const sharp = require('sharp');

// Otsu's method: picks the threshold that maximizes between-class variance
// of a 256-bin grayscale histogram. Much more reliable than a fixed
// mean/stddev heuristic across photos with varying lighting/exposure.
function otsuThreshold(data) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 1) hist[data[i]] += 1;
  const total = data.length;

  let sumAll = 0;
  for (let t = 0; t < 256; t += 1) sumAll += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

// Sliding-window minimum over a binary (0/1) array using a monotonic deque,
// so eroding a full row/column costs O(length) instead of O(length*radius).
function slidingMin(arr, radius) {
  const n = arr.length;
  const out = new Uint8Array(n);
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n + radius; i += 1) {
    if (i < n) {
      while (tail > head && arr[deque[tail - 1]] >= arr[i]) tail -= 1;
      deque[tail] = i;
      tail += 1;
    }
    const outIdx = i - radius;
    if (outIdx >= 0 && outIdx < n) {
      while (deque[head] < outIdx - radius) head += 1;
      out[outIdx] = arr[deque[head]];
    }
  }
  return out;
}

function clusterLines(hits, mergeGap) {
  const lines = [];
  let runStart = -1;
  for (let i = 0; i < hits.length; i += 1) {
    if (hits[i] && runStart === -1) {
      runStart = i;
    } else if (!hits[i] && runStart !== -1) {
      lines.push(Math.round((runStart + i - 1) / 2));
      runStart = -1;
    }
  }
  if (runStart !== -1) lines.push(Math.round((runStart + hits.length - 1) / 2));

  const merged = [];
  for (const l of lines) {
    if (merged.length && l - merged[merged.length - 1] <= mergeGap) {
      merged[merged.length - 1] = Math.round((merged[merged.length - 1] + l) / 2);
    } else {
      merged.push(l);
    }
  }
  return merged;
}

/**
 * Detects the table's grid lines and its own bounding box (so photo chrome
 * around the table - a phone's screenshot toolbar, a spreadsheet's row/
 * column headers - is excluded automatically) using morphological erosion:
 * a genuine ruling line stays dark across a long, unbroken run, while text
 * strokes are short blobs that vanish once eroded with a wide-enough
 * structuring element. This is far more selective than a raw dark-pixel
 * ratio, which dense text can trip just as easily as a real line.
 *
 * Returns { rows, cols, width, height, cropLeft, cropTop } - rows/cols are
 * pixel positions already in the coordinate space of the ORIGINAL input
 * image (`width`/`height` are the original dimensions), and are the
 * boundaries of the detected table itself, not necessarily 0/width-1.
 */
async function detectGridLines(imageBuffer) {
  const ANALYZE_MAX_DIM = 1400;
  const meta = await sharp(imageBuffer).metadata();
  const origWidth = meta.width;
  const origHeight = meta.height;
  const scale = Math.min(1, ANALYZE_MAX_DIM / Math.max(origWidth, origHeight));
  const width = Math.max(1, Math.round(origWidth * scale));
  const height = Math.max(1, Math.round(origHeight * scale));

  const { data } = await sharp(imageBuffer)
    .resize(width, height, { fit: 'fill' })
    .grayscale()
    .normalize()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const threshold = otsuThreshold(data);
  const dark = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i += 1) dark[i] = data[i] < threshold ? 1 : 0;

  // A structuring element noticeably longer than a character but much
  // shorter than a real ruling line (which spans a whole column/row).
  const hRadius = Math.max(6, Math.round(width * 0.012));
  const vRadius = Math.max(5, Math.round(height * 0.012));

  const rowScore = new Float64Array(height);
  const rowBuf = new Uint8Array(width);
  for (let y = 0; y < height; y += 1) {
    rowBuf.set(dark.subarray(y * width, y * width + width));
    const eroded = slidingMin(rowBuf, hRadius);
    let sum = 0;
    for (let x = 0; x < width; x += 1) sum += eroded[x];
    rowScore[y] = sum / width;
  }

  const colScore = new Float64Array(width);
  const colBuf = new Uint8Array(height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) colBuf[y] = dark[y * width + x];
    const eroded = slidingMin(colBuf, vRadius);
    let sum = 0;
    for (let y = 0; y < height; y += 1) sum += eroded[y];
    colScore[x] = sum / height;
  }

  const LINE_COVERAGE = 0.13; // fraction of the row/col that must survive erosion
  const rowHits = Array.from(rowScore, (v) => v >= LINE_COVERAGE);
  const colHits = Array.from(colScore, (v) => v >= LINE_COVERAGE);

  let rows = clusterLines(rowHits, Math.max(3, Math.round(height * 0.008)));
  let cols = clusterLines(colHits, Math.max(3, Math.round(width * 0.008)));

  // Keep only lines that actually participate in a grid: a real table row
  // line should be roughly as wide as the table (i.e. span between the
  // outermost surviving column lines), which filters out stray long dark
  // streaks that don't belong to the table (e.g. a toolbar's separator).
  const rescale = (arr, factor) => arr.map((v) => Math.round(v / factor));
  rows = rescale(rows, scale);
  cols = rescale(cols, scale);

  if (rows.length < 2 || cols.length < 2) {
    return {
      rows: [0, origHeight - 1], cols: [0, origWidth - 1], width: origWidth, height: origHeight,
    };
  }

  return {
    rows, cols, width: origWidth, height: origHeight,
  };
}

module.exports = { detectGridLines };
