import { strict as assert } from 'node:assert';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Expected "${expected}", got "${actual}"`);
  }
}

// formatTokenCount — extracted from ui-render.js logic
function formatTokenCount(tokens) {
  if (tokens >= 1000) return '~' + Math.round(tokens / 1000) + 'k tokens';
  return '~' + tokens + ' tokens';
}

console.log('\n  formatTokenCount tests\n');

test('formatTokenCount: zero', () => {
  assertEqual(formatTokenCount(0), '~0 tokens');
});

test('formatTokenCount: sub-thousand', () => {
  assertEqual(formatTokenCount(500), '~500 tokens');
});

test('formatTokenCount: just below 1000', () => {
  assertEqual(formatTokenCount(999), '~999 tokens');
});

test('formatTokenCount: exactly 1000', () => {
  assertEqual(formatTokenCount(1000), '~1k tokens');
});

test('formatTokenCount: mid-range', () => {
  assertEqual(formatTokenCount(32000), '~32k tokens');
});

test('formatTokenCount: rounds 1500 to 2k', () => {
  assertEqual(formatTokenCount(1500), '~2k tokens');
});

test('formatTokenCount: rounds 1499 to 1k', () => {
  assertEqual(formatTokenCount(1499), '~1k tokens');
});

test('formatTokenCount: max ctx limit', () => {
  assertEqual(formatTokenCount(128000), '~128k tokens');
});

test('formatTokenCount: minimum clamped value (5000)', () => {
  assertEqual(formatTokenCount(5000), '~5k tokens');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exit(1);