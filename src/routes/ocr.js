'use strict';

const express = require('express');
const { getImage } = require('../lib/imageStore');
const { ocrCell } = require('../lib/cellOcr');

const router = express.Router();

// A margin here sounds forgiving but backfires badly in practice: it pulls
// in gridline pixels and slivers of neighboring cells' text, which confuses
// Tesseract far more than a slightly tight crop does. Trust the grid exactly
// as drawn - the interactive editor is where alignment gets fixed.
const PAD = 0;

router.post('/api/images/:id/ocr-cells', async (req, res) => {
  try {
    const entry = getImage(req.params.id);
    if (!entry) return res.status(404).json({ error: '圖片不存在或已過期' });

    const { cells } = req.body;
    if (!Array.isArray(cells) || cells.length === 0) {
      return res.status(400).json({ error: '缺少 cells 參數' });
    }
    if (cells.length > 2000) {
      return res.status(400).json({ error: '單次請求的儲存格數量過多' });
    }

    const results = await Promise.all(cells.map(async (cell) => {
      const pad = Number.isFinite(cell.pad) ? cell.pad : PAD;
      const left = Math.max(0, Math.round(cell.left) - pad);
      const top = Math.max(0, Math.round(cell.top) - pad);
      const right = Math.min(entry.width, Math.round(cell.left + cell.width) + pad);
      const bottom = Math.min(entry.height, Math.round(cell.top + cell.height) + pad);
      try {
        const { text, confidence } = await ocrCell(entry.filePath, {
          left, top, width: right - left, height: bottom - top,
        }, { psm: cell.psm });
        return {
          key: cell.key, text, confidence,
        };
      } catch (err) {
        return {
          key: cell.key, text: '', confidence: 0, error: err.message,
        };
      }
    }));

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: `辨識失敗: ${err.message}` });
  }
});

module.exports = router;
