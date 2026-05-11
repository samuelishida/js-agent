---
name: file-generation
description: "Generate binary files (PDF, DOCX, XLSX, PPTX, HTML, ZIP) from structured data. Use when user wants a downloadable file output. This is the ONLY skill needed for binary file generation; all common formats are handled here. Triggers: any request for a Word doc, Excel file, PDF, PowerPoint, HTML, or ZIP as output."
license: Proprietary
---

# File Generation Skill

Generate downloadable files using precompiled generators. For known formats, pass structured JSON data; do not write JavaScript.

## Preferred Path

For PDF, DOCX, XLSX, PPTX, HTML, and ZIP, use `runtime_generateArtifact`.

Do not use `runtime_generateFile` for these known formats unless the user explicitly needs custom code that the precompiled generator cannot express. The common failure mode is hand-writing bundled JavaScript with raw newlines, nested template literals, or incorrect `docx`/`pptxgenjs` constructors. Avoid that entire class of errors by using structured input.

## HTML-First Workflow

Prefer designing the content as HTML first, using frontend-design skills for layout, hierarchy, tables, cards, typography, and visual polish. This gives the model a simpler, inspectable representation before final export.

Use this order by default:

1. Build the content and visual structure as clean standalone HTML.
2. If the user wants HTML, call `runtime_generateArtifact(generator="html", ...)`.
3. If the user wants DOCX/PDF/PPTX/XLSX, translate the finalized HTML structure into the target generator's structured JSON only at the end.
4. Use the target generator once for the final file.

Do not hand-write conversion scripts for known formats. The HTML-first step is for planning and structure; the final output should still use `runtime_generateArtifact` for PDF, DOCX, XLSX, PPTX, HTML, or ZIP.

```xml
<tool_call>
{"tool":"runtime_generateArtifact","args":{"generator":"docx","filename":"output.docx","input":{"title":"Document","sections":[{"children":[{"type":"paragraph","text":"Hello"}]}]}}}
</tool_call>
```

## Generator Inputs

### PDF

```xml
<tool_call>
{"tool":"runtime_generateArtifact","args":{"generator":"pdf","filename":"report.pdf","input":{"title":"My Report","text":"Hello World","pages":[{"text":"Page 1 content","fontSize":12}]}}}
</tool_call>
```

### DOCX

Use `heading` as a number from 1 to 6. For tables, pass plain string arrays in `rows`; the generator creates the `TableRow` and `TableCell` objects.

```xml
<tool_call>
{"tool":"runtime_generateArtifact","args":{"generator":"docx","filename":"report.docx","input":{"title":"Report Title","sections":[{"children":[{"type":"heading","text":"Summary","heading":1},{"type":"paragraph","text":"Hello World"},{"type":"table","rows":[["Metric","Value"],["AQI","87"],["Humidity","44%"]]},{"type":"bulletList","items":["Cerrado: 36","Brasil: 17"]}]}]}}}
</tool_call>
```

### XLSX

```xml
<tool_call>
{"tool":"runtime_generateArtifact","args":{"generator":"xlsx","filename":"data.xlsx","input":{"sheets":[{"name":"Sheet1","data":[["Header1","Header2"],["A","B"]]}]}}}
</tool_call>
```

### PPTX

```xml
<tool_call>
{"tool":"runtime_generateArtifact","args":{"generator":"pptx","filename":"presentation.pptx","input":{"title":"My Presentation","slides":[{"title":"Slide 1","text":"Hello","bullets":["Point 1","Point 2"]}]}}}
</tool_call>
```

### HTML

```xml
<tool_call>
{"tool":"runtime_generateArtifact","args":{"generator":"html","filename":"artifact.html","input":{"title":"My Artifact","html":"<h1>Hello World</h1><p>Content here</p>","type":"html"}}}
</tool_call>
```

### ZIP

```xml
<tool_call>
{"tool":"runtime_generateArtifact","args":{"generator":"zip","filename":"bundle.zip","input":{"files":[{"path":"file1.txt","content":"Hello","encoding":"utf8"},{"path":"file2.txt","content":"SGVsbG8=","encoding":"base64"}]}}}
</tool_call>
```

## DOCX Report Pattern

For a structured environmental report like the Yvy example, use one tool call and structured children:

```xml
<tool_call>
{"tool":"runtime_generateArtifact","args":{"generator":"docx","filename":"Yvy_Environmental_Report.docx","input":{"title":"Yvy | Environmental Observability Report","sections":[{"children":[{"type":"paragraph","text":"Date: April 30, 2026 | Source: https://yvy.app.br"},{"type":"heading","text":"Live Fire Data (Foco de Calor)","heading":1},{"type":"bulletList","items":["Total active heat spots: 3,856"]},{"type":"heading","text":"Climate Data - Nova Nazare","heading":1},{"type":"table","rows":[["Metric","Value"],["AQI","87"],["PM2.5","87 ug/m3"],["Humidity","44%"],["Temperature","29C (SC: 30C)"],["Wind","7 km/h NE"]]},{"type":"heading","text":"Heat Spots by Biome (24H - BR)","heading":1},{"type":"table","rows":[["Biome","Heat Spots"],["Cerrado","1,415"],["Mata Atlantica","714"],["Amazonia","210"],["Caatinga","145"],["Pampa","64"],["Pantanal","51"]]},{"type":"heading","text":"Live Alerts (18 Active)","heading":1},{"type":"bulletList","items":["Cerrado: 36","Cerrado: 7","Cerrado: 10","Brasil: 17","Cerrado: 6"]},{"type":"heading","text":"News","heading":1},{"type":"bulletList","items":["Cerrado wildfires increase by 40% in April","NASA FIRMS updates monitoring for Brazil"]}]}]}}}
</tool_call>
```

## Decision Tree

```text
User wants a binary/downloadable file?
YES -> Design the content as HTML first when layout/visual structure matters.
YES -> Is it PDF, DOCX, XLSX, PPTX, HTML, or ZIP?
YES -> Convert the finalized HTML structure into runtime_generateArtifact structured input.
NO  -> Use runtime_generateFile with a custom .cjs script only when needed.
```

## File Extension Rules

For `runtime_generateArtifact`:

- `pdf` -> `.pdf`
- `docx` -> `.docx`
- `xlsx` -> `.xlsx`
- `pptx` -> `.pptx`
- `html` -> `.html`, `.htm`, `.svg`, or `.txt`
- `zip` -> `.zip`
- Always pass `filename="output.ext"` to set the download name.

For `runtime_generateFile`:

- Script file must use `.cjs` extension.
- Script path should be like `agent-sandbox/gen.cjs`.
- Script must write base64 to stdout via `process.stdout.write(base64)`.
- Never embed real newline characters inside quoted JS strings. If a custom script is truly needed, use arrays joined with `\n`, escaped `\\n`, or template literals inside a carefully authored script file.

## Advanced: Custom Generator Scripts

Use `runtime_generateFile` only when you need custom logic or unsupported formats. If the desired output is PDF, DOCX, XLSX, PPTX, HTML, or ZIP, stop and use `runtime_generateArtifact`.

```xml
<tool_call>
{"tool":"runtime_generateFile","args":{"path":"agent-sandbox/gen.cjs","content":"const PDFDocument = require('pdfkit');\nconst doc = new PDFDocument();\nconst chunks = [];\ndoc.on('data', c => chunks.push(c));\ndoc.on('end', () => process.stdout.write(Buffer.concat(chunks).toString('base64')));\ndoc.text('Hello');\ndoc.end();","filename":"output.pdf"}}
</tool_call>
```

The file lands in Downloads automatically; no follow-up tool call is needed.
