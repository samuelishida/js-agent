---
name: pdf
description: "Use this skill for reading/processing existing PDF files. For generating new PDFs, use 'file-generation' skill instead."
license: Proprietary
---

# PDF Skill (Reading/Processing Existing Files)

For **creating new** PDF files, use the **file-generation** skill.

This skill is for reading and processing existing PDF files.

## Required Dependencies

```bash
npm install pdf-lib pdfjs-dist canvas
```

**Note:** Full PDF-to-image conversion also works via LibreOffice:
```bash
libreoffice --headless --convert-to png file.pdf --outdir output/
```

---

## Checking Fillable Fields

```bash
node src/skills/pdf/scripts/check_fillable_fields.js input.pdf
# → "This PDF has fillable form fields"
# → or "This PDF does not have fillable form fields..."
```

## Extracting Form Field Info

```bash
node src/skills/pdf/scripts/extract_form_field_info.js input.pdf [output.json]
```

Returns JSON with field IDs, types, and coordinates:
```json
[
  { "field_id": "name", "type": "text", "page": 1 },
  { "field_id": "agree", "type": "checkbox", "checked_value": "Yes", "unchecked_value": "/Off", "page": 1 }
]
```

## Filling Form Fields

```bash
node src/skills/pdf/scripts/fill_fillable_fields.js input.pdf fields.json output.pdf
```

`fields.json` format:
```json
[
  { "field_id": "name", "page": 1, "value": "John Doe" },
  { "field_id": "agree", "page": 1, "value": true }
]
```

## Checking Bounding Boxes

```bash
node src/skills/pdf/scripts/check_bounding_boxes.js fields.json
```

Detects overlapping or invalid bounding boxes in field definitions.

## Filling by Annotation (non-fillable PDFs)

```bash
node src/skills/pdf/scripts/fill_pdf_form_with_annotations.js input.pdf fields.json output.pdf
```

Places text at exact coordinates on each page. Requires bounding box data.

## Creating Validation Images

```bash
node src/skills/pdf/scripts/create_validation_image.js <page_num> <fields.json> <input_image> <output_image>
```

**Note:** Requires `canvas` package. Or use LibreOffice to convert PDF to image first:
```bash
libreoffice --headless --convert-to png input.pdf --outdir output/
# Then:
node create_validation_image.js 1 fields.json output/page_1.png validation.png
```

## Converting PDF to Images

```bash
node src/skills/pdf/scripts/convert_pdf_to_images.js input.pdf output_dir [max_dim]
```

**Note:** Requires `pdfjs-dist` and `canvas`. Or use LibreOffice:
```bash
libreoffice --headless --convert-to png input.pdf --outdir output/
```

## JavaScript Reference (pdf-lib)

```javascript
import { PDFDocument } from 'pdf-lib';

// Reading a PDF
const pdfBytes = readFileSync('document.pdf');
const pdfDoc = await PDFDocument.load(pdfBytes);
console.log(`Pages: ${pdfDoc.getPageCount()}`);

// Reading form fields
const form = pdfDoc.getForm();
const fields = form.getFields();

// Filling text fields
const textField = form.getTextField('fieldName');
textField.setText('Hello');

// Filling checkboxes
const checkBox = form.getCheckBox('agreeBox');
checkBox.check();

// Saving
const modifiedPdfBytes = await pdfDoc.save();
writeFileSync('output.pdf', modifiedPdfBytes);
```

For PDF creation, see **file-generation** skill.

---

## Python Scripts (Deprecated — Use JS Equivalents)

The following Python scripts are deprecated. Use the JS equivalents above:

| Python | JavaScript |
|--------|------------|
| `check_fillable_fields.py` | `check_fillable_fields.js` |
| `extract_form_field_info.py` | `extract_form_field_info.js` |
| `fill_fillable_fields.py` | `fill_fillable_fields.js` |
| `check_bounding_boxes.py` | `check_bounding_boxes.js` |
| `extract_form_structure.py` | `extract_form_structure.js` |
| `fill_pdf_form_with_annotations.py` | `fill_pdf_form_with_annotations.js` |
| `create_validation_image.py` | `create_validation_image.js` |
| `convert_pdf_to_images.py` | `convert_pdf_to_images.js` |
