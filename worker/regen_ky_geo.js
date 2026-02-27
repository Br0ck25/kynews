const fs = require('fs');

// read original ky-geo to get counties array (top part)
const original = fs.readFileSync('src/data/ky-geo.ts','utf-8');
const lines = original.split('\n');
let countiesLines = [];
for(const line of lines){
  countiesLines.push(line);
  if(line.trim().startsWith('] as const')) break;
}

// read mapping.ts content entirely
const mapping = fs.readFileSync('mapping.ts','utf-8');
// mapping contains its own export line etc.

// build new ky-geo content
let output = countiesLines.join('\n') + '\n\n';
output += mapping + '\n';

fs.writeFileSync('src/data/ky-geo.ts', output);
console.log('Rewrote ky-geo.ts with full mapping.');
