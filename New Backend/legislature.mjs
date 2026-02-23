/**
 * Kentucky Legislature Tracker
 *
 * Two functions:
 *  1. Scrape legislature.ky.gov for active bills and cache in ky_bills table
 *  2. Scan article text for bill number mentions (HB 123, SB 45, HCR 7 etc.)
 *     and link articles to bills via article_bills junction table
 *
 * Schedule: Run bill scraper daily. Run article tagging in body-worker pipeline.
 */

import * as cheerio from "cheerio";

const LRC_BASE = "https://legislature.ky.gov";
const BILL_LIST_URL = `${LRC_BASE}/Legislation/default.aspx`;

// Bill number regex — matches:
//   HB 123, SB 45, HCR 7, HR 200, SCR 12, SJR 3, HJR 18
//   Also handles no-space variants: HB123, sb45
const BILL_RE = /\b(H\.?B\.?|S\.?B\.?|H\.?C\.?R\.?|S\.?C\.?R\.?|H\.?J\.?R\.?|S\.?J\.?R\.?|H\.?R\.?|S\.?R\.?)\s*(\d{1,4})\b/gi;

// Bill type full names
const BILL_TYPE_NAMES = {
  "HB":  "House Bill",
  "SB":  "Senate Bill",
  "HCR": "House Concurrent Resolution",
  "SCR": "Senate Concurrent Resolution",
  "HJR": "House Joint Resolution",
  "SJR": "Senate Joint Resolution",
  "HR":  "House Resolution",
  "SR":  "Senate Resolution",
};

// ─── Bill scraping ────────────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (compatible; KYNewsAggregator/1.0; +https://localkynews.com/bot)";

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

/**
 * Determine current legislative session year.
 * KY General Assembly meets in even years (regular) and odd years (short session).
 */
function currentSession() {
  const year = new Date().getFullYear();
  return year;
}

/**
 * Scrape the LRC bill index for the current session.
 * Returns array of { billNumber, billType, title, status, sponsor, url }
 *
 * Note: LRC uses ASP.NET WebForms — the bill list is rendered server-side.
 * We scrape the HTML table on the default legislation page.
 */
export async function scrapeLegislatureBills() {
  const session = currentSession();
  const url = `${LRC_BASE}/Legislation/default.aspx`;

  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    console.error(`Legislature scrape failed: ${err.message}`);
    return [];
  }

  const $ = cheerio.load(html);
  const bills = [];

  // LRC renders a table with class "table" for bill listings
  $("table.table tbody tr, .bill-list tr, #ctl00_ContentPlaceHolder1_gridView_GridView tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 3) return;

    const billCell = $(cells[0]);
    const link = billCell.find("a").first();
    const billText = link.text().trim() || billCell.text().trim();
    const relUrl = link.attr("href") || "";
    const fullUrl = relUrl ? new URL(relUrl, LRC_BASE).toString() : "";

    const titleText = $(cells[1]).text().trim();
    const statusText = cells.length > 2 ? $(cells[cells.length - 1]).text().trim() : "";

    if (!billText) return;

    // Parse bill number from text like "HB 1" or "SB 100"
    const match = billText.match(/^([A-Z]+)\s*(\d+)/i);
    if (!match) return;

    const rawType = match[1].toUpperCase().replace(/\./g, "");
    const billNum = parseInt(match[2], 10);
    const billType = BILL_TYPE_NAMES[rawType] ? rawType : null;
    if (!billType) return;

    bills.push({
      billNumber: `${billType} ${billNum}`,
      billType,
      billNum,
      title: titleText.slice(0, 500),
      status: statusText.slice(0, 100),
      url: fullUrl,
      session,
    });
  });

  return bills;
}

/**
 * Upsert bills into ky_bills table.
 */
export async function syncBillsToDb(db, bills) {
  for (const bill of bills) {
    await db.prepare(`
      INSERT INTO ky_bills (bill_number, bill_type, bill_num, title, status, url, session_year, updated_at)
      VALUES (@billNumber, @billType, @billNum, @title, @status, @url, @session, datetime('now'))
      ON CONFLICT(bill_number) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(bill);
  }
}

// ─── Article bill tagging ─────────────────────────────────────────────────────

/**
 * Extract all bill mentions from article text.
 * Returns array of normalised bill number strings like ["HB 1", "SB 200"]
 */
export function extractBillMentions(text) {
  if (!text) return [];
  const found = new Set();
  let m;
  const re = new RegExp(BILL_RE.source, "gi");

  while ((m = re.exec(text)) !== null) {
    const rawType = m[1].toUpperCase().replace(/\./g, "");
    const num = parseInt(m[2], 10);
    if (!isNaN(num) && BILL_TYPE_NAMES[rawType]) {
      found.add(`${rawType} ${num}`);
    }
  }

  return [...found];
}

/**
 * Tag an article with any bill mentions found in title + body.
 * Inserts into article_bills junction table.
 */
export async function tagArticleWithBills(db, itemId, title, body) {
  const combined = `${title} ${body}`;
  const mentions = extractBillMentions(combined);

  if (mentions.length === 0) return;

  for (const billNumber of mentions) {
    // Only link bills that exist in our ky_bills table
    const bill = await db.prepare(
      `SELECT bill_number FROM ky_bills WHERE bill_number = @bn`
    ).get({ bn: billNumber });

    if (bill) {
      await db.prepare(`
        INSERT OR IGNORE INTO article_bills (item_id, bill_number)
        VALUES (@item_id, @bill_number)
      `).run({ item_id: itemId, bill_number: billNumber });
    }
  }

  // Also add "legislature" to categories
  if (mentions.length > 0) {
    await db.prepare(`
      INSERT OR IGNORE INTO item_categories (item_id, category) VALUES (@id, 'legislature')
    `).run({ id: itemId });
  }
}
