const PptxGenJS = require('pptxgenjs');
const fs = require('fs');
const path = require('path');

const run = async (args) => {
  try {
    const inputFile = args.input;

    if (!fs.existsSync(inputFile)) {
      process.stderr.write(`Error: Input file not found: ${inputFile}\n`);
      process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    const { slides = [], title = 'Presentation', fontSize = 24 } = data || {};
    const pptx = new PptxGenJS();

    if (title) {
      const titleSlide = pptx.addSlide();
      titleSlide.addText(title, { x: 1, y: 0.7, w: 8, h: 0.8, fontSize: 36, bold: true });
    }

    slides.forEach(slideData => {
      const slide = pptx.addSlide();
      const slideFontSize = slideData.fontSize || fontSize;

      if (slideData.title) {
        slide.addText(slideData.title, { x: 1, y: 0.5, w: 8, h: 0.5, fontSize: 28, bold: true });
      }

      if (slideData.text) {
        slide.addText(slideData.text, { x: 1, y: slideData.title ? 1.3 : 1, w: 8, h: 1, fontSize: slideFontSize });
      }

      if (Array.isArray(slideData.bullets)) {
        slideData.bullets.forEach((bullet, index) => {
          slide.addText(String(bullet || ''), {
            x: 1,
            y: 2 + (index * 0.45),
            w: 8,
            h: 0.35,
            fontSize: slideFontSize,
            bullet: { type: 'bullet' },
          });
        });
      }
    });

    const tempPath = path.join(process.cwd(), 'agent-sandbox', `temp-pptx-${Date.now()}-${Math.random().toString(16).slice(2)}.pptx`);
    fs.mkdirSync(path.dirname(tempPath), { recursive: true });
    await pptx.writeFile({ fileName: tempPath });

    const buffer = fs.readFileSync(tempPath);
    fs.unlinkSync(tempPath);
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
