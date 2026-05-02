#!/usr/bin/env node
/**
 * Pack a directory into a DOCX, PPTX, or XLSX file.
 * Run directly: node pack.js <input_dir> <output_file>
 */

const JSZip = require('jszip');
const { readdirSync, readFileSync, statSync, writeFileSync, existsSync } = require('fs');
const { join, extname } = require('path');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node pack.js <input_dir> <output_file>');
  process.exit(1);
}

const inputDir = args[0];
const outputFile = args[1];

const suffix = extname(outputFile).toLowerCase();
if (!['.docx', '.pptx', '.xlsx'].includes(suffix)) {
  console.error('Error: Output must be .docx, .pptx, or .xlsx file');
  process.exit(1);
}

async function pack() {
  try {
    if (!existsSync(inputDir)) {
      console.error(`Error: ${inputDir} is not a directory`);
      process.exit(1);
    }

    console.error(`Packing ${inputDir} to ${outputFile}...`);

    const zip = new JSZip();

    function addFiles(dir, prefix = '') {
      const files = readdirSync(dir);
      for (const file of files) {
        const filePath = join(dir, file);
        const relativePath = prefix ? `${prefix}/${file}` : file;
        
        if (statSync(filePath).isDirectory()) {
          addFiles(filePath, relativePath);
        } else {
          const content = readFileSync(filePath);
          zip.file(relativePath, content);
        }
      }
    }

    addFiles(inputDir);

    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 }
    });

    writeFileSync(outputFile, buffer);

    console.log(`Successfully packed ${inputDir} to ${outputFile}`);
    process.exit(0);
  } catch (err) {
    console.error(`Error packing: ${err.message}`);
    process.exit(1);
  }
}

pack();
