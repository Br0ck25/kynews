// worker/src/lib/spc.ts — Storm Prediction Center RSS auto-ingestion
import type { NewArticle } from '../types';
import { sha256Hex, normalizeCanonicalUrl } from './http';
import { findArticleByHash, insertArticle } from './db';

const SPC_RSS_URL = 'https://www.spc.noaa.gov/products/spcrss.xml';
const SPC_USER_AGENT = 'LocalKYNews/1.0 (localkynews.com; news@localkynews.com)';

// Image assets embedded in SPC articles
export const SPC_DAY1_RISK_MAP = 'https://www.spc.noaa.gov/products/outlook/day1otlk.gif';
export const SPC_WATCH_MAP = 'https://www.spc.noaa.gov/products/watch/ww.png';

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

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Parse a raw SPC product full-text into named sections.
 * Returns a map of section name → clean paragraph text.
 * Recognised sections: SUMMARY, DISCUSSION, and key metadata lines
 * (Areas affected, Concerning, Valid, Probability of Watch Issuance,
 * MOST PROBABLE PEAK TORNADO INTENSITY, etc.).
 */
function parseSpcFullText(raw: string): {
  areasAffected: string;
  concerning: string;
  watchProbability: string;
  valid: string;
  summary: string;
  discussion: string;
  peakTornadoIntensity: string;
  peakHailSize: string;
  peakWindGust: string;
} {
  const normalized = raw.replace(/\r\n/g, '\n');

  // ── Single-line metadata fields ───────────────────────────────────────────
  const extract = (pattern: RegExp): string => {
    const m = normalized.match(pattern);
    return m ? m[1].trim() : '';
  };

  const areasAffected = extract(/Areas affected\.{3}([\s\S]*?)(?=\n\n|\nConcerning|\nValid)/i)
    .replace(/\n\s+/g, ' ').trim();
  const concerning = extract(/Concerning\.{3}([\s\S]*?)(?=\n\n|\nValid|\nProbability)/i)
    .replace(/\n\s+/g, ' ').trim();
  const valid = extract(/Valid\s+([\d]+Z\s*-\s*[\d]+Z)/i);
  const watchProbability = extract(/Probability of Watch Issuance\.{3}([^\n]+)/i);
  const peakTornadoIntensity = extract(/MOST PROBABLE PEAK TORNADO INTENSITY\.{3}([^\n]+)/i);
  const peakHailSize = extract(/MOST PROBABLE PEAK HAIL SIZE\.{3}([^\n]+)/i);
  const peakWindGust = extract(/MOST PROBABLE PEAK WIND GUST\.{3}([^\n]+)/i);

  // ── Multi-line SUMMARY block ───────────────────────────────────────────────
  const summaryMatch = normalized.match(/SUMMARY\.{3}([\s\S]*?)(?=\n\s*\n\s*(?:DISCUSSION|\.\.[\w]))/i);
  const summary = summaryMatch
    ? summaryMatch[1].replace(/\n\s+/g, ' ').replace(/\s{2,}/g, ' ').trim()
    : '';

  // ── Multi-line DISCUSSION block ────────────────────────────────────────────
  // Stop before the forecaster initials line (e.g. "..Chalmers/Gleason.. 03/10/2026")
  const discussionMatch = normalized.match(/DISCUSSION\.{3}([\s\S]*?)(?=\n\s*\.\.[A-Za-z\/]+\.\.\s+\d{2}\/\d{2}\/\d{4}|\nATTN\.\.\.|\nLAT\.\.\.)/i);
  const discussion = discussionMatch
    ? discussionMatch[1]
        .split(/\n\n+/)
        .map((p) => p.replace(/\n\s+/g, ' ').replace(/\s{2,}/g, ' ').trim())
        .filter(Boolean)
        .join('\n\n')
    : '';

  return { areasAffected, concerning, watchProbability, valid, summary, discussion, peakTornadoIntensity, peakHailSize, peakWindGust };
}

/** Compose the article body from item RSS description + optional full text. */
function buildBody(item: SpcItem, fullText: string): { contentText: string; contentHtml: string } {

  // ── Parse structured sections from full text if available ─────────────────
  const parsed = fullText ? parseSpcFullText(fullText) : null;

  // ── Plain-text version ────────────────────────────────────────────────────
  const textLines: string[] = [];

  const productLabel = humanProductType(item.productType);
  textLines.push(
    `The Storm Prediction Center has issued a ${productLabel} update` +
    (parsed?.areasAffected ? ` affecting ${parsed.areasAffected}.` : ' affecting portions of the region.'),
  );

  if (parsed?.concerning) {
    textLines.push(`Concern: ${parsed.concerning}`);
  }
  if (parsed?.watchProbability) {
    textLines.push(`Watch issuance probability: ${parsed.watchProbability}`);
  }

  if (parsed?.summary) {
    textLines.push(parsed.summary);
  } else if (item.description) {
    // Fall back to a cleaned RSS description — strip the raw product header line (e.g. "MD 0187 CONCERNING...")
    const cleanDesc = item.description
      .replace(/^MD\s+\d+\s+[A-Z .]+\n?/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleanDesc) textLines.push(cleanDesc);
  }

  // Probable peak hazard stats (when present)
  const hazards: string[] = [];
  if (parsed?.peakTornadoIntensity) hazards.push(`Peak tornado intensity: ${parsed.peakTornadoIntensity}`);
  if (parsed?.peakHailSize) hazards.push(`Peak hail size: ${parsed.peakHailSize}`);
  if (parsed?.peakWindGust) hazards.push(`Peak wind gust: ${parsed.peakWindGust}`);
  if (hazards.length > 0) textLines.push(hazards.join('\n'));

  if (parsed?.discussion) {
    textLines.push('Meteorologist Discussion\n\n' + parsed.discussion);
  }

  textLines.push(
    'More updates will be provided as additional information becomes available.',
    'Stay tuned to Local KY News for additional weather updates.',
  );

  const contentText = textLines.join('\n\n');

  // ── HTML version ──────────────────────────────────────────────────────────
  const mapHtml = getSpcMapHtml(item.productType);
  const htmlParts: string[] = [];

  // Lead paragraph
  htmlParts.push(`<p>${esc(textLines[0])}</p>`);

  // Metadata pills / quick-facts block
  const metaItems: string[] = [];
  if (parsed?.concerning) metaItems.push(`<strong>Concern:</strong> ${esc(parsed.concerning)}`);
  if (parsed?.watchProbability) metaItems.push(`<strong>Watch probability:</strong> ${esc(parsed.watchProbability)}`);
  if (parsed?.valid) metaItems.push(`<strong>Valid:</strong> ${esc(parsed.valid)}`);
  if (metaItems.length > 0) {
    htmlParts.push(`<ul>${metaItems.map((m) => `<li>${m}</li>`).join('\n')}</ul>`);
  }

  // Summary section
  const summaryText = parsed?.summary || (item.description ? item.description.replace(/^MD\s+\d+\s+[A-Z .]+\n?/i, '').replace(/\s{2,}/g, ' ').trim() : '');
  if (summaryText) {
    htmlParts.push(`<h3>Summary</h3>\n<p>${esc(summaryText)}</p>`);
  }

  // Probable peak hazards
  if (hazards.length > 0) {
    htmlParts.push(
      `<h3>Probable Peak Hazards</h3>\n<ul>${hazards.map((h) => `<li>${esc(h)}</li>`).join('\n')}</ul>`,
    );
  }

  // Map image
  htmlParts.push(mapHtml);

  // Full discussion
  if (parsed?.discussion) {
    const discussionHtml = parsed.discussion
      .split(/\n\n+/)
      .map((p) => `<p>${esc(p.trim())}</p>`)
      .join('\n');
    htmlParts.push(`<h3>Meteorologist Discussion</h3>\n${discussionHtml}`);
  }

  htmlParts.push(`<p>Stay tuned to Local KY News for additional weather updates.</p>`);

  const contentHtml = htmlParts.join('\n');

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

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
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

  // generate a mostly-readable slug from the title plus a short hash
  const baseSlug = slugify(title) || urlHash.slice(0, 8);
  const slug = `${baseSlug}-${urlHash.slice(0, 8)}`;

  // choose a representative image — the same map we embed in the body
  const imageUrl =
    item.productType === 'tornado_watch' || item.productType === 'tstorm_watch'
      ? SPC_WATCH_MAP
      : SPC_DAY1_RISK_MAP;

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
    imageUrl,
    rawR2Key: null,
    slug,
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
