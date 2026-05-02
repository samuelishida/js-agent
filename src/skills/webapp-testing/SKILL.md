---
name: webapp-testing
description: Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs.
license: Complete terms in LICENSE.txt
---

# Web Application Testing

> **Browser compatibility note**: The `node scripts/with_server.js` helper below requires the **dev server** (`node proxy/dev-server.js`) which provides the `runtime_generateFile` sandbox. In a pure browser environment without the sandbox, Playwright scripts cannot run. Use `runtime_generateFile` to execute them if the sandbox is available. In pure browser mode, guide the user to write Playwright scripts manually or use browser DevTools for testing.

To test local web applications, write native Node.js Playwright scripts.

**Helper Scripts Available**:
- `scripts/with_server.js` - Manages server lifecycle (supports multiple servers)

**Always run scripts with `--help` first** to see usage. DO NOT read the source until you try running the script first and find that a customized solution is abslutely necessary. These scripts can be very large and thus pollute your context window. They exist to be called directly as black-box scripts rather than ingested into your context window.

## Decision Tree: Choosing Your Approach

```
User task → Is it static HTML?
    ├─ Yes → Read HTML file directly to identify selectors
    │         ├─ Success → Write Playwright script using selectors
    │         └─ Fails/Incomplete → Treat as dynamic (below)
    │
    └─ No (dynamic webapp) → Is the server already running?
        ├─ No → Run: node scripts/with_server.js --help
        │        Then use the helper + write simplified Playwright script
        │
        └─ Yes → Reconnaissance-then-action:
            1. Navigate and wait for networkidle
            2. Take screenshot or inspect DOM
            3. Identify selectors from rendered state
            4. Execute actions with discovered selectors
```

## Example: Using with_server.js

To start a server, run `--help` first, then use the helper:

**Single server:**
```bash
node scripts/with_server.js --server "npm run dev" --port 5173 -- node your_automation.js
```

**Multiple servers (e.g., backend + frontend):**
```bash
node scripts/with_server.js \
  --server "cd backend && node server.js" --port 3000 \
  --server "cd frontend && npm run dev" --port 5173 \
  -- node your_automation.js
```

To create an automation script, include only Playwright logic (servers are managed automatically):
```javascript
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true }); // Always launch chromium in headless mode
  const page = await browser.newPage();
  await page.goto('http://localhost:5173'); // Server already running and ready
  await page.waitForLoadState('networkidle'); // CRITICAL: Wait for JS to execute
  // ... your automation logic
  await browser.close();
})();
```

## Reconnaissance-Then-Action Pattern

1. **Inspect rendered DOM**:
   ```javascript
   await page.screenshot({ path: '/tmp/inspect.png', fullPage: true });
   const content = await page.content();
   await page.locator('button').all();
   ```

2. **Identify selectors** from inspection results

3. **Execute actions** using discovered selectors

## Common Pitfall

❌ **Don't** inspect the DOM before waiting for `networkidle` on dynamic apps
✅ **Do** wait for `page.wait_for_load_state('networkidle')` before inspection

## Best Practices

- **Use bundled scripts as black boxes** - To accomplish a task, consider whether one of the scripts available in `scripts/` can help. These scripts handle common, complex workflows reliably without cluttering the context window. Use `--help` to see usage, then invoke directly. 
- Use `async/await` with Playwright
- Always close the browser when done
- Use descriptive selectors: `text=`, `role=`, CSS selectors, or IDs
- Add appropriate waits: `page.wait_for_selector()` or `page.wait_for_timeout()`

## Reference Files

- **examples/** - Examples showing common patterns:
  - `element_discovery.js` - Discovering buttons, links, and inputs on a page
  - `static_html_automation.js` - Using file:// URLs for local HTML
  - `console_logging.js` - Capturing console logs during automation