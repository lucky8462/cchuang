'use strict';

const {
  Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
  WidthType, AlignmentType, BorderStyle, HeadingLevel, PageBreak,
} = require('docx');

const FONT = 'Microsoft JhengHei';
const CELL_BORDER = {
  style: BorderStyle.SINGLE, size: 2, color: '999999',
};
const BORDERS = {
  top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER,
};

function buildCell(cell) {
  const lines = String(cell.text || '').split('\n');
  return new TableCell({
    columnSpan: cell.colSpan && cell.colSpan > 1 ? cell.colSpan : undefined,
    rowSpan: cell.rowSpan && cell.rowSpan > 1 ? cell.rowSpan : undefined,
    borders: BORDERS,
    shading: cell.shade ? { fill: cell.shade } : undefined,
    verticalAlign: 'center',
    children: lines.length
      ? lines.map((line) => new Paragraph({
        alignment: cell.align === 'left' ? AlignmentType.LEFT : AlignmentType.CENTER,
        children: [new TextRun({
          text: line,
          bold: !!cell.bold,
          font: FONT,
          size: (cell.fontSize || 21),
          color: cell.color || undefined,
        })],
      }))
      : [new Paragraph({ children: [] })],
  });
}

/**
 * Builds a docx Table for one page's grid. `cells` is a flat list of only
 * the "anchor" cells (top-left of any merge); the docx library takes care
 * of inserting the correct vertical-merge continuation cells for rowSpan
 * automatically once each row only contains its own anchors.
 */
function buildTable(page) {
  const { numRows, numCols, cells } = page;
  const covered = Array.from({ length: numRows }, () => new Array(numCols).fill(false));
  const byRow = Array.from({ length: numRows }, () => []);
  for (const cell of cells) {
    byRow[cell.r].push(cell);
  }
  for (const row of byRow) row.sort((a, b) => a.c - b.c);

  const rows = [];
  for (let r = 0; r < numRows; r += 1) {
    const rowCells = [];
    let c = 0;
    const anchorsByCol = new Map(byRow[r].map((cell) => [cell.c, cell]));
    while (c < numCols) {
      if (covered[r][c]) {
        c += 1;
        continue;
      }
      const cell = anchorsByCol.get(c) || { r, c, rowSpan: 1, colSpan: 1, text: '' };
      const rowSpan = Math.max(1, cell.rowSpan || 1);
      const colSpan = Math.max(1, cell.colSpan || 1);
      for (let rr = r; rr < Math.min(numRows, r + rowSpan); rr += 1) {
        for (let cc = c; cc < Math.min(numCols, c + colSpan); cc += 1) {
          covered[rr][cc] = true;
        }
      }
      rowCells.push(buildCell(cell));
      c += colSpan;
    }
    rows.push(new TableRow({ children: rowCells }));
  }

  const columnWidths = new Array(numCols).fill(Math.floor(9000 / numCols));
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths,
  });
}

async function buildDocx(pages) {
  const children = [];
  pages.forEach((page, idx) => {
    if (idx > 0) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
    if (page.name) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: [new TextRun({ text: page.name, font: FONT })],
      }));
    }
    children.push(buildTable(page));
    children.push(new Paragraph({ children: [] }));
  });

  const doc = new Document({
    sections: [{ children }],
    styles: {
      default: {
        document: { run: { font: FONT, size: 21 } },
      },
    },
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildDocx };
