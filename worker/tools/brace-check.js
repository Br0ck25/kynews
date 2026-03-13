import fs from 'fs';

const text = fs.readFileSync('src/index.ts', 'utf8');

let depth = 0;
let parenDepth = 0;
let bracketDepth = 0;
let templateExprDepth = 0;
let line = 1;
let inSingle = false;
let inDouble = false;
let inTemplate = false;
let inLineComment = false;
let inBlockComment = false;
let unclosedSingle = null;
let inTemplateAtTarget = false;

const targetLine = 3507;
let depthAtTarget = null;

const depthAtIndex = new Array(text.length).fill(0);
for (let i = 0; i < text.length; i++) {
  const ch = text[i];
  const next = text[i + 1] || '';

  // Save current depth before processing this character
  depthAtIndex[i] = depth;
  if (line === targetLine && depthAtTarget === null) {
    depthAtTarget = depth;
  }

  if (ch === '\n') {
    line++;
    inLineComment = false;
  }

  if (inLineComment) {
    continue;
  }

  if (inBlockComment) {
    if (ch === '*' && next === '/') {
      inBlockComment = false;
      i++;
    }
    continue;
  }

  if (!inSingle && !inDouble && !inTemplate) {
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
  }

  if (!inSingle && !inTemplate && ch === '"') {
    inDouble = true;
    continue;
  }
  if (inDouble && ch === '"' && text[i - 1] !== '\\') {
    inDouble = false;
    continue;
  }

  if (!inDouble && !inTemplate && ch === "'") {
    inSingle = true;
    unclosedSingle = { line, index: i, snippet: text.slice(i, i + 80).split('\n')[0] };
    continue;
  }
  if (inSingle && ch === "'" && text[i - 1] !== '\\') {
    inSingle = false;
    unclosedSingle = null;
    continue;
  }

  if (!inSingle && !inDouble && ch === '`') {
    inTemplate = true;
    templateExprDepth = 0;
    continue;
  }
  if (inTemplate) {
    if (ch === '$' && next === '{') {
      templateExprDepth++;
      i++;
      continue;
    }
    if (ch === '}' && templateExprDepth > 0) {
      templateExprDepth--;
      continue;
    }
    if (ch === '`' && templateExprDepth === 0 && text[i - 1] !== '\\') {
      inTemplate = false;
      continue;
    }
    continue;
  }

  if (inSingle || inDouble) continue;

  if (ch === '{') depth++;
  else if (ch === '}') depth--;
  else if (ch === '(') parenDepth++;
  else if (ch === ')') parenDepth--;
  else if (ch === '[') bracketDepth++;
  else if (ch === ']') bracketDepth--;

  if (line === targetLine && depthAtTarget === null) {
    depthAtTarget = { brace: depth, paren: parenDepth, bracket: bracketDepth, inTemplate };
    inTemplateAtTarget = inTemplate;
  }
}

const exports = [];
const exportRegex = /\bexport\b/g;
let match;
while ((match = exportRegex.exec(text)) !== null) {
  const idx = match.index;
  const line = text.slice(0, idx).split('\n').length;
  exports.push({ line, depth: depthAtIndex[idx], snippet: text.slice(idx, idx + 60).split('\n')[0] });
}

console.log('depth at target line', targetLine, depthAtTarget);
console.log('inTemplate at target line', inTemplateAtTarget);
console.log('final depths', { brace: depth, paren: parenDepth, bracket: bracketDepth, templateExpr: templateExprDepth });
console.log('final state', { inSingle, inDouble, inTemplate, inLineComment, inBlockComment });
if (unclosedSingle) {
  console.log('unclosed single-quote started at', unclosedSingle);
}
console.log('last exports:', exports.slice(-10));
