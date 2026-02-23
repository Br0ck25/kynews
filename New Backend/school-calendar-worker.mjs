/**
 * School Calendar Worker
 * Fetches ICS calendars from all 120 KY school districts every 6 hours.
 *
 * Run: node workers/school-calendar-worker.mjs
 * Schedule: Every 6 hours
 */

import { openDb } from "../lib/db-adapter.mjs";
import { syncSchoolCalendars } from "../lib/school-calendar.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function main() {
  const db = await openDb({ path: process.env.DB_PATH || `${root}/data/dev.sqlite` });

  // Optionally filter to specific counties: COUNTIES=Fayette,Jefferson node ...
  const filterCounties = process.env.COUNTIES
    ? process.env.COUNTIES.split(",").map((c) => c.trim())
    : null;

  console.log("📅 Starting school calendar sync...");
  const count = await syncSchoolCalendars(db, filterCounties);
  console.log(`✅ Synced ${count} school events`);

  if (db.close) db.close();
}

main().catch((err) => {
  console.error("School calendar worker error:", err);
  process.exit(1);
});
