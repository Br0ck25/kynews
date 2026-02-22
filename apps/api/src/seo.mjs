import { normalizeCounty } from "./search.mjs";
import { ensureSchema } from "./schema.mjs";

const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://localkynews.com";

// ── XML / date helpers ────────────────────────────────────────────────────────

export function escapeXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function toYYYYMMDD(isoStr) {
  const d = isoStr ? new Date(isoStr) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

const RFC822_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RFC822_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function toRfc822(isoStr) {
  const d = isoStr ? new Date(isoStr) : new Date();
  if (isNaN(d.getTime())) return new Date().toUTCString();
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${RFC822_DAYS[d.getUTCDay()]}, ${dd} ${RFC822_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${hh}:${mm}:${ss} GMT`;
}

export function countySlug(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function xmlDecl() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n';
}

function seoHeaders(reply) {
  reply.header("Cache-Control", "public, max-age=300");
  reply.header("Access-Control-Allow-Origin", "*");
}

function displayCountyName(county) {
  return String(county || "")
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ── RSS item builder (shared by /rss.xml and /rss/:county.xml) ────────────────

function buildRssItem(row) {
  const pub = toRfc822(row.published_at);
  const desc = escapeXml(row.ai_summary || row.summary || "");
  const lines = [
    "    <item>",
    `      <title>${escapeXml(row.title)}</title>`,
    `      <link>${escapeXml(row.url)}</link>`,
    `      <guid isPermaLink="false">${escapeXml(String(row.id))}</guid>`,
    `      <pubDate>${pub}</pubDate>`,
    `      <description>${desc}</description>`
  ];
  if (row.author) {
    lines.push(`      <author>${escapeXml(row.author)}</author>`);
  }
  if (row.image_url) {
    lines.push(`      <enclosure url="${escapeXml(row.image_url)}" length="0" type="image/jpeg"/>`);
  }
  lines.push("    </item>");
  return lines.join("\n");
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerSeoRoutes(app, openDb) {
  // robots.txt is served centrally in server.mjs to avoid route duplication.

  // ── 1. sitemap-index.xml ─────────────────────────────────────────────────
  app.get("/sitemap-index.xml", async (_req, reply) => {
    seoHeaders(reply);
    reply.header("Content-Type", "application/xml");
    const today = toYYYYMMDD(new Date().toISOString());
    const xml = [
      xmlDecl(),
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      `  <sitemap><loc>${SITE_ORIGIN}/sitemap-news.xml</loc><lastmod>${today}</lastmod></sitemap>`,
      `  <sitemap><loc>${SITE_ORIGIN}/sitemap-counties.xml</loc><lastmod>${today}</lastmod></sitemap>`,
      `  <sitemap><loc>${SITE_ORIGIN}/sitemap-lost-found.xml</loc><lastmod>${today}</lastmod></sitemap>`,
      `  <sitemap><loc>${SITE_ORIGIN}/sitemap-static.xml</loc><lastmod>${today}</lastmod></sitemap>`,
      "</sitemapindex>"
    ].join("\n");
    return reply.send(xml);
  });

  // ── 2. sitemap-news.xml (Google News format) ─────────────────────────────
  app.get("/sitemap-news.xml", async (_req, reply) => {
    seoHeaders(reply);
    reply.header("Content-Type", "application/xml");
    const db = openDb();
    try {
      ensureSchema(db);
      const rows = db
        .prepare(
          `SELECT id, title, published_at
           FROM items
           WHERE published_at >= datetime('now', '-48 hours')
             AND region_scope = 'ky'
             AND article_fetch_status = 'ok'
           ORDER BY published_at DESC
           LIMIT 1000`
        )
        .all();

      const urlBlocks = rows
        .map((row) => {
          const pubIso = row.published_at
            ? new Date(row.published_at).toISOString()
            : new Date().toISOString();
          return [
            "  <url>",
            `    <loc>${SITE_ORIGIN}/news/${escapeXml(String(row.id))}</loc>`,
            `    <lastmod>${toYYYYMMDD(row.published_at)}</lastmod>`,
            "    <news:news>",
            "      <news:publication>",
            "        <news:name>Kentucky Local News</news:name>",
            "        <news:language>en</news:language>",
            "      </news:publication>",
            `      <news:publication_date>${escapeXml(pubIso)}</news:publication_date>`,
            `      <news:title>${escapeXml(row.title)}</news:title>`,
            "    </news:news>",
            "  </url>"
          ].join("\n");
        })
        .join("\n");

      const xml = [
        xmlDecl(),
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
        '        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">',
        urlBlocks,
        "</urlset>"
      ].join("\n");
      return reply.send(xml);
    } catch (err) {
      reply.status(500);
      return reply.send(`Internal error: ${String(err?.message ?? err)}`);
    } finally {
      db.close();
    }
  });

  // ── 3. sitemap-counties.xml ──────────────────────────────────────────────
  app.get("/sitemap-counties.xml", async (_req, reply) => {
    seoHeaders(reply);
    reply.header("Content-Type", "application/xml");
    const db = openDb();
    try {
      ensureSchema(db);
      const rows = db
        .prepare(
          `SELECT il.county, MAX(COALESCE(i.published_at, i.fetched_at)) AS latest
           FROM item_locations il
           JOIN items i ON i.id = il.item_id
           WHERE il.state_code = 'KY'
             AND il.county != ''
             AND i.region_scope = 'ky'
             AND COALESCE(i.published_at, i.fetched_at) >= datetime('now', '-7 days')
           GROUP BY il.county
           ORDER BY il.county`
        )
        .all();

      const urlBlocks = rows
        .map((row) => {
          const slug = countySlug(row.county);
          return [
            "  <url>",
            `    <loc>${SITE_ORIGIN}/county/${escapeXml(slug)}</loc>`,
            `    <lastmod>${toYYYYMMDD(row.latest)}</lastmod>`,
            "    <changefreq>hourly</changefreq>",
            "    <priority>0.8</priority>",
            "  </url>"
          ].join("\n");
        })
        .join("\n");

      const xml = [
        xmlDecl(),
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        urlBlocks,
        "</urlset>"
      ].join("\n");
      return reply.send(xml);
    } catch (err) {
      reply.status(500);
      return reply.send(`Internal error: ${String(err?.message ?? err)}`);
    } finally {
      db.close();
    }
  });

  // ── 4. sitemap-lost-found.xml ────────────────────────────────────────────
  app.get("/sitemap-lost-found.xml", async (_req, reply) => {
    seoHeaders(reply);
    reply.header("Content-Type", "application/xml");
    const db = openDb();
    try {
      ensureSchema(db);
      const rows = db
        .prepare(
          `SELECT id, approved_at, submitted_at
           FROM lost_found_posts
           WHERE status = 'approved'
             AND expires_at > datetime('now')
           ORDER BY COALESCE(approved_at, submitted_at) DESC`
        )
        .all();

      const urlBlocks = rows
        .map((row) => {
          const dateStr = toYYYYMMDD(row.approved_at || row.submitted_at);
          return [
            "  <url>",
            `    <loc>${SITE_ORIGIN}/lost-found/${escapeXml(String(row.id))}</loc>`,
            `    <lastmod>${dateStr}</lastmod>`,
            "    <changefreq>weekly</changefreq>",
            "    <priority>0.5</priority>",
            "  </url>"
          ].join("\n");
        })
        .join("\n");

      const xml = [
        xmlDecl(),
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        urlBlocks,
        "</urlset>"
      ].join("\n");
      return reply.send(xml);
    } catch (err) {
      reply.status(500);
      return reply.send(`Internal error: ${String(err?.message ?? err)}`);
    } finally {
      db.close();
    }
  });

  // ── 5. sitemap-static.xml ────────────────────────────────────────────────
  app.get("/sitemap-static.xml", async (_req, reply) => {
    seoHeaders(reply);
    reply.header("Content-Type", "application/xml");
    const today = toYYYYMMDD(new Date().toISOString());
    const staticPages = [
      { loc: "/", changefreq: "hourly", priority: "1.0" },
      { loc: "/lost-found", changefreq: "daily", priority: "0.7" },
      { loc: "/weather", changefreq: "hourly", priority: "0.6" },
      { loc: "/search", changefreq: "daily", priority: "0.5" }
    ];

    const urlBlocks = staticPages
      .map((p) =>
        [
          "  <url>",
          `    <loc>${SITE_ORIGIN}${p.loc}</loc>`,
          `    <lastmod>${today}</lastmod>`,
          `    <changefreq>${p.changefreq}</changefreq>`,
          `    <priority>${p.priority}</priority>`,
          "  </url>"
        ].join("\n")
      )
      .join("\n");

    const xml = [
      xmlDecl(),
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      urlBlocks,
      "</urlset>"
    ].join("\n");
    return reply.send(xml);
  });

  // ── 6. rss.xml – global KY feed ──────────────────────────────────────────
  app.get("/rss.xml", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Content-Type", "application/rss+xml; charset=utf-8");
    const db = openDb();
    try {
      ensureSchema(db);
      const rows = db
        .prepare(
          `SELECT id, title, url, author, published_at, summary, ai_summary, image_url
           FROM items
           WHERE region_scope = 'ky'
             AND COALESCE(published_at, fetched_at) >= datetime('now', '-72 hours')
           ORDER BY COALESCE(published_at, fetched_at) DESC
           LIMIT 50`
        )
        .all();

      const buildDate = toRfc822(new Date().toISOString());
      const itemsXml = rows.map((r) => buildRssItem(r)).join("\n");

      const xml = [
        xmlDecl(),
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
        "  <channel>",
        "    <title>Kentucky Local News</title>",
        `    <link>${SITE_ORIGIN}</link>`,
        "    <description>Local news from across Kentucky&#x27;s 120 counties</description>",
        "    <language>en-us</language>",
        `    <lastBuildDate>${buildDate}</lastBuildDate>`,
        `    <atom:link href="${SITE_ORIGIN}/rss.xml" rel="self" type="application/rss+xml"/>`,
        itemsXml,
        "  </channel>",
        "</rss>"
      ].join("\n");
      return reply.send(xml);
    } catch (err) {
      reply.status(500);
      return reply.send(`Internal error: ${String(err?.message ?? err)}`);
    } finally {
      db.close();
    }
  });

  // ── 7. /rss/:county.xml – per-county RSS feed ────────────────────────────
  // Fastify match: /rss/jefferson.xml → params.county = "jefferson"
  app.get("/rss/:county.xml", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Content-Type", "application/rss+xml; charset=utf-8");

    const rawCounty = decodeURIComponent(String(req.params?.county ?? ""));
    const county = normalizeCounty(rawCounty);
    if (!county) {
      reply.status(404);
      return reply.send("Not found");
    }

    const db = openDb();
    try {
      ensureSchema(db);
      const rows = db
        .prepare(
          `SELECT i.id, i.title, i.url, i.author, i.published_at, i.summary, i.ai_summary, i.image_url
           FROM items i
           JOIN item_locations il ON il.item_id = i.id
           WHERE il.state_code = 'KY'
             AND il.county = @county
             AND i.region_scope = 'ky'
             AND COALESCE(i.published_at, i.fetched_at) >= datetime('now', '-72 hours')
           ORDER BY COALESCE(i.published_at, i.fetched_at) DESC
           LIMIT 50`
        )
        .all({ county });

      if (!rows.length) {
        reply.status(404);
        return reply.send("Not found");
      }

      const buildDate = toRfc822(new Date().toISOString());
      const displayName = displayCountyName(county);
      const feedUrl = `${SITE_ORIGIN}/rss/${encodeURIComponent(county)}.xml`;
      const itemsXml = rows.map((r) => buildRssItem(r)).join("\n");

      const xml = [
        xmlDecl(),
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
        "  <channel>",
        `    <title>${escapeXml(`${displayName} County, Kentucky – Local News`)}</title>`,
        `    <link>${SITE_ORIGIN}/county/${countySlug(county)}</link>`,
        `    <description>${escapeXml(`Local news from ${displayName} County, Kentucky`)}</description>`,
        "    <language>en-us</language>",
        `    <lastBuildDate>${buildDate}</lastBuildDate>`,
        `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>`,
        itemsXml,
        "  </channel>",
        "</rss>"
      ].join("\n");
      return reply.send(xml);
    } catch (err) {
      reply.status(500);
      return reply.send(`Internal error: ${String(err?.message ?? err)}`);
    } finally {
      db.close();
    }
  });

  // ── 8. GET /api/structured-data/item/:id ─────────────────────────────────
  app.get("/api/structured-data/item/:id", async (req, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    const id = req.params?.id;
    const db = openDb();
    try {
      ensureSchema(db);
      const row = db
        .prepare(
          `SELECT id, title, url, author, published_at, fetched_at,
                  summary, ai_summary, image_url, article_text_excerpt
           FROM items
           WHERE id = ?`
        )
        .get(id);

      if (!row) return app.httpErrors.notFound("Item not found");

      const description = row.ai_summary || row.summary || "";
      const articleBody = row.article_text_excerpt
        ? String(row.article_text_excerpt).slice(0, 500)
        : "";
      const datePublished = row.published_at || row.fetched_at || "";
      const dateModified = row.fetched_at || row.published_at || "";

      const jsonLd = {
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        headline: row.title || "",
        url: `${SITE_ORIGIN}/news/${row.id}`,
        datePublished,
        dateModified,
        publisher: {
          "@type": "Organization",
          name: "Kentucky Local News",
          url: SITE_ORIGIN
        },
        description,
        articleBody
      };

      if (row.author) {
        jsonLd.author = { "@type": "Person", name: row.author };
      }
      if (row.image_url) {
        jsonLd.image = row.image_url;
      }

      reply.header("Content-Type", "application/ld+json");
      return reply.send(JSON.stringify(jsonLd, null, 2));
    } catch (err) {
      return app.httpErrors.internalServerError(String(err?.message ?? err));
    } finally {
      db.close();
    }
  });

  // ── 9. GET /api/structured-data/county/:county ──────────────────────────
  app.get("/api/structured-data/county/:county", async (req, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    const rawCounty = decodeURIComponent(String(req.params?.county ?? ""));
    const county = normalizeCounty(rawCounty);
    if (!county) return app.httpErrors.badRequest("Invalid county");

    const db = openDb();
    try {
      ensureSchema(db);
      const rows = db
        .prepare(
          `SELECT i.id, i.title
           FROM items i
           JOIN item_locations il ON il.item_id = i.id
           WHERE il.state_code = 'KY'
             AND il.county = @county
             AND i.region_scope = 'ky'
             AND COALESCE(i.published_at, i.fetched_at) >= datetime('now', '-7 days')
           ORDER BY COALESCE(i.published_at, i.fetched_at) DESC
           LIMIT 20`
        )
        .all({ county });

      const displayName = displayCountyName(county);
      const slug = countySlug(county);

      const jsonLd = {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: `${displayName} County News`,
        description: `Latest local news from ${displayName} County, Kentucky`,
        url: `${SITE_ORIGIN}/county/${slug}`,
        numberOfItems: rows.length,
        itemListElement: rows.map((row, idx) => ({
          "@type": "ListItem",
          position: idx + 1,
          url: `${SITE_ORIGIN}/news/${row.id}`,
          name: row.title || ""
        }))
      };

      reply.header("Content-Type", "application/ld+json");
      return reply.send(JSON.stringify(jsonLd, null, 2));
    } catch (err) {
      return app.httpErrors.internalServerError(String(err?.message ?? err));
    } finally {
      db.close();
    }
  });
}
