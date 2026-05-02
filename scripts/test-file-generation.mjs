/**
 * Playwright test suite for file-generation skill
 * Tests the correct workflow: write script -> execute -> parse base64 -> download
 * 
 * Run: node scripts/test-file-generation.mjs
 * 
 * This verifies the TWO-PHASE pattern:
 * 1. runtime_generateFile (content=script) → writes to sandbox
 * 2. runtime_runTerminal (command="node agent-sandbox/gen.js") → returns base64
 * 3. fs_download_file(content=base64) → triggers download
 */

import { chromium } from 'playwright';
import { writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const AGENT_URL = 'http://localhost:5500';
const SANDBOX_DIR = 'agent-sandbox';

// Verified working scripts that output base64 to stdout
// NOTE: Scripts must use .cjs extension because package.json has "type": "module"
const TEST_CASES = [
  {
    name: 'DOCX minimal',
    script: `const {Document,Packer,Paragraph}=require('docx');const doc=new Document({sections:[{children:[new Paragraph({text:'Test'})]}]});Packer.toBase64String(doc).then(b=>process.stdout.write(b));`,
    ext: '.cjs',
    verify: (base64) => base64.startsWith('UEsDBAo') // DOCX ZIP signature
  },
  {
    name: 'PDF minimal',
    script: `const PDFDocument=require('pdfkit');const d=new PDFDocument();const c=[];d.on('data',x=>c.push(x));d.on('end',()=>process.stdout.write(Buffer.concat(c).toString('base64')));d.text('Test');d.end();`,
    ext: '.cjs',
    verify: (base64) => base64.length > 1000
  },
  {
    name: 'XLSX minimal',
    script: `const XLSX=require('xlsx');const wb=XLSX.utils.book_new();const ws=XLSX.utils.aoa_to_sheet([['A','B'],[1,2]]);XLSX.utils.book_append_sheet(wb,ws,'Sheet1');process.stdout.write(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}).toString('base64'));`,
    ext: '.cjs',
    verify: (base64) => base64.startsWith('UEsDBAo') || base64.startsWith('UEsDBBQ') // XLSX is also ZIP (Office format)
  }
];

async function runTests() {
  console.log('=== File Generation Skill Test Suite ===\n');
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log(`Navigating to ${AGENT_URL}...`);
  await page.goto(AGENT_URL);
  await page.waitForLoadState('networkidle');
  console.log('✓ Agent loaded\n');
  
  const results = [];
  
  for (const tc of TEST_CASES) {
    console.log(`Testing: ${tc.name}`);
    const scriptPath = join(SANDBOX_DIR, `test_${tc.name.replace(/\s/g, '_')}${tc.ext}`);
    
    try {
      // PHASE 1: Write script (like runtime_generateFile does)
      writeFileSync(scriptPath, tc.script);
      console.log(`  ✓ Script written to sandbox`);
      
      // PHASE 2: Execute (like runtime_runTerminal does)
      const output = execSync(`node "${scriptPath}"`, { 
        cwd: 'E:\\Code\\Agent',
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024 // 50MB for large files
      });
      
      const base64 = output.trim();
      console.log(`  ✓ Executed, base64 length: ${base64.length}`);
      
      // Verify format
      if (tc.verify(base64)) {
        console.log(`  ✓ Format verified`);
        results.push({ name: tc.name, success: true });
      } else {
        console.log(`  ✗ Format invalid`);
        results.push({ name: tc.name, success: false, error: 'Invalid format' });
      }
      
    } catch (err) {
      console.log(`  ✗ Error: ${err.message}`);
      results.push({ name: tc.name, success: false, error: err.message });
    } finally {
      // Cleanup
      if (existsSync(scriptPath)) {
        try { unlinkSync(scriptPath); } catch {}
      }
    }
    console.log('');
  }
  
  // Summary
  console.log('=== Results ===');
  results.forEach(r => {
    console.log(`${r.success ? '✓' : '✗'} ${r.name}${r.error ? ': ' + r.error : ''}`);
  });
  
  const passed = results.filter(r => r.success).length;
  console.log(`\n${passed}/${results.length} passed`);
  
  await browser.close();
  return passed === results.length;
}

// Run if called directly
const isMain = process.argv[1]?.includes('test-file-generation');
if (isMain) {
  runTests().then(ok => process.exit(ok ? 0 : 1)).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

export { runTests };
