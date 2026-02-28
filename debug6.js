// replicate enumeration regex from geo.ts to inspect behavior
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// minimal subset of counties
const KY_COUNTIES = ['Knox','Laurel','Clay'];
const countyAlt = KY_COUNTIES.map((c) => `(?:\\b${escapeRegExp(c.toLowerCase())}\\b)`).join('|');
const enumRegex = new RegExp(
  `((?:${countyAlt})(?:\\s+(?:${countyAlt}))*` +
    `(?:\\s*(?:,|/|-|and|or|&)\\s*(?:${countyAlt}))*` +
    `)\\s+(?:county|counties|cnty|co\\b)`,
  'gi',
);
console.log('regex', enumRegex);

const texts = [
  'knox laurel clay county',
  'knox laurel county',
  'knox/ laurel / clay county',
];
for(const t of texts){
  const m = enumRegex.exec(t);
  console.log('text', t, 'match', m && m[1]);
}
