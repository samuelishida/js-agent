---
name: file-generation
version: "7"
description: "Generate binary files (PDF, DOCX, XLSX, PPTX, HTML, ZIP) from structured data. Use when user wants a downloadable file output. This is the ONLY skill needed for binary file generation; all common formats are handled here. Triggers: any request for a Word doc, Excel file, PDF, PowerPoint, HTML, or ZIP as output."
license: Proprietary
---

# File Generation Skill

Generate downloadable files via `runtime_generateArtifact`. Pass structured JSON — do NOT write JavaScript. Pre-compiled generators handle all formats.

**Always required:** `generator` (string), `filename` (string), `input` (object with content).

## Save Behavior (automatic — no extra step needed)

Files auto-save using this priority:
1. **Electron desktop** — saves to configured output folder.
2. **Authorized folder** — if user clicked "Authorize Folder", file writes there directly.
3. **Sandbox + browser download** — otherwise saves a copy to `agent-sandbox/<filename>` and triggers browser file download.

---

## Format: PDF

Supports: headings (H1–H6), paragraphs (with bold/italic/color/align), bullet lists, numbered lists, tables, horizontal rules, page breaks.

```
runtime_generateArtifact(generator="pdf", filename="report.pdf", input={
  "title": "Environmental Report",
  "fontSize": 11,
  "margin": 50,
  "sections": [{
    "children": [
      {"type":"heading","heading":1,"text":"Executive Summary"},
      {"type":"paragraph","text":"Air quality is moderate with AQI at 87."},
      {"type":"paragraph","text":"Critical finding.","bold":true,"color":"#CC0000","align":"center"},
      {"type":"horizontalRule"},
      {"type":"heading","heading":2,"text":"Climate Data"},
      {"type":"table","rows":[
        ["Metric","Value"],
        ["AQI","87"],
        ["PM2.5","87 µg/m³"],
        ["Humidity","44%"],
        ["Temperature","29°C"]
      ]},
      {"type":"heading","heading":2,"text":"Key Findings"},
      {"type":"bulletList","items":[
        "Cerrado accounts for 37% of total heat spots.",
        "AQI 87 is Moderate — sensitive groups should limit outdoor exposure.",
        {"text":"18 active fire alerts require immediate attention.","bold":true}
      ]},
      {"type":"numberedList","items":["Monitor daily","Issue alerts","Deploy response teams"]},
      {"type":"pageBreak"},
      {"type":"heading","heading":1,"text":"Appendix"},
      {"type":"paragraph","text":"Data sourced from NASA FIRMS and local sensors.","italic":true,"align":"center"}
    ]
  }]
})
```

**PDF Child Node Properties:**

| Property | Type | Notes |
|---|---|---|
| `type` | string | `paragraph`, `heading`, `table`, `bulletList`, `numberedList`, `horizontalRule`, `pageBreak` |
| `text` | string | Content for paragraph/heading |
| `heading` | number 1–6 | Heading level (H1 = 22pt, H6 = 11pt) |
| `rows` | string[][] | Table rows — first row is bold header with gray background |
| `items` | string[] or {text,bold?,color?}[] | List items |
| `bold` | boolean | Bold text |
| `italic` | boolean | Italic text (Helvetica-Oblique) |
| `color` | string | Any CSS color or hex: `"#FF0000"`, `"red"` |
| `align` | string | `"left"`, `"center"`, `"right"`, `"justify"` |
| `fontSize` | number | Override font size in pt |

---

## Format: DOCX

Supports: headings (H1–H6), paragraphs, mixed inline runs (bold+italic+color+underline per word), bullet lists, numbered lists, tables (styled header row), horizontal rules, page breaks.

```
runtime_generateArtifact(generator="docx", filename="report.docx", input={
  "title": "Quarterly Sales Report",
  "margins": {"top":720,"right":720,"bottom":720,"left":720},
  "sections": [{
    "children": [
      {"type":"heading","heading":1,"text":"Overview"},
      {"type":"paragraph","text":"Revenue grew 23% year-over-year."},
      {"type":"paragraph","bold":true,"italic":false,"text":"Key insight: Q4 outperformed all forecasts."},
      {"type":"paragraph","runs":[
        {"text":"Status: "},
        {"text":"EXCEEDED TARGET","bold":true,"color":"007700"},
        {"text":" by 12%."}
      ]},
      {"type":"horizontalRule"},
      {"type":"heading","heading":2,"text":"Regional Breakdown"},
      {"type":"table","rows":[
        ["Region","Q3","Q4","Growth"],
        ["North","$1.2M","$1.5M","+25%"],
        ["South","$0.9M","$1.1M","+22%"],
        ["West","$1.4M","$1.7M","+21%"]
      ]},
      {"type":"heading","heading":2,"text":"Action Items"},
      {"type":"numberedList","items":[
        "Expand North region sales team.",
        "Launch West Coast campaign in January.",
        "Review pricing model for Southern accounts."
      ]},
      {"type":"heading","heading":2,"text":"Highlights"},
      {"type":"bulletList","items":[
        "Best Q4 on record.",
        {"text":"New enterprise contracts: 14","bold":true},
        "Customer retention at 94%."
      ]},
      {"type":"paragraph","text":"Prepared by Finance Team","align":"right","italic":true}
    ]
  }]
})
```

**DOCX Child Node Properties:**

| Property | Type | Notes |
|---|---|---|
| `type` | string | `paragraph`, `heading`, `table`, `bulletList`, `numberedList`, `horizontalRule`, `pageBreak` |
| `text` | string | Content (used when no `runs`) |
| `runs` | array | Mixed inline runs: `[{text, bold?, italic?, underline?, strikethrough?, color?, fontSize?}]` |
| `heading` | number 1–6 | Heading level |
| `rows` | string[][] | Table — first row auto-styled bold+gray unless `headerRow: false` |
| `headerRow` | boolean | Default true; set false to skip header styling |
| `noBorders` | boolean | Remove table borders |
| `items` | string[] or {text,bold?,italic?,color?,level?}[] | List items |
| `bold` | boolean | Bold |
| `italic` | boolean | Italic |
| `underline` | boolean | Underline |
| `strikethrough` | boolean | Strikethrough |
| `color` | string | Hex color without `#`: `"FF0000"` for red |
| `fontSize` | number | Points |
| `align` | string | `"left"`, `"center"`, `"right"`, `"justify"` |
| `spacing` | number | Spacing before/after in pt |

---

## Format: XLSX

Supports: multiple sheets, auto-sized columns, styled header row, per-column number formats.

```
runtime_generateArtifact(generator="xlsx", filename="data.xlsx", input={
  "sheets": [
    {
      "name": "Sales Data",
      "data": [
        ["Product","Units","Revenue","Margin"],
        ["Widget A",1250,62500,0.32],
        ["Widget B",890,44500,0.28],
        ["Widget C",2100,105000,0.41]
      ],
      "formats": ["", "#,##0", "$#,##0.00", "0%"]
    },
    {
      "name": "Summary",
      "data": [
        ["Metric","Value"],
        ["Total Units",4240],
        ["Total Revenue",212000],
        ["Avg Margin","0.337"]
      ],
      "colWidths": [20, 15]
    }
  ]
})
```

**XLSX Sheet Properties:**

| Property | Type | Notes |
|---|---|---|
| `name` | string | Tab name (max 31 chars) |
| `data` | string[][] | Rows of cells — first row = header (bold+gray) |
| `colWidths` | number[] | Per-column width in characters (auto-calculated if omitted) |
| `formats` | string[] | Per-column number format: `"$#,##0.00"`, `"0%"`, `"YYYY-MM-DD"`, `"#,##0"` |
| `options.header` | boolean | Set `false` to skip header row styling |

---

## Format: PPTX

Supports: title slide with subtitle, content slides with text + bullets + table, speaker notes, per-slide background color.

```
runtime_generateArtifact(generator="pptx", filename="deck.pptx", input={
  "title": "Q4 Performance Review",
  "subtitle": "Finance Team — January 2026",
  "background": "#1E3A5F",
  "fontSize": 18,
  "slides": [
    {
      "title": "Revenue Overview",
      "text": "Q4 exceeded all targets by 12%.",
      "bullets": [
        "Total revenue: $3.3M",
        {"text":"Record Q4 performance","bold":true},
        "14 new enterprise contracts"
      ],
      "notes": "Emphasize the YoY comparison here."
    },
    {
      "title": "Regional Breakdown",
      "table": [
        ["Region","Q3","Q4","Growth"],
        ["North","$1.2M","$1.5M","+25%"],
        ["South","$0.9M","$1.1M","+22%"],
        ["West","$1.4M","$1.7M","+21%"]
      ]
    },
    {
      "title": "Next Steps",
      "bullets": [
        {"text":"Expand North sales team","bold":true},
        "Launch West Coast campaign",
        "Review Southern pricing model"
      ],
      "background": "#F0F4F8"
    }
  ]
})
```

**PPTX Slide Properties:**

| Property | Type | Notes |
|---|---|---|
| `title` | string | Slide heading |
| `text` | string | Body paragraph below title |
| `bullets` | string[] or {text,bold?,color?,level?}[] | Bullet list (proper PPTX bullets, not faked) |
| `table` | string[][] | Data table (first row = styled header) |
| `notes` | string | Speaker notes |
| `background` | string | Hex fill e.g. `"#FFFFFF"` |
| `color` | string | Default text color for slide |
| `titleColor` | string | Title text color |
| `fontSize` | number | Override font size |

---

## Format: HTML

Pass any HTML body content. Wraps in full HTML5 template with `<title>` and optional CSS.

```
runtime_generateArtifact(generator="html", filename="report.html", input={
  "title": "Environmental Report",
  "type": "html",
  "css": "body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:24px} table{border-collapse:collapse;width:100%} th,td{border:1px solid #ddd;padding:8px;text-align:left} th{background:#f0f0f0}",
  "html": "<h1>Environmental Observability Report</h1><p>Report Date: April 30, 2026</p><table><tr><th>Metric</th><th>Value</th></tr><tr><td>AQI</td><td>87</td></tr><tr><td>PM2.5</td><td>87 µg/m³</td></tr><tr><td>Humidity</td><td>44%</td></tr></table>"
})
```

**HTML Properties:**

| Property | Type | Notes |
|---|---|---|
| `html` | string | Body content (or SVG inner content, or raw text) |
| `title` | string | `<title>` tag value |
| `css` | string | Injected in `<style>` block in `<head>` |
| `type` | string | `"html"` (default), `"svg"`, `"text"` |
| `width` / `height` | number | SVG dimensions |
| `viewBox` | string | SVG viewBox e.g. `"0 0 800 600"` |

---

## Format: ZIP

Bundle multiple files (text or binary) into a single ZIP download.

```
runtime_generateArtifact(generator="zip", filename="bundle.zip", input={
  "files": [
    {"path":"README.md","content":"# Project\n\nSee data/ for exports.","encoding":"utf8"},
    {"path":"data/report.csv","content":"Name,Score\nAlice,95\nBob,87","encoding":"utf8"},
    {"path":"assets/logo.png","content":"<base64-encoded-png-bytes>","encoding":"base64"}
  ]
})
```

**ZIP File Entry Properties:**

| Property | Type | Notes |
|---|---|---|
| `path` | string | File path inside ZIP (use `/` separators, no `..`) |
| `content` | string | File content |
| `encoding` | string | `"utf8"` (default) or `"base64"` for binary files |

---

## Decision Tree

```
User wants a downloadable file?
├─ PDF, DOCX, XLSX, PPTX, HTML, ZIP → runtime_generateArtifact with correct generator
│   └─ Design content structure as sections/children JSON (not JavaScript)
│   └─ Use structured types: heading, paragraph, table, bulletList, numberedList
└─ Custom format or unsupported → runtime_generateFile with a .cjs Node.js script
    └─ Script MUST end in .cjs
    └─ Script writes base64 to process.stdout
    └─ Available packages: pdfkit, docx, pptxgenjs, xlsx, pdf-lib
```

## Common Mistakes to Avoid

1. **Don't hand-write JavaScript for PDF/DOCX/XLSX/PPTX/HTML/ZIP** — always use `runtime_generateArtifact`.
2. **Don't pass `text` at top level** — always use `input: { sections: [...] }` for DOCX/PDF content.
3. **Don't use `children` at top level** — wrap in `sections: [{children: [...]}]`.
4. **DOCX color** — no `#` prefix: `"FF0000"` not `"#FF0000"`.
5. **PDF color** — include `#` prefix: `"#FF0000"` or use named colors.
6. **Table rows must be string[][]** — nested arrays of strings, not objects.
7. **PPTX bullets** — use the `bullets` array, not separate `text` fields, for proper PPTX bullet rendering.
8. **XLSX formats** — `formats` array is indexed by column (col 0 = first format string).
