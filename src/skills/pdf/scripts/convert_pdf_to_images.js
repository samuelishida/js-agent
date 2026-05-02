#!/usr/bin/env node
/**
 * Convert PDF pages to images.
 *
 * Usage: node convert_pdf_to_images.js <input.pdf> <output_dir> [max_dim]
 *
 * Note: Full PDF-to-image conversion requires external tools.
 * Options:
 *   1. Use pdfjs-dist + canvas (for rendering):
 *      npm install pdfjs-dist canvas
 *   2. Use LibreOffice (headless):
 *      libreoffice --headless --convert-to png input.pdf --outdir output_dir/
 *   3. Use Poppler/PoDoFo on Linux:
 *      pdftoppm -png input.pdf output_dir/page
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node convert_pdf_to_images.js <input.pdf> <output_dir> [max_dim]');
  console.error('');
  console.error('Note: Full PDF-to-image conversion requires one of:');
  console.error('  - LibreOffice: libreoffice --headless --convert-to png file.pdf --outdir dir/');
  console.error('  - Poppler:     pdftoppm -png input.pdf output/page');
  console.error('  - pdfjs-dist + canvas (Node.js): npm install pdfjs-dist canvas');
  process.exit(1);
}

const pdfPath = args[0];
const outputDir = args[1];
const maxDim = parseInt(args[2]) || 1000;

if (!existsSync(pdfPath)) {
  console.error(`Error: ${pdfPath} does not exist`);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

function convertPdf() {
  return import('pdfjs-dist').then((pdfJsLib) => {
    const data = new Uint8Array(readFileSync(pdfPath));
    const loadingTask = pdfJsLib.getDocument({ data });
    return loadingTask.promise;
  }).then((pdf) => {
    console.error(`Converting ${pdf.numPages} page(s)...`);

    const pagePromises = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      pagePromises.push(
        pdf.getPage(i).then((page) => {
          const viewport = page.getViewport({ scale: 1 });

          let scale = 1;
          if (viewport.width > maxDim || viewport.height > maxDim) {
            scale = Math.min(maxDim / viewport.width, maxDim / viewport.height);
          }

          const scaledViewport = page.getViewport({ scale });

          return import('canvas').then((canvasLib) => {
            const canvas = canvasLib.createCanvas(
              Math.floor(scaledViewport.width),
              Math.floor(scaledViewport.height)
            );
            const ctx = canvas.getContext('2d');

            return page.render({
              canvasContext: ctx,
              viewport: scaledViewport,
            }).promise.then(() => {
              const outputPath = join(outputDir, `page_${i}.png`);
              const buffer = canvas.toBuffer('image/png');
              writeFileSync(outputPath, buffer);
              console.error(`Saved page ${i} as ${outputPath} (${canvas.width}x${canvas.height})`);
            });
          });
        })
      );
    }

    return Promise.all(pagePromises).then(() => {
      console.log(`Converted ${pdf.numPages} pages to PNG images`);
    });
  });
}

convertPdf().catch((/** @type {any} */ err) => {
  if (err.code === 'MODULE_NOT_FOUND') {
    console.error('Error: canvas module is required. Run: npm install canvas');
    console.error('Or use LibreOffice/pdftoppm from command line.');
  } else {
    console.error(`Error converting PDF: ${err.message}`);
  }
  process.exit(1);
});
