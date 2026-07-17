'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { ingestImage, getImage } = require('../lib/imageStore');
const { detectGridLines } = require('../lib/gridDetect');
const { reconstructTableFromText } = require('../lib/textLayoutOcr');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
});

const router = express.Router();

// Upload one or more images; each is normalized (EXIF auto-rotate, size cap)
// and persisted server-side as the stable "working image" every later step
// refers to. Returns one entry per uploaded file, in order.
router.post('/api/images', upload.array('images', 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '沒有收到任何圖片' });
    }
    const results = [];
    for (const file of req.files) {
      const { id, width, height } = await ingestImage(file.buffer, file.originalname);
      results.push({
        id, width, height, originalName: file.originalname, url: `/api/images/${id}/file`,
      });
    }
    res.json({ images: results });
  } catch (err) {
    res.status(500).json({ error: `圖片處理失敗: ${err.message}` });
  }
});

router.get('/api/images/:id/file', (req, res) => {
  const entry = getImage(req.params.id);
  if (!entry) return res.status(404).json({ error: '圖片不存在或已過期' });
  res.type('png');
  fs.createReadStream(entry.filePath).pipe(res);
});

router.get('/api/images/:id/grid-suggest', async (req, res) => {
  try {
    const entry = getImage(req.params.id);
    if (!entry) return res.status(404).json({ error: '圖片不存在或已過期' });
    const buffer = fs.readFileSync(entry.filePath);
    const grid = await detectGridLines(buffer);
    res.json(grid);
  } catch (err) {
    res.status(500).json({ error: `格線偵測失敗: ${err.message}` });
  }
});

// Fully-automatic reconstruction: one whole-image OCR pass, table
// structure and cell text derived directly from where the text actually
// is. Used as the default path; the grid-line editor (grid-suggest above,
// followed by per-cell OCR) remains available as a manual fallback for
// photos where this struggles.
router.get('/api/images/:id/auto-table', async (req, res) => {
  try {
    const entry = getImage(req.params.id);
    if (!entry) return res.status(404).json({ error: '圖片不存在或已過期' });
    const table = await reconstructTableFromText(entry.filePath);
    if (!table) return res.status(422).json({ error: '無法自動判斷表格結構' });
    res.json(table);
  } catch (err) {
    res.status(500).json({ error: `自動辨識失敗: ${err.message}` });
  }
});

module.exports = router;
