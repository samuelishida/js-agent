#!/usr/bin/env node
/**
 * Excel Formula Recalculation Script
 *
 * LIMITATION: Full formula recalculation requires LibreOffice or Excel.
 *
 * This script:
 *   - Checks for formula errors using openpyxl-compatible detection
 *   - Counts total formulas in the workbook
 *   - For actual recalculation, use LibreOffice:
 *     libreoffice --headless --convert-to xlsx --infilter="Calc MS Excel 2007 XML" input.xlsx --outdir output/
 *
 * Usage: node recalc.js <excel_file> [timeout_seconds]
 */

import * as XLSX from 'xlsx';
import { existsSync } from 'fs';

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node recalc.js <excel_file> [timeout_seconds]');
  console.error('');
  console.error('Note: Full formula recalculation requires LibreOffice.');
  console.error('For recalculation, use: libreoffice --headless --calc input.xlsx');
  process.exit(1);
}

const filename = args[0];
const timeout = parseInt(args[1]) || 30;

const EXCEL_ERRORS = [
  '#VALUE!',
  '#DIV/0!',
  '#REF!',
  '#NAME?',
  '#NULL!',
  '#NUM!',
  '#N/A',
  '#GETTING_DATA',
];

function checkFormulas(workbook) {
  const errorDetails = Object.fromEntries(EXCEL_ERRORS.map(e => [e, []]));
  let totalErrors = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');

    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[addr];
        if (!cell || cell.v === undefined || cell.v === null) continue;

        const val = typeof cell.v === 'string' ? cell.v : String(cell.v);

        for (const err of EXCEL_ERRORS) {
          if (val === err || val.includes(err)) {
            const location = `${sheetName}!${addr}`;
            errorDetails[err].push(location);
            totalErrors++;
            break;
          }
        }
      }
    }
  }

  return { errorDetails, totalErrors };
}

function countFormulas(workbook) {
  let formulaCount = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet || !sheet['!ref']) continue;

    for (const addr of Object.keys(sheet)) {
      if (addr === '!ref' || addr === '!merges') continue;
      const cell = sheet[addr];
      if (cell && cell.t === 'f' && cell.f && typeof cell.f === 'string' && cell.f.startsWith('=')) {
        formulaCount++;
      }
    }
  }

  return formulaCount;
}

function main() {
  if (!existsSync(filename)) {
    console.error(`Error: File ${filename} does not exist`);
    process.exit(1);
  }

  try {
    // Read with data_only=false to get formulas
    const wbFormulas = XLSX.readFile(filename, { cellFormula: true });

    // Read with data_only=true to get cached values
    let wbValues;
    try {
      wbValues = XLSX.readFile(filename, { cellNF: true });
    } catch (_) {
      wbValues = wbFormulas;
    }

    const { errorDetails, totalErrors } = checkFormulas(wbValues);
    const formulaCount = countFormulas(wbFormulas);

    const errorSummary = {};
    for (const [errType, locations] of Object.entries(errorDetails)) {
      if (locations.length > 0) {
        errorSummary[errType] = {
          count: locations.length,
          locations: locations.slice(0, 20),
        };
      }
    }

    const result = {
      status: totalErrors === 0 ? 'success' : 'errors_found',
      total_errors: totalErrors,
      total_formulas: formulaCount,
      error_summary: errorSummary,
      note: 'Full formula recalculation requires LibreOffice. Run: libreoffice --headless --calc file.xlsx',
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (/** @type {any} */ err) {
    console.error(`Error reading Excel file: ${err.message}`);
    process.exit(1);
  }
}

main();
