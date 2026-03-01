require('ts-node').register({ project: './worker/tsconfig.json' });
const { detectAllCounties } = require('./worker/src/lib/geo');

try {
  const result = detectAllCounties('North Laurel breezed by Clay County, 66-41', 'North Laurel breezed by Clay County, 66-41');
  console.log('result', result);
} catch (err) {
  console.error('caught error', err);
}