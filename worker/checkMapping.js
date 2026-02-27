const fs=require('fs');
const path=require('path');
const md=fs.readFileSync(path.join('..','Kentucky_Counties_and_Cities.md'),'utf8');
const lines=md.split(/\r?\n/);
const counties={};
for(const line of lines){
  const m=line.match(/^\*\*(.+?) County:\*\* (.+)$/);
  if(m){
    const cnt=m[1];
    const cities=m[2].split(/,\s*/).map(s=>s.toLowerCase().trim());
    counties[cnt.toLowerCase()]=cities;
  }
}
// manually parse the TS file to avoid requiring it
const geoText=fs.readFileSync('./src/data/ky-geo.ts','utf8');
const map={};
const objMatch=geoText.match(/export const KY_CITY_TO_COUNTY:[^{]+\{([\s\S]+?)\}\s*;/);
if(objMatch){
  const body=objMatch[1];
  const entryRegex=/"([^\"]+)":\s*"([^\"]+)"/g;
  let m;
  while((m=entryRegex.exec(body))){
    map[m[1]]=m[2];
  }
}
const missing=[];
for(const [county,cities] of Object.entries(counties)){
  for(const city of cities){
    if(!map[city]){
      missing.push({county,city});
    }
  }
}
// ensure we don't accidentally have a city named after a county
if(map['woodford']){
  console.log('Unexpected "woodford" key found in map');
}
if(missing.length){
  console.log('Missing entries count',missing.length);
  console.log(JSON.stringify(missing.slice(0,20),null,2));
} else {
  console.log('No missing entries; all markdown cities present in ky-geo.');
}
