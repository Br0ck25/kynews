/**
 * Coverage Report + Alerting
 *
 * Lists Kentucky counties with zero/low articles.
 * Fires Slack/email alerts for counties with 0 articles for 48+ hours.
 *
 * Run: node scripts/coverage-report.mjs
 *
 * Options:
 *   COVERAGE_DAYS=7   — lookback window (default: 7)
 *   ALERT=true        — send alerts for 0-coverage counties
 */

import { openDb } from "../lib/db-adapter.mjs";
import { KY_COUNTIES } from "../lib/ky-geo.mjs";
import { alertCoverageGaps, alertFeedFailures } from "../lib/alerting.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAYS  = Number(process.env.COVERAGE_DAYS || 7);
const ALERT = process.env.ALERT === "true";

const db = await openDb({ path: process.env.DB_PATH || `${root}/data/dev.sqlite` });

const covered = await db.prepare(`
  SELECT il.county, COUNT(DISTINCT i.id) as n, MAX(i.published_at) as latest
  FROM item_locations il
  JOIN items i ON i.id = il.item_id
  WHERE il.state_code = 'KY' AND il.county != ''
    AND i.published_at >= datetime('now', '-${DAYS} days')
  GROUP BY il.county
`).all();

const coveredMap = new Map(covered.map((r) => [r.county, r]));

const paywallStats = await db.prepare(`
  SELECT
    SUM(CASE WHEN is_paywalled=1 THEN 1 ELSE 0 END) as paywalled,
    SUM(CASE WHEN paywall_deprioritized=1 THEN 1 ELSE 0 END) as deprioritized,
    COUNT(*) as total
  FROM items WHERE published_at >= datetime('now', '-${DAYS} days')
`).get();

const dedupStats = await db.prepare(`
  SELECT
    SUM(CASE WHEN is_duplicate=1 THEN 1 ELSE 0 END) as duplicates,
    COUNT(*) as total
  FROM items WHERE published_at >= datetime('now', '-${DAYS} days')
`).get();

const breakingStats = await db.prepare(`
  SELECT alert_level, COUNT(*) as n
  FROM items WHERE is_breaking=1 AND published_at >= datetime('now', '-24 hours')
  GROUP BY alert_level
`).all();

const failingFeeds = await db.prepare(`
  SELECT f.name, COUNT(fe.id) as errors
  FROM feeds f JOIN fetch_errors fe ON fe.feed_id = f.id
  WHERE fe.at >= datetime('now', '-3 hours') AND f.enabled=1
  GROUP BY f.id HAVING errors >= 3
  ORDER BY errors DESC LIMIT 10
`).all();

const bingFeeds = await db.prepare(`
  SELECT COUNT(*) as n FROM feeds WHERE is_bing_fallback=1 AND enabled=1
`).get();

// ── Print report ──────────────────────────────────────────────────────────────

console.log(`\n📰 Kentucky County Coverage Report (last ${DAYS} days)`);
console.log("═".repeat(60));

const zero = [], low = [], good = [];
for (const county of KY_COUNTIES) {
  const data = coveredMap.get(county);
  if (!data) zero.push(county);
  else if (data.n < 3) low.push({ county, n: data.n, latest: data.latest });
  else good.push({ county, n: data.n });
}

if (zero.length > 0) {
  console.log(`\n🔴 NO COVERAGE — ${zero.length} counties:`);
  for (let i = 0; i < zero.length; i += 3) {
    console.log("   " + zero.slice(i, i + 3).map((c) => c.padEnd(22)).join(""));
  }
}

if (low.length > 0) {
  console.log(`\n🟡 LOW COVERAGE — ${low.length} counties:`);
  low.forEach(({ county, n, latest }) =>
    console.log(`   ${county.padEnd(20)} ${n} articles — ${latest?.slice(0, 10) || "?"}`));
}

console.log(`\n🟢 COVERED — ${good.length} counties`);
console.log("\n" + "─".repeat(60));
console.log(`Coverage: ${good.length}/${KY_COUNTIES.length} (${Math.round(good.length / KY_COUNTIES.length * 100)}%)`);
console.log(`Bing fallback feeds active: ${bingFeeds?.n || 0}`);

console.log("\n📊 Article Health");
console.log("─".repeat(60));
if (paywallStats) {
  const pct = paywallStats.total > 0 ? Math.round(paywallStats.paywalled / paywallStats.total * 100) : 0;
  console.log(`Paywalled:     ${paywallStats.paywalled} (${pct}%) | Deprioritized: ${paywallStats.deprioritized}`);
}
if (dedupStats) {
  const pct = dedupStats.total > 0 ? Math.round(dedupStats.duplicates / dedupStats.total * 100) : 0;
  console.log(`Duplicates:    ${dedupStats.duplicates} suppressed (${pct}%)`);
}

if (breakingStats.length > 0) {
  console.log(`\n🔴 Breaking News (24h): ` + breakingStats.map(r => `${r.alert_level}: ${r.n}`).join(" | "));
}

if (failingFeeds.length > 0) {
  console.log(`\n⚠️  Failing Feeds:`);
  failingFeeds.forEach(({ name, errors }) =>
    console.log(`   ${name.slice(0, 42).padEnd(44)} ${errors} errors`));
}

if (ALERT) {
  console.log("\n🚨 Sending alerts...");
  await alertCoverageGaps(db);
  await alertFeedFailures(db);
}

if (db.close) db.close();
