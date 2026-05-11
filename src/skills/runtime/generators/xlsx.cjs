const XLSX = require('xlsx');
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
    
    const { sheets = [] } = data || {};
    
    const workbook = XLSX.utils.book_new();
    
    sheets.forEach(sheet => {
      const { name = 'Sheet', data: rows = [], options = { header: true } } = sheet || {};
      const worksheet = XLSX.utils.aoa_to_sheet(rows);
      
      if (options.header) {
        worksheet['!cols'] = [
          { wch: 10 },
        ];
      }
      
      XLSX.utils.book_append_sheet(workbook, worksheet, name);
    });
    
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const base64 = buffer.toString('base64');
    console.log(base64);
    
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
};

// Auto-execute when run as a script
if (require.main === module) {
  const inputFile = process.argv[2];
  run({ input: inputFile });
}

module.exports = run;