const fs = require('fs');
const file = fs.readFileSync('worker/src/data/source-seeds.ts', 'utf8');
function extract(fileText) {
  const urls = new Set();
  const lines = fileText.split(/\r?\n/);
  const re = /['\"](https?:\/\/[^'\"\)\s,]+)['\"]/g;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) continue;
    const effective = line.replace(/\/\/.*$/, '');
    console.log('line', JSON.stringify(line));
    console.log('effective', JSON.stringify(effective));
    let m;
    while ((m = re.exec(effective))) {
      console.log(' match', m[1]);
      urls.add(m[1]);
    }
  }
  return Array.from(urls);
}
console.log('count', extract(file).length);
console.log('first', extract(file)[0]);
