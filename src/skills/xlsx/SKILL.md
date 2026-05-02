---
name: xlsx
description: "Use this skill for reading/analyzing existing spreadsheet files. For generating new XLSX files, use 'file-generation' skill instead."
license: Proprietary. LICENSE.txt has complete terms
---

# XLSX Skill (Reading/Analyzing Existing Files)

For **creating new** spreadsheet files, use the **file-generation** skill instead.

This skill is for reading, analyzing, and editing existing .xlsx, .csv, and .tsv files.

## Reading Files

```javascript
import * as XLSX from 'xlsx';

const wb = XLSX.readFile('data.xlsx');
console.log(wb.SheetNames);
```

## Recalculating Formulas

```bash
node src/skills/xlsx/scripts/recalc.js <excel_file> [timeout_seconds]
```

**Limitation:** Full Excel formula recalculation requires LibreOffice. This script detects formula errors but cannot recalculate. For recalculation:

```bash
# Linux/Mac
libreoffice --headless --calc input.xlsx

# Windows
"C:\Program Files\LibreOffice\program\soffice.exe" --headless --calc input.xlsx
```

## Python Scripts (Deprecated — Use JS + LibreOffice)

| Python | JavaScript | Alternative |
|--------|------------|------------|
| `recalc.py` | `recalc.js` | `libreoffice --headless --calc file.xlsx` |

---

For spreadsheet generation, see **file-generation** skill.
