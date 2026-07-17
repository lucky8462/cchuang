'use strict';

// Downloads Tesseract trained-language data needed for OCR (Traditional
// Chinese + English) into ./tessdata so the app can run fully offline at
// request time. Skips files that already exist so repeat installs are fast.

const fs = require('fs');
const path = require('path');
const https = require('https');

const TESSDATA_DIR = path.join(__dirname, '..', 'tessdata');
const BASE_URL = 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_best';
const LANGS = ['chi_tra', 'eng'];

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(destPath, () => {});
          download(res.headers.location, destPath).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          reject(new Error(`HTTP ${res.statusCode} while fetching ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
  });
}

(async () => {
  fs.mkdirSync(TESSDATA_DIR, { recursive: true });

  for (const lang of LANGS) {
    const dest = path.join(TESSDATA_DIR, `${lang}.traineddata.gz`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`[tessdata] ${lang}.traineddata.gz already present, skipping`);
      continue;
    }
    const url = `${BASE_URL}/${lang}.traineddata.gz`;
    console.log(`[tessdata] downloading ${url}`);
    try {
      await download(url, dest);
      console.log(`[tessdata] saved ${dest}`);
    } catch (err) {
      fs.unlink(dest, () => {});
      console.error(`[tessdata] FAILED to download ${lang}: ${err.message}`);
      console.error('[tessdata] OCR will not work until this file is present.');
      console.error(`[tessdata] You can manually download it from ${url} and place it at ${dest}`);
    }
  }
})();
