#!/usr/bin/env node
/**
 * Unpack Office files (DOCX, PPTX, XLSX) for editing.
 * Run directly: node unpack.js <input> <output>
 */

const JSZip = require('jszip');
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('fs');
const { join } = require('path');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node unpack.js <input_file> <output_dir>');
  process.exit(1);
}

const inputFile = args[0];
const outputDir = args[1];

const suffix = inputFile.toLowerCase().split('.').pop();
if (!['docx', 'pptx', 'xlsx'].includes(suffix)) {
  console.error('Error: Input must be .docx, .pptx, or .xlsx file');
  process.exit(1);
}

async function unpack() {
  try {
    if (!existsSync(inputFile)) {
      console.error(`Error: ${inputFile} does not exist`);
      process.exit(1);
    }

    mkdirSync(outputDir, { recursive: true });
    console.error(`Unpacking ${inputFile} to ${outputDir}...`);

    const buffer = readFileSync(inputFile);
    const zip = await JSZip.loadAsync(buffer);
    
    const xmlFiles = [];
    
    await zip.forEach(async (relativePath, file) => {
      const isDir = file.dir;
      const outputPath = join(outputDir, relativePath);
      
      if (isDir) {
        mkdirSync(outputPath, { recursive: true });
      } else {
        const dir = outputPath.split(/[/\\]/).slice(0, -1).join('/');
        if (dir) mkdirSync(dir, { recursive: true });
        
        const content = await file.async('string');
        
        if (relativePath.endsWith('.xml') || relativePath.endsWith('.rels')) {
          const pretty = prettyPrintXml(content);
          writeFileSync(outputPath, pretty, 'utf8');
        } else {
          const buf = await file.async('nodebuffer');
          writeFileSync(outputPath, buf);
        }
        
        if (relativePath.endsWith('.xml') || relativePath.endsWith('.rels')) {
          xmlFiles.push(relativePath);
        }
      }
    });

    await new Promise(resolve => setTimeout(resolve, 200));

    console.log(`Unpacked ${inputFile} (${xmlFiles.length} XML files)`);
    process.exit(0);
  } catch (err) {
    console.error(`Error unpacking: ${err.message}`);
    process.exit(1);
  }
}

function prettyPrintXml(xml) {
  let formatted = '';
  let indent = 0;
  const parts = xml.replace(/>\s*</g, '><').split(/(<[^>]+>)/);
  
  for (const part of parts) {
    if (!part.trim()) continue;
    if (part.startsWith('<?') || part.startsWith('<!')) {
      formatted += part + '\n';
    } else if (part.match(/^<\/\w/)) {
      indent--;
      formatted += '  '.repeat(Math.max(0, indent)) + part + '\n';
    } else if (part.match(/^<\w[^>]*[^\/]>$/)) {
      formatted += '  '.repeat(indent) + part + '\n';
      indent++;
    } else if (part.match(/^<\w[^>]*\/>$/)) {
      formatted += '  '.repeat(indent) + part + '\n';
    } else {
      formatted += '  '.repeat(indent) + part + '\n';
    }
  }
  return formatted.trim();
}

unpack();
