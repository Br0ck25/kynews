// jestRawMock.js
// returns the contents of the markdown file for tests
const fs = require('fs');
const path = require('path');
// tests run from workspace root, but the markdown file lives in src
const data = fs.readFileSync(path.resolve(__dirname, 'src', 'Kentucky_County_Data.md'), 'utf8');
module.exports = data;
