// src/skills/runtime/generators/html.cjs
var fs = require("fs");
var path = require("path");
var run = async (args) => {
  try {
    const inputFile = args.input;
    if (!fs.existsSync(inputFile)) {
      process.stderr.write(`Error: Input file not found: ${inputFile}
`);
      process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(inputFile, "utf8"));
    const { html, title = "Generated Artifact", type = "html" } = data || {};
    if (!html) {
      process.stderr.write(`Error: Missing html field in input
`);
      process.exit(1);
    }
    let content = html;
    if (type === "html" || type === "htm") {
      content = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head><body>
${html}
</body></html>`;
    } else if (type === "text") {
      content = html;
    } else if (type === "svg") {
      content = `<svg xmlns="http://www.w3.org/2000/svg">
${html}
</svg>`;
    }
    const buffer = Buffer.from(content, "utf8");
    const base64 = buffer.toString("base64");
    console.log(base64);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}
`);
    process.exit(1);
  }
};
if (require.main === module) {
  const inputFile = process.argv[2];
  run({ input: inputFile });
}
module.exports = run;
