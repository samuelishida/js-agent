#!/usr/bin/env node
/**
 * Check if a PDF has fillable form fields.
 * Pure JavaScript replacement for check_fillable_fields.py
 *
 * Usage: node check_fillable_fields.js <input.pdf>
 */

import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'fs';

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node check_fillable_fields.js <input.pdf>');
  process.exit(1);
}

const pdfPath = args[0];

PDFDocument.load(readFileSync(pdfPath), { ignoreEncryption: true }).then(pdfDoc => {
  const form = pdfDoc.getForm();
  const fields = form.getFields();

  if (fields.length > 0) {
    console.log('This PDF has fillable form fields');
  } else {
    console.log('This PDF does not have fillable form fields; you will need to visually determine where to enter data');
  }
}).catch((/** @type {any} */ err) => {
  console.error(`Error reading PDF: ${err.message}`);
  process.exit(1);
});
