#!/usr/bin/env ts-node
/**
 * Sitemap coverage audit for localkynews.com
 *
 * Fetches sitemap.xml and sitemap-news.xml, queries the D1 database for
 * recently-published articles, reports coverage metrics, and exits with
 * code 1 if sitemap.xml coverage of 30-day articles falls below
 * COVERAGE_THRESHOLD (90%).
 *
 * Usage (from repo root):
 *   npm run audit:sitemap
 *
 * Required environment variables for remote D1 access:
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BASE_URL = 'https://localkynews.com';
const COVERAGE_THRESHOLD = 90;  // exit 1 if sitemap.xml coverage drops below this
const DAYS_WINDOW = 30;          // DB look-back window for audit
const MISSING_SAMPLE = 10;       // max missing articles to print
const SPOT_CHECK_N = 20;         // random live URLs to probe
const FETCH_TIMEOUT_MS = 30_000;

/** Absolute path to worker/ — the directory that contains wrangler.jsonc. */
const WORKER_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function extractLocs(xml: string): string[] {
  const urls: string[] = [];
  const re = /<loc>\s*(https?:\/\/[^\s<]+)\s*<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    urls.push(m[1].trim());
  }
  return urls;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function slugFromUrl(rawUrl: string): string {
  try {
    const segments = new URL(rawUrl).pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? '';
  } catch {
    return '';
  }
}

/** Build article URL from a DB row — must match buildArticleUrl in index.ts. */
function buildArticleUrl(row: ArticleRow): string {
  if (row.is_national) return `${BASE_URL}/news/national/${row.slug}`;
  if (row.county) {
    let c = row.county.trim();
    if (!/county$/i.test(c)) c += ' County';
    const countySlug = c.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `${BASE_URL}/news/kentucky/${countySlug}/${row.slug}`;
  }
  return `${BASE_URL}/news/kentucky/${row.slug}`;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function sampleN<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return [...arr];
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// D1 via wrangler CLI
// ---------------------------------------------------------------------------

interface ArticleRow {
  id: number;
  slug: string;
  county: string | null;
  category: string;
  is_national: number;
  published_at: string;
}

/**
 * Execute a SQL query against the remote D1 database via wrangler.
 * Uses --file to avoid shell-quoting issues on all platforms.
 */
function d1Query(sql: string): ArticleRow[] {
  const tmpFile = path.join(os.tmpdir(), `audit-sitemap-${Date.now()}.sql`);
  try {
    fs.writeFileSync(tmpFile, sql, 'utf8');

    // spawnSync avoids shell interpretation of the command arguments
    const result = spawnSync(
      'npx',
      ['wrangler', 'd1', 'execute', 'ky-news-db', '--remote', `--file=${tmpFile}`, '--json'],
      {
        cwd: WORKER_DIR,
        encoding: 'utf8',
        timeout: 90_000,
        // Windows requires shell: true to resolve npx.cmd
        shell: process.platform === 'win32',
      },
    );

    if (result.error) {
      throw result.error;
    }

    const stdout = result.stdout ?? '';
    if (!stdout.trim()) {
      throw new Error(
        `wrangler returned no output.\nstderr: ${result.stderr ?? '(empty)'}`,
      );
    }

    // Strip any warning/progress lines before the JSON payload
    const firstBracket = stdout.indexOf('[');
    const firstBrace   = stdout.indexOf('{');
    const startIdx = Math.min(
      firstBracket < 0 ? Infinity : firstBracket,
      firstBrace   < 0 ? Infinity : firstBrace,
    );
    if (startIdx === Infinity) {
      throw new Error(
        `No JSON found in wrangler output.\nstdout: ${stdout}\nstderr: ${result.stderr}`,
      );
    }

    // wrangler --json returns: [ { results: [...], success: bool, meta: {...} } ]
    const json = JSON.parse(stdout.slice(startIdx));
    const block = Array.isArray(json) ? json[0] : json;
    return (block?.results ?? []) as ArticleRow[];
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
  }
}

// ---------------------------------------------------------------------------
// HTTP spot-check
// ---------------------------------------------------------------------------

interface CheckResult {
  url: string;
  status: number;
  ok: boolean;
}

async function spotCheck(url: string): Promise<CheckResult> {
  try {
    const res = await timedFetch(url, { method: 'HEAD', redirect: 'follow' });
    return { url, status: res.status, ok: res.ok };
  } catch {
    return { url, status: 0, ok: false };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const bar = '='.repeat(52);
  console.log(bar);
  console.log('  Sitemap Audit — localkynews.com');
  console.log(`  ${new Date().toISOString()}`);
  console.log(bar + '\n');

  // ── 1. Fetch sitemaps ────────────────────────────────────────────────────
  console.log('[1/4] Fetching sitemaps…');
  let sitemapXml = '';
  let newsXml = '';
  try {
    const [sRes, nRes] = await Promise.all([
      timedFetch(`${BASE_URL}/sitemap.xml`),
      timedFetch(`${BASE_URL}/sitemap-news.xml`),
    ]);
    if (!sRes.ok) throw new Error(`sitemap.xml returned HTTP ${sRes.status}`);
    if (!nRes.ok) throw new Error(`sitemap-news.xml returned HTTP ${nRes.status}`);
    [sitemapXml, newsXml] = await Promise.all([sRes.text(), nRes.text()]);
  } catch (err) {
    console.error('ERROR: Could not fetch sitemaps:', (err as Error).message);
    process.exit(1);
  }

  const sitemapUrls = extractLocs(sitemapXml);
  const newsUrls    = extractLocs(newsXml);
  console.log(`  sitemap.xml      → ${sitemapUrls.length} URLs`);
  console.log(`  sitemap-news.xml → ${newsUrls.length} URLs  (last 48 h)`);

  // ── 2. Query D1 ──────────────────────────────────────────────────────────
  console.log(`\n[2/4] Querying D1 for articles published in last ${DAYS_WINDOW} days…`);
  let dbRows: ArticleRow[] = [];
  try {
    dbRows = d1Query(
      `SELECT id, slug, county, category, is_national, published_at ` +
      `FROM articles ` +
      `WHERE slug IS NOT NULL AND slug != '' ` +
      `  AND published_at >= datetime('now', '-${DAYS_WINDOW} days') ` +
      `  AND (is_kentucky = 1 OR is_national = 1) ` +
      `  AND raw_word_count > 50 ` +
      `ORDER BY published_at DESC`,
    );
  } catch (err) {
    console.error('ERROR: D1 query failed:', (err as Error).message);
    process.exit(1);
  }
  console.log(`  Articles in DB (${DAYS_WINDOW}-day window): ${dbRows.length}`);

  // ── 3. Coverage analysis ─────────────────────────────────────────────────
  console.log('\n[3/4] Computing coverage…');

  const dbSlugs      = new Set<string>(dbRows.map((r) => r.slug).filter(Boolean));
  const sitemapSlugs = new Set<string>(sitemapUrls.map(slugFromUrl).filter(Boolean));
  const newsSlugs    = new Set<string>(newsUrls.map(slugFromUrl).filter(Boolean));

  const coveredBySitemap = [...dbSlugs].filter((s) => sitemapSlugs.has(s));
  const coveredByNews    = [...dbSlugs].filter((s) => newsSlugs.has(s));

  const sitemapCoverage = dbSlugs.size > 0
    ? (coveredBySitemap.length / dbSlugs.size) * 100
    : 0;
  const newsCoverage = dbSlugs.size > 0
    ? (coveredByNews.length / dbSlugs.size) * 100
    : 0;

  console.log('\n  Coverage Report');
  console.log('  ───────────────────────────────────────────────────');
  console.log(`  DB articles (${DAYS_WINDOW} days)        : ${dbSlugs.size}`);
  console.log(`  sitemap.xml total URLs       : ${sitemapUrls.length}`);
  console.log(`  sitemap-news.xml total URLs  : ${newsUrls.length}`);
  console.log('  ───────────────────────────────────────────────────');
  console.log(`  Covered by sitemap.xml       : ${coveredBySitemap.length} / ${dbSlugs.size}  →  ${sitemapCoverage.toFixed(1)}%`);
  console.log(`  Covered by sitemap-news.xml  : ${coveredByNews.length} / ${dbSlugs.size}  →  ${newsCoverage.toFixed(1)}%`);
  console.log('  (sitemap-news covers 48 h only; use sitemap.xml for the full window)');

  // Articles missing from sitemap.xml
  const missingMain = dbRows.filter((r) => r.slug && !sitemapSlugs.has(r.slug));
  if (missingMain.length > 0) {
    console.log(`\n  WARNING: ${missingMain.length} DB article(s) missing from sitemap.xml`);
    console.log(`  (showing up to ${MISSING_SAMPLE}):`);
    for (const r of missingMain.slice(0, MISSING_SAMPLE)) {
      console.log(`    · ${buildArticleUrl(r)}  (${r.published_at?.slice(0, 10) ?? 'unknown'})`);
    }
  }

  // Articles missing from sitemap-news (48 h subset only — expected for older items)
  const cutoff48h  = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const recent48h  = dbRows.filter((r) => r.published_at >= cutoff48h);
  const missingNews = recent48h.filter((r) => r.slug && !newsSlugs.has(r.slug));
  if (recent48h.length > 0) {
    console.log(`\n  sitemap-news coverage (last 48 h): ${recent48h.length - missingNews.length} / ${recent48h.length} articles indexed`);
    if (missingNews.length > 0) {
      console.log(`  Missing from sitemap-news (showing up to ${MISSING_SAMPLE}):`);
      for (const r of missingNews.slice(0, MISSING_SAMPLE)) {
        console.log(`    · ${buildArticleUrl(r)}  (${r.published_at?.slice(0, 10) ?? 'unknown'})`);
      }
    }
  }

  // ── 4. Spot-check live URLs ───────────────────────────────────────────────
  const combined = [...new Set([...sitemapUrls, ...newsUrls])];
  const toCheck  = sampleN(combined, Math.min(SPOT_CHECK_N, combined.length));
  console.log(`\n[4/4] Spot-checking ${toCheck.length} random live URLs…`);
  const checks  = await Promise.all(toCheck.map(spotCheck));
  const failed  = checks.filter((c) => !c.ok);
  const passed  = checks.length - failed.length;
  console.log(`  Passed: ${passed} / ${checks.length}`);
  if (failed.length > 0) {
    console.log('  Failed:');
    for (const c of failed) {
      console.log(`    ${c.status || 'ERR'}  ${c.url}`);
    }
  }

  // ── Final verdict ─────────────────────────────────────────────────────────
  const passes = sitemapCoverage >= COVERAGE_THRESHOLD;
  console.log('\n' + bar);
  if (passes) {
    console.log(`  PASS  sitemap.xml coverage ${sitemapCoverage.toFixed(1)}% >= ${COVERAGE_THRESHOLD}%`);
  } else {
    console.log(`  FAIL  sitemap.xml coverage ${sitemapCoverage.toFixed(1)}% < ${COVERAGE_THRESHOLD}%`);
  }
  console.log(bar + '\n');

  if (!passes) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
