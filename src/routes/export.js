'use strict';

const express = require('express');
const { buildDocx } = require('../lib/docxBuilder');

const router = express.Router();

function validatePage(page, idx) {
  if (!page || typeof page.numRows !== 'number' || typeof page.numCols !== 'number') {
    throw new Error(`第 ${idx + 1} 份表格資料格式錯誤`);
  }
  if (page.numRows <= 0 || page.numCols <= 0 || page.numRows > 500 || page.numCols > 100) {
    throw new Error(`第 ${idx + 1} 份表格列數/欄數不合理`);
  }
  if (!Array.isArray(page.cells)) {
    throw new Error(`第 ${idx + 1} 份表格缺少 cells`);
  }
}

router.post('/api/export', async (req, res) => {
  try {
    const { pages, filename } = req.body;
    if (!Array.isArray(pages) || pages.length === 0) {
      return res.status(400).json({ error: '沒有可匯出的表格' });
    }
    pages.forEach(validatePage);

    const buffer = await buildDocx(pages);
    const safeName = (filename || 'ocr-result').replace(/[^\w一-鿿㐀-䶿-]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}.docx"`);
    res.send(buffer);
  } catch (err) {
    res.status(400).json({ error: `匯出失敗: ${err.message}` });
  }
});

module.exports = router;
