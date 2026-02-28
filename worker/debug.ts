import { detectCity, detectKentuckyGeo, detectAllCounties } from './src/lib/geo';

// replicate helper for debugging
const normalizeForSearch = (input) =>
  ` ${input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `.replace(/\s+/g, ' ');

const tests = [
  'Morgan was kidnapped from her apartment complex in Bowling Green, Kentucky',
  'A story from Green, Kentucky mentions nothing else.',
  'Residents of Evergreen celebrate',
  "Laurel and Knox County's Commonwealth's Attorney",
  'Harlan, Letcher, and Perry County officials',
];

tests.forEach((t) => {
  console.log('TEXT:', t);
  console.log('  city ->', detectCity(t));
  const norm = normalizeForSearch(t);
  console.log('  normalized ->', norm);
  // show regex matches directly for debugging
  {
    const KY_COUNTIES = require('./src/data/ky-geo').KY_COUNTIES;
    const escapeRegExp = (v) => v.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
    const countyNamesPattern = KY_COUNTIES.map((c) => escapeRegExp(c.toLowerCase())).join('|');
    const enumRegex = new RegExp(
      `\\b((?:${countyNamesPattern})(?:\\s+(?:${countyNamesPattern}))*` +
        `(?:\\s*(?:and|or|&)\\s*(?:${countyNamesPattern}))*)\\s+(?:county|cnty|co\\b)`,
      'gi',
    );
    console.log('  enumRegex ->', enumRegex);
    const matches = [];
    let m;
    while ((m = enumRegex.exec(norm))) {
      matches.push([m[0], m[1]]);
    }
    console.log('  regex matched ->', matches);
  }
  console.log('  all counties ->', detectAllCounties(t, t));
  console.log('  geo ->', detectKentuckyGeo(t));
  console.log('');
});
