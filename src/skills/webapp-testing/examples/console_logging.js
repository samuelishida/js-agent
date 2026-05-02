#!/usr/bin/env node
/**
 * Example: Capturing console logs during browser automation
 *
 * Usage:
 *     node console_logging.js [url]
 *
 * Default URL: http://localhost:5173
 */

'use strict';

const { chromium } = require('playwright');

async function main() {
  const url = process.argv[2] || 'http://localhost:5173';

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  const consoleLogs = [];

  // Set up console log capture
  page.on('console', msg => {
    const entry = `[${msg.type()}] ${msg.text()}`;
    consoleLogs.push(entry);
    console.log(`Console: ${entry}`);
  });

  // Navigate to page
  await page.goto(url);
  await page.waitForLoadState('networkidle');

  // Interact with the page (triggers console logs)
  await page.click('text=Dashboard');
  await page.waitForTimeout(1000);

  await browser.close();

  // Save console logs to file
  const fs = require('fs');
  const path = require('path');
  const outputDir = process.env.OUTPUT_DIR || '/tmp';
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'console.log'), consoleLogs.join('\n'));

  console.log(`\nCaptured ${consoleLogs.length} console messages`);
  console.log(`Logs saved to: ${path.join(outputDir, 'console.log')}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});