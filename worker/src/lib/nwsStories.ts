// worker/src/lib/nwsStories.ts
// Fetches local weather briefings from the three NWS offices that cover Kentucky:
//   LMK — NWS Louisville  (Central & Western KY)
//   JKL — NWS Jackson     (Eastern KY)
//   PAH — NWS Paducah     (Western KY / lower Ohio Valley)

const NWS_UA = '(localkynews.com, news@localkynews.com)';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NwsStory {
  title: string;
  /** Plain-text body, HTML stripped */
  description: string;
  link: string;
  publishedAt: string;
}

export interface NwsOfficeStories {
  officeId: string;
  officeName: string;
  officeArea: string;
  stories: NwsStory[];
  /** Static forecast-graphic images published by NWS at known URLs */
  images: { url: string; alt: string }[];
}

// ─── Office configuration ─────────────────────────────────────────────────────
// Images are served at fixed paths; NWS overwrites them in-place as forecasts are updated.

const OFFICES: Record<string, {
  name: string;
  area: string;
  feedUrl: string;
  images: { url: string; alt: string }[];
}> = {
  lmk: {
    name: 'NWS Louisville',
    area: 'Central & Western Kentucky',
    feedUrl: 'https://www.weather.gov/rss_page.php?site_name=lmk',
    images: [
      { url: 'https://www.weather.gov/images/lmk/WebWxBrief/Next12Hours.gif',     alt: 'NWS Louisville — Next 12 Hours' },
      { url: 'https://www.weather.gov/images/lmk/WebWxBrief/Next12to24Hours.gif', alt: 'NWS Louisville — Next 12 to 24 Hours' },
      { url: 'https://www.weather.gov/images/lmk/wxstory/Tab2FileL.png',           alt: 'NWS Louisville weather story graphic' },
      { url: 'https://www.weather.gov/images/lmk/wxstory/Tab3FileL.png',           alt: 'NWS Louisville extended forecast graphic' },
    ],
  },
  jkl: {
    name: 'NWS Jackson',
    area: 'Eastern Kentucky',
    feedUrl: 'https://www.weather.gov/rss_page.php?site_name=jkl',
    images: [
      { url: 'https://www.weather.gov/images/jkl/wxstory/Tab2FileL.png', alt: 'NWS Jackson weather story graphic' },
      { url: 'https://www.weather.gov/images/jkl/wxstory/Tab3FileL.png', alt: 'NWS Jackson extended forecast graphic' },
    ],
  },
  pah: {
    name: 'NWS Paducah',
    area: 'Western Kentucky & Southern Illinois',
    feedUrl: 'https://www.weather.gov/rss_page.php?site_name=pah',
    images: [
      { url: 'https://www.weather.gov/images/pah/wxstory/Tab2FileL.png', alt: 'NWS Paducah weather story graphic' },
      { url: 'https://www.weather.gov/images/pah/wxstory/Tab3FileL.png', alt: 'NWS Paducah extended forecast graphic' },
      { url: 'https://www.weather.gov/images/pah/wxstory/Tab4FileL.png', alt: 'NWS Paducah weekend forecast graphic' },
      { url: 'https://www.weather.gov/images/pah/wxstory/Tab5FileL.png', alt: 'NWS Paducah long-range forecast graphic' },
    ],
  },
};

// ─── RSS helpers ──────────────────────────────────────────────────────────────

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

/** Strip HTML tags from a description field and produce clean plain text. */
function stripHtml(html: string): string {
  let t = html
    // Turn block-level endings into paragraph breaks before stripping
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  return t
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Detect and convert mostly-uppercase NWS text to sentence case. */
function toReadableCase(text: string): string {
  if (!text) return text;
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (!letters.length) return text;
  const upperFraction = letters.split('').filter((c) => c >= 'A' && c <= 'Z').length / letters.length;
  if (upperFraction < 0.6) return text; // already mixed case

  return text
    .toLowerCase()
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, lead, ch) => lead + ch.toUpperCase())
    .replace(/\bi\b/g, 'I')
    .replace(/\bkentucky\b/gi, 'Kentucky')
    .replace(/\bnational weather service\b/gi, 'National Weather Service')
    .replace(/\bnws\b/gi, 'NWS')
    .replace(/\b(mph|am|pm|utc|est|cst|edt|cdt)\b/gi, (m) => m.toUpperCase());
}

/**
 * Ensure a link from the NWS RSS feed is an absolute URL.
 * Some items are emitted as "www.weather.gov/..." (no protocol) or as
 * root-relative paths, both of which break when used as <a href> values.
 */
function normalizeNwsLink(link: string): string {
  if (!link) return '';
  if (link.startsWith('http://') || link.startsWith('https://')) return link;
  if (link.startsWith('www.')) return `https://${link}`;
  if (link.startsWith('/')) return `https://www.weather.gov${link}`;
  return `https://www.weather.gov/${link}`;
}

function parseRssStories(xml: string): NwsStory[] {
  const stories: NwsStory[] = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const rawTitle = decodeXml(tagValue(block, 'title') ?? '').trim();
    const rawDesc  = decodeXml(tagValue(block, 'description') ?? '').trim();
    const link     = decodeXml(tagValue(block, 'link') ?? '').trim();
    const pubRaw   = tagValue(block, 'pubDate') ?? '';
    const publishedAt = pubRaw ? new Date(pubRaw).toISOString() : new Date().toISOString();

    if (!rawTitle) continue;

    const description = toReadableCase(stripHtml(rawDesc));
    const title = toReadableCase(rawTitle);
    const safeLink = normalizeNwsLink(link);

    stories.push({ title, description, link: safeLink, publishedAt });
  }

  return stories;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchOffice(officeId: string): Promise<NwsOfficeStories | null> {
  const cfg = OFFICES[officeId];
  if (!cfg) return null;

  let xml: string;
  try {
    const res = await fetch(cfg.feedUrl, {
      headers: { 'User-Agent': NWS_UA, Accept: 'application/rss+xml, application/xml' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    xml = await res.text();
  } catch {
    return null;
  }

  const stories = parseRssStories(xml).slice(0, 3);
  return { officeId, officeName: cfg.name, officeArea: cfg.area, stories, images: cfg.images };
}

/**
 * Fetch briefings from all three Kentucky NWS offices in parallel.
 * Returns whichever succeed; silently omits any that time out or error.
 */
export async function fetchNwsStories(): Promise<NwsOfficeStories[]> {
  const results = await Promise.allSettled([
    fetchOffice('lmk'),
    fetchOffice('jkl'),
    fetchOffice('pah'),
  ]);

  return results
    .filter((r): r is PromiseFulfilledResult<NwsOfficeStories | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((v): v is NwsOfficeStories => v !== null);
}
