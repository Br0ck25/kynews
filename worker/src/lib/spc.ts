// worker/src/lib/spc.ts — Storm Prediction Center RSS auto-ingestion
import type { NewArticle } from '../types';
import { sha256Hex, normalizeCanonicalUrl } from './http';
import { findArticleByHash, insertArticle } from './db';

const SPC_USER_AGENT = 'LocalKYNews/1.0 (localkynews.com; news@localkynews.com)';

// ─── All 7 SPC RSS feed endpoints ────────────────────────────────────────────
// Each entry declares the feed URL and the product type it represents.
// The general feed (spcrss.xml) covers all products and is always polled;
// the remaining six are product-specific and give us early / targeted coverage.
export const SPC_FEEDS: { url: string; productHint: SpcProductType | null }[] = [
  { url: 'https://www.spc.noaa.gov/products/spcrss.xml',    productHint: null              }, // all products
  { url: 'https://www.spc.noaa.gov/products/spcwwrss.xml',  productHint: 'tornado_watch'   }, // watches (tornado + tstorm)
  { url: 'https://www.spc.noaa.gov/products/spcpdswwrss.xml', productHint: 'pds_watch'     }, // PDS (particularly dangerous situation) watches
  { url: 'https://www.spc.noaa.gov/products/spcmdrss.xml',  productHint: 'mesoscale_discussion' }, // mesoscale discussions
  { url: 'https://www.spc.noaa.gov/products/spcacrss.xml',  productHint: 'convective_outlook'   }, // convective outlooks (AC = all-convective)
  { url: 'https://www.spc.noaa.gov/products/spcmbrss.xml',  productHint: 'public_severe'   }, // public severe weather outlooks (MB)
  { url: 'https://www.spc.noaa.gov/products/spcfwrss.xml',  productHint: 'fire_weather'    }, // fire weather outlooks
];

// Fallback static images used when dynamic scraping fails to find one.
export const SPC_DAY1_RISK_MAP  = 'https://www.spc.noaa.gov/products/outlook/day1otlk.gif';
export const SPC_WATCH_MAP      = 'https://www.spc.noaa.gov/products/watch/ww.png';
export const SPC_FIRE_MAP       = 'https://www.spc.noaa.gov/products/fire_wx/fwdy1.gif';
export const SPC_MD_MAP         = 'https://www.spc.noaa.gov/products/md/';   // base path, used as fallback hint

// ─── Types ────────────────────────────────────────────────────────────────────

export type SpcProductType =
  | 'tornado_watch'
  | 'tstorm_watch'
  | 'pds_watch'
  | 'mesoscale_discussion'
  | 'convective_outlook'
  | 'public_severe'
  | 'fire_weather'
  | 'other';

export interface SpcItem {
  /** Human-readable title from the RSS feed */
  title: string;
  /** HTML page link, e.g. https://www.spc.noaa.gov/products/md/md0215.html */
  link: string;
  /** RSS description text (brief area summary) */
  description: string;
  /** ISO datetime */
  publishedAt: string;
  /** Product type inferred from title + feed hint */
  productType: SpcProductType;
  /** Source feed URL (for logging / deduplication) */
  feedUrl: string;
}

// Kentucky-relevant keywords.  Items matching ONLY broad national product
// keywords must still pass the full-text KY check before being published.
const KY_FILTER_TERMS = [
  'kentucky', ' ky ', ' ky,', ',ky', 'kentucky.', 'kentucky ',
  // broad national products that *may* affect KY — full-text verified before publish
  'tornado watch', 'severe thunderstorm watch', 'convective outlook',
  'mesoscale discussion', 'fire weather',
];

// ─── RSS fetch + parse ───────────────────────────────────────────────────────

/**
 * Fetch and parse all SPC RSS feeds.
 * Returns deduplicated items relevant to Kentucky across all feeds.
 */
export async function fetchAllSpcItems(): Promise<SpcItem[]> {
  const seen = new Set<string>(); // dedup by item link
  const all: SpcItem[] = [];

  const results = await Promise.allSettled(
    SPC_FEEDS.map((feed) => fetchSpcFeed(feed.url, feed.productHint)),
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const item of result.value) {
      if (seen.has(item.link)) continue;
      seen.add(item.link);
      all.push(item);
    }
  }

  return all;
}

/** Fetch one SPC RSS feed and return Kentucky-filtered items. */
async function fetchSpcFeed(
  feedUrl: string,
  productHint: SpcProductType | null,
): Promise<SpcItem[]> {
  let xml: string;
  try {
    const res = await fetch(feedUrl, {
      headers: { 'User-Agent': SPC_USER_AGENT, Accept: 'application/rss+xml, application/xml' },
    });
    if (!res.ok) return [];
    xml = await res.text();
  } catch {
    return [];
  }

  const items = parseRssItems(xml, feedUrl, productHint);

  return items.filter((item) => {
    const haystack = `${item.title} ${item.description}`.toLowerCase();
    return KY_FILTER_TERMS.some((term) => haystack.includes(term));
  });
}

function parseRssItems(
  xml: string,
  feedUrl: string,
  productHint: SpcProductType | null,
): SpcItem[] {
  const results: SpcItem[] = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title       = decodeXml(tagValue(block, 'title') ?? '').trim();
    const link        = decodeXml(tagValue(block, 'link')  ?? '').trim();
    const description = decodeXml(tagValue(block, 'description') ?? '').trim();
    const pubDateRaw  = tagValue(block, 'pubDate') ?? '';
    const pubDate     = pubDateRaw ? new Date(pubDateRaw).toISOString() : new Date().toISOString();

    if (!link) continue;

    results.push({
      title: title || 'SPC Weather Product',
      link,
      description,
      publishedAt: pubDate,
      productType: inferProductType(title, productHint),
      feedUrl,
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

function inferProductType(title: string, hint: SpcProductType | null): SpcProductType {
  const t = title.toLowerCase();
  if (t.includes('particularly dangerous situation') || t.includes('pds')) return 'pds_watch';
  if (t.includes('tornado watch'))                          return 'tornado_watch';
  if (t.includes('severe thunderstorm watch'))              return 'tstorm_watch';
  if (t.includes('mesoscale discussion'))                   return 'mesoscale_discussion';
  if (t.includes('convective outlook') || /day\s*[123]/.test(t)) return 'convective_outlook';
  if (t.includes('fire weather'))                           return 'fire_weather';
  if (t.includes('public severe'))                          return 'public_severe';
  // fall back to the feed-level hint if title parsing didn't resolve a specific type
  if (hint) return hint;
  return 'other';
}

// ─── Dynamic image extraction ────────────────────────────────────────────────

/**
 * Scrape the SPC product HTML page and return the first meaningful image
 * or GIF URL found in the page content.  Prefers in-page <img> tags over
 * the static fallback images.
 *
 * Strategy (in priority order):
 *  1. Look for <img> tags inside the main product content area.
 *  2. Look for any spc.noaa.gov absolute image URL in the HTML.
 *  3. Return null if nothing found (caller will use a static fallback).
 */
async function extractSpcPageImage(htmlUrl: string): Promise<string | null> {
  let html: string;
  try {
    const res = await fetch(htmlUrl, {
      headers: { 'User-Agent': SPC_USER_AGENT },
      // 5 s timeout via AbortController
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const baseUrl = 'https://www.spc.noaa.gov';

  // 1. Find <img src="..."> tags — prefer .gif, .png, .jpg
  //    Exclude tiny decorative images (e.g. 1x1 spacers, icons < 10px implied by name)
  const imgRegex = /<img[^>]+src=["']([^"']+\.(?:gif|png|jpg|jpeg))["'][^>]*>/gi;
  const candidates: string[] = [];
  let imgMatch: RegExpExecArray | null;

  while ((imgMatch = imgRegex.exec(html)) !== null) {
    const src = imgMatch[1];
    if (!src) continue;
    // Skip tiny icons / bullets
    if (/\b(?:1x1|spacer|bullet|arrow|icon|logo|nav)\b/i.test(src)) continue;
    // Build absolute URL
    const abs = src.startsWith('http') ? src : `${baseUrl}${src.startsWith('/') ? '' : '/'}${src}`;
    candidates.push(abs);
  }

  // Prefer GIFs (SPC's primary map format) over PNGs, then any image
  const gif = candidates.find((u) => u.endsWith('.gif'));
  if (gif) return gif;
  const png = candidates.find((u) => u.endsWith('.png') || u.endsWith('.jpg') || u.endsWith('.jpeg'));
  if (png) return png;

  // 2. Brute-force scan for any spc.noaa.gov image URL in raw HTML
  const rawImgMatch = /https?:\/\/www\.spc\.noaa\.gov\/[^\s"'<>]+\.(?:gif|png|jpg|jpeg)/i.exec(html);
  if (rawImgMatch) return rawImgMatch[0];

  return null;
}

// ─── Full-text fetch ─────────────────────────────────────────────────────────

/**
 * Fetch the plain-text version of an SPC product page (.html → .txt).
 * Returns empty string on failure.
 */
async function fetchSpcFullText(htmlUrl: string): Promise<string> {
  const txtUrl = htmlUrl.replace(/\.html?$/i, '.txt');
  if (txtUrl === htmlUrl) return '';

  try {
    const res = await fetch(txtUrl, {
      headers: { 'User-Agent': SPC_USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const text = await res.text();
    return text.replace(/\f/g, '').replace(/^\s*\d{3}\s*\n/, '').trim();
  } catch {
    return '';
  }
}

// ─── Article builder ─────────────────────────────────────────────────────────

/** Choose the static fallback image for a product type. */
function getFallbackImageUrl(productType: SpcProductType): string {
  switch (productType) {
    case 'tornado_watch':
    case 'tstorm_watch':
    case 'pds_watch':
      return SPC_WATCH_MAP;
    case 'fire_weather':
      return SPC_FIRE_MAP;
    case 'mesoscale_discussion':
    case 'convective_outlook':
    case 'public_severe':
    case 'other':
    default:
      return SPC_DAY1_RISK_MAP;
  }
}

/** Human-readable product name for article copy. */
function humanProductType(t: SpcProductType): string {
  switch (t) {
    case 'tornado_watch':         return 'tornado watch';
    case 'tstorm_watch':          return 'severe thunderstorm watch';
    case 'pds_watch':             return 'particularly dangerous situation (PDS) watch';
    case 'mesoscale_discussion':  return 'mesoscale discussion';
    case 'convective_outlook':    return 'convective outlook';
    case 'public_severe':         return 'public severe weather outlook';
    case 'fire_weather':          return 'fire weather outlook';
    default:                      return 'weather product';
  }
}

/** Produce a clean display title. */
function buildTitle(item: SpcItem): string {
  const base = item.title.replace(/^SPC\s+/i, '').trim() || item.title;
  return `${base} — Storm Prediction Center Update`.slice(0, 200);
}

/** Compose article body from RSS description + optional full text. */
function buildBody(
  item: SpcItem,
  fullText: string,
  imageUrl: string,
): { contentText: string; contentHtml: string } {
  const productLabel = humanProductType(item.productType);
  const textParagraphs: string[] = [];

  textParagraphs.push(
    `The Storm Prediction Center has issued a new ${productLabel} affecting portions of the region.`,
  );

  if (item.description) {
    const cleanDesc = item.description.replace(/\s{2,}/g, ' ').trim();
    textParagraphs.push(`Summary: ${cleanDesc}`);
  }

  if (fullText) {
    const shortened = fullText.slice(0, 1500).trim();
    const parts = shortened
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    textParagraphs.push('Full meteorologist discussion:', ...parts);
  }

  textParagraphs.push(
    'More updates will be provided as additional information becomes available.',
    'Stay tuned to Local KY News for additional weather updates.',
  );

  const contentText = textParagraphs.join('\n\n');

  // HTML — embed the extracted (or fallback) image at the top of the article
  const imageAlt = `SPC ${humanProductType(item.productType)} map`;
  const imageHtml = `<p><img src="${imageUrl}" alt="${imageAlt}" style="max-width:100%;border:1px solid #ccc;border-radius:4px;"></p>`;

  const bodyHtml = textParagraphs
    .slice(0, -1)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  const contentHtml = [
    imageHtml,
    bodyHtml,
    `<p>Stay tuned to Local KY News for additional weather updates.</p>`,
  ].join('\n');

  return { contentText, contentHtml };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

export async function buildSpcArticle(
  item: SpcItem,
): Promise<NewArticle & { _rawFullText: string }> {
  const canonicalUrl = item.link;
  const urlHash = await sha256Hex(normalizeCanonicalUrl(canonicalUrl));

  // Fetch full product text and extract page image in parallel
  const [fullText, scrapedImageUrl] = await Promise.all([
    fetchSpcFullText(item.link),
    extractSpcPageImage(item.link),
  ]);

  // Use the dynamically extracted image; fall back to the static product-type map
  const imageUrl = scrapedImageUrl ?? getFallbackImageUrl(item.productType);

  const { contentText, contentHtml } = buildBody(item, fullText, imageUrl);

  const title = buildTitle(item);
  const seoDescription = `${title}. ${item.description}`.replace(/\s+/g, ' ').slice(0, 300);
  const now = new Date().toISOString();

  const baseSlug = slugify(title) || urlHash.slice(0, 8);
  const slug = `${baseSlug}-${urlHash.slice(0, 8)}`;

  const imageAlt = imageUrl
    ? [title].filter(Boolean).join(' — ')
    : null;

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
    summary: contentText.slice(0, 800),
    seoDescription,
    rawWordCount: contentText.split(/\s+/).filter(Boolean).length,
    summaryWordCount: 0,
    contentText,
    contentHtml,
    imageUrl,
    imageAlt,
    rawR2Key: null,
    slug,
    contentHash: await sha256Hex(contentText.slice(0, 3000)),
    _rawFullText: fullText,
  };
}

// ─── Kentucky relevance check ────────────────────────────────────────────────

function isKentuckyContent(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('kentucky') || /\bky\b/.test(lower);
}

function isPlaceholderStatusReport(text: string): boolean {
  return /has not been issued yet/i.test(text);
}

// ─── KV deduplication ────────────────────────────────────────────────────────

async function spcDedupeKey(link: string): Promise<string> {
  return `spc:item:${await sha256Hex(link)}`;
}

async function markSpcItemIfNew(env: Env, link: string): Promise<boolean> {
  if (!env.CACHE) return true;
  const key = await spcDedupeKey(link);
  if (await env.CACHE.get(key)) return false;
  await env.CACHE.put(key, '1', { expirationTtl: 259200 }); // 72 h
  return true;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Poll all 7 SPC RSS feeds for new Kentucky-relevant products and publish any
 * that haven't been seen before.  Called from the scheduled handler.
 */
export async function processSpcFeed(
  env: Env,
): Promise<{ published: number; skipped: number }> {
  let published = 0;
  let skipped = 0;

  let items: SpcItem[];
  try {
    items = await fetchAllSpcItems();
  } catch (err) {
    console.error('[SPC] fetchAllSpcItems failed', err);
    return { published: 0, skipped: 0 };
  }

  console.log(`[SPC] Fetched ${items.length} KY-candidate items across all feeds`);

  for (const item of items) {
    try {
      // 1. KV dedup — skip if already published
      const isNew = await markSpcItemIfNew(env, item.link);
      if (!isNew) {
        skipped++;
        continue;
      }

      // 2. Build article (fetches full text + extracts page image in parallel)
      const article = await buildSpcArticle(item);

      // 3. Hard KY gate — raw product text OR RSS description must mention KY
      const kyCheckText = `${article._rawFullText} ${item.description}`;
      if (!isKentuckyContent(kyCheckText)) {
        console.log(`[SPC] Skipped non-KY product: "${item.title}" (feed: ${item.feedUrl})`);
        skipped++;
        continue;
      }

      // 4. Skip unissued placeholder pages; un-mark KV so we retry next tick
      if (isPlaceholderStatusReport(article._rawFullText)) {
        console.log(`[SPC] Skipped placeholder: "${item.title}"`);
        if (env.CACHE) {
          const key = await spcDedupeKey(item.link);
          await env.CACHE.delete(key).catch(() => {});
        }
        skipped++;
        continue;
      }

      // 5. DB dedup — guard against KV being cleared
      const existing = await findArticleByHash(env, article.urlHash);
      if (existing) {
        skipped++;
        continue;
      }

      // 6. AI summarization
      const { summarizeArticle } = await import('./ai');
      const aiResult = await summarizeArticle(
        env,
        article.urlHash,
        article.title,
        article.contentText,
        article.publishedAt,
      ).catch(() => null);

      if (aiResult) {
        article.summary           = aiResult.summary;
        article.seoDescription    = aiResult.seoDescription || article.seoDescription;
        article.summaryWordCount  = aiResult.summaryWordCount;
      }

      // 7. Insert into D1
      const id = await insertArticle(env, article);
      published++;
      console.log(
        `[SPC] Published: "${article.title}" → id=${id} | feed=${item.feedUrl} | image=${article.imageUrl}`,
      );
    } catch (err) {
      console.error(`[SPC] Failed to publish item ${item.link}:`, err);
    }
  }

  return { published, skipped };
}
