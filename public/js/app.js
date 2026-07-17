'use strict';

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

const pendingFiles = []; // { file, rotation }
const pages = []; // { id, url, width, height, originalName, stage, rows, cols, cells, img }
let currentPageIndex = -1;

// ---------------------------------------------------------------------
// Upload stage
// ---------------------------------------------------------------------

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const uploadList = document.getElementById('upload-list');
const startBtn = document.getElementById('start-btn');

['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => {
  handleFiles(fileInput.files);
  fileInput.value = '';
});

function handleFiles(fileList) {
  for (const file of fileList) {
    if (!file.type.startsWith('image/')) continue;
    pendingFiles.push({ file, rotation: 0, previewUrl: URL.createObjectURL(file) });
  }
  renderUploadList();
}

function renderUploadList() {
  uploadList.innerHTML = '';
  pendingFiles.forEach((pf, idx) => {
    const item = document.createElement('div');
    item.className = 'upload-item';
    item.innerHTML = `
      <img src="${pf.previewUrl}" style="transform: rotate(${pf.rotation}deg)" />
      <div class="meta">${escapeHtml(pf.file.name)}</div>
      <div class="rotate-row">
        <button data-act="rotate-l">⟲</button>
        <button data-act="rotate-r">⟳</button>
        <button data-act="remove" class="remove-btn">移除</button>
      </div>
    `;
    item.querySelector('[data-act="rotate-l"]').onclick = () => { pf.rotation = (pf.rotation - 90 + 360) % 360; renderUploadList(); };
    item.querySelector('[data-act="rotate-r"]').onclick = () => { pf.rotation = (pf.rotation + 90) % 360; renderUploadList(); };
    item.querySelector('[data-act="remove"]').onclick = () => { pendingFiles.splice(idx, 1); renderUploadList(); };
    uploadList.appendChild(item);
  });
  startBtn.disabled = pendingFiles.length === 0;
}

async function rotateFileIfNeeded(pf) {
  if (pf.rotation === 0) return pf.file;
  const img = await loadImageFromFile(pf.file);
  const canvas = document.createElement('canvas');
  const swap = pf.rotation % 180 !== 0;
  canvas.width = swap ? img.height : img.width;
  canvas.height = swap ? img.width : img.height;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((pf.rotation * Math.PI) / 180);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new File([blob], pf.file.name, { type: 'image/png' });
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startBtn.textContent = '上傳處理中...';
  try {
    const formData = new FormData();
    for (const pf of pendingFiles) {
      const finalFile = await rotateFileIfNeeded(pf);
      formData.append('images', finalFile);
    }
    const resp = await fetch('/api/images', { method: 'POST', body: formData });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '上傳失敗');

    startBtn.textContent = '偵測格線中...';
    for (const info of data.images) {
      const page = {
        id: info.id,
        url: info.url,
        width: info.width,
        height: info.height,
        originalName: info.originalName,
        stage: 'grid',
        rows: [0, info.height - 1],
        cols: [0, info.width - 1],
        cells: [],
        selection: null,
      };
      // Resolved before the grid editor is ever shown, so there is no
      // window in which the user could be mid-edit when this lands and
      // have their changes silently overwritten.
      try {
        const gridResp = await fetch(`/api/images/${page.id}/grid-suggest`);
        const gridData = await gridResp.json();
        if (gridResp.ok && gridData.rows.length >= 2 && gridData.cols.length >= 2) {
          page.rows = gridData.rows;
          page.cols = gridData.cols;
        }
      } catch (e) {
        // keep the 1x1 default grid; user can build it up manually
      }
      pages.push(page);
    }

    document.getElementById('upload-section').hidden = true;
    document.getElementById('workspace-section').hidden = false;
    document.getElementById('export-section').hidden = false;
    renderPageTabs();
    selectPage(0);
    updateExportSummary();
  } catch (err) {
    alert(`處理失敗: ${err.message}`);
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = '開始處理';
  }
});

// ---------------------------------------------------------------------
// Page tabs
// ---------------------------------------------------------------------

const pageTabsEl = document.getElementById('page-tabs');
const tabTemplate = document.getElementById('page-tab-template');

function renderPageTabs() {
  pageTabsEl.innerHTML = '';
  pages.forEach((page, idx) => {
    const node = tabTemplate.content.cloneNode(true);
    const btn = node.querySelector('.page-tab');
    btn.classList.toggle('active', idx === currentPageIndex);
    node.querySelector('.page-tab-thumb').src = page.url;
    node.querySelector('.page-tab-label').textContent = page.originalName;
    node.querySelector('.page-tab-status').textContent = stageLabel(page.stage);
    btn.onclick = () => selectPage(idx);
    pageTabsEl.appendChild(node);
  });
}

function stageLabel(stage) {
  return { grid: '設定格線', review: '校對中', done: '已完成' }[stage] || stage;
}

function selectPage(idx) {
  currentPageIndex = idx;
  renderPageTabs();
  renderWorkspace();
}

// ---------------------------------------------------------------------
// Workspace dispatcher
// ---------------------------------------------------------------------

const workspaceEl = document.getElementById('page-workspace');

function renderWorkspace() {
  const page = pages[currentPageIndex];
  if (!page) { workspaceEl.innerHTML = ''; return; }
  if (page.stage === 'grid') renderGridStage(page);
  else renderReviewStage(page);
}

// ---------------------------------------------------------------------
// Grid stage
// ---------------------------------------------------------------------

const MAX_CANVAS_W = 900;
const MAX_CANVAS_H = 640;

async function suggestGridForCurrentPage() {
  const page = pages[currentPageIndex];
  try {
    const resp = await fetch(`/api/images/${page.id}/grid-suggest`);
    const data = await resp.json();
    if (resp.ok && data.rows.length >= 2 && data.cols.length >= 2) {
      page.rows = data.rows;
      page.cols = data.cols;
    }
  } catch (e) {
    // fall back silently to the 1x1 default grid; user can add lines manually
  }
  if (page.stage === 'grid') renderGridStage(page);
}

function renderGridStage(page) {
  workspaceEl.innerHTML = `
    <div class="stage-toolbar">
      <button class="secondary-btn" id="btn-add-row">新增列線</button>
      <button class="secondary-btn" id="btn-add-col">新增欄線</button>
      <button class="secondary-btn" id="btn-resuggest">重新自動偵測</button>
      <button class="secondary-btn" id="btn-reset-grid">清空重畫</button>
      <button class="primary-btn" id="btn-grid-next">下一步：校對內容</button>
    </div>
    <div class="grid-editor-wrap">
      <div class="grid-canvas-box">
        <canvas id="grid-canvas"></canvas>
      </div>
      <div class="grid-help">
        <p>紅線＝列（橫線），藍線＝欄（直線）。</p>
        <p>拖曳線條可調整位置；雙擊線條可刪除。</p>
        <p>請確保格線的最外框只包含實際表格內容（不含照片中多餘的畫面）。</p>
        <p>圖片解析度：${page.width} × ${page.height}px</p>
      </div>
    </div>
  `;

  document.getElementById('btn-add-row').onclick = () => { addLine(page, 'rows'); drawGrid(page); };
  document.getElementById('btn-add-col').onclick = () => { addLine(page, 'cols'); drawGrid(page); };
  document.getElementById('btn-reset-grid').onclick = () => {
    page.rows = [0, page.height - 1];
    page.cols = [0, page.width - 1];
    drawGrid(page);
  };
  document.getElementById('btn-resuggest').onclick = () => suggestGridForCurrentPage();
  document.getElementById('btn-grid-next').onclick = () => {
    if (page.rows.length < 2 || page.cols.length < 2) {
      alert('至少需要各一條列線與欄線');
      return;
    }
    initCellsFromGrid(page);
    page.stage = 'review';
    renderPageTabs();
    renderReviewStage(page);
  };

  setupGridCanvas(page);
}

function addLine(page, key) {
  const arr = page[key];
  const a = arr[0];
  const b = arr[arr.length - 1];
  let bestGap = -1;
  let bestPos = Math.round((a + b) / 2);
  for (let i = 0; i < arr.length - 1; i += 1) {
    const gap = arr[i + 1] - arr[i];
    if (gap > bestGap) {
      bestGap = gap;
      bestPos = Math.round((arr[i] + arr[i + 1]) / 2);
    }
  }
  arr.push(bestPos);
  arr.sort((x, y) => x - y);
}

function setupGridCanvas(page) {
  const canvas = document.getElementById('grid-canvas');
  const scale = Math.min(1, MAX_CANVAS_W / page.width, MAX_CANVAS_H / page.height);
  canvas.width = Math.round(page.width * scale);
  canvas.height = Math.round(page.height * scale);
  canvas._scale = scale;

  if (!page.img) {
    page.img = new Image();
    page.img.crossOrigin = 'anonymous';
    page.img.src = page.url;
  }
  const draw = () => drawGrid(page);
  if (page.img.complete) draw(); else page.img.onload = draw;

  let dragging = null; // { key, index }
  const HIT_TOLERANCE = 6;

  canvas.addEventListener('mousedown', (e) => {
    const { x, y } = canvasPos(canvas, e);
    const hit = hitTestLine(page, canvas._scale, x, y, HIT_TOLERANCE);
    if (hit) dragging = hit;
  });
  canvas.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const { x, y } = canvasPos(canvas, e);
    const arr = page[dragging.key];
    const raw = dragging.key === 'rows' ? y / canvas._scale : x / canvas._scale;
    const lo = dragging.index === 0 ? 0 : arr[dragging.index - 1] + 3;
    const hi = dragging.index === arr.length - 1
      ? (dragging.key === 'rows' ? page.height - 1 : page.width - 1)
      : arr[dragging.index + 1] - 3;
    arr[dragging.index] = Math.max(lo, Math.min(hi, Math.round(raw)));
    drawGrid(page);
  });
  window.addEventListener('mouseup', () => { dragging = null; });
  canvas.addEventListener('dblclick', (e) => {
    const { x, y } = canvasPos(canvas, e);
    const hit = hitTestLine(page, canvas._scale, x, y, HIT_TOLERANCE);
    if (hit && page[hit.key].length > 2) {
      page[hit.key].splice(hit.index, 1);
      drawGrid(page);
    }
  });
}

function canvasPos(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) * canvas.width) / rect.width,
    y: ((e.clientY - rect.top) * canvas.height) / rect.height,
  };
}

function hitTestLine(page, scale, x, y, tolerance) {
  for (let i = 0; i < page.rows.length; i += 1) {
    if (Math.abs(page.rows[i] * scale - y) <= tolerance) return { key: 'rows', index: i };
  }
  for (let i = 0; i < page.cols.length; i += 1) {
    if (Math.abs(page.cols[i] * scale - x) <= tolerance) return { key: 'cols', index: i };
  }
  return null;
}

function drawGrid(page) {
  const canvas = document.getElementById('grid-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const scale = canvas._scale;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (page.img.complete) ctx.drawImage(page.img, 0, 0, canvas.width, canvas.height);

  ctx.lineWidth = 2;
  ctx.strokeStyle = '#e0453f';
  page.rows.forEach((y) => {
    ctx.beginPath();
    ctx.moveTo(0, y * scale);
    ctx.lineTo(canvas.width, y * scale);
    ctx.stroke();
  });
  ctx.strokeStyle = '#2f6fed';
  page.cols.forEach((x) => {
    ctx.beginPath();
    ctx.moveTo(x * scale, 0);
    ctx.lineTo(x * scale, canvas.height);
    ctx.stroke();
  });
}

function initCellsFromGrid(page) {
  const numRows = page.rows.length - 1;
  const numCols = page.cols.length - 1;
  page.numRows = numRows;
  page.numCols = numCols;
  page.cells = [];
  for (let r = 0; r < numRows; r += 1) {
    for (let c = 0; c < numCols; c += 1) {
      page.cells.push({
        r, c, rowSpan: 1, colSpan: 1, text: '',
      });
    }
  }
}

// ---------------------------------------------------------------------
// Review stage (proofreading table + merge editor + OCR)
// ---------------------------------------------------------------------

function cellAt(page, r, c) {
  return page.cells.find((cell) => cell.r === r && cell.c === c);
}

function buildCoverageMap(page) {
  const covered = Array.from({ length: page.numRows }, () => new Array(page.numCols).fill(null));
  for (const cell of page.cells) {
    for (let rr = cell.r; rr < cell.r + cell.rowSpan; rr += 1) {
      for (let cc = cell.c; cc < cell.c + cell.colSpan; cc += 1) {
        covered[rr][cc] = cell;
      }
    }
  }
  return covered;
}

function renderReviewStage(page) {
  workspaceEl.innerHTML = `
    <div class="stage-toolbar">
      <button class="secondary-btn" id="btn-back-grid">回上一步（重設格線）</button>
      <button class="secondary-btn" id="btn-merge">合併選取儲存格</button>
      <button class="secondary-btn" id="btn-unmerge">取消合併</button>
      <button class="primary-btn" id="btn-run-ocr">開始辨識 (OCR)</button>
      <button class="secondary-btn" id="btn-mark-done">標記此圖片完成 ✓</button>
      <span class="status-text" id="ocr-status"></span>
    </div>
    <div class="progress-bar"><div class="progress-bar-fill" id="ocr-progress"></div></div>
    <div class="review-wrap">
      <div class="review-image-box"><img src="${page.url}" alt="原始圖片" /></div>
      <div class="review-table-box" id="table-box"></div>
    </div>
  `;

  document.getElementById('btn-back-grid').onclick = () => {
    page.stage = 'grid';
    renderPageTabs();
    renderGridStage(page);
  };
  document.getElementById('btn-run-ocr').onclick = () => runOcrForPage(page);
  document.getElementById('btn-merge').onclick = () => mergeSelection(page);
  document.getElementById('btn-unmerge').onclick = () => unmergeSelection(page);
  document.getElementById('btn-mark-done').onclick = () => {
    page.stage = 'done';
    renderPageTabs();
    updateExportSummary();
  };

  renderTable(page);
}

let selectionAnchor = null; // {r,c}
let selectionEnd = null;
let isSelecting = false;

function renderTable(page) {
  const box = document.getElementById('table-box');
  const covered = buildCoverageMap(page);
  const seen = new Set();
  const table = document.createElement('table');
  table.className = 'ocr-table';
  for (let r = 0; r < page.numRows; r += 1) {
    const tr = document.createElement('tr');
    for (let c = 0; c < page.numCols; c += 1) {
      const cell = covered[r][c];
      if (!cell) continue;
      const key = `${cell.r},${cell.c}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const td = document.createElement('td');
      td.contentEditable = 'true';
      td.dataset.r = cell.r;
      td.dataset.c = cell.c;
      td.textContent = cell.text || '';
      if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
      if (cell.colSpan > 1) td.colSpan = cell.colSpan;
      if (cell.rowSpan > 1 || cell.colSpan > 1) td.classList.add('merged-anchor');
      if (typeof cell.confidence === 'number' && cell.confidence < 60 && cell.text) {
        td.classList.add('low-confidence');
        td.title = `辨識信心較低 (${Math.round(cell.confidence)}%)，請對照原圖確認`;
      }
      td.addEventListener('input', () => { cell.text = td.textContent; });
      td.addEventListener('mousedown', (e) => {
        isSelecting = true;
        selectionAnchor = { r: cell.r, c: cell.c };
        selectionEnd = { r: cell.r, c: cell.c };
        updateSelectionHighlight(page);
      });
      td.addEventListener('mouseenter', () => {
        if (isSelecting) {
          selectionEnd = { r: cell.r, c: cell.c };
          updateSelectionHighlight(page);
        }
      });
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  box.innerHTML = '';
  box.appendChild(table);

  window.onmouseup = () => { isSelecting = false; };
}

function updateSelectionHighlight(page) {
  const box = document.getElementById('table-box');
  if (!box || !selectionAnchor) return;
  const minR = Math.min(selectionAnchor.r, selectionEnd.r);
  const maxR = Math.max(selectionAnchor.r, selectionEnd.r);
  const minC = Math.min(selectionAnchor.c, selectionEnd.c);
  const maxC = Math.max(selectionAnchor.c, selectionEnd.c);
  box.querySelectorAll('td').forEach((td) => {
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    const inRange = r >= minR && r <= maxR && c >= minC && c <= maxC;
    td.classList.toggle('selected', inRange);
  });
}

function getSelectionBounds() {
  if (!selectionAnchor || !selectionEnd) return null;
  return {
    minR: Math.min(selectionAnchor.r, selectionEnd.r),
    maxR: Math.max(selectionAnchor.r, selectionEnd.r),
    minC: Math.min(selectionAnchor.c, selectionEnd.c),
    maxC: Math.max(selectionAnchor.c, selectionEnd.c),
  };
}

function mergeSelection(page) {
  const bounds = getSelectionBounds();
  if (!bounds) { alert('請先拖曳選取要合併的儲存格範圍'); return; }
  const { minR, maxR, minC, maxC } = bounds;
  if (minR === maxR && minC === maxC) { alert('請選取多個儲存格再合併'); return; }

  const covered = buildCoverageMap(page);
  const anchorsInRange = new Set();
  for (let r = minR; r <= maxR; r += 1) {
    for (let c = minC; c <= maxC; c += 1) {
      const cell = covered[r][c];
      if (cell.r < minR || cell.r > maxR || cell.c < minC || cell.c > maxC
        || cell.r + cell.rowSpan - 1 > maxR || cell.c + cell.colSpan - 1 > maxC) {
        alert('選取範圍必須是完整矩形，且不可切到既有合併儲存格的一部分');
        return;
      }
      anchorsInRange.add(cell);
    }
  }
  const texts = [...anchorsInRange].map((cell) => cell.text).filter(Boolean);
  page.cells = page.cells.filter((cell) => !anchorsInRange.has(cell));
  page.cells.push({
    r: minR, c: minC, rowSpan: maxR - minR + 1, colSpan: maxC - minC + 1, text: texts.join(' '),
  });
  selectionAnchor = null;
  selectionEnd = null;
  renderTable(page);
}

function unmergeSelection(page) {
  const bounds = getSelectionBounds();
  if (!bounds) { alert('請先點選要取消合併的儲存格'); return; }
  const { minR, maxR, minC, maxC } = bounds;
  const target = page.cells.find((cell) => cell.r === minR && cell.c === minC
    && cell.r + cell.rowSpan - 1 === maxR && cell.c + cell.colSpan - 1 === maxC
    && (cell.rowSpan > 1 || cell.colSpan > 1));
  if (!target) { alert('請選取一個已合併的儲存格'); return; }
  page.cells = page.cells.filter((cell) => cell !== target);
  for (let r = target.r; r < target.r + target.rowSpan; r += 1) {
    for (let c = target.c; c < target.c + target.colSpan; c += 1) {
      page.cells.push({
        r, c, rowSpan: 1, colSpan: 1, text: r === target.r && c === target.c ? target.text : '',
      });
    }
  }
  selectionAnchor = null;
  selectionEnd = null;
  renderTable(page);
}

async function runOcrForPage(page) {
  const statusEl = document.getElementById('ocr-status');
  const progressEl = document.getElementById('ocr-progress');
  const anchors = [...page.cells];
  let done = 0;
  statusEl.textContent = `辨識中... 0/${anchors.length}`;

  const rowsGrouped = new Map();
  anchors.forEach((cell) => {
    if (!rowsGrouped.has(cell.r)) rowsGrouped.set(cell.r, []);
    rowsGrouped.get(cell.r).push(cell);
  });
  const rowKeys = [...rowsGrouped.keys()].sort((a, b) => a - b);

  for (const rowKey of rowKeys) {
    const group = rowsGrouped.get(rowKey);
    const cellsPayload = group.map((cell, i) => ({
      key: `${cell.r}-${cell.c}`,
      left: page.cols[cell.c],
      top: page.rows[cell.r],
      width: page.cols[cell.c + cell.colSpan] - page.cols[cell.c],
      height: page.rows[cell.r + cell.rowSpan] - page.rows[cell.r],
      psm: cell.rowSpan > 1 || cell.colSpan > 2 ? '6' : '7',
    }));
    try {
      const resp = await fetch(`/api/images/${page.id}/ocr-cells`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cells: cellsPayload }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '辨識失敗');
      const byKey = new Map(data.results.map((r) => [r.key, r]));
      group.forEach((cell) => {
        const result = byKey.get(`${cell.r}-${cell.c}`);
        if (result) {
          cell.text = result.text;
          cell.confidence = result.confidence;
        }
      });
    } catch (err) {
      statusEl.textContent = `辨識發生錯誤: ${err.message}`;
    }
    done += group.length;
    progressEl.style.width = `${Math.round((done / anchors.length) * 100)}%`;
    statusEl.textContent = `辨識中... ${done}/${anchors.length}`;
    renderTable(page);
  }
  statusEl.textContent = `辨識完成 (${anchors.length} 個儲存格)，請對照左側圖片校對文字內容`;
}

// ---------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------

function updateExportSummary() {
  document.getElementById('total-count').textContent = pages.length;
  document.getElementById('done-count').textContent = pages.filter((p) => p.stage === 'done').length;
}

document.getElementById('export-btn').addEventListener('click', async () => {
  const exportable = pages.filter((p) => p.stage === 'review' || p.stage === 'done');
  if (exportable.length === 0) {
    alert('目前沒有已完成格線設定的圖片可匯出');
    return;
  }
  const skipped = pages.length - exportable.length;
  const statusEl = document.getElementById('export-status');
  statusEl.textContent = '產生 Word 文件中...';
  try {
    const payloadPages = exportable.map((page) => ({
      name: page.originalName,
      numRows: page.numRows,
      numCols: page.numCols,
      cells: page.cells,
    }));
    const filename = document.getElementById('export-filename').value || 'OCR轉換結果';
    const resp = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages: payloadPages, filename }),
    });
    if (!resp.ok) {
      const data = await resp.json();
      throw new Error(data.error || '匯出失敗');
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    statusEl.textContent = skipped > 0
      ? `已下載 (${skipped} 張圖片尚未設定格線，未包含在內)`
      : '已下載完成';
  } catch (err) {
    statusEl.textContent = '';
    alert(`匯出失敗: ${err.message}`);
  }
});

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}
