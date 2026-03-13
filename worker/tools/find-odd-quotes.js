const fs = require('fs');

const lines = fs.readFileSync('src/index.ts', 'utf8').split('\n');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  let count = 0;
  for (let j = 0; j < line.length; j++) {
    if (line[j] === "'" && line[j - 1] !== '\\') count++;
  }
  if (count % 2 === 1) {
    console.log('odd quotes', i + 1, line);
  }
}
