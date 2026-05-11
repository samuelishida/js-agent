'use strict';
const PptxGenJS = require('pptxgenjs');
const fs = require('fs');
const path = require('path');

const SLIDE_W = 10;
const SLIDE_H = 5.63;

function hex(color) {
  if (!color) return undefined;
  return String(color).replace('#', '');
}

function buildTitleSlide(pptx, title, subtitle, background) {
  const slide = pptx.addSlide();
  if (background) slide.background = { fill: hex(background) || 'FFFFFF' };
  slide.addText(title, {
    x: 0.5, y: 1.8, w: SLIDE_W - 1, h: 1.2,
    fontSize: 40, bold: true, align: 'center',
    color: hex(subtitle?.color) || '333333',
  });
  if (subtitle) {
    const subText = typeof subtitle === 'string' ? subtitle : subtitle.text || '';
    if (subText) {
      slide.addText(subText, {
        x: 0.5, y: 3.2, w: SLIDE_W - 1, h: 0.6,
        fontSize: 20, align: 'center', color: '666666',
      });
    }
  }
  return slide;
}

function addContentSlide(pptx, slideData, defaultFontSize) {
  const slide = pptx.addSlide();
  if (slideData.background) slide.background = { fill: hex(slideData.background) || 'FFFFFF' };

  const fontSize = Number(slideData.fontSize || defaultFontSize || 18);
  let contentY = 0.5;

  // Title
  if (slideData.title) {
    slide.addText(slideData.title, {
      x: 0.4, y: contentY, w: SLIDE_W - 0.8, h: 0.7,
      fontSize: 28, bold: true, align: 'left',
      color: hex(slideData.titleColor) || '222222',
    });
    contentY += 0.9;
  }

  // Subtitle / text block
  if (slideData.text) {
    slide.addText(slideData.text, {
      x: 0.4, y: contentY, w: SLIDE_W - 0.8, h: 0.7,
      fontSize: fontSize - 2, align: 'left', valign: 'top',
      color: hex(slideData.color) || '444444',
    });
    contentY += 0.85;
  }

  // Bullet list — use pptxgenjs array form for proper bullet rendering
  if (Array.isArray(slideData.bullets) && slideData.bullets.length) {
    const bulletTextArr = slideData.bullets.map(b => {
      const text = typeof b === 'string' ? b : (b?.text || '');
      const level = typeof b === 'object' ? Number(b?.level || 0) : 0;
      return {
        text,
        options: {
          bullet: { type: 'bullet' },
          indentLevel: level,
          fontSize,
          color: (typeof b === 'object' && b?.color) ? hex(b.color) : (hex(slideData.color) || '333333'),
          bold: typeof b === 'object' ? Boolean(b?.bold) : false,
        },
      };
    });
    const bullH = Math.min(slideData.bullets.length * 0.42 + 0.2, SLIDE_H - contentY - 0.3);
    slide.addText(bulletTextArr, {
      x: 0.4, y: contentY, w: SLIDE_W - 0.8, h: bullH,
      fontSize, align: 'left', valign: 'top',
    });
    contentY += bullH;
  }

  // Table
  if (Array.isArray(slideData.table) && slideData.table.length) {
    const tableRows = slideData.table.map((row, ri) =>
      (Array.isArray(row) ? row : []).map(cell => ({
        text: String(cell ?? ''),
        options: {
          bold: ri === 0,
          fill: ri === 0 ? 'D0D0D0' : (ri % 2 === 0 ? 'F5F5F5' : 'FFFFFF'),
          color: '333333',
          fontSize: fontSize - 2,
          align: 'left',
          valign: 'middle',
        },
      }))
    );
    const tableH = Math.min(slideData.table.length * 0.38 + 0.1, SLIDE_H - contentY - 0.2);
    slide.addTable(tableRows, {
      x: 0.4, y: contentY, w: SLIDE_W - 0.8, h: tableH,
      border: { type: 'solid', pt: 1, color: 'CCCCCC' },
    });
  }

  // Notes
  if (slideData.notes) {
    slide.addNotes(String(slideData.notes));
  }

  return slide;
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

    const { slides = [], title = '', subtitle = '', fontSize = 18, background = '' } = data || {};
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';

    if (title) {
      buildTitleSlide(pptx, title, subtitle, background);
    }

    for (const slideData of (Array.isArray(slides) ? slides : [])) {
      addContentSlide(pptx, slideData, fontSize);
    }

    if (!title && !slides.length) {
      const empty = pptx.addSlide();
      empty.addText('(empty presentation)', { x: 1, y: 2, w: 8, h: 1, fontSize: 20, align: 'center' });
    }

    const tempPath = path.join(
      process.cwd(), 'agent-sandbox',
      `temp-pptx-${Date.now()}-${Math.random().toString(16).slice(2)}.pptx`
    );
    fs.mkdirSync(path.dirname(tempPath), { recursive: true });
    await pptx.writeFile({ fileName: tempPath });
    const buffer = fs.readFileSync(tempPath);
    try { fs.unlinkSync(tempPath); } catch {}
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
