import { KY_CITY_TO_COUNTY } from './worker/src/data/ky-geo';

function normalizeForSearch(input) {
  return ` ${input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `.replace(/\s+/g, ' ');
}
function buildCityPattern(city) {
  return new RegExp(`\\b${city.toLowerCase()}\\b`, 'i');
}
function overlaps(matchStart, matchEnd, matched) {
  return matched.some((r) => matchStart < r.end && matchEnd > r.start);
}
function isMatchDisqualifiedByState(normalized, matchIndex, matchLength) {
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
function hasLocationSignalNearby(normalizedInput, city) {
  const signals = [' in ', ' at ', ' from ', ' near ', ' city of ', ' county ', ' ky ', ' kentucky '];
  const words = normalizedInput.trim().split(/\s+/);
  const cityWords = city.split(' ');

  for (let i = 0; i < words.length; i += 1) {
    let matches = true;
    for (let j = 0; j < cityWords.length; j += 1) {
      if (words[i + j] !== cityWords[j]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    const start = Math.max(0, i - 5);
    const end = Math.min(words.length, i + cityWords.length + 5);
    const windowText = ` ${words.slice(start, end).join(' ')} `;
    if (signals.some((signal) => windowText.includes(signal))) return true;
  }

  return false;
}
function detectCity(input) {
  const raw = String(input || '');
  const normalized = normalizeForSearch(raw);
  const hasKentuckyContext = /\bkentucky\b|\bky\b/.test(normalized);
  const matchedRanges = [];

  console.log('normalized', normalized, 'hasKY', hasKentuckyContext);

  const cities = Object.keys(KY_CITY_TO_COUNTY).sort((a,b)=>b.length-a.length);
  console.log('loaded city count', cities.length);
  cities.forEach(c => {
    if (c.includes('corb')) console.log('city key contains corb:', JSON.stringify(c));
  });
  for (const city of cities) {
    if (city === 'corbin') console.log('checking corbin');
    if (['corbin','bowling green','green'].includes(city)) console.log('try city',city);
    // skip noise omitted for debug
    const pattern = buildCityPattern(city);
    const allMatches = Array.from(normalized.matchAll(new RegExp(pattern.source,'gi')));
    if(allMatches.length===0) continue;
    console.log('city',city,'allMatches',allMatches.length);
    const nonOverlapping = allMatches.filter((m)=>{
      const start=m.index; const end=start+m[0].length;
      return !overlaps(start,end,matchedRanges);
    });
    if(nonOverlapping.length===0) continue;
    const likelyCount = nonOverlapping.length;
    const cityIndex = nonOverlapping[0].index??-1;
    const hasLocationSignals = hasLocationSignalNearby(normalized, city);
    console.log('log',city,'likelyCount',likelyCount,'hasLoc',hasLocationSignals);
    if (!hasLocationSignals && !hasKentuckyContext && likelyCount < 2) {
      continue;
    }
    if (likelyCount === 1 && false) {
      // skip person name disabled
    }
    if (!hasKentuckyContext) {
      if (cityIndex !== -1 && isMatchDisqualifiedByState(normalized, cityIndex, city.length)) {
        continue;
      }
    }
    matchedRanges.push({ start:nonOverlapping[0].index,end: nonOverlapping[0][0].length + nonOverlapping[0].index});
    return city;
  }
  return null;
}

console.log('detectCity gives', detectCity('Police in Corbin responded to a call'));
