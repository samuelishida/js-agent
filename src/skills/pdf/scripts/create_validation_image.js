#!/usr/bin/env node
/**
 * Create a validation image showing field bounding boxes on a page.
 *
 * Usage: node create_validation_image.js <page_num> <fields.json> <input_image> <output_image>
 *
 * Note: This requires the `canvas` package for image manipulation.
 *   npm install canvas
 *
 * Alternatively, use PIL/Pillow in Python:
 *   python create_validation_image.py 1 fields.json input.png output.png
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const args = process.argv.slice(2);
if (args.length < 4) {
  console.error('Usage: node create_validation_image.js <page_num> <fields.json> <input_image> <output_image>');
  console.error('');
  console.error('Note: Requires canvas package. Run: npm install canvas');
  console.error('Alternative (Python): python create_validation_image.py ...');
  process.exit(1);
}

const pageNumber = parseInt(args[0]);
const fieldsJsonPath = args[1];
const inputImagePath = args[2];
const outputImagePath = args[3];

if (!existsSync(fieldsJsonPath)) {
  console.error(`Error: ${fieldsJsonPath} does not exist`);
  process.exit(1);
}
if (!existsSync(inputImagePath)) {
  console.error(`Error: ${inputImagePath} does not exist`);
  process.exit(1);
}

async function createValidationImage() {
  let canvasLib;
  try {
    canvasLib = await import('canvas');
  } catch (_) {}

  if (!canvasLib) {
    console.error('Error: canvas module is not installed. Run: npm install canvas');
    console.error('Alternative (Python): python create_validation_image.py ...');
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(fieldsJsonPath, 'utf8'));
  const fields = data.form_fields || data.fields || [];

  const img = await canvasLib.loadImage(inputImagePath);
  const canvas = canvasLib.createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(img, 0, 0);

  let numBoxes = 0;
  for (const field of fields) {
    if (field.page_number === pageNumber) {
      const entryBox = field.entry_bounding_box;
      const labelBox = field.label_bounding_box;

      if (entryBox) {
        ctx.strokeStyle = 'red';
        ctx.lineWidth = 2;
        ctx.strokeRect(entryBox[0], entryBox[1], entryBox[2] - entryBox[0], entryBox[3] - entryBox[1]);
        numBoxes++;
      }

      if (labelBox) {
        ctx.strokeStyle = 'blue';
        ctx.lineWidth = 2;
        ctx.strokeRect(labelBox[0], labelBox[1], labelBox[2] - labelBox[0], labelBox[3] - labelBox[1]);
        numBoxes++;
      }
    }
  }

  const buffer = canvas.toBuffer('image/png');
  writeFileSync(outputImagePath, buffer);
  console.log(`Created validation image at ${outputImagePath} with ${numBoxes} bounding boxes`);
}

createValidationImage().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
