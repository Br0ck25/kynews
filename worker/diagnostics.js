const ts = require('typescript');
const program = ts.createProgram({
  rootNames: ['src/index.ts'],
  options: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2024,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
  },
});
const diagnostics = ts.getPreEmitDiagnostics(program);
const relevant = diagnostics.filter(d => d.file && d.file.fileName.endsWith('src/index.ts'));
console.log('total diagnostics', diagnostics.length, 'relevant', relevant.length);
for (const d of relevant) {
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
  console.log(`${line+1}:${character+1} - ${ts.flattenDiagnosticMessageText(d.messageText,' ')}`);
}
