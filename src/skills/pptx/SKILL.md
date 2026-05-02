---
name: pptx
description: "Use this skill for reading/editing existing PowerPoint files. For generating new PPTX files, use '\''file-generation'\'' skill instead."
license: Proprietary. LICENSE.txt has complete terms
---

# PPTX Skill (Reading/Editing Existing Files)

For **creating new** PowerPoint files, use the **file-generation** skill.

This skill is for reading and editing existing .pptx files.

## Reading Content

```javascript
// Use pptxgenjs to read PPTX
const PptxGenJS = require('\''pptxgenjs'\'');
// Note: pptxgenjs is primarily for creation, not parsing existing files.
// For deep parsing, unpack the PPTX and read the XML directly.
```

## Editing Workflow

### Unpack
```bash
node scripts/office/unpack_standalone.js presentation.pptx unpacked/
```

### Edit XML
Edit the XML files in `unpacked/` directly.

### Repack
```bash
node scripts/office/pack_standalone.js unpacked/ output.pptx
```

## Standalone Executables

For deployment without Node.js runtime:
- `dist/unpack.exe` - Unpack Office files
- `dist/pack.exe` - Pack directories to Office files
