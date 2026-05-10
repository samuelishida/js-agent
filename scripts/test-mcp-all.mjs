import { spawn } from 'node:child_process';

const MCP_TESTS = [
  'scripts/test-mcp-store.mjs',
  'scripts/test-mcp-http.mjs',
  'scripts/test-mcp-filters.mjs',
  'scripts/test-mcp-stdio.mjs',
  'scripts/test-mcp-refresh.mjs',
  'scripts/test-mcp-sse.mjs',
  'scripts/test-mcp-routing.mjs',
  'scripts/test-mcp-settings.mjs',
];

const SMOKE_TESTS = [
  'scripts/test-smoke.mjs',
  'scripts/test-tools-smoke.mjs',
  'scripts/test-artifact-flow.mjs',
];

async function run(script) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [script], { stdio: 'inherit' });
    proc.on('close', code => resolve(code));
  });
}

console.log('='.repeat(60));
console.log(' MCP Manager Test Suite');
console.log('='.repeat(60));
console.log();

const totalSuites = MCP_TESTS.length + SMOKE_TESTS.length;
let passedSuites = 0;
let failedSuites = 0;

// Run MCP tests sequentially; exit immediately on failure
for (const script of MCP_TESTS) {
  console.log(`\n--- Running ${script} ---`);
  const code = await run(script);
  if (code !== 0) {
    console.error(`\nFAILED: ${script} exited with code ${code}`);
    process.exit(code || 1);
  }
  console.log(`PASSED: ${script}`);
  passedSuites++;
}

// Run smoke tests sequentially; report failures but continue
for (const script of SMOKE_TESTS) {
  console.log(`\n--- Running ${script} ---`);
  const code = await run(script);
  if (code !== 0) {
    console.error(`\nWARNING: ${script} exited with code ${code}`);
    failedSuites++;
  } else {
    console.log(`PASSED: ${script}`);
    passedSuites++;
  }
}

// Summary
console.log('\n' + '='.repeat(60));
console.log(' Summary');
console.log('='.repeat(60));
console.log(`Total suites:  ${totalSuites}`);
console.log(`Passed suites: ${passedSuites}`);
console.log(`Failed suites: ${failedSuites}`);
console.log(`Result: ${failedSuites === 0 ? 'ALL PASSED' : 'SOME TESTS FAILED'}`);

if (failedSuites > 0) {
  process.exit(1);
}
