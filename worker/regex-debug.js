const normalized = ` ${'Laurel and Knox County\'s Commonwealth\'s Attorney'.toLowerCase().replace(/[^a-z0-9\s]/g,' ')} `.replace(/\s+/g,' ');
console.log('norm', normalized);
const { KY_COUNTIES } = require('../src/data/ky-geo');
const escapeRegExp = (v) => v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const countyNamesPattern = KY_COUNTIES.map((c) => escapeRegExp(c.toLowerCase())).join('|');
const enumRegex = new RegExp(`\\b((?:${countyNamesPattern})(?:\\s+(?:${countyNamesPattern}))*` +
      `(?:\\s*(?:and|or|&)\\s*(?:${countyNamesPattern}))*)\\s+(?:county|cnty|co\\b)`,
    'gi');
console.log('regex', enumRegex);
let m;
while ((m = enumRegex.exec(normalized))) {
  console.log('match', m[0], 'group1', m[1]);
}
