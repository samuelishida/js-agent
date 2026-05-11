'use strict';
const {
  AlignmentType, BorderStyle, Document, HeadingLevel, Packer,
  Paragraph, ShadingType, Table, TableBorders, TableCell, TableRow,
  TextRun, WidthType
} = require('docx');
const fs = require('fs');

const HEADING_LEVEL_MAP = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

const ALIGN_MAP = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
  both: AlignmentType.BOTH,
};

function hexColor(c) {
  if (!c) return undefined;
  return String(c).replace('#', '').toUpperCase().padEnd(6, '0').slice(0, 6);
}

function makeTextRun(text, opts = {}) {
  const cfg = {
    text: String(text ?? ''),
    bold: Boolean(opts.bold),
    italics: Boolean(opts.italic || opts.italics),
    strike: Boolean(opts.strikethrough || opts.strike),
    size: Math.round(Number(opts.fontSize || 12) * 2),
  };
  if (opts.underline) cfg.underline = {};
  if (opts.color) cfg.color = hexColor(opts.color);
  return new TextRun(cfg);
}

// Support mixed inline runs: child.runs = [{text, bold, italic, color, ...}]
function inlineRuns(child) {
  if (Array.isArray(child.runs) && child.runs.length) {
    return child.runs.map(r => makeTextRun(r.text || '', { ...child, ...r }));
  }
  return [makeTextRun(child.text || '', child)];
}

function resolveHeading(value) {
  const n = parseInt(String(value || '1'), 10);
  return HEADING_LEVEL_MAP[Math.min(Math.max(n, 1), 6)] || HeadingLevel.HEADING_1;
}

function makeTableNode(rows = [], opts = {}) {
  if (!rows.length) return null;
  const colCount = Math.max(...rows.map(r => (Array.isArray(r) ? r.length : 0)));
  if (!colCount) return null;
  const colWidthDxa = Math.floor(8640 / colCount); // ~6in total

  return new Table({
    width: { size: 8640, type: WidthType.DXA },
    borders: opts.noBorders ? TableBorders.NONE : undefined,
    rows: rows.map((row, ri) => {
      const isHeader = ri === 0 && opts.headerRow !== false;
      const cells = Array.isArray(row) ? row : [];
      return new TableRow({
        tableHeader: isHeader,
        children: Array.from({ length: colCount }, (_, ci) => {
          const cellText = String(cells[ci] ?? '');
          return new TableCell({
            width: { size: colWidthDxa, type: WidthType.DXA },
            shading: isHeader ? { fill: 'E0E0E0', type: ShadingType.CLEAR, color: 'auto' } : undefined,
            children: [new Paragraph({
              children: [makeTextRun(cellText, { bold: isHeader, fontSize: opts.fontSize || 11 })],
            })],
          });
        }),
      });
    }),
  });
}

function buildChildren(sections) {
  const out = [];
  for (const section of (Array.isArray(sections) ? sections : [])) {
    for (const child of (Array.isArray(section.children) ? section.children : [])) {
      const type = String(child.type || 'paragraph');
      const align = ALIGN_MAP[child.align || child.alignment];

      if (type === 'heading') {
        out.push(new Paragraph({
          heading: resolveHeading(child.heading),
          alignment: align,
          children: inlineRuns(child),
        }));

      } else if (type === 'table') {
        const node = makeTableNode(child.rows || [], {
          headerRow: child.headerRow,
          noBorders: child.noBorders,
          fontSize: child.fontSize,
        });
        if (node) out.push(node);

      } else if (type === 'bulletList') {
        for (const item of (Array.isArray(child.items) ? child.items : [])) {
          const itemChild = typeof item === 'string' ? { text: item } : (item || {});
          out.push(new Paragraph({
            bullet: { level: Number(itemChild.level || child.level || 0) },
            children: inlineRuns({ fontSize: child.fontSize || 12, ...itemChild }),
          }));
        }

      } else if (type === 'numberedList') {
        for (let i = 0; i < (Array.isArray(child.items) ? child.items.length : 0); i++) {
          const item = child.items[i];
          const itemChild = typeof item === 'string' ? { text: item } : (item || {});
          out.push(new Paragraph({
            children: [makeTextRun(
              `${i + 1}. ${itemChild.text || ''}`,
              { fontSize: child.fontSize || 12, ...itemChild }
            )],
          }));
        }

      } else if (type === 'horizontalRule') {
        out.push(new Paragraph({
          border: { bottom: { color: 'AAAAAA', space: 1, style: BorderStyle.SINGLE, size: 6 } },
          children: [new TextRun('')],
        }));

      } else if (type === 'pageBreak') {
        out.push(new Paragraph({ pageBreakBefore: true, children: [new TextRun('')] }));

      } else {
        // paragraph (default)
        out.push(new Paragraph({
          alignment: align,
          spacing: child.spacing ? { before: child.spacing * 20, after: child.spacing * 20 } : undefined,
          children: inlineRuns(child),
        }));
      }
    }
  }
  return out;
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
      sections = [],
      title = '',
      margins = { top: 720, right: 720, bottom: 720, left: 720 },
    } = data || {};

    const children = [];

    if (title) {
      children.push(new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        children: [makeTextRun(title, { bold: true, fontSize: 24 })],
      }));
    }

    children.push(...buildChildren(sections));

    if (!children.length) {
      children.push(new Paragraph({ children: [new TextRun('')] }));
    }

    const doc = new Document({
      sections: [{
        properties: { page: { margin: margins } },
        children,
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    console.log(buffer.toString('base64'));
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
};

if (require.main === module) {
  run({ input: process.argv[2] });
}

module.exports = run;
