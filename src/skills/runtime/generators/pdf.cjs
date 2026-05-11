const PDFDocument = require('pdfkit/js/pdfkit.standalone');
const fs = require('fs');

const run = async (args) => {
  try {
    const inputFile = args.input;

    if (!fs.existsSync(inputFile)) {
      process.stderr.write(`Error: Input file not found: ${inputFile}\n`);
      process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    const { text = '', pages = [], fontSize = 12, title = 'Document', margin = 50 } = data || {};

    const chunks = [];
    const done = new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin, autoFirstPage: true });

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', resolve);
      doc.on('error', reject);

      if (title) {
        doc.fontSize(24).text(title, { align: 'center' }).moveDown();
        doc.fontSize(fontSize);
      }

      if (text) {
        doc.text(text);
      }

      pages.forEach(page => {
        doc.addPage();
        if (page.text) {
          doc.fontSize(page.fontSize || fontSize).text(page.text);
        }
      });

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
