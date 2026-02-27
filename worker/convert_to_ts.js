const fs = require('fs');
const mapRaw = fs.readFileSync('mapping.json','utf-8');
const map = JSON.parse(mapRaw);
let out = 'export const KY_CITY_TO_COUNTY: Record<string,string> = {\n';
for(const [k,v] of Object.entries(map)){
  out += `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`;
}
out += '};\n';
fs.writeFileSync('mapping.ts', out);
console.log('written mapping.ts with', Object.keys(map).length, 'entries');
