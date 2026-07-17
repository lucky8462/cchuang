'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const STORE_DIR = path.join(__dirname, '..', '..', 'tmp', 'images');
fs.mkdirSync(STORE_DIR, { recursive: true });

const MAX_DIM = 2200; // cap so grid coords stay in a sane range and cropping stays fast
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

const store = new Map(); // id -> { filePath, width, height, createdAt, originalName }

function filePathFor(id) {
  return path.join(STORE_DIR, `${id}.png`);
}

/**
 * Normalizes an uploaded image (auto-rotate by EXIF, cap max dimension) and
 * persists it as the "working image" that every later step (grid detection,
 * cell OCR, preview) reads from - so all pixel coordinates the frontend
 * works with refer to one single, stable image.
 */
async function ingestImage(buffer, originalName) {
  const id = crypto.randomBytes(12).toString('hex');
  const filePath = filePathFor(id);

  const rotated = sharp(buffer).rotate(); // auto-orient using EXIF, then strips it
  const meta = await rotated.metadata();
  const scale = Math.min(1, MAX_DIM / Math.max(meta.width || MAX_DIM, meta.height || MAX_DIM));
  const width = Math.round((meta.width || MAX_DIM) * scale);
  const height = Math.round((meta.height || MAX_DIM) * scale);

  await rotated.resize(width, height, { fit: 'fill' }).png().toFile(filePath);

  const entry = {
    filePath, width, height, createdAt: Date.now(), originalName,
  };
  store.set(id, entry);
  return { id, width, height };
}

function getImage(id) {
  const entry = store.get(id);
  if (!entry || !fs.existsSync(entry.filePath)) return null;
  return entry;
}

function cleanup() {
  const now = Date.now();
  for (const [id, entry] of store.entries()) {
    if (now - entry.createdAt > MAX_AGE_MS) {
      fs.unlink(entry.filePath, () => {});
      store.delete(id);
    }
  }
}

setInterval(cleanup, 30 * 60 * 1000).unref();

module.exports = { ingestImage, getImage, filePathFor };
