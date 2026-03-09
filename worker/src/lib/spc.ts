// worker/src/lib/spc.ts — Storm Prediction Center RSS auto-ingestion
import type { NewArticle } from '../types';
import { sha256Hex, normalizeCanonicalUrl } from './http';
import { findArticleByHash, insertArticle } from './db';

const SPC_RSS_URL = 'https://www.spc.noaa.gov/products/spcrss.xml';
const SPC_USER_AGENT = 'LocalKYNews/1.0 (localkynews.com; news@localkynews.com)';

// Image assets embedded in SPC articles
const SPC_DAY1_RISK_MAP = 'https://www.spc.noaa.gov/products/outlook/day1otlk.gif';
const SPC_WATCH_MAP = 'https://www.spc.noaa.gov/products/watch/ww.png';

// Kentucky-relevant keywords used as a first-pass pre-filter on the RSS feed.
// Items that pass only because of a broad product type (e.g. 'tornado watch')
// are still subject to the full-text KY relevance check in processSpcFeed before
// they can be published.  Non-KY products caught by the broad terms will be
// dropped at that second stage.
const KY_FILTER_TERMS = [
  'kentucky', ' ky ', ' ky,', ',ky', 'kentucky.', 'kentucky ',
  // broad national products that *may* affect KY — full-text verified before publish
  'tornado watch', 'severe thunderstorm watch', 'convective outlook',
  'mesoscale discussion',
];

export interface SpcItem {
  /** Human-readable title from the RSS feed */
  title: string;
  /** HTML page link, e.g. https://www.spc.noaa.gov/products/md/md0215.html */
  link: string;
  /** RSS description text (brief area summary) */
  description: string;
  /** ISO datetime */
  publishedAt: string;
  /** Product type inferred from title */
  productType: SpcProductType;
}

type SpcProductType =
  | 'tornado_watch'
  | 'tstorm_watch'
  | 'mesoscale_discussion'
  | 'convective_outlook'
  | 'fire_weather'
  | 'other';

// ─── RSS fetch + parse ───────────────────────────────────────────────────────

/** Fetch and parse the SPC RSS feed. Returns items relevant to Kentucky. */
export async function fetchSpcItems(): Promise<SpcItem[]> {
  let xml: string;
  try {
    const res = await fetch(SPC_RSS_URL, {
      headers: { 'User-Agent': SPC_USER_AGENT, Accept: 'application/rss+xml, application/xml' },
    });
    if (!res.ok) return [];
    xml = await res.text();
  } catch {
    return [];
  }

  const items = parseRssItems(xml);

  return items.filter((item) => {
    const haystack = `${item.title} ${item.description}`.toLowerCase();
    return KY_FILTER_TERMS.some((term) => haystack.includes(term));
  });
}

function parseRssItems(xml: string): SpcItem[] {
  const results: SpcItem[] = [];
  // Match each <item>…</item> block
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = decodeXml(tagValue(block, 'title') ?? '').trim();
    const link = decodeXml(tagValue(block, 'link') ?? '').trim();
    const description = decodeXml(tagValue(block, 'description') ?? '').trim();
    const pubDateRaw = tagValue(block, 'pubDate') ?? '';
    const pubDate = pubDateRaw ? new Date(pubDateRaw).toISOString() : new Date().toISOString();

    if (!link) continue;

    results.push({
      title: title || 'SPC Weather Product',
      link,
      description,
      publishedAt: pubDate,
      productType: inferProductType(title),
    });
  }

  return results;
}

function tagValue(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  return m ? m[1] : null;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function inferProductType(title: string): SpcProductType {
  const t = title.toLowerCase();
  if (t.includes('tornado watch')) return 'tornado_watch';
  if (t.includes('severe thunderstorm watch')) return 'tstorm_watch';
  if (t.includes('mesoscale discussion')) return 'mesoscale_discussion';
  if (t.includes('convective outlook') || t.includes('day 1') || t.includes('day1')) return 'convective_outlook';
  if (t.includes('fire weather')) return 'fire_weather';
  return 'other';
}

// ─── Deduplication ───────────────────────────────────────────────────────────

/** KV dedup key for an SPC item (keyed by item URL). */
async function spcDedupeKey(link: string): Promise<string> {
  return `spc:item:${await sha256Hex(link)}`;
}

/** Returns true if the item is new (and marks it seen). */
async function markSpcItemIfNew(env: Env, link: string): Promise<boolean> {
  if (!env.CACHE) return true;
  const key = await spcDedupeKey(link);
  if (await env.CACHE.get(key)) return false;
  // 72h TTL — SPC products don't expire that quickly
  await env.CACHE.put(key, '1', { expirationTtl: 259200 });
  return true;
}

// ─── Full-text fetch ─────────────────────────────────────────────────────────

/**
 * Fetch the plain-text version of an SPC product page.
 * SPC hosts .txt equivalents for most .html product pages.
 * Returns empty string on failure.
 */
async function fetchSpcFullText(htmlUrl: string): Promise<string> {
  // Convert .html → .txt (works for MD, watches, and outlook pages)
  const txtUrl = htmlUrl.replace(/\.html?$/i, '.txt');
  if (txtUrl === htmlUrl) return ''; // no conversion possible

  try {
    const res = await fetch(txtUrl, {
      headers: { 'User-Agent': SPC_USER_AGENT },
    });
    if (!res.ok) return '';
    const text = await res.text();
    // SPC .txt files start with form-feed characters and line separators — clean them
    return text
      .replace(/\f/g, '')
      .replace(/^\s*\d{3}\s*\n/, '')
      .trim();
  } catch {
    return '';
  }
}

// ─── Article builder ─────────────────────────────────────────────────────────

/** Choose the right SPC map image for the product type. */
function getSpcMapHtml(productType: SpcProductType): string {
  if (productType === 'tornado_watch' || productType === 'tstorm_watch') {
    return `<p><strong>Current Watch Map:</strong></p>\n<p><img src="${SPC_WATCH_MAP}" alt="SPC Watch Map" style="max-width:100%;border:1px solid #ccc;border-radius:4px;"></p>`;
  }
  // Convective outlook, mesoscale discussion, fire weather, other — use day1 risk map
  return `<p><strong>Day 1 Convective Risk Map:</strong></p>\n<p><img src="${SPC_DAY1_RISK_MAP}" alt="SPC Day 1 Convective Outlook" style="max-width:100%;border:1px solid #ccc;border-radius:4px;"></p>`;
}

/** Produce a clean display title based on the RSS item. */
function buildTitle(item: SpcItem): string {
  // Plan §7: "{TITLE} — Storm Prediction Center Update"
  // Strip the "SPC " prefix from the raw RSS title then append the suffix.
  const base = item.title.replace(/^SPC\s+/i, '').trim() || item.title;
  return `${base} — Storm Prediction Center Update`.slice(0, 200);
}

/** Compose the article body from item RSS description + optional full text. */
function buildBody(item: SpcItem, fullText: string): { contentText: string; contentHtml: string } {
  const textParagraphs: string[] = [];

  // Opening sentence — plan §7 template
  textParagraphs.push(
    `The Storm Prediction Center has issued a new weather update affecting portions of the region.`,
  );

  // Brief summary from RSS description
  if (item.description) {
    const cleanDesc = item.description.replace(/\s{2,}/g, ' ').trim();
    textParagraphs.push(`Summary: ${cleanDesc}`);
  }

  // Full discussion text (if successfully fetched) — first ~1000 chars to keep it readable
  if (fullText) {
    const shortened = fullText.slice(0, 1500).trim();
    const parts = shortened.split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
    // Plan §7: "Full meteorologist discussion:"
    textParagraphs.push('Full meteorologist discussion:', ...parts);
  }

  textParagraphs.push(
    'More updates will be provided as additional information becomes available.',
    'Stay tuned to Local KY News for additional weather updates.',
  );

  const contentText = textParagraphs.join('\n\n');

  // HTML — structured paragraphs with SPC map image
  const mapHtml = getSpcMapHtml(item.productType);
  const bodyHtml = textParagraphs
    .slice(0, -1) // all but closing "Stay tuned" line
    .map((p) => `<p>${p}</p>`)
    .join('\n');

  const contentHtml = [
    bodyHtml,
    mapHtml,
    `<p>Stay tuned to Local KY News for additional weather updates.</p>`,
  ].join('\n');

  return { contentText, contentHtml };
}

function humanProductType(t: SpcProductType): string {
  switch (t) {
    case 'tornado_watch': return 'tornado watch';
    case 'tstorm_watch': return 'severe thunderstorm watch';
    case 'mesoscale_discussion': return 'mesoscale discussion';
    case 'convective_outlook': return 'convective outlook';
    case 'fire_weather': return 'fire weather outlook';
    default: return 'weather product';
  }
}

export async function buildSpcArticle(item: SpcItem): Promise<NewArticle> {
  const canonicalUrl = item.link;
  const urlHash = await sha256Hex(normalizeCanonicalUrl(canonicalUrl));

  const fullText = await fetchSpcFullText(item.link);
  const { contentText, contentHtml } = buildBody(item, fullText);

  const title = buildTitle(item);
  const seoDescription =
    `${title}. ${item.description}`.replace(/\s+/g, ' ').slice(0, 300);
  const now = new Date().toISOString();

  return {
    canonicalUrl,
    sourceUrl: canonicalUrl,
    urlHash,
    title,
    author: 'Storm Prediction Center',
    publishedAt: item.publishedAt || now,
    category: 'weather',
    isKentucky: true,
    isNational: false,
    county: null,
    counties: [],
    city: null,
    // Fallback summary — overwritten by summarizeArticle() in processSpcFeed()
    summary: contentText.slice(0, 800),
    seoDescription,
    rawWordCount: contentText.split(/\s+/).filter(Boolean).length,
    summaryWordCount: 0,
    contentText,
    contentHtml,
    imageUrl: null,
    rawR2Key: null,
    contentHash: await sha256Hex(contentText.slice(0, 3000)),
  };
}

// ─── Kentucky relevance check ────────────────────────────────────────────────

/**
 * Returns true if the text clearly mentions Kentucky by name or by the
 * common two-letter abbreviation as a standalone word.  Used as a final gate
 * before publishing SPC products that passed the broad RSS pre-filter.
 */
function isKentuckyContent(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('kentucky') || /\bky\b/.test(lower);
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Check the SPC RSS feed for new Kentucky-relevant products and publish any
 * that haven't been seen before.  Called from the scheduled handler via ctx.waitUntil().
 */
export async function processSpcFeed(env: Env): Promise<{ published: number; skipped: number }> {
  let published = 0;
  let skipped = 0;

  let items: SpcItem[];
  try {
    items = await fetchSpcItems();
  } catch (err) {
    console.error('[SPC] fetchSpcItems failed', err);
    return { published: 0, skipped: 0 };
  }

  for (const item of items) {
    try {
      // 1. KV dedup — skip if we've already published this SPC item URL
      const isNew = await markSpcItemIfNew(env, item.link);
      if (!isNew) {
        skipped++;
        continue;
      }

      // 2. Build the base article record (also fetches full product text)
      const article = await buildSpcArticle(item);

      // 2a. Hard KY gate — the full text must mention Kentucky or ", KY".
      //     This blocks non-KY products (e.g. a Texas tornado watch) that
      //     slipped through the broad RSS pre-filter terms.
      if (!isKentuckyContent(article.contentText)) {
        console.log(`[SPC] Skipped non-KY product: "${item.title}"`);
        skipped++;
        continue;
      }

      // 3. DB dedup — check url_hash in case KV was cleared
      const existing = await findArticleByHash(env, article.urlHash);
      if (existing) {
        skipped++;
        continue;
      }

      // 4. Run AI summarization (same as normal ingest pipeline)
      const { summarizeArticle } = await import('./ai');
      const aiResult = await summarizeArticle(
        env,
        article.urlHash,
        article.title,
        article.contentText,
        article.publishedAt,
      ).catch(() => null);

      if (aiResult) {
        article.summary = aiResult.summary;
        article.seoDescription = aiResult.seoDescription || article.seoDescription;
        article.summaryWordCount = aiResult.summaryWordCount;
      }

      // 5. Insert into D1
      const id = await insertArticle(env, article);
      published++;
      console.log(`[SPC] Published: "${article.title}" → id=${id}`);
    } catch (err) {
      console.error(`[SPC] Failed to publish item ${item.link}:`, err);
    }
  }

  return { published, skipped };
}
