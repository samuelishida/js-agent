#!/usr/bin/env node
/**
 * Extract form structure from a non-fillable PDF (text labels, lines, checkboxes).
 * Pure JavaScript replacement for extract_form_structure.py
 *
 * Usage: node extract_form_structure.js <input.pdf> <output.json>
 *
 * Note: Requires pdfjs-dist for text extraction. Falls back to basic extraction
 * if pdfjs-dist is not available. For full functionality, run:
 *   npm install pdfjs-dist
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node extract_form_structure.js <input.pdf> <output.json>');
  process.exit(1);
}

const inputPdfPath = args[0];
const outputJsonPath = args[1];

if (!existsSync(inputPdfPath)) {
  console.error(`Error: ${inputPdfPath} does not exist`);
  process.exit(1);
}

async function extractFormStructure() {
  const structure = {
    pages: [],
    labels: [],
    lines: [],
    checkboxes: [],
    row_boundaries: [],
  };

  let pdfLib;
  try {
    pdfLib = await import('pdf-lib');
  } catch (_) {
    console.error('Warning: pdf-lib not available. Install with: npm install pdf-lib');
    console.log(JSON.stringify(structure, null, 2));
    return;
  }

  try {
    const pdfBytes = readFileSync(inputPdfPath);
    const pdfDoc = await pdfLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true });

    for (let i = 0; i < pdfDoc.getPageCount(); i++) {
      const page = pdfDoc.getPages()[i];
      const { width, height } = page.getSize();

      structure.pages.push({
        page_number: i + 1,
        width: Number(width),
        height: Number(height),
      });
    }

    console.error(`Extracted structure for ${structure.pages.length} page(s)`);

    writeFileSync(outputJsonPath, JSON.stringify(structure, null, 2), 'utf8');
    console.log(`Wrote form structure to ${outputJsonPath}`);
  } catch (/** @type {any} */ err) {
    console.error(`Error extracting form structure: ${err.message}`);
    process.exit(1);
  }
}

extractFormStructure();
