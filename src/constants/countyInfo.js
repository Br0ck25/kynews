// countyInfo.js
// Parses the raw markdown file containing county details and exposes a lookup map.
// In the browser the markdown is imported as raw text via Vite's ?raw loader.
// In the Jest/node environment we read it from the filesystem.

// import markdown as raw string; jest will map this to file contents
// via jestRawMock.js
// eslint-disable-next-line import/no-unresolved, import/extensions
import rawMarkdown from "../Kentucky_County_Data.md?raw";

let rawData = rawMarkdown;

if (typeof process !== "undefined" && process.env.JEST_WORKER_ID !== undefined) {
  const fs = require("fs");
  const path = require("path");
  rawData = fs.readFileSync(path.resolve(__dirname, "..", "Kentucky_County_Data.md"), "utf8");
}

let _map = null;

function parse() {
  if (_map) return _map;
  _map = {};
  const lines = rawData.split(/\r?\n/);
  let current = null;
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (/^[A-Za-z][A-Za-z '\-]+ County$/.test(trimmed)) {
      current = trimmed;
      _map[current] = {};
      return;
    }
    if (current) {
      const m = line.match(/^\s*([^:]+):\s*(.+)$/);
      if (m) {
        const key = m[1].trim();
        const val = m[2].trim();
        _map[current][key] = val;
      }
    }
  });
  return _map;
}

export function getCountyInfo() {
  return parse();
}
