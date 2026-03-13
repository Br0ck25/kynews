const fs = require('fs');
const esbuild = require('esbuild');

const src = fs.readFileSync('src/index.ts', 'utf8');
const modified = src.replace('export { worker as default };', 'export default worker;');

try {
  esbuild.transformSync(modified, { loader: 'ts' });
  console.log('parse ok with export default');
} catch (e) {
  console.error('parse failed:', e.message);
}
