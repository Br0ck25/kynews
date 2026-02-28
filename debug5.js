// minimal subset of counties for testing
const KY_COUNTIES = ['Knox','Laurel','Clay','Pike','Floyd','Knott','Todd','Harlan','Letcher','Perry'];
const chunk = 'knox laurel clay';
console.log('tokens', chunk.split(/\s+/));
let tokens = chunk.split(/\s+/);
let names = [];
let j = 0;
while (j < tokens.length) {
  let matchedCounty = null;
  for (const county of KY_COUNTIES) {
    const words = county.toLowerCase().split(' ');
    if (
      tokens.slice(j, j + words.length).join(' ') ===
      words.join(' ')
    ) {
      if (
        !matchedCounty ||
        words.length > matchedCounty.split(' ').length
      ) {
        matchedCounty = county;
      }
    }
  }
  if (matchedCounty) {
    names.push(matchedCounty);
    j += matchedCounty.split(' ').length;
  } else {
    j += 1;
  }
}
console.log('names', names);
