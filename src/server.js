'use strict';

const express = require('express');
const path = require('path');
const cors = require('cors');
const { warmUp } = require('./lib/ocrWorker');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(require('./routes/images'));
app.use(require('./routes/ocr'));
app.use(require('./routes/export'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`圖片 OCR 轉 Word 系統已啟動: http://localhost:${PORT}`);
  // Kick off Tesseract worker initialization in the background so the first
  // real OCR request doesn't have to pay the (slow) startup cost.
  warmUp().then(
    () => console.log('OCR 引擎已就緒'),
    (err) => console.error('OCR 引擎初始化失敗:', err),
  );
});
