/**
 * Legislature Worker
 * Scrapes KY legislature.ky.gov for active bills daily
 * and runs article bill-tagging on recently processed items.
 *
 * Run: node workers/legislature-worker.mjs
 * Schedule: Daily at 8am ET
 */

import { openDb } from "../lib/db-adapter.mjs";
import { scrapeLegislatureBills, syncBillsToDb, tagArticleWithBills } from "../lib/legislature.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function main() {
  const db = await openDb({ path: process.env.DB_PATH || `${root}/data/dev.sqlite` });

  // Step 1: Scrape and sync bills
  console.log("📜 Fetching KY Legislature bills...");
  const bills = await scrapeLegislatureBills();
  console.log(`  Found ${bills.length} bills`);
  if (bills.length > 0) {
    await syncBillsToDb(db, bills);
    console.log(`  ✅ Bills synced to DB`);
  }

  // Step 2: Tag recent articles that mention bill numbers
  console.log("\n🏷️  Tagging recent articles with bill mentions...");
  const recentItems = await db.prepare(`
    SELECT id, title, body_text, summary FROM items
    WHERE published_at >= datetime('now', '-7 days')
      AND body_text IS NOT NULL
    ORDER BY published_at DESC
    LIMIT 500
  `).all();

  let tagged = 0;
  for (const item of recentItems) {
    const body = item.body_text || item.summary || "";
    const mentions = (await import("../lib/legislature.mjs")).extractBillMentions(`${item.title} ${body}`);
    if (mentions.length > 0) {
      await tagArticleWithBills(db, item.id, item.title, body);
      tagged++;
    }
  }

  console.log(`  ✅ Tagged ${tagged} articles with bill references`);
  if (db.close) db.close();
}

main().catch((err) => {
  console.error("Legislature worker error:", err);
  process.exit(1);
});
