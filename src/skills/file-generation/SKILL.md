---
name: file-generation
description: "Generate binary files (DOCX, PDF, XLSX, PPTX) from data. Use when user wants a downloadable file output. This is the ONLY skill needed for binary file generation — docx/pdf/xlsx/pptx are all handled here. Triggers: any request for a Word doc, Excel file, PDF, or PowerPoint as output."
license: Proprietary
---

# File Generation Skill

Generate binary files (DOCX, PDF, XLSX, PPTX) using Node.js scripts executed via the dev server sandbox.

## One-Step Generation

`runtime_generateFile` accepts a Node.js script as `content`, executes it on the dev server, captures base64 from stdout, and **auto-downloads** the resulting file to the user's Downloads folder.

```javascript
// Tool: runtime_generateFile
// path: "agent-sandbox/gen.cjs"
// content: "const PDFDocument = require('pdfkit');\nconst doc = new PDFDocument();\nconst chunks=[];\ndoc.on('data',c=>chunks.push(c));\ndoc.on('end',()=>process.stdout.write(Buffer.concat(chunks).toString('base64')));\ndoc.text('Hello');\ndoc.end();"
// filename: "output.pdf"
```

The file lands in Downloads automatically — no follow-up tool call needed.

## Decision Tree

```
User wants a binary file output?
├── YES → Use this skill (file-generation)
│         1. Call runtime_generateFile(path="agent-sandbox/gen.cjs", content=script, filename="output.pdf")
│         2. Tool result confirms download
│
└── NO → Use other skills (web_fetch, read_file, etc.)
```

## ⚠️ Critical: File Extension MUST be `.cjs`

**The dev server runs with `"type": "module"` in package.json, so `.js` files are ES modules.**
**Generator scripts MUST use `.cjs` extension to use CommonJS `require()`.**

Script path format: `agent-sandbox/gen.cjs` (NOT `gen.js`)

## Step-by-Step Workflow

### Step 1: Build the Generator Script

Write a Node.js script that writes base64 to stdout via `process.stdout.write(base64)`:

```javascript
// filepath: agent-sandbox/gen_docx.cjs
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

### Step 2: Generate and Download

```javascript
// Tool: runtime_generateFile
// path: "agent-sandbox/gen_docx.cjs"
// content: "<the script above>"
// filename: "report.docx"
```

The tool result will confirm the download and provide the file size.

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
| `ERR_UNKNOWN_FILE_EXTENSION` | Path does not end in `.cjs` | Use `"agent-sandbox/gen.cjs"` |
| Downloaded `.cjs` or `.js` name | Missing `filename` or older runtime | Retry with `filename="output.pdf"` or update runtime |

## What NOT To Do

❌ **Don't** pass base64 in tool arguments — truncated at ~4096 chars
❌ **Don't** use `fs_write_file` for binary content — writes to virtual FS
❌ **Don't** use `storage_set` for generator scripts — pass the script in `content`
❌ **Don't** call `runtime_runTerminal` after `runtime_generateFile` — already auto-executes
❌ **Don't** call `fs_download_file` after `runtime_generateFile` — already auto-downloads

✅ **Do** write script via `runtime_generateFile` and let it auto-execute + auto-download
