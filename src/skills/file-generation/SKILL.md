---
name: file-generation
description: "Generate binary files (DOCX, PDF, XLSX, PPTX) from data. Use when user wants a downloadable file output. This is the ONLY skill needed for binary file generation — docx/pdf/xlsx/pptx are all handled here. Triggers: any request for a Word doc, Excel file, PDF, or PowerPoint as output."
license: Proprietary
---

# File Generation Skill

Generate binary files (DOCX, PDF, XLSX, PPTX) using Node.js scripts executed via the dev server sandbox.

## ⚠️ Critical: Two-Phase Generation

Binary file generation requires TWO separate tool calls:
1. **Phase 1**: Write script to disk via `runtime_generateFile` (no output returned)
2. **Phase 2**: Execute script via `runtime_runTerminal` → captures base64 from stdout

**NEVER try to pass base64 in tool arguments — it will be truncated!**

## Decision Tree

```
User wants a binary file output?
├── YES → Use this skill (file-generation)
│         1. Write generator script via runtime_generateFile (content=script, path="agent-sandbox/gen.cjs")
│         2. Execute via runtime_runTerminal (command="node agent-sandbox/gen.cjs")
│         3. Parse base64 from stdout in tool result
│         4. Serve via fs_download_file(content=base64)
│
└── NO → Use other skills (web_fetch, read_file, etc.)
```

## ⚠️ Critical: File Extension MUST be `.cjs`

**The dev server runs with `"type": "module"` in package.json, so `.js` files are ES modules.**
**Generator scripts MUST use `.cjs` extension to use CommonJS `require()`.**

Script path format: `agent-sandbox/gen.cjs` (NOT `gen.js`)

## Step-by-Step Workflow

### Step 1: Write the Generator Script

Use `runtime_generateFile` with your Node.js script as `content`:

```javascript
// filepath: agent-sandbox/gen_docx.js
const { Document, Packer, Paragraph, TextRun } = require('docx');

const doc = new Document({
  sections: [{
    children: [
      new Paragraph({ text: 'Report Title', heading: 1 }),
      new Paragraph({ text: 'Hello World' })
    ]
  }]
});

Packer.toBase64String(doc).then(b64 => process.stdout.write(b64));
```

**Key**: Script MUST write base64 to stdout via `process.stdout.write(b64)` or `console.log(b64)`.

### Step 2: Execute and Capture Base64

```javascript
// Tool: runtime_runTerminal
// Command: node agent-sandbox/gen_docx.js
```

The tool result will contain `base64:<long_string>` in the output. Extract this.

### Step 3: Serve the File

```javascript
// Tool: fs_download_file
// filename: "report.docx"
// content: "<extracted_base64>"
```

## Library Templates

### DOCX Template
```javascript
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType } = require('docx');

const doc = new Document({
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    children: [
      new Paragraph({ text: 'Title', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
      new Paragraph({ children: [new TextRun('Body text')] })
    ]
  }]
});

Packer.toBase64String(doc).then(b64 => process.stdout.write(b64));
```

### PDF Template
```javascript
const PDFDocument = require('pdfkit');
const doc = new PDFDocument();
const chunks = [];
doc.on('data', chunk => chunks.push(chunk));
doc.on('end', () => process.stdout.write(Buffer.concat(chunks).toString('base64')));
doc.text('Hello World');
doc.end();
```

### XLSX Template
```javascript
const XLSX = require('xlsx');
const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet([['Header1', 'Header2'], ['A', 'B']]);
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
process.stdout.write(buf.toString('base64'));
```

### PPTX Template
```javascript
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.addSlide().addText('Hello', { x: 1, y: 1, fontSize: 24 });
pres.writeFile({ fileName: 'agent-sandbox/temp.pptx' }).then(() => {
  const fs = require('fs');
  process.stdout.write(fs.readFileSync('agent-sandbox/temp.pptx').toString('base64'));
});
```

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `MODULE_NOT_FOUND` | Script uses wrong require path | Use `require('docx')` not relative paths |
| `Exit code: 1` | Syntax error in script | Test script in terminal first |
| `storage_set Saved undefined` | Script content too long | Use `runtime_generateFile` with `content` instead |
| `Command too long` | Command exceeds 4096 chars | Use `runtime_generateFile` to write script first |

## What NOT To Do

❌ **Don't** pass base64 in tool arguments — truncated at ~4096 chars
❌ **Don't** use `fs_write_file` for binary content — writes to virtual FS
❌ **Don't** use `storage_set` with full script — may truncate
❌ **Don't** use `runtime_runTerminal` with long inline scripts — hits command limit

✅ **Do** write script via `runtime_generateFile`, execute via `runtime_runTerminal`
