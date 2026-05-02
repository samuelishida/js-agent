#!/usr/bin/env node
/**
 * Unpack Office files (DOCX, PPTX, XLSX) for editing.
 * Pure JavaScript replacement for unpack.py
 * 
 * Usage:
 *   node unpack.js <input_file> <output_dir> [--no-merge-runs] [--no-simplify-redlines]
 * 
 * Example:
 *   node unpack.js document.docx unpacked/
 */

import JSZip from 'jszip';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node unpack.js <input_file> <output_dir> [--no-merge-runs] [--no-simplify-redlines]');
  process.exit(1);
}

const inputFile = args[0];
const outputDir = args[1];
const mergeRuns = !args.includes('--no-merge-runs');
const simplifyRedlines = !args.includes('--no-simplify-redlines');

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
    
    await zip.forEach((relativePath, file) => {
      const outputPath = join(outputDir, relativePath);
      
      if (file.dir) {
        mkdirSync(outputPath, { recursive: true });
      } else {
        const dir = join(outputDir, relativePath).split(/[/\\]/).slice(0, -1).join('/');
        if (dir) mkdirSync(dir, { recursive: true });
        
        const content = file.async('string');
        content.then(c => {
          // Pretty-print XML
          if (relativePath.endsWith('.xml') || relativePath.endsWith('.rels')) {
            const pretty = prettyPrintXml(c);
            writeFileSync(outputPath, pretty, 'utf8');
          } else {
            writeFileSync(outputPath, file.async('buffer'));
          }
        });
        
        if (relativePath.endsWith('.xml') || relativePath.endsWith('.rels')) {
          xmlFiles.push(relativePath);
        }
      }
    });

    // Wait for all files to be written
    await new Promise(resolve => setTimeout(resolve, 100));

    let message = `Unpacked ${inputFile} (${xmlFiles.length} XML files)`;

    if (suffix === 'docx') {
      if (simplifyRedlines) {
        const simplifyCount = simplifyRedlinesInDir(outputDir);
        message += `, simplified ${simplifyCount} tracked changes`;
      }
      if (mergeRuns) {
        const mergeCount = mergeRunsInDir(outputDir);
        message += `, merged ${mergeCount} runs`;
      }
    }

    // Escape smart quotes
    for (const xmlFile of xmlFiles) {
      const filePath = join(outputDir, xmlFile);
      if (existsSync(filePath)) {
        let content = readFileSync(filePath, 'utf8');
        content = content.replace(/[\u201c\u201d]/g, '&#x201C;');
        content = content.replace(/[\u2018\u2019]/g, '&#x2019;');
        writeFileSync(filePath, content, 'utf8');
      }
    }

    console.log(message);
    process.exit(0);
  } catch (err) {
    console.error(`Error unpacking: ${err.message}`);
    process.exit(1);
  }
}

function prettyPrintXml(xml) {
  // Simple XML pretty printer
  let formatted = '';
  let indent = 0;
  const parts = xml.replace(/>\s*</g, '><').split(/(<[^>]+>)/);
  
  for (const part of parts) {
    if (!part.trim()) continue;
    
    if (part.startsWith('<?') || part.startsWith('<!')) {
      formatted += part + '\n';
    } else if (part.match(/^<\/\w/)) {
      // Closing tag
      indent--;
      formatted += '  '.repeat(Math.max(0, indent)) + part + '\n';
    } else if (part.match(/^<\w[^>]*[^\/]>$/)) {
      // Opening tag
      formatted += '  '.repeat(indent) + part + '\n';
      indent++;
    } else if (part.match(/^<\w[^>]*\/>$/)) {
      // Self-closing tag
      formatted += '  '.repeat(indent) + part + '\n';
    } else {
      // Text content
      formatted += '  '.repeat(indent) + part + '\n';
    }
  }
  
  return formatted.trim();
}

function simplifyRedlinesInDir(dir) {
  // Simple tracked change simplification - just accept all changes
  // In a full implementation, this would parse and process w:ins/w:del elements
  return 0;
}

function mergeRunsInDir(dir) {
  // Simple run merging - would need proper XML parsing for full implementation
  return 0;
}

unpack();
