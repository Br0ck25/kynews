import { KY_COUNTIES } from './worker/src/data/ky-geo';

// replicate ambiguous county names here (same order as in geo.ts)
const AMBIGUOUS_COUNTY_NAMES = new Set([
  'Green','Ohio','Logan','Lincoln','Monroe','Mason','Warren','Grant','Lee','Todd',
  'Lawrence','Fleming','Boyd','Clay','Hart','Lewis','Allen','Powell','Russell',
  'Spencer','Taylor','Wayne','Webster',
]);

function normalizeForSearch(input) {
  return ` ${input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `.replace(/\s+/g, ' ');
}
function isMatchDisqualifiedByState(normalized, matchIndex, matchLength) {
  // copy definition from geo.ts
  const OUT_OF_STATE_NAMES = [
    'alabama','alaska','arizona','arkansas','california','colorado',
    'connecticut','delaware','florida','georgia','hawaii','idaho',
    'illinois','indiana','iowa','kansas','louisiana','maine',
    'maryland','massachusetts','michigan','minnesota','mississippi',
    'missouri','montana','nebraska','nevada','new hampshire','new jersey',
    'new mexico','new york','north carolina','north dakota','ohio',
    'oklahoma','oregon','pennsylvania','rhode island','south carolina',
    'south dakota','tennessee','texas','utah','vermont','virginia',
    'washington','west virginia','wisconsin','wyoming',
  ];
  const OUT_OF_STATE_WINDOW = 150;
  const start = Math.max(0, matchIndex - OUT_OF_STATE_WINDOW);
  const end = Math.min(normalized.length, matchIndex + matchLength + OUT_OF_STATE_WINDOW);
  const window = normalized.slice(start, end);
  for (const state of OUT_OF_STATE_NAMES) {
    if (window.includes(state)) return true;
  }
  return false;
}

function detectAllCounties(input, rawInput) {
  const normalized = normalizeForSearch(input);
  const globalText = rawInput ? rawInput.toLowerCase() : normalized;
  const hasKentuckyContext = /\bkentucky\b|\bky\b/i.test(globalText);
  console.log('normalized>', normalized, 'kycontext', hasKentuckyContext);
  const matches = [];

  for (const county of KY_COUNTIES) {
    const escaped = county.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\s+(?:county|counties|cnty|co(?=[\\s]|$))\\b`, 'gi');
    let m;
    while ((m = pattern.exec(normalized))) {
      const idx = m.index;
      const disqualified =
        !hasKentuckyContext &&
        isMatchDisqualifiedByState(normalized, idx, m[0].length);
      console.log('county', county, 'match', m[0], 'idx', idx, 'disq', disqualified);
      if (AMBIGUOUS_COUNTY_NAMES.has(county)) {
        console.log(county, 'is ambiguous');
        if (!hasKentuckyContext || disqualified) {
          console.log('  skipping ambiguous');
          continue;
        }
      } else {
        if (disqualified) {
          console.log('  skipping disqualified');
          continue;
        }
      }
      console.log('  pushing', county);
      matches.push({ index: idx, names: [county] });
    }
  }
  console.log('final matches', matches);
  return matches.map((m) => m.names[0]);
}

console.log('result', detectAllCounties('Todd County fair is coming','Todd County fair is coming'));
console.log('result2', detectAllCounties('Harlan, Letcher, and Perry County officials','Harlan, Letcher, and Perry County officials'));
