#!/usr/bin/env node
/**
 * Example: Automating interaction with static HTML files using file:// URLs
 *
 * Usage:
 *     node static_html_automation.js <html-file-path>
 *
 * Example:
 *     node static_html_automation.js path/to/your/file.html
 */

'use strict';

const path = require('path');
const { chromium } = require('playwright');

async function main() {
  const htmlFilePath = process.argv[2] || 'path/to/your/file.html';
  const absolutePath = path.resolve(htmlFilePath);
  const fileUrl = `file://${absolutePath}`;

  const outputDir = process.env.OUTPUT_DIR || '/tmp';

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  // Navigate to local HTML file
  await page.goto(fileUrl);

  // Take screenshot
  const fs = require('fs');
  fs.mkdirSync(outputDir, { recursive: true });
  await page.screenshot({ path: path.join(outputDir, 'static_page.png'), fullPage: true });

  // Interact with elements
  await page.click('text=Click Me');
  await page.fill('#name', 'John Doe');
  await page.fill('#email', 'john@example.com');

  // Submit form
  await page.click('button[type="submit"]');
  await page.waitForTimeout(500);

  // Take final screenshot
  await page.screenshot({ path: path.join(outputDir, 'after_submit.png'), fullPage: true });

  await browser.close();

  console.log('Static HTML automation completed!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});