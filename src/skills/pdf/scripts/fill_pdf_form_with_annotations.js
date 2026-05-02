#!/usr/bin/env node
/**
 * Fill a PDF form by placing text annotations at specific coordinates.
 * Pure JavaScript replacement for fill_pdf_form_with_annotations.py
 *
 * Usage: node fill_pdf_form_with_annotations.js <input.pdf> <fields.json> <output.pdf>
 *
 * fields.json format:
 * {
 *   "pages": [{ "page_number": 1, "width": 612, "height": 792 }],
 *   "form_fields": [
 *     {
 *       "page_number": 1,
 *       "entry_bounding_box": [x0, top, x1, bottom],
 *       "entry_text": { "text": "John Doe", "font_size": 12 }
 *     }
 *   ]
 * }
 */

import { PDFDocument, PDFName } from 'pdf-lib';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('Usage: node fill_pdf_form_with_annotations.js <input.pdf> <fields.json> <output.pdf>');
  process.exit(1);
}

const inputPdfPath = args[0];
const fieldsJsonPath = args[1];
const outputPdfPath = args[2];

function transformFromImageCoords(bbox, imageWidth, imageHeight, pdfWidth, pdfHeight) {
  const xScale = pdfWidth / imageWidth;
  const yScale = pdfHeight / imageHeight;

  const left = bbox[0] * xScale;
  const right = bbox[2] * xScale;
  const top = pdfHeight - (bbox[1] * yScale);
  const bottom = pdfHeight - (bbox[3] * yScale);

  return [left, bottom, right, top];
}

function transformFromPdfCoords(bbox, pdfHeight) {
  const left = bbox[0];
  const right = bbox[2];
  const pypdfTop = pdfHeight - bbox[1];
  const pypdfBottom = pdfHeight - bbox[3];
  return [left, pypdfBottom, right, pypdfTop];
}

async function fillPdfForm() {
  if (!existsSync(inputPdfPath)) {
    console.error(`Error: ${inputPdfPath} does not exist`);
    process.exit(1);
  }
  if (!existsSync(fieldsJsonPath)) {
    console.error(`Error: ${fieldsJsonPath} does not exist`);
    process.exit(1);
  }

  const fieldsData = JSON.parse(readFileSync(fieldsJsonPath, 'utf8'));

  const pdfBytes = readFileSync(inputPdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

  const pdfDimensions = {};
  const pages = pdfDoc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const mediabox = pages[i].node.get(PDFName.of('MediaBox'));
    if (mediabox) {
      pdfDimensions[i + 1] = [
        mediabox.array.get(2).numberValue(),
        mediabox.array.get(3).numberValue(),
      ];
    } else {
      const { width, height } = pages[i].getSize();
      pdfDimensions[i + 1] = [width, height];
    }
  }

  for (const field of fieldsData.form_fields || fieldsData.fields || []) {
    const pageNum = field.page_number;
    const pageInfo = (fieldsData.pages || []).find(p => p.page_number === pageNum);
    const [pdfWidth, pdfHeight] = pdfDimensions[pageNum] || [612, 792];

    let entryBox;
    if (pageInfo && pageInfo.pdf_width) {
      entryBox = transformFromPdfCoords(field.entry_bounding_box, pdfHeight);
    } else if (pageInfo) {
      const imageWidth = pageInfo.image_width || pdfWidth;
      const imageHeight = pageInfo.image_height || pdfHeight;
      entryBox = transformFromImageCoords(
        field.entry_bounding_box,
        imageWidth, imageHeight,
        pdfWidth, pdfHeight
      );
    } else {
      entryBox = field.entry_bounding_box;
    }

    if (!field.entry_text || !field.entry_text.text) continue;

    const text = field.entry_text.text;
    const fontSize = field.entry_text.font_size || 12;

    const page = pages[pageNum - 1];

    const font = await pdfDoc.embedFont('Helvetica');

    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const textHeight = fontSize;

    const x = entryBox[0];
    const y = entryBox[3] - textHeight;

    page.drawText(text, {
      x,
      y,
      size: fontSize,
      font,
    });

    console.error(`Filled field '${field.description || 'unknown'}' on page ${pageNum} at (${x.toFixed(1)}, ${y.toFixed(1)})`);
  }

  const modifiedPdfBytes = await pdfDoc.save();
  writeFileSync(outputPdfPath, modifiedPdfBytes);
  console.log(`Filled PDF form → ${outputPdfPath}`);
}

fillPdfForm().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
