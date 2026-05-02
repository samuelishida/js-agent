#!/usr/bin/env node
/**
 * Extract form field information from a fillable PDF.
 * Pure JavaScript replacement for extract_form_field_info.py
 *
 * Usage: node extract_form_field_info.js <input.pdf> [output.json]
 */

import { PDFDocument } from 'pdf-lib';
import { readFileSync, writeFileSync } from 'fs';

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node extract_form_field_info.js <input.pdf> [output.json]');
  process.exit(1);
}

const pdfPath = args[0];
const outputPath = args[1] || null;

function getFieldId(field) {
  const parts = [];
  let current = field;
  while (current) {
    const name = current.getInheritedProperty?.('T') || current.T || current.get?.('/T');
    if (name) parts.unshift(name);
    current = current.getParent?.() || current.Parent || current.get?.('/Parent');
  }
  return parts.join('.') || null;
}

function makeFieldDict(field, fieldId) {
  const type = field.constructor.name;
  const fieldDict = { field_id: fieldId };

  const fieldType = field.fieldType?.() || field.getFieldType?.() || type;

  if (fieldType === 'Tx' || type === 'PDFTextField' || type === 'PDFTextInput') {
    fieldDict.type = 'text';
  } else if (fieldType === 'Btn' || type === 'PDFButton' || type === 'PDFCheckBox' || type === 'PDFRadioGroup') {
    fieldDict.type = 'checkbox';
    try {
      const checked = field.isChecked?.() || field.getIsChecked?.();
      if (checked !== undefined) {
        fieldDict.checked_value = checked ? 'Yes' : '/Off';
        fieldDict.unchecked_value = '/Off';
      }
    } catch (_) {}
  } else if (fieldType === 'Ch' || type === 'PDFDropdown' || type === 'PDFOptionList') {
    fieldDict.type = 'choice';
    try {
      const options = field.getOptions?.() || [];
      fieldDict.choice_options = options.map((opt, i) => ({
        value: String(i),
        text: typeof opt === 'string' ? opt : (opt.displayValue || String(opt)),
      }));
    } catch (_) {}
  } else {
    fieldDict.type = `unknown (${fieldType || type})`;
  }

  return fieldDict;
}

async function extractFieldInfo() {
  try {
    const pdfBytes = readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

    const form = pdfDoc.getForm();
    const fields = form.getFields();

    const fieldInfo = [];

    for (const field of fields) {
      const id = getFieldId(field);
      if (id) {
        const info = makeFieldDict(field, id);

        try {
          const rect = field.getBoundingBox?.() || field.rect;
          if (rect) {
            info.rect = [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
          }
        } catch (_) {}

        try {
          const page = field.acroField.dict.get('P');
          if (page) {
            const pages = pdfDoc.getPages();
            const pageIndex = pages.indexOf(page);
            if (pageIndex >= 0) info.page = pageIndex + 1;
          }
        } catch (_) {}

        fieldInfo.push(info);
      }
    }

    const result = JSON.stringify({ fields: fieldInfo }, null, 2);

    if (outputPath) {
      writeFileSync(outputPath, result, 'utf8');
      console.log(`Wrote field info to ${outputPath}`);
    } else {
      console.log(result);
    }
  } catch (/** @type {any} */ err) {
    console.error(`Error extracting field info: ${err.message}`);
    process.exit(1);
  }
}

extractFieldInfo();
