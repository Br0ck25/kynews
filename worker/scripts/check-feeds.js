const fs = require('fs').promises;
const path = require('path');

const SOURCE_FILE = path.join(__dirname, '..', 'src', 'data', 'source-seeds.ts');
const TIMEOUT_MS = 15000;
const STALE_DAYS = 90;

function extractUrlsFromSource(fileText) {
  const urls = new Set();
  const lines = fileText.split(/\r?\n/);
  const re = /['\"](https?:\/\/[^'\"\)\s,]+)['\"]/g;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) continue;
    let m;
    while ((m = re.exec(line))) urls.add(m[1]);
  }
  return Array.from(urls);
}

function parseDatesFromText(text) {
  const dates = [];
  const pubRe = /<pubDate>\s*([^<]+)\s*<\/pubDate>/gi;
  const tagRe = /<(?:updated|published)>\s*([^<]+)\s*<\/(?:updated|published)>/gi;
  const isoRe = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
  const jsonRe = /"(?:datePublished|published|pubDate)"\s*:\s*"([^"]+)"/gi;

  let m;
  while ((m = pubRe.exec(text))) dates.push(new Date(m[1]));
  while ((m = tagRe.exec(text))) dates.push(new Date(m[1]));
  while ((m = jsonRe.exec(text))) dates.push(new Date(m[1]));
  while ((m = isoRe.exec(text))) dates.push(new Date(m[0]));

  return dates.filter(d => !Number.isNaN(d.getTime()));
}

async function fetchWithTimeout(url, timeout = TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const text = await res.text();
    clearTimeout(id);
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    clearTimeout(id);
    return { error: String(err) };
  }
}

async function main() {
  const fileText = await fs.readFile(SOURCE_FILE, 'utf8');
  const urls = extractUrlsFromSource(fileText);
  console.log(`Found ${urls.length} unique URLs to check.`);

  const problems = [];

  for (const url of urls) {
    process.stdout.write(`Checking ${url} ... `);
    const res = await fetchWithTimeout(url);
    if (res.error) {
      console.log(`ERROR (${res.error})`);
      problems.push({ url, reason: `fetch error: ${res.error}` });
      continue;
    }

    if (!res.ok) {
      console.log(`HTTP ${res.status}`);
      problems.push({ url, reason: `http ${res.status}` });
      continue;
    }

    const text = res.text || '';
    const hasItems = /<item\b|<entry\b|"articles"|"item"/i.test(text);
    const dates = parseDatesFromText(text);
    const newest = dates.length ? new Date(Math.max(...dates.map(d=>d.getTime()))) : null;

    if (!hasItems) {
      console.log('NO ITEMS');
      problems.push({ url, reason: 'no items found' });
      continue;
    }

    if (!newest) {
      console.log('ITEMS but NO DATES');
      problems.push({ url, reason: 'items but no dates found' });
      continue;
    }

    const ageDays = Math.round((Date.now() - newest.getTime()) / (1000*60*60*24));
    if (ageDays > STALE_DAYS) {
      console.log(`STALE (${ageDays} days since newest)`);
      problems.push({ url, reason: `stale: ${ageDays} days since newest`, newest: newest.toISOString() });
      continue;
    }

    console.log(`OK (newest ${newest.toISOString()}, ${ageDays}d)`);
  }

  console.log('\nSummary:');
  if (problems.length === 0) {
    console.log('All feeds returned items with recent dates.');
    process.exit(0);
  }

  console.log(`${problems.length} problem(s) found:`);
  for (const p of problems) console.log(`- ${p.url} => ${p.reason}${p.newest ? ` (newest ${p.newest})` : ''}`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(2); });
