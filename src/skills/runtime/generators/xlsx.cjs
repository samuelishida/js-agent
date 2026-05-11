'use strict';
const XLSX = require('xlsx');
const fs = require('fs');

function autoColWidths(rows) {
  if (!rows.length) return [];
  const colCount = Math.max(...rows.map(r => (Array.isArray(r) ? r.length : 0)));
  const widths = Array(colCount).fill(8);
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    row.forEach((cell, ci) => {
      const len = String(cell ?? '').length;
      if (len > widths[ci]) widths[ci] = Math.min(len + 2, 60);
    });
  }
  return widths.map(w => ({ wch: w }));
}

function styleHeaderRow(ws, colCount) {
  for (let ci = 0; ci < colCount; ci++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c: ci });
    if (!ws[addr]) continue;
    ws[addr].s = {
      font: { bold: true },
      fill: { patternType: 'solid', fgColor: { rgb: 'E0E0E0' } },
      alignment: { horizontal: 'center' },
    };
  }
}

function applyCellFormats(ws, formats, rowCount, colCount) {
  // formats: array indexed by col, each entry is a number format string
  if (!Array.isArray(formats)) return;
  for (let ri = 1; ri < rowCount; ri++) {
    for (let ci = 0; ci < formats.length && ci < colCount; ci++) {
      const fmt = formats[ci];
      if (!fmt) continue;
      const addr = XLSX.utils.encode_cell({ r: ri, c: ci });
      if (!ws[addr]) continue;
      ws[addr].s = ws[addr].s || {};
      ws[addr].s.numFmt = fmt;
    }
  }
}

const run = async (args) => {
  try {
    const inputFile = args.input;
    if (!fs.existsSync(inputFile)) {
      process.stderr.write(`Error: Input file not found: ${inputFile}\n`);
      process.exit(1);
    }

    let data;
    try {
      data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    } catch (e) {
      process.stderr.write(`Error: Invalid JSON in input file: ${e.message}\n`);
      process.exit(1);
    }

    const { sheets = [] } = data || {};
    const workbook = XLSX.utils.book_new();

    for (const sheet of (Array.isArray(sheets) ? sheets : [])) {
      const {
        name = 'Sheet',
        data: rows = [],
        options = {},
        colWidths,
        formats,
      } = sheet || {};

      const ws = XLSX.utils.aoa_to_sheet(Array.isArray(rows) ? rows : []);
      const colCount = rows.length ? Math.max(...rows.map(r => (Array.isArray(r) ? r.length : 0))) : 0;

      // Column widths: explicit array, or auto-calculated from content
      if (Array.isArray(colWidths) && colWidths.length) {
        ws['!cols'] = colWidths.map(w => ({ wch: Number(w) || 10 }));
      } else {
        ws['!cols'] = autoColWidths(Array.isArray(rows) ? rows : []);
      }

      // Style header row if present
      if (options.header !== false && rows.length > 0) {
        styleHeaderRow(ws, colCount);
      }

      // Apply number formats per column (e.g. '$#,##0.00', '0%', 'YYYY-MM-DD')
      if (Array.isArray(formats)) {
        applyCellFormats(ws, formats, rows.length, colCount);
      }

      XLSX.utils.book_append_sheet(workbook, ws, String(name || 'Sheet').slice(0, 31));
    }

    if (!workbook.SheetNames.length) {
      // Always need at least one sheet
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[]]), 'Sheet1');
    }

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
    console.log(buffer.toString('base64'));
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
};

if (require.main === module) {
  run({ input: process.argv[2] });
}

module.exports = run;
