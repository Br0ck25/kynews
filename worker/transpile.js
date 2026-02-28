const fs = require('fs');
const ts = require('typescript');
const s = fs.readFileSync('src/index.ts', 'utf8');
const out = ts.transpileModule(s, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020}}).outputText;
fs.writeFileSync('tmp.js', out);
console.log('transpiled size', out.length);
