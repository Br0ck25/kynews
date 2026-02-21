import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const root = path.resolve(process.cwd());
const seedPath = path.join(root, "feeds.seed.json");
const dbPath = path.join(root, "data", "dev.sqlite");

if (!fs.existsSync(seedPath)) {
  console.error("Missing feeds.seed.json");
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error("Missing DB. Run: npm run db:reset");
  process.exit(1);
}

const feeds = JSON.parse(fs.readFileSync(seedPath, "utf-8"));
const db = new Database(dbPath);
const feedCols = db.prepare("PRAGMA table_info(feeds)").all().map((r) => r.name);
if (!feedCols.includes("default_county")) {
  db.prepare("ALTER TABLE feeds ADD COLUMN default_county TEXT").run();
}

const upsert = db.prepare(`
INSERT INTO feeds (id, name, category, url, state_code, default_county, region_scope, enabled)
VALUES (
  @id,
  @name,
  @category,
  @url,
  COALESCE(@state_code, 'KY'),
  @default_county,
  COALESCE(@region_scope, 'ky'),
  COALESCE(@enabled, 1)
)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  category=excluded.category,
  url=excluded.url,
  state_code=excluded.state_code,
  default_county=excluded.default_county,
  region_scope=excluded.region_scope,
  enabled=excluded.enabled
`);

const seedIds = feeds.map((f) => f.id);
const deleteStale =
  seedIds.length > 0
    ? db.prepare(
        `DELETE FROM feeds WHERE id NOT IN (${seedIds.map((_, idx) => `@id${idx}`).join(", ")})`
      )
    : db.prepare("DELETE FROM feeds");

const tx = db.transaction((rows) => {
  for (const f of rows) upsert.run({ default_county: null, ...f });
  const staleParams = {};
  seedIds.forEach((id, idx) => {
    staleParams[`id${idx}`] = id;
  });
  deleteStale.run(staleParams);
});

tx(feeds);
db.close();

console.log("✅ Seeded feeds:", feeds.length);
