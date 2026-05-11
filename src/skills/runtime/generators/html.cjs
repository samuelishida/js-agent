'use strict';
const fs = require('fs');

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

    const { html = '', title = 'Generated Artifact', type = 'html', css = '', width, height } = data || {};

    if (!html && type !== 'text') {
      process.stderr.write(`Error: Missing html field in input\n`);
      process.exit(1);
    }

    let content;
    if (type === 'html' || type === 'htm') {
      const styleBlock = css ? `\n  <style>\n${css}\n  </style>` : '';
      content = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${String(title).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</title>${styleBlock}
</head>
<body>
${html}
</body>
</html>`;
    } else if (type === 'svg') {
      const wAttr = width ? ` width="${width}"` : '';
      const hAttr = height ? ` height="${height}"` : '';
      content = `<svg xmlns="http://www.w3.org/2000/svg"${wAttr}${hAttr} viewBox="${data.viewBox || `0 0 ${width || 800} ${height || 600}`}">\n${html}\n</svg>`;
    } else {
      // text / raw passthrough
      content = html;
    }

    console.log(Buffer.from(content, 'utf8').toString('base64'));
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
};

if (require.main === module) {
  run({ input: process.argv[2] });
}

module.exports = run;
