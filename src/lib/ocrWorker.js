'use strict';

const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');

const TESSDATA_DIR = path.join(__dirname, '..', '..', 'tessdata');
const CACHE_DIR = path.join(__dirname, '..', '..', 'tmp', 'tess-cache');
const POOL_SIZE = 3;

class WorkerPool {
  constructor(size) {
    this.size = size;
    this.idle = [];
    this.waiters = [];
    this.initPromise = null;
  }

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      for (let i = 0; i < this.size; i += 1) {
        const worker = await createWorker(['chi_tra', 'eng'], 1, {
          langPath: TESSDATA_DIR,
          cachePath: CACHE_DIR,
        });
        this.idle.push(worker);
      }
    })();
    return this.initPromise;
  }

  async acquire() {
    await this.init();
    if (this.idle.length > 0) return this.idle.pop();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(worker) {
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift();
      resolve(worker);
    } else {
      this.idle.push(worker);
    }
  }

  async withWorker(fn) {
    const worker = await this.acquire();
    try {
      return await fn(worker);
    } finally {
      this.release(worker);
    }
  }
}

const pool = new WorkerPool(POOL_SIZE);

// psm 7 = treat image as a single text line; psm 6 = a single uniform block
// of text (used for cells that may wrap onto more than one line).
async function recognizeText(imageBuffer, { psm = '7' } = {}) {
  return pool.withWorker(async (worker) => {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(imageBuffer);
    return {
      text: data.text.replace(/\s+/g, (m) => (m.includes('\n') ? '\n' : ' ')).trim(),
      confidence: data.confidence,
    };
  });
}

async function warmUp() {
  await pool.init();
}

module.exports = { recognizeText, warmUp };
