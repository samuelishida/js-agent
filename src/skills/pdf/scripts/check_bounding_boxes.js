#!/usr/bin/env node
/**
 * Check if bounding boxes in a fields JSON overlap.
 * Pure JavaScript replacement for check_bounding_boxes.py
 *
 * Usage: node check_bounding_boxes.js <fields.json>
 *
 * Output: List of overlapping bounding boxes with failure messages.
 */

import { readFileSync } from 'fs';

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node check_bounding_boxes.js <fields.json>');
  process.exit(1);
}

const fieldsJsonPath = args[0];

function rectsIntersect(r1, r2) {
  const disjointHorizontal = r1[0] >= r2[2] || r1[2] <= r2[0];
  const disjointVertical = r1[1] >= r2[3] || r1[3] <= r2[1];
  return !(disjointHorizontal || disjointVertical);
}

function checkBoundingBoxes(fieldsJson) {
  const data = JSON.parse(fieldsJson);
  const fields = data.form_fields || data.fields || [];

  console.error(`Read ${fields.length} fields`);

  const rectsAndFields = [];
  for (const f of fields) {
    if (f.label_bounding_box) {
      rectsAndFields.push({ rect: f.label_bounding_box, rectType: 'label', field: f });
    }
    if (f.entry_bounding_box) {
      rectsAndFields.push({ rect: f.entry_bounding_box, rectType: 'entry', field: f });
    }
  }

  let hasError = false;
  const messages = [];

  for (let i = 0; i < rectsAndFields.length; i++) {
    const ri = rectsAndFields[i];
    for (let j = i + 1; j < rectsAndFields.length; j++) {
      const rj = rectsAndFields[j];

      if (ri.field.page_number === rj.field.page_number && rectsIntersect(ri.rect, rj.rect)) {
        hasError = true;
        const isSame = ri.field === rj.field;

        if (isSame) {
          messages.push(`FAILURE: intersection between label and entry bounding boxes for \`${ri.field.description}\` (${JSON.stringify(ri.rect)}, ${JSON.stringify(rj.rect)})`);
        } else {
          messages.push(`FAILURE: intersection between ${ri.rectType} bounding box for \`${ri.field.description}\` (${JSON.stringify(ri.rect)}) and ${rj.rectType} bounding box for \`${rj.field.description}\` (${JSON.stringify(rj.rect)})`);
        }

        if (messages.length >= 20) {
          messages.push('Aborting further checks; fix bounding boxes and try again');
          break;
        }
      }
    }

    if (ri.rectType === 'entry' && ri.field.entry_text) {
      const fontSize = ri.field.entry_text.font_size || 14;
      const entryHeight = ri.rect[3] - ri.rect[1];
      if (entryHeight < fontSize) {
        hasError = true;
        messages.push(`FAILURE: entry bounding box for \`${ri.field.description}\` is too short (height ${entryHeight} < font_size ${fontSize})`);
      }
    }

    if (messages.length >= 20) break;
  }

  for (const msg of messages) {
    console.error(msg);
  }

  if (hasError) {
    process.exit(1);
  } else {
    console.log('All bounding boxes are valid (no intersections detected)');
  }
}

try {
  const content = readFileSync(fieldsJsonPath, 'utf8');
  checkBoundingBoxes(content);
} catch (/** @type {any} */ err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
