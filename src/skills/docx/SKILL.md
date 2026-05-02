---
name: docx
description: "Use this skill for reading/editing existing Word documents. For creating new docs, use '\''file-generation'\'' skill instead."
license: Proprietary
---

# DOCX Skill (Reading/Editing Existing Files)

For **creating new** Word documents, use the **file-generation** skill.

This skill is for reading and editing existing .docx files.

## Reading Content

```bash
pandoc document.docx -o output.md
```

## Editing Workflow (Pure JavaScript)

### Step 1: Unpack
```bash
node scripts/office/unpack_standalone.js document.docx unpacked/
```

### Step 2: Edit XML
Edit the XML files in `unpacked/` directly using string replacement.

### Step 3: Repack
```bash
node scripts/office/pack_standalone.js unpacked/ output.docx
```

## Standalone Executables

For deployment without Node.js runtime, use the pre-built executables in `dist/`:
- `dist/unpack.exe` - Unpack Office files
- `dist/pack.exe` - Pack directories to Office files

```bash
dist/unpack.exe document.docx unpacked/
dist/pack.exe unpacked/ output.docx
```
