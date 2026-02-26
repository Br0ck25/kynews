const fs=require('fs');
const path='c:/Users/James/Desktop/Eastern Kentucky News/Kentucky News/worker/test/index.spec.ts';
const lines=fs.readFileSync(path,'utf8').split('\n');
lines.forEach((l,i)=>{if(l.toLowerCase().includes('social preview'))console.log(i+1,l); if(l.includes('ky-test')) console.log('ky-test at',i+1);});
