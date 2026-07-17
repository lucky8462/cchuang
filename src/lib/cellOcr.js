'use strict';

const sharp = require('sharp');
const { recognizeText } = require('./ocrWorker');

const MIN_CELL_TEXT_HEIGHT = 56; // px - upscale small cells so glyphs are big enough for tesseract

/**
 * Crops a single cell out of the source image and runs OCR on it in
 * isolation. Isolating each cell (instead of OCR-ing the whole photo at
 * once) is what makes recognition of a dense, photographed table usable -
 * Tesseract does far better on one short, high-contrast, upscaled snippet
 * of text than on a full skewed page.
 */
async function ocrCell(imagePath, rect, { psm } = {}) {
  const { left, top, width, height } = rect;
  if (width < 2 || height < 2) return { text: '', confidence: 0 };

  const roundedRect = {
    left: Math.max(0, Math.round(left)),
    top: Math.max(0, Math.round(top)),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };

  const upscale = Math.max(1, Math.min(4, MIN_CELL_TEXT_HEIGHT / roundedRect.height));
  const outWidth = Math.max(1, Math.round(roundedRect.width * upscale));
  const outHeight = Math.max(1, Math.round(roundedRect.height * upscale));

  // Very wide cells (a header/title merged across many columns, mostly
  // blank around a short centered label) are prone to a subtle photo-glare
  // gradient that normalize()+sharpen() amplify into fake glyph-like
  // speckles across the whole blank margin, badly confusing Tesseract. For
  // those, skip sharpening and let Tesseract's own binarization handle it.
  const isVeryWide = roundedRect.width > roundedRect.height * 6;

  let pipeline = sharp(imagePath)
    .extract(roundedRect)
    .resize(outWidth, outHeight, { kernel: 'lanczos3' })
    .grayscale()
    .normalize();
  if (!isVeryWide) pipeline = pipeline.sharpen();

  const processed = await pipeline
    .extend({
      top: 12, bottom: 12, left: 12, right: 12, background: '#ffffff',
    })
    .png()
    .toBuffer();

  const guessedPsm = psm
    || (roundedRect.height > roundedRect.width * 0.6 || roundedRect.height > MIN_CELL_TEXT_HEIGHT * 1.8 ? '6' : '7');
  const { text, confidence } = await recognizeText(processed, { psm: guessedPsm });
  return { text, confidence };
}

module.exports = { ocrCell };
