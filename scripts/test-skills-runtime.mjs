import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');
const generatorDir = path.join(projectDir, 'src/skills/runtime/generators');
const generatedDir = path.join(projectDir, 'src/skills/generated/runtime');
const sandboxDir = path.join(projectDir, 'agent-sandbox');

// Ensure sandbox exists
if (!fs.existsSync(sandboxDir)) {
  fs.mkdirSync(sandboxDir, { recursive: true });
}

console.log('=== Skills Runtime Test Suite ===\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (error) {
    console.log(`[FAIL] ${name}`);
    console.log(`   Error: ${error.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function base64ToBuffer(b64) {
  return Buffer.from(b64, 'base64');
}

function assertZipContains(buffer, entries) {
  assert(buffer.toString('utf8', 0, 2) === 'PK', 'Output does not start with ZIP magic bytes');
  const content = buffer.toString('latin1');
  entries.forEach(entry => {
    assert(content.includes(entry), `ZIP output does not contain ${entry}`);
  });
}

function readStdoutFromGenerator(generatorId, input) {
  const inputPath = path.join(sandboxDir, `test-${generatorId}-input.json`);
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2));
  
  try {
    const generatorPath = path.join(generatedDir, `${generatorId}.cjs`);
    // Run the generator via child_process to capture stdout
    // The generators are designed to be called as: node generator.cjs input.json
    const result = execFileSync(`node`, [generatorPath, inputPath], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 60000
    });
    // The generators output raw base64 directly to stdout
    return result.trim();
  } catch (error) {
    // Try to get stderr for debugging
    const stderr = error.stderr || '';
    const stdout = error.stdout || '';
    throw new Error(`Generator execution failed: ${error.message}\nStdout: ${stdout}\nStderr: ${stderr}`);
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
  }
}

// Test 1: Check manifest exists
test('Manifest exists', () => {
  const manifestPath = path.join(projectDir, 'src/skills/runtime/manifest.json');
  assert(fs.existsSync(manifestPath), 'manifest.json not found');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert(Array.isArray(manifest.generators), 'manifest.generators is not an array');
  console.log(`   Found ${manifest.generators.length} generators`);
});

// Test 2: Check all generator source files exist
test('All generator source files exist', () => {
  const requiredGenerators = ['html', 'pdf', 'docx', 'xlsx', 'pptx', 'zip'];
  requiredGenerators.forEach(gen => {
    const genPath = path.join(generatorDir, `${gen}.cjs`);
    assert(fs.existsSync(genPath), `${gen}.cjs not found`);
  });
});

// Test 3: Check all generated bundles exist
test('All generated bundles exist', () => {
  const requiredGenerators = ['html', 'pdf', 'docx', 'xlsx', 'pptx', 'zip'];
  requiredGenerators.forEach(gen => {
    const bundlePath = path.join(generatedDir, `${gen}.cjs`);
    assert(fs.existsSync(bundlePath), `${gen}.cjs bundle not found`);
    const stats = fs.statSync(bundlePath);
    console.log(`   ${gen}.cjs: ${stats.size.toLocaleString()} bytes`);
  });
});

// Test 4: Test HTML generator
test('HTML generator works', () => {
  const input = {
    html: '<h1>Hello World</h1><p>This is a test.</p>',
    title: 'Test HTML',
    type: 'html'
  };
  const b64 = readStdoutFromGenerator('html', input);
  assert(b64.length > 0, 'HTML generator produced no output');
  const buffer = base64ToBuffer(b64);
  const content = buffer.toString('utf8');
  assert(content.includes('<h1>') || content.includes('<html'), 'Output does not contain valid HTML');
  console.log('   Output length:', buffer.length, 'bytes');
});

// Test 5: Test PDF generator
test('PDF generator works', () => {
  const input = {
    text: 'Hello World',
    title: 'Test PDF',
    margin: 50
  };
  const b64 = readStdoutFromGenerator('pdf', input);
  assert(b64.length > 0, 'PDF generator produced no output');
  const buffer = base64ToBuffer(b64);
  assert(buffer.toString('utf8', 0, 5) === '%PDF-', 'Output does not start with PDF magic bytes');
  console.log('   Output length:', buffer.length, 'bytes');
});

// Test 6: Test DOCX generator
test('DOCX generator works', () => {
  const input = {
    sections: [
      {
        children: [
          { type: 'paragraph', text: 'Hello World', bold: false, fontSize: 12 }
        ]
      }
    ],
    title: 'Test DOCX'
  };
  const b64 = readStdoutFromGenerator('docx', input);
  assert(b64.length > 0, 'DOCX generator produced no output');
  const buffer = base64ToBuffer(b64);
  assertZipContains(buffer, ['[Content_Types].xml', 'word/document.xml']);
  console.log('   Output length:', buffer.length, 'bytes');
});

test('DOCX generator handles report-shaped structured input', () => {
  const input = {
    title: 'Yvy | Environmental Observability Report',
    sections: [
      {
        children: [
          { type: 'paragraph', text: 'Date: April 30, 2026 | Source: https://yvy.app.br' },
          { type: 'heading', text: 'Live Fire Data (Foco de Calor)', heading: 'Heading 1' },
          { type: 'bulletList', items: ['Total active heat spots: 3,856'] },
          { type: 'heading', text: 'Climate Data - Nova Nazare', heading: 2 },
          {
            type: 'table',
            rows: [
              ['Metric', 'Value'],
              ['AQI', '87'],
              ['PM2.5', '87 ug/m3'],
              ['Humidity', '44%'],
              ['Temperature', '29C (SC: 30C)'],
              ['Wind', '7 km/h NE']
            ]
          },
          { type: 'heading', text: 'Live Alerts (18 Active)', heading: 2 },
          { type: 'bulletList', items: ['Cerrado: 36', 'Cerrado: 7', 'Brasil: 17'] }
        ]
      }
    ]
  };
  const b64 = readStdoutFromGenerator('docx', input);
  assert(b64.length > 0, 'DOCX generator produced no output');
  const buffer = base64ToBuffer(b64);
  assertZipContains(buffer, ['[Content_Types].xml', 'word/document.xml']);
  console.log('   Output length:', buffer.length, 'bytes');
});

// Test 7: Test XLSX generator
test('XLSX generator works', () => {
  const input = {
    sheets: [
      {
        name: 'Sheet1',
        data: [
          ['Name', 'Age'],
          ['Alice', 30],
          ['Bob', 25]
        ]
      }
    ]
  };
  const b64 = readStdoutFromGenerator('xlsx', input);
  assert(b64.length > 0, 'XLSX generator produced no output');
  const buffer = base64ToBuffer(b64);
  assertZipContains(buffer, ['xl/workbook.xml']);
  console.log('   Output length:', buffer.length, 'bytes');
});

// Test 8: Test PPTX generator
test('PPTX generator works', () => {
  const input = {
    slides: [
      {
        title: 'Slide 1',
        text: 'Hello World',
        fontSize: 18
      }
    ],
    title: 'Test PPTX'
  };
  const b64 = readStdoutFromGenerator('pptx', input);
  assert(b64.length > 0, 'PPTX generator produced no output');
  const buffer = base64ToBuffer(b64);
  assertZipContains(buffer, ['ppt/presentation.xml']);
  console.log('   Output length:', buffer.length, 'bytes');
});

// Test 9: Test ZIP generator
test('ZIP generator works', () => {
  const input = {
    files: [
      { path: 'test.txt', content: 'Hello World', encoding: 'utf8' },
      { path: 'data.json', content: '{"key": "value"}', encoding: 'utf8' }
    ]
  };
  const b64 = readStdoutFromGenerator('zip', input);
  assert(b64.length > 0, 'ZIP generator produced no output');
  const buffer = base64ToBuffer(b64);
  assertZipContains(buffer, ['test.txt', 'data.json', 'Hello World', '{"key": "value"}']);
  console.log('   Output length:', buffer.length, 'bytes');
});

// Test 10: Error handling - unknown generator
test('Error handling: unknown generator ID', () => {
  const input = { test: 'data' };
  const inputPath = path.join(sandboxDir, 'test-error-input.json');
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2));
  
  try {
    execSync(`node "${path.join(generatedDir, 'unknown.cjs')}" "${inputPath}"`, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000
    });
    throw new Error('Should have thrown an error for unknown generator');
  } catch (error) {
    assert(error.message.includes('unknown') || error.message.includes('not found'), 'Error message should mention unknown generator');
    console.log('   Correctly rejected unknown generator');
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
  }
});

// Test 11: Error handling - missing input
test('Error handling: missing input file', () => {
  try {
    execFileSync('node', [path.join(generatedDir, 'html.cjs'), path.join(sandboxDir, 'does-not-exist.json')], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000
    });
    throw new Error('Should have thrown an error for missing input file');
  } catch (error) {
    const stderr = String(error.stderr || '');
    assert(stderr.includes('Input file not found'), 'Error message should mention missing input file');
    console.log('   Correctly handled missing input');
  }
});

// Test 12: Manifest schema validation
test('Manifest schema validation', () => {
  const manifestPath = path.join(projectDir, 'src/skills/runtime/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  
  const requiredFields = ['id', 'description', 'inputSchema', 'outputMime', 'extensions'];
  manifest.generators.forEach(gen => {
    requiredFields.forEach(field => {
      assert(gen.hasOwnProperty(field), `${gen.id} missing required field: ${field}`);
    });
  });
  console.log('   All generators have required fields');
});

// Test 13: Generator file syntax validation
test('Generator files are valid Node.js', () => {
  const requiredGenerators = ['html', 'pdf', 'docx', 'xlsx', 'pptx', 'zip'];
  requiredGenerators.forEach(gen => {
    const genPath = path.join(generatedDir, `${gen}.cjs`);
    try {
      execFileSync('node', ['--check', genPath], { cwd: projectDir });
      console.log(`   ${gen}.cjs syntax valid`);
    } catch (error) {
      throw new Error(`${gen}.cjs has syntax errors: ${error.message}`);
    }
  });
});

// Test 14: Build validation
test('Build validation: all bundles exist and are valid', () => {
  const requiredGenerators = ['html', 'pdf', 'docx', 'xlsx', 'pptx', 'zip'];
  requiredGenerators.forEach(gen => {
    const bundlePath = path.join(generatedDir, `${gen}.cjs`);
    assert(fs.existsSync(bundlePath), `${gen}.cjs bundle not found`);
    const stats = fs.statSync(bundlePath);
    assert(stats.size > 1000, `${gen}.cjs bundle is too small (${stats.size} bytes)`);
  });
  console.log('   All bundles exist and have reasonable size');
});

// Summary
console.log('\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}
