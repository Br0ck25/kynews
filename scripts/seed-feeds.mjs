import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const root = path.resolve(process.cwd());
const seedPath = path.join(root, "feeds.seed.json");
const masterDbPath = path.join(root, "Kentucky News Master Database");
const dbPath = path.join(root, "data", "dev.sqlite");

if (!fs.existsSync(seedPath)) {
  console.error("Missing feeds.seed.json");
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error("Missing DB. Run: npm run db:reset");
  process.exit(1);
}

const baseFeeds = JSON.parse(fs.readFileSync(seedPath, "utf-8"));

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function canonicalizeSourceUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    u.protocol = "https:";
    u.hash = "";
    u.search = "";
    u.username = "";
    u.password = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    u.pathname = (u.pathname || "/").replace(/\/+$/, "") || "/";
    return u.toString();
  } catch {
    return null;
  }
}

function canonicalizeFeedUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    u.protocol = "https:";
    u.hash = "";
    u.username = "";
    u.password = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return String(raw || "").trim();
  }
}

function extractMasterSourceUrls(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  const matches = raw.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  const unique = new Set();
  for (const m of matches) {
    const cleaned = String(m || "").replace(/[),.;]+$/, "");
    const canonical = canonicalizeSourceUrl(cleaned);
    if (canonical) unique.add(canonical);
  }
  return [...unique];
}

function buildMasterWatchFeed(sourceUrl) {
  const source = new URL(sourceUrl);
  const host = source.hostname.replace(/^www\./, "");
  const pathPart = source.pathname && source.pathname !== "/" ? source.pathname : "";
  const sourceKey = `${host}${pathPart}`;
  const id = `ky-master-${slugify(sourceKey)}`;
  const searchQuery = `site:${sourceKey} Kentucky`;

  return {
    id,
    name: `Master Watch: ${sourceKey}`,
    category: "Kentucky - Master Sources",
    url: `https://www.bing.com/news/search?q=${encodeURIComponent(searchQuery)}&format=rss`,
    state_code: "KY",
    region_scope: "ky",
    enabled: 1
  };
}

function mergeFeeds(base, masterDerived) {
  const merged = [];
  const seenIds = new Set();
  const seenUrls = new Set();

  function pushFeed(feed) {
    const row = { ...feed };
    let id = String(row.id || "").trim();
    if (!id) return;

    let counter = 2;
    while (seenIds.has(id)) {
      id = `${row.id}-${counter}`;
      counter += 1;
    }
    row.id = id;

    const canonicalUrl = canonicalizeFeedUrl(row.url);
    if (!canonicalUrl || seenUrls.has(canonicalUrl)) return;
    row.url = canonicalUrl;

    seenIds.add(row.id);
    seenUrls.add(canonicalUrl);
    merged.push(row);
  }

  for (const feed of base) pushFeed(feed);
  for (const feed of masterDerived) pushFeed(feed);
  return merged;
}

const masterSourceUrls = extractMasterSourceUrls(masterDbPath);
const masterDerivedFeeds = masterSourceUrls.map(buildMasterWatchFeed);
const feeds = mergeFeeds(baseFeeds, masterDerivedFeeds);
const db = new Database(dbPath);
const feedCols = db.prepare("PRAGMA table_info(feeds)").all().map((r) => r.name);
if (!feedCols.includes("default_county")) {
  db.prepare("ALTER TABLE feeds ADD COLUMN default_county TEXT").run();
}
if (!feedCols.includes("fetch_mode")) {
  db.prepare("ALTER TABLE feeds ADD COLUMN fetch_mode TEXT NOT NULL DEFAULT 'rss'").run();
}
if (!feedCols.includes("scraper_id")) {
  db.prepare("ALTER TABLE feeds ADD COLUMN scraper_id TEXT").run();
}

const upsert = db.prepare(`
INSERT INTO feeds (id, name, category, url, state_code, default_county, region_scope, fetch_mode, scraper_id, enabled)
VALUES (
  @id,
  @name,
  @category,
  @url,
  COALESCE(@state_code, 'KY'),
  @default_county,
  COALESCE(@region_scope, 'ky'),
  COALESCE(@fetch_mode, 'rss'),
  @scraper_id,
  COALESCE(@enabled, 1)
)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  category=excluded.category,
  url=excluded.url,
  state_code=excluded.state_code,
  default_county=excluded.default_county,
  region_scope=excluded.region_scope,
  fetch_mode=excluded.fetch_mode,
  scraper_id=excluded.scraper_id,
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
  for (const f of rows) {
    upsert.run({
      default_county: null,
      fetch_mode: "rss",
      scraper_id: null,
      ...f
    });
  }
  const staleParams = {};
  seedIds.forEach((id, idx) => {
    staleParams[`id${idx}`] = id;
  });
  deleteStale.run(staleParams);
});

tx(feeds);
db.close();

const derivedAdded = Math.max(0, feeds.length - baseFeeds.length);
console.log(
  `✅ Seeded feeds: ${feeds.length} total (${baseFeeds.length} base + ${derivedAdded} master-derived from ${masterSourceUrls.length} master sources)`
);
