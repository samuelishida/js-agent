const { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } = require('docx');
const fs = require('fs');

const HEADING_BY_LEVEL = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

function runText(text, options = {}) {
  return new TextRun({
    text: String(text ?? ''),
    bold: Boolean(options.bold),
    size: Number(options.fontSize || 12) * 2,
  });
}

function paragraph(text, options = {}) {
  return new Paragraph({
    heading: options.heading,
    bullet: options.bullet ? { level: 0 } : undefined,
    children: [runText(text, options)],
  });
}

function table(rows = []) {
  return new Table({
    rows: rows.map(row => new TableRow({
      children: row.map(cell => new TableCell({
        children: [paragraph(cell)],
      })),
    })),
  });
}

function headingLevel(value) {
  const match = String(value || '1').match(/[1-6]/);
  const level = match ? Number(match[0]) : 1;
  return HEADING_BY_LEVEL[level] || HeadingLevel.HEADING_1;
}

const run = async (args) => {
  try {
    const inputFile = args.input;

    if (!fs.existsSync(inputFile)) {
      process.stderr.write(`Error: Input file not found: ${inputFile}\n`);
      process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    const { sections = [], title = 'Document', margins = { top: 720, right: 720, bottom: 720, left: 720 } } = data || {};
    const children = [];

    if (title) {
      children.push(paragraph(title, { bold: true, fontSize: 20, heading: HeadingLevel.TITLE }));
    }

    for (const section of Array.isArray(sections) ? sections : []) {
      for (const child of Array.isArray(section.children) ? section.children : []) {
        if (child.type === 'heading') {
          children.push(paragraph(child.text || '', {
            bold: true,
            fontSize: child.fontSize || 16,
            heading: headingLevel(child.heading),
          }));
        } else if (child.type === 'table' && Array.isArray(child.rows)) {
          children.push(table(child.rows));
        } else if (child.type === 'bulletList' && Array.isArray(child.items)) {
          child.items.forEach(item => {
            children.push(paragraph(item || '', {
              bullet: true,
              fontSize: child.fontSize || 12,
            }));
          });
        } else {
          children.push(paragraph(child.text || '', {
            bold: child.bold,
            fontSize: child.fontSize || 12,
          }));
        }
      }
    }

    if (children.length === 0) {
      children.push(paragraph(''));
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
