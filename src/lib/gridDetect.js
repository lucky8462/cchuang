'use strict';

const sharp = require('sharp');

// Clusters consecutive/near indices whose score exceeds `thresh` into single
// line positions (the centroid of each run). Returns positions sorted asc.
function clusterLines(scores, thresh, mergeGap) {
  const lines = [];
  let runStart = -1;
  for (let i = 0; i < scores.length; i += 1) {
    const hit = scores[i] >= thresh;
    if (hit && runStart === -1) {
      runStart = i;
    } else if (!hit && runStart !== -1) {
      lines.push(Math.round((runStart + i - 1) / 2));
      runStart = -1;
    }
  }
  if (runStart !== -1) lines.push(Math.round((runStart + scores.length - 1) / 2));

  // Merge lines that ended up very close together (e.g. double borders).
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
 * Detects candidate horizontal/vertical grid lines in an image by looking for
 * rows/columns of pixels that are mostly dark (table borders) across most of
 * the image. This is only meant to produce a *starting suggestion* - the
 * user reviews and adjusts the grid in the UI before OCR runs, so imperfect
 * detection here is not fatal.
 *
 * Returns { rows, cols, width, height } where rows/cols are pixel positions
 * already scaled to `width`/`height` == the ORIGINAL input image's own
 * dimensions, regardless of the (smaller) resolution actually analyzed - so
 * callers can use these coordinates directly against the source image.
 */
async function detectGridLines(imageBuffer) {
  const ANALYZE_MAX_DIM = 1200; // analyze at a capped resolution for speed
  const meta = await sharp(imageBuffer).metadata();
  const origWidth = meta.width;
  const origHeight = meta.height;
  const scale = Math.min(1, ANALYZE_MAX_DIM / Math.max(origWidth, origHeight));
  const width = Math.max(1, Math.round(origWidth * scale));
  const height = Math.max(1, Math.round(origHeight * scale));

  const { data } = await sharp(imageBuffer)
    .resize(width, height, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  for (let i = 0; i < data.length; i += 1) sum += data[i];
  const mean = sum / data.length;
  let variance = 0;
  for (let i = 0; i < data.length; i += 1) variance += (data[i] - mean) ** 2;
  const std = Math.sqrt(variance / data.length);
  const darkThreshold = Math.min(200, Math.max(60, mean - 0.5 * std));

  // A real ruling line stays dark across (almost) the whole width/height, even
  // though its actual darkness within any short stretch is faint after
  // photo blur + downscaling. Text rows/columns, by contrast, always have
  // some stretches of blank padding between characters/cells. So instead of
  // scoring by overall dark-pixel ratio, we split each row/column into
  // segments and score by what fraction of segments contain *any* dark
  // pixel at all - a continuous line lights up nearly every segment, dense
  // text usually does not.
  const SEGMENTS = 40;
  const segScore = (getPixel, length, perpLength) => {
    const segLen = Math.ceil(perpLength / SEGMENTS);
    const scores = new Float64Array(length);
    for (let i = 0; i < length; i += 1) {
      let covered = 0;
      for (let s = 0; s < SEGMENTS; s += 1) {
        const p0 = s * segLen;
        const p1 = Math.min(perpLength, p0 + segLen);
        if (p1 <= p0) continue;
        let hit = false;
        for (let p = p0; p < p1 && !hit; p += 1) {
          if (getPixel(i, p) < darkThreshold) hit = true;
        }
        if (hit) covered += 1;
      }
      scores[i] = covered / SEGMENTS;
    }
    return scores;
  };

  const rowScores = segScore((y, x) => data[y * width + x], height, width);
  const colScores = segScore((x, y) => data[y * width + x], width, height);

  const LINE_COVERAGE = 0.8;
  let rows = clusterLines(rowScores, LINE_COVERAGE, Math.max(3, Math.round(height * 0.012)));
  let cols = clusterLines(colScores, LINE_COVERAGE, Math.max(3, Math.round(width * 0.012)));

  // This is only a starting suggestion for the user to refine in the grid
  // editor, so collapse anything closer than a plausible minimum row/column
  // size to avoid overwhelming them with near-duplicate lines caused by
  // dense text also scoring as "covered".
  const dedupe = (arr, minGap) => {
    const out = [];
    for (const v of arr) {
      if (out.length && v - out[out.length - 1] < minGap) continue;
      out.push(v);
    }
    return out;
  };
  rows = dedupe(rows, Math.max(8, Math.round(height * 0.035)));
  cols = dedupe(cols, Math.max(8, Math.round(width * 0.035)));

  const ensureBoundary = (arr, max) => {
    const out = [...arr];
    if (!out.length || out[0] > max * 0.02) out.unshift(0);
    if (!out.length || out[out.length - 1] < max * 0.98) out.push(max - 1);
    return out;
  };

  const rescale = (arr, factor, max) => arr.map((v) => Math.min(max - 1, Math.round(v / factor)));

  return {
    rows: rescale(ensureBoundary(rows, height), scale, origHeight),
    cols: rescale(ensureBoundary(cols, width), scale, origWidth),
    width: origWidth,
    height: origHeight,
  };
}

module.exports = { detectGridLines };
