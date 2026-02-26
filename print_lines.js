const fs=require('fs');
const path='c:/Users/James/Desktop/Eastern Kentucky News/Kentucky News/worker/test/index.spec.ts';
const lines=fs.readFileSync(path,'utf8').split('\n');
for(let i=669;i<691;i++){
    console.log(i+1, lines[i]);
}
