#!/usr/bin/env node
/**
 * Fill fillable form fields in a PDF.
 * Pure JavaScript replacement for fill_fillable_fields.py
 *
 * Usage: node fill_fillable_fields.js <input.pdf> <fields.json> <output.pdf>
 *
 * fields.json format:
 * [
 *   { "field_id": "name", "page": 1, "value": "John Doe" },
 *   { "field_id": "agree", "page": 1, "value": true }
 * ]
 */

import { PDFDocument } from 'pdf-lib';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('Usage: node fill_fillable_fields.js <input.pdf> <fields.json> <output.pdf>');
  process.exit(1);
}

const inputPdfPath = args[0];
const fieldsJsonPath = args[1];
const outputPdfPath = args[2];

function validationErrorForFieldValue(fieldInfo, fieldValue) {
  const fieldType = fieldInfo.type;
  const fieldId = fieldInfo.field_id;

  if (fieldType === 'checkbox') {
    const checkedVal = fieldInfo.checked_value;
    const uncheckedVal = fieldInfo.unchecked_value;
    if (fieldValue === true || fieldValue === 'true') {
      if (checkedVal && checkedVal !== '/Off') return null;
      return `ERROR: checkbox field '${fieldId}' cannot be set to true (checked) - no valid checked value found`;
    }
    if (fieldValue === false || fieldValue === 'false' || fieldValue === uncheckedVal) return null;
    return `ERROR: checkbox field '${fieldId}' cannot be set to value '${fieldValue}' (checked=${checkedVal}, unchecked=${uncheckedVal})`;
  }

  if (fieldType === 'text') {
    if (typeof fieldValue !== 'string') {
      return `ERROR: text field '${fieldId}' expects a string value, got ${typeof fieldValue}`;
    }
    if (fieldValue.length > 32767) {
      return `ERROR: text field '${fieldId}' value exceeds max length (${fieldValue.length} > 32767)`;
    }
  }

  if (fieldType === 'choice') {
    if (typeof fieldValue !== 'string') {
      return `ERROR: choice field '${fieldId}' expects a string value, got ${typeof fieldValue}`;
    }
    const options = fieldInfo.choice_options || [];
    const matchingOption = options.find(o => o.text === fieldValue || o.value === fieldValue);
    if (options.length > 0 && !matchingOption) {
      return `ERROR: choice field '${fieldId}' does not have option '${fieldValue}'. Available: ${options.map(o => o.text).join(', ')}`;
    }
  }

  return null;
}

async function fillPdfFields() {
  try {
    if (!existsSync(inputPdfPath)) {
      console.error(`ERROR: ${inputPdfPath} does not exist`);
      process.exit(1);
    }
    if (!existsSync(fieldsJsonPath)) {
      console.error(`ERROR: ${fieldsJsonPath} does not exist`);
      process.exit(1);
    }

    const fields = JSON.parse(readFileSync(fieldsJsonPath, 'utf8'));

    const pdfBytes = readFileSync(inputPdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

    const form = pdfDoc.getForm();
    const allFields = form.getFields();

    const fieldsById = {};
    for (const field of allFields) {
      const id = getFieldId(field);
      if (id) {
        fieldsById[id] = field;
      }
    }

    let hasError = false;
    for (const field of fields) {
      const existingField = fieldsById[field.field_id];
      if (!existingField) {
        hasError = true;
        console.error(`ERROR: '${field.field_id}' is not a valid field ID`);
        continue;
      }

      const fieldPage = getFieldPage(existingField, pdfDoc);
      if (fieldPage !== field.page) {
        hasError = true;
        console.error(`ERROR: Incorrect page number for '${field.field_id}' (got ${field.page}, expected ${fieldPage})`);
        continue;
      }

      if ('value' in field) {
        const fieldInfo = makeFieldInfo(existingField, field.field_id);
        const err = validationErrorForFieldValue(fieldInfo, field.value);
        if (err) {
          console.error(err);
          hasError = true;
        }
      }
    }

    if (hasError) {
      process.exit(1);
    }

    for (const field of fields) {
      if (!('value' in field)) continue;
      const existingField = fieldsById[field.field_id];
      if (!existingField) continue;

      const type = existingField.constructor.name;

      if (type === 'PDFTextField' || type === 'PDFTextInput') {
        existingField.setText(String(field.value));
      } else if (type === 'PDFCheckBox') {
        if (field.value === true || field.value === 'true') {
          existingField.check();
        } else {
          existingField.uncheck();
        }
      } else if (type === 'PDFRadioGroup') {
        existingField.select(field.value);
      } else if (type === 'PDFDropdown' || type === 'PDFOptionList') {
        existingField.select(String(field.value));
      } else {
        try {
          existingField.setText(String(field.value));
        } catch (_) {}
      }
    }

    const modifiedPdfBytes = await pdfDoc.save();
    writeFileSync(outputPdfPath, modifiedPdfBytes);
    console.log(`Filled ${fields.length} field(s) → ${outputPdfPath}`);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

function getFieldId(field) {
  const parts = [];
  let current = field;
  while (current) {
    const t = current.getInheritedProperty?.('T') || current.T || current.get?.('/T');
    if (t) parts.unshift(t);
    current = current.getParent?.() || current.Parent || current.get?.('/Parent');
  }
  return parts.join('.') || null;
}

function getFieldPage(field, pdfDoc) {
  try {
    const pages = pdfDoc.getPages();
    for (let i = 0; i < pages.length; i++) {
      const annots = pages[i].node.get('/Annots');
      if (annots) {
        for (const ref of annots.array) {
          const annot = ref.getObject();
          const parent = annot.get('/Parent');
          if (parent && field.acroField && annot === field.acroField.dict) return i + 1;
        }
      }
    }
  } catch (_) {}
  return 1;
}

function makeFieldInfo(field, fieldId) {
  const info = { field_id: fieldId, type: 'unknown' };
  const type = field.constructor.name;

  if (type === 'PDFTextField' || type === 'PDFTextInput') {
    info.type = 'text';
  } else if (type === 'PDFCheckBox') {
    info.type = 'checkbox';
    info.checked_value = 'Yes';
    info.unchecked_value = '/Off';
  } else if (type === 'PDFRadioGroup') {
    info.type = 'checkbox';
  } else if (type === 'PDFDropdown' || type === 'PDFOptionList') {
    info.type = 'choice';
    try {
      info.choice_options = field.getOptions?.()?.map((opt, i) => ({
        value: String(i),
        text: typeof opt === 'string' ? opt : String(opt),
      })) || [];
    } catch (_) {}
  }

  return info;
}

fillPdfFields();
