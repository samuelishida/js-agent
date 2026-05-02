#!/usr/bin/env node
/**
 * Example: Discovering buttons and other elements on a page
 *
 * Usage:
 *     node element_discovery.js [url]
 *
 * Default URL: http://localhost:5173
 */

'use strict';

const { chromium } = require('playwright');

async function main() {
  const url = process.argv[2] || 'http://localhost:5173';

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Navigate to page and wait for it to fully load
  await page.goto(url);
  await page.waitForLoadState('networkidle');

  // Discover all buttons on the page
  const buttons = await page.locator('button').all();
  console.log(`Found ${buttons.length} buttons:`);
  for (let i = 0; i < buttons.length; i++) {
    const isVisible = await buttons[i].isVisible();
    const text = isVisible ? await buttons[i].innerText() : '[hidden]';
    console.log(`  [${i}] ${text}`);
  }

  // Discover links
  const links = await page.locator('a[href]').all();
  console.log(`\nFound ${links.length} links:`);
  for (let i = 0; i < Math.min(5, links.length); i++) {
    const text = (await links[i].innerText()).trim();
    const href = await links[i].getAttribute('href');
    console.log(`  - ${text} -> ${href}`);
  }

  // Discover input fields
  const inputs = await page.locator('input, textarea, select').all();
  console.log(`\nFound ${inputs.length} input fields:`);
  for (const input of inputs) {
    const name = await input.getAttribute('name') || await input.getAttribute('id') || '[unnamed]';
    const inputType = await input.getAttribute('type') || 'text';
    console.log(`  - ${name} (${inputType})`);
  }

  // Take screenshot for visual reference
  await page.screenshot({ path: '/tmp/page_discovery.png', fullPage: true });
  console.log('\nScreenshot saved to /tmp/page_discovery.png');

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});