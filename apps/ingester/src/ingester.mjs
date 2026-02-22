import cron from "node-cron";
import Parser from "rss-parser";
import { fetch } from "undici";
import * as cheerio from "cheerio";
import { openDb } from "./db.mjs";
import { makeItemId, pickImage, stableHash, toIsoOrNull } from "./util.mjs";
import kyCounties from "./ky-counties.json" with { type: "json" };
import kyCityCounty from "./ky-city-county.json" with { type: "json" };

const parser = new Parser({
  customFields: {
    item: [
      ["media:content", "media:content"],
      ["media:thumbnail", "media:thumbnail"],
      ["itunes:image", "itunes:image"]
    ]
  }
});

const INTERVAL_MINUTES = Number(process.env.INGEST_INTERVAL_MINUTES || 15);
const FEED_TIMEOUT_MS = Number(process.env.FEED_TIMEOUT_MS || 15000);
const ARTICLE_TIMEOUT_MS = Number(process.env.ARTICLE_TIMEOUT_MS || 12000);
const ARTICLE_MAX_CHARS = Number(process.env.ARTICLE_MAX_CHARS || 2_000_000); // HTML chars
const EXCERPT_MAX_CHARS = Number(process.env.ARTICLE_EXCERPT_MAX_CHARS || 10_000);
const MIN_ARTICLE_WORDS = Number(process.env.MIN_ARTICLE_WORDS || 50);

// Simple text normalization for matching
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function textWordCount(input) {
  return String(input || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

const KY_COUNTY_PATTERNS = (() => {
  const names = (kyCounties || []).map((c) => c.name).filter(Boolean);
  names.sort((a, b) => b.length - a.length);
  return names.map((name) => {
    const n = norm(name);
    // Match "X county", "X co", "X co.", etc.
    const re = new RegExp(`\\b${n.replace(/\s+/g, "\\s+")}\\s+(county|co\\.?)(\\b|\\s|,|\\.)`, "i");
    return { name, re };
  });
})();


const KY_CITY_PATTERNS = (() => {
  const rows = Array.isArray(kyCityCounty) ? kyCityCounty : [];
  // Longer first to avoid partial matches ("Fort Thomas" before "Thomas")
  const cities = rows
    .map((r) => ({ city: String(r.city || "").trim(), county: String(r.county || "").trim() }))
    .filter((r) => r.city && r.county);
  cities.sort((a, b) => b.city.length - a.city.length);

  return cities.map(({ city, county }) => {
    const n = norm(city);
    // Match city name as a whole phrase (word boundaries), allowing whitespace between words.
    const re = new RegExp(`\\b${n.replace(/\\s+/g, "\\s+")}\\b`, "i");
    return { city, county, re };
  });
})();

const OTHER_STATE_NAME_PATTERNS = (() => {
  const names = [
    "Alabama",
    "Alaska",
    "Arizona",
    "Arkansas",
    "California",
    "Colorado",
    "Connecticut",
    "Delaware",
    "Florida",
    "Georgia",
    "Hawaii",
    "Idaho",
    "Illinois",
    "Indiana",
    "Iowa",
    "Kansas",
    "Louisiana",
    "Maine",
    "Maryland",
    "Massachusetts",
    "Michigan",
    "Minnesota",
    "Mississippi",
    "Missouri",
    "Montana",
    "Nebraska",
    "Nevada",
    "New Hampshire",
    "New Jersey",
    "New Mexico",
    "New York",
    "North Carolina",
    "North Dakota",
    "Ohio",
    "Oklahoma",
    "Oregon",
    "Pennsylvania",
    "Rhode Island",
    "South Carolina",
    "South Dakota",
    "Tennessee",
    "Texas",
    "Utah",
    "Vermont",
    "Virginia",
    "Washington",
    "West Virginia",
    "Wisconsin",
    "Wyoming",
    "District of Columbia"
  ];
  return names.map((name) => ({
    name,
    re: new RegExp(`\\b${norm(name).replace(/\s+/g, "\\s+")}\\b`, "i")
  }));
})();

function hasKySignal(text, counties) {
  if (counties.length) return true;
  const raw = String(text || "");
  return /\bkentucky\b/i.test(raw) || /\bky\b/i.test(raw);
}

function detectOtherStateNames(text) {
  const t = norm(text);
  if (!t) return [];
  const out = [];
  for (const { name, re } of OTHER_STATE_NAME_PATTERNS) {
    if (re.test(t)) out.push(name);
  }
  return Array.from(new Set(out));
}



function detectKyCounties(text) {
  const t = norm(text);
  if (!t) return [];
  const out = [];
  const raw = String(text || "");
  const hasKyContext = /\bkentucky\b/i.test(raw) || /\bky\b/i.test(raw);

  // Direct county mentions: "X County" / "X Co."
  for (const { name, re } of KY_COUNTY_PATTERNS) {
    if (re.test(t)) out.push(name);
  }

  // City names are highly ambiguous across states; require explicit Kentucky context.
  if (hasKyContext) {
    for (const { county, re } of KY_CITY_PATTERNS) {
      if (re.test(t)) out.push(county);
    }
  }

  return Array.from(new Set(out));
}

function extractReadableText(html) {
  const $ = cheerio.load(html, { decodeEntities: true });

  // Remove obvious non-content
  $("script,style,noscript,iframe,svg,canvas,form,header,footer,nav,aside,button").remove();

  // Prefer semantic containers when present
  let text = $("article").text() || $("main").text() || $("#main").text() || $("body").text() || "";
  text = text
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();

  if (text.length > EXCERPT_MAX_CHARS) text = text.slice(0, EXCERPT_MAX_CHARS);
  return text;
}

function pickOgImage(html) {
  try {
    const $ = cheerio.load(html, { decodeEntities: true });
    const og =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="og:image"]').attr("content") ||
      $('meta[property="twitter:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      null;
    if (og && /^https?:\/\//i.test(og)) return og;
  } catch {
    // ignore
  }
  return null;
}

function pickInlineImage(html, pageUrl) {
  try {
    const $ = cheerio.load(html, { decodeEntities: true });
    const imgs = $("article img, main img, .entry-content img, .post-content img, img").toArray();
    for (const el of imgs) {
      const src =
        $(el).attr("src") ||
        $(el).attr("data-src") ||
        $(el).attr("data-lazy-src") ||
        $(el).attr("data-original");
      if (!src) continue;
      const lower = String(src).toLowerCase();
      if (lower.startsWith("data:")) continue;
      if (/\b(sprite|logo|icon|avatar)\b/i.test(lower)) continue;

      let abs = "";
      try {
        abs = new URL(src, pageUrl).toString();
      } catch {
        abs = "";
      }
      if (!/^https?:\/\//i.test(abs)) continue;
      return abs;
    }
  } catch {
    // ignore
  }
  return null;
}

async function fetchArticle(url) {
  if (!url || !/^https?:\/\//i.test(url)) return { status: "skip", text: "", ogImage: null };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ARTICLE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        // Gentle headers; many sites respond better with a UA.
        "user-agent": "Mozilla/5.0 (compatible; FeedlyCloneLocal/1.0; +https://localhost)",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (res.status < 200 || res.status >= 300) return { status: `http_${res.status}`, text: "", ogImage: null };

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
      return { status: "non_html", text: "", ogImage: null };
    }

    let html = await res.text();
    if (html.length > ARTICLE_MAX_CHARS) html = html.slice(0, ARTICLE_MAX_CHARS);

    const ogImage = pickOgImage(html) || pickInlineImage(html, url);
    const text = extractReadableText(html);
    return { status: "ok", text, ogImage };
  } catch (e) {
    return { status: "error", text: "", ogImage: null };
  } finally {
    clearTimeout(t);
  }
}

function ensureSchema(db) {
  // Add optional columns for article fetching (safe to run repeatedly)
  const itemCols = db.prepare("PRAGMA table_info(items)").all().map((r) => r.name);
  const feedCols = db.prepare("PRAGMA table_info(feeds)").all().map((r) => r.name);
  const add = (name, type) => {
    if (!itemCols.includes(name)) {
      db.prepare(`ALTER TABLE items ADD COLUMN ${name} ${type}`).run();
    }
  };
  const addFeed = (name, type) => {
    if (!feedCols.includes(name)) {
      db.prepare(`ALTER TABLE feeds ADD COLUMN ${name} ${type}`).run();
    }
  };
  addFeed("region_scope", "TEXT NOT NULL DEFAULT 'ky'");
  addFeed("default_county", "TEXT");
  add("region_scope", "TEXT NOT NULL DEFAULT 'ky'");
  add("article_checked_at", "TEXT");
  add("article_fetch_status", "TEXT");
  add("article_text_excerpt", "TEXT");
}

function recordError(db, feedId, err) {
  db.prepare("INSERT INTO fetch_errors (feed_id, at, error) VALUES (?, datetime('now'), ?)").run(
    feedId,
    String(err?.stack || err)
  );
}

function startRun(db) {
  const stmt = db.prepare("INSERT INTO fetch_runs (started_at, status) VALUES (datetime('now'), 'running')");
  const info = stmt.run();
  return info.lastInsertRowid;
}

function finishRun(db, runId, status) {
  db.prepare("UPDATE fetch_runs SET finished_at=datetime('now'), status=? WHERE id=?").run(status, runId);
}

async function fetchWithConditional(url, etag, lastModified) {
  const headers = {};
  if (etag) headers["If-None-Match"] = etag;
  if (lastModified) headers["If-Modified-Since"] = lastModified;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);

  try {
    const res = await fetch(url, { headers, redirect: "follow", signal: ctrl.signal });

    if (res.status === 304) return { status: 304, etag, lastModified, text: null };
    if (res.status < 200 || res.status >= 300) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} for ${url} :: ${body.slice(0, 200)}`);
    }

    const newEtag = res.headers.get("etag") || etag || null;
    const newLast = res.headers.get("last-modified") || lastModified || null;
    const text = await res.text();
    return { status: res.status, etag: newEtag, lastModified: newLast, text };
  } finally {
    clearTimeout(t);
  }
}

function upsertItemAndLink(db, feedId, row) {
  const insertItem = db.prepare(`
    INSERT INTO items (id, title, url, guid, author, region_scope, published_at, summary, content, image_url, hash)
    VALUES (@id, @title, @url, @guid, @author, @region_scope, @published_at, @summary, @content, @image_url, @hash)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      author=excluded.author,
      region_scope=excluded.region_scope,
      published_at=excluded.published_at,
      summary=excluded.summary,
      content=excluded.content,
      image_url=excluded.image_url,
      hash=excluded.hash
  `);

  const linkFeedItem = db.prepare(`INSERT OR IGNORE INTO feed_items (feed_id, item_id) VALUES (?, ?)`);

  insertItem.run(row);
  linkFeedItem.run(feedId, row.id);
}

function removeLowWordItem(db, feedId, itemId) {
  db.prepare("DELETE FROM feed_items WHERE feed_id=? AND item_id=?").run(feedId, itemId);
  const refs = db.prepare("SELECT COUNT(1) AS refs FROM feed_items WHERE item_id=?").get(itemId);
  if (Number(refs?.refs || 0) <= 0) {
    db.prepare("DELETE FROM items WHERE id=?").run(itemId);
  }
}

async function tagItemLocations(db, itemId, stateCode, parts, url) {
  const st = (stateCode || "KY").toUpperCase();

  const del = db.prepare("DELETE FROM item_locations WHERE item_id=? AND state_code=?");
  const ins = db.prepare(
    "INSERT OR IGNORE INTO item_locations (item_id, state_code, county) VALUES (?, ?, ?)"
  );

  del.run(itemId, st);

  const titleText = String(parts?.[0] || "");
  const seedArticleText = textOnly(parts.slice(1).filter(Boolean).join(" \n "));

  const meta = db
    .prepare("SELECT article_checked_at, article_fetch_status, image_url FROM items WHERE id=?")
    .get(itemId);

  const alreadyChecked = Boolean(meta?.article_checked_at);
  const needsImage = !String(meta?.image_url || "").trim();

  let excerpt = "";
  if ((needsImage || !seedArticleText) && !alreadyChecked) {
    const fetched = await fetchArticle(url);
    excerpt = fetched.text || "";

    const update = db.prepare(`
      UPDATE items
      SET
        article_checked_at = datetime('now'),
        article_fetch_status = @status,
        article_text_excerpt = @excerpt,
        content = COALESCE(content, @excerpt),
        image_url = COALESCE(image_url, @ogImage)
      WHERE id=@id
    `);
    update.run({
      id: itemId,
      status: fetched.status,
      excerpt: excerpt || null,
      ogImage: fetched.ogImage || null
    });
  }

  const articleText = textOnly(excerpt || seedArticleText);
  const titleCounties = detectKyCounties(titleText);
  const bodyCounties = detectKyCounties(articleText);
  const taggedCounties = new Set([...titleCounties, ...bodyCounties].map((county) => normalizeCounty(county)).filter(Boolean));
  const titleKySignal = st !== "KY" ? true : hasKySignal(titleText, titleCounties);
  const bodyKySignal = st !== "KY" ? true : hasKySignal(articleText, bodyCounties);

  const hasTitleOutOfStateSignal =
    st === "KY" &&
    detectOtherStateNames(titleText).length > 0 &&
    !titleKySignal &&
    titleCounties.length === 0;
  const hasPrimaryOutOfStateSignal =
    st === "KY" &&
    detectOtherStateNames(articleText).length > 0 &&
    !bodyKySignal &&
    bodyCounties.length === 0;
  if (st === "KY" && (hasTitleOutOfStateSignal || hasPrimaryOutOfStateSignal)) {
    return;
  }

  const hasStrongKySignal =
    st !== "KY" ||
    titleKySignal ||
    bodyKySignal ||
    taggedCounties.size > 0;
  const shouldTagAsKy = st !== "KY" || hasStrongKySignal;
  if (!shouldTagAsKy) return;

  // Keep a state-level marker for valid in-state content.
  ins.run(itemId, st, "");

  if (st === "KY") {
    for (const county of taggedCounties) ins.run(itemId, st, county);
  }
}

async function ingestOnce() {
  const db = openDb();
  ensureSchema(db);
  const runId = startRun(db);

  try {
    const feeds = db
      .prepare(
        "SELECT id, url, etag, last_modified, state_code, region_scope, default_county FROM feeds WHERE enabled=1 ORDER BY name"
      )
      .all();

    const updateFeedMeta = db.prepare(`
      UPDATE feeds
      SET etag=@etag, last_modified=@last_modified, last_checked_at=datetime('now')
      WHERE id=@id
    `);

    const tx = db.transaction((fn) => fn());

    for (const f of feeds) {
      try {
        const { status, etag, lastModified, text } = await fetchWithConditional(f.url, f.etag, f.last_modified);
        updateFeedMeta.run({ id: f.id, etag, last_modified: lastModified });

        if (status === 304 || !text) continue;

        const feed = await parser.parseString(text);
        const items = feed.items || [];

        for (const it of items) {
          const published_at = toIsoOrNull(it.isoDate || it.pubDate);
          const url = it.link || it.guid || "";
          const title = (it.title || "").trim() || "(untitled)";
          const summary = (it.contentSnippet || "").trim() || null;
          const content = (it.content || "").trim() || null;
          const author = (it.creator || it.author || "").trim() || null;
          const image_url = pickImage(it);

          const id = makeItemId({ url, guid: it.guid, title, published_at });
          const hash = stableHash([title, url, summary || "", content || "", author || "", published_at || ""].join("|"));

          // Upsert item + link in a quick transaction
          tx(() => {
            upsertItemAndLink(db, f.id, {
              id,
              title,
              url,
              guid: it.guid || null,
              author,
              region_scope: f.region_scope === "national" ? "national" : "ky",
              published_at,
              summary,
              content,
              image_url,
              hash
            });
          });

          // Only Kentucky feeds participate in state/county tagging.
          if ((f.region_scope || "ky") === "ky") {
            await tagItemLocations(
              db,
              id,
              f.state_code || "KY",
              [title, content || ""],
              url
            );
          }

          const quality = db
            .prepare("SELECT article_text_excerpt, content, summary FROM items WHERE id=? LIMIT 1")
            .get(id);
          const qualityText = String(quality?.article_text_excerpt || quality?.content || quality?.summary || "");
          if (textWordCount(qualityText) < MIN_ARTICLE_WORDS) {
            removeLowWordItem(db, f.id, id);
          }
        }
      } catch (err) {
        recordError(db, f.id, err);
        // keep going
      }
    }

    finishRun(db, runId, "ok");
  } catch (err) {
    finishRun(db, runId, "failed");
    throw err;
  } finally {
    db.close();
  }
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[ingester] ${ts} ${msg}`);
}

async function main() {
  const runOnce = process.argv.includes("--once") || process.env.INGEST_ONCE === "1";
  log(`Starting ingester. Interval: ${INTERVAL_MINUTES} minutes`);

  // Run once at startup
  await ingestOnce().catch((e) => log(`Initial ingest failed: ${String(e?.message || e)}`));

  if (runOnce) {
    log("Ingest once complete, exiting.");
    return;
  }

  // Then on schedule
  cron.schedule(`*/${INTERVAL_MINUTES} * * * *`, async () => {
    log("Ingest tick");
    await ingestOnce().catch((e) => log(`Ingest failed: ${String(e?.message || e)}`));
  });
}

main();
