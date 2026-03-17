const fs = require('fs');
const path = 'worker/src/lib/classify.ts';
const text = fs.readFileSync(path, 'utf8');
const lines = text.split(/\r?\n/);
lines.forEach((line, idx) => {
  if (line.includes('isLouisvilleDateline')) {
    console.log('line', idx + 1, JSON.stringify(line));
  }
});
