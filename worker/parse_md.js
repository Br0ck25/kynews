const fs = require('fs');
const md = fs.readFileSync('../Kentucky_Counties_and_Cities.md','utf-8');
const lines = md.split('\n');
let map={};let currentCounty=null;
// track seen city names to detect duplicates (partial counties, etc.)
const seenCities = new Set();

for(let line of lines){
  const m=line.match(/^\*\*([^:]+?)\s+County:\*\*/);
  if(m){
    currentCounty=m[1].trim();
    // also capture any cities listed after the header on the same line
    const rest=line.split(':**')[1] || '';
    const parts=rest.split(',').map(s=>s.trim()).filter(Boolean);
    for(let city of parts){
      city = city.replace(/\.$/, "");
      // remove any parenthetical notes such as "(Consolidated City-County)"
      city = city.replace(/\s*\(.*?\)/g, '');
      // strip markdown asterisks left over from formatting
      city = city.replace(/\*/g, '');
      city = city.trim();
      {
        const key = city.toLowerCase();
        if (seenCities.has(key)) {
          delete map[key];
        } else {
          map[key] = currentCounty;
          seenCities.add(key);
        }
      }
    }
    continue;
  }
  if(currentCounty){
    line=line.replace(/^\*\*/,'').replace(/\*\*/,'');
    const parts=line.split(',').map(s=>s.trim()).filter(Boolean);
    for(let city of parts){
      city = city.replace(/\.$/, "");
      city = city.replace(/\s*\(.*?\)/g, '');
      city = city.replace(/\*/g, '');
      city = city.trim();
      {
        const key = city.toLowerCase();
        if (seenCities.has(key)) {
          delete map[key];
        } else {
          map[key] = currentCounty;
          seenCities.add(key);
        }
      }
    }
  }
}
console.log(JSON.stringify(map,null,2));
