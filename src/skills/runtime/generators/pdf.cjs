'use strict';
const PDFDocument = require('pdfkit/js/pdfkit.standalone');
const fs = require('fs');

const HEADING_SIZES = [22, 18, 15, 13, 12, 11];

function resolveAlign(align) {
  const a = String(align || '').toLowerCase();
  if (a === 'center') return 'center';
  if (a === 'right') return 'right';
  if (a === 'justify') return 'justify';
  return 'left';
}

function parseColor(color, fallback = 'black') {
  if (!color) return fallback;
  const s = String(color).trim();
  return s.startsWith('#') ? s : s;
}

function drawHR(doc, margin, pageWidth, color) {
  const y = doc.y + 4;
  doc.save()
    .moveTo(margin, y)
    .lineTo(margin + pageWidth, y)
    .lineWidth(0.5)
    .strokeColor(color || '#AAAAAA')
    .stroke()
    .restore();
  doc.moveDown(0.5);
}

function drawTable(doc, rows, margin, pageWidth, baseFontSize) {
  if (!rows.length) return;
  const colCount = Math.max(...rows.map(r => (Array.isArray(r) ? r.length : 0)));
  if (!colCount) return;
  const colWidth = pageWidth / colCount;
  const cellPad = 4;
  const lineH = (baseFontSize || 11) + cellPad * 2 + 2;

  for (let ri = 0; ri < rows.length; ri++) {
    const row = Array.isArray(rows[ri]) ? rows[ri] : [];
    if (doc.y + lineH > doc.page.height - (doc.page.margins?.bottom || 50)) {
      doc.addPage();
    }
    const rowY = doc.y;
    const isHeader = ri === 0;

    if (isHeader) {
      doc.save().rect(margin, rowY, pageWidth, lineH).fill('#E0E0E0').restore();
    }

    for (let ci = 0; ci < colCount; ci++) {
      const cx = margin + ci * colWidth;
      doc.save().rect(cx, rowY, colWidth, lineH).stroke('#CCCCCC').restore();
      doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(baseFontSize || 11)
        .fillColor('black')
        .text(String(row[ci] ?? ''), cx + cellPad, rowY + cellPad, {
          width: colWidth - cellPad * 2,
          lineBreak: false,
          ellipsis: true,
        });
    }
    doc.y = rowY + lineH;
  }
  doc.moveDown(0.3);
}

function renderChild(doc, child, margin, pageWidth) {
  const type = String(child.type || 'paragraph');
  const fontSize = Number(child.fontSize || 11);
  const align = resolveAlign(child.align || child.alignment);
  const color = parseColor(child.color, 'black');
  const font = (child.bold || type === 'heading')
    ? (child.italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold')
    : (child.italic ? 'Helvetica-Oblique' : 'Helvetica');

  if (type === 'heading') {
    const level = Math.min(Math.max(parseInt(String(child.heading || 1), 10), 1), 6);
    const hSize = HEADING_SIZES[level - 1];
    if (doc.y + hSize + 8 > doc.page.height - (doc.page.margins?.bottom || 50)) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(hSize).fillColor(color || 'black')
      .text(child.text || '', { align, continued: false }).moveDown(0.25);

  } else if (type === 'table') {
    drawTable(doc, child.rows || [], margin, pageWidth, fontSize);

  } else if (type === 'bulletList') {
    const items = Array.isArray(child.items) ? child.items : [];
    for (const item of items) {
      const itemText = typeof item === 'string' ? item : (item?.text || '');
      const itemColor = (typeof item === 'object' && item?.color) ? parseColor(item.color) : color;
      const itemFont = (typeof item === 'object' && item?.bold) ? 'Helvetica-Bold' : 'Helvetica';
      doc.font(itemFont).fontSize(fontSize).fillColor(itemColor)
        .text(`•  ${itemText}`, { indent: 16, align: 'left', continued: false }).moveDown(0.1);
    }
    doc.moveDown(0.2);

  } else if (type === 'numberedList') {
    const items = Array.isArray(child.items) ? child.items : [];
    items.forEach((item, i) => {
      const itemText = typeof item === 'string' ? item : (item?.text || '');
      doc.font('Helvetica').fontSize(fontSize).fillColor(color)
        .text(`${i + 1}.  ${itemText}`, { indent: 16, align: 'left', continued: false }).moveDown(0.1);
    });
    doc.moveDown(0.2);

  } else if (type === 'horizontalRule') {
    drawHR(doc, margin, pageWidth, child.color);

  } else if (type === 'pageBreak') {
    doc.addPage();

  } else {
    // paragraph
    const spacing = Number(child.spacing || 0);
    if (spacing) doc.moveDown(spacing / 10);
    doc.font(font).fontSize(fontSize).fillColor(color)
      .text(child.text || '', { align, continued: false }).moveDown(0.25);
    if (spacing) doc.moveDown(spacing / 10);
  }
}

const run = async (args) => {
  try {
    const inputFile = args.input;
    if (!fs.existsSync(inputFile)) {
      process.stderr.write(`Error: Input file not found: ${inputFile}\n`);
      process.exit(1);
    }

    let data;
    try {
      data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    } catch (e) {
      process.stderr.write(`Error: Invalid JSON in input file: ${e.message}\n`);
      process.exit(1);
    }

    const {
      title = '',
      sections = [],
      text = '',
      pages = [],
      fontSize: baseFontSize = 11,
      margin = 50,
      landscape = false,
    } = data || {};

    const chunks = [];
    const done = new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        margin,
        autoFirstPage: true,
        layout: landscape ? 'landscape' : 'portrait',
      });
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', resolve);
      doc.on('error', reject);

      const pageWidth = doc.page.width - margin * 2;

      if (title) {
        doc.font('Helvetica-Bold').fontSize(24).fillColor('black')
          .text(title, { align: 'center' }).moveDown(0.3);
        doc.save()
          .moveTo(margin, doc.y).lineTo(doc.page.width - margin, doc.y)
          .lineWidth(0.5).strokeColor('#999999').stroke()
          .restore()
          .moveDown(0.5);
      }

      for (const section of (Array.isArray(sections) ? sections : [])) {
        for (const child of (Array.isArray(section.children) ? section.children : [])) {
          renderChild(doc, child, margin, pageWidth);
        }
      }

      // Simple text fallback (no sections)
      if (!sections.length && text) {
        doc.font('Helvetica').fontSize(baseFontSize).fillColor('black').text(String(text));
      }

      // Legacy append-pages mode
      for (const page of (Array.isArray(pages) ? pages : [])) {
        doc.addPage();
        if (page.title) {
          doc.font('Helvetica-Bold').fontSize(16).text(page.title).moveDown();
        }
        if (page.text) {
          doc.font('Helvetica').fontSize(page.fontSize || baseFontSize).text(page.text);
        }
      }

      doc.end();
    });

    await done;
    console.log(Buffer.concat(chunks).toString('base64'));
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
};

if (require.main === module) {
  run({ input: process.argv[2] });
}

module.exports = run;
