// worker/src/lib/nws.ts — NWS Weather Alert auto-ingestion for Kentucky
import { KY_COUNTIES } from '../data/ky-geo';
import type { NewArticle } from '../types';
import { sha256Hex, normalizeCanonicalUrl } from './http';
import { findArticleByHash, insertArticle } from './db';
// ingestSingleUrl intentionally not imported — HWO products are built directly

const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active?area=KY';
const NWS_USER_AGENT = 'LocalKYNews/1.0 (localkynews.com; news@localkynews.com)';

export interface NwsAlert {
  id: string;
  event: string;
  headline: string;
  description: string;
  instruction: string | null;
  areaDesc: string;
  severity: string;
  urgency: string;
  sent: string;
  effective: string;
  expires: string;
  status: string;
  counties: string[];
  /** Raw GeoJSON geometry from the NWS feature (Polygon or MultiPolygon). Null when absent. */
  geometry: any | null;
}

/** Fetch active Kentucky alerts from the NWS API. */
export async function fetchActiveKyAlerts(): Promise<NwsAlert[]> {
  const res = await fetch(NWS_ALERTS_URL, {
    headers: {
      'User-Agent': NWS_USER_AGENT,
      'Accept': 'application/geo+json',
    },
  });

  if (!res.ok) return [];

  let data: any;
  try {
    data = await res.json();
  } catch {
    return [];
  }

  const features: any[] = Array.isArray(data?.features) ? data.features : [];

  return features
    .map((f): NwsAlert | null => {
      const p = f?.properties;
      if (!p) return null;
      if (p.status !== 'Actual') return null;
      if (!isWeatherEventType(p.event ?? '')) return null;

      return {
        id: String(f.id ?? p.id ?? ''),
        event: String(p.event ?? 'Weather Alert'),
        headline: String(p.headline ?? p.event ?? 'Weather Alert'),
        description: String(p.description ?? ''),
        instruction: p.instruction ? String(p.instruction) : null,
        areaDesc: String(p.areaDesc ?? ''),
        severity: String(p.severity ?? 'Unknown'),
        urgency: String(p.urgency ?? 'Unknown'),
        sent: String(p.sent ?? p.effective ?? new Date().toISOString()),
        effective: String(p.effective ?? new Date().toISOString()),
        expires: String(p.expires ?? ''),
        status: String(p.status ?? 'Actual'),
        counties: extractKyCountiesFromAreaDesc(String(p.areaDesc ?? '')),
        geometry: f.geometry ?? null,
      };
    })
    .filter((a): a is NwsAlert => a !== null)
    // Hard KY gate: require at least one recognized KY county, or the area
    // description must explicitly mention Kentucky or ", KY".  This prevents
    // border-area alerts with no KY county names from being published.
    .filter((a) =>
      a.counties.length > 0 ||
      /\bkentucky\b|,\s*ky\b/i.test(a.areaDesc)
    );
}

/** Derive a stable KV deduplication key for an alert. */
export async function alertDedupeKey(alertId: string): Promise<string> {
  return `nws:alert:${await sha256Hex(alertId)}`;
}

/** Check whether this alert has already been published. Returns true if new. */
export async function markAlertIfNew(env: Env, alertId: string): Promise<boolean> {
  if (!env.CACHE) return true;
  const key = await alertDedupeKey(alertId);
  const existing = await env.CACHE.get(key);
  if (existing) return false;
  // 48h TTL — long enough to prevent re-posting, short enough to re-publish
  // if NWS genuinely reissues the same underlying alert ID.
  await env.CACHE.put(key, '1', { expirationTtl: 172800 });
  return true;
}

/**
 * Build a short, readable plain-text summary for an NWS alert.
 * Produces one or two clean sentences rather than a raw text dump.
 */
function buildAlertSummary(
  alert: NwsAlert,
  countyList: string,
  issuedAt: string,
  expiryPhrase: string,
): string {
  // Opening sentence: what, where, when
  let summary = `The National Weather Service has issued a ${alert.event} for ${countyList}, effective ${issuedAt}${expiryPhrase ? ' and expiring' + expiryPhrase : ''}.`;

  // Append the first plain-text sentence from the description if it's useful
  if (alert.description) {
    const cleaned = alert.description
      .replace(/^\*[^\n]+\n?/m, '')   // strip leading "* LABEL..." header line
      .replace(/\n+/g, ' ')           // collapse newlines
      .replace(/\.{2,}/g, '')         // remove NWS "..." artifacts
      .trim();
    // Grab the first sentence (ends at . ! or ?)
    const firstSentenceMatch = cleaned.match(/[^.!?]+[.!?]/);
    const firstSentence = firstSentenceMatch ? firstSentenceMatch[0].trim() : '';
    if (firstSentence && firstSentence.length > 20) {
      summary += ' ' + firstSentence;
    }
  }

  return summary.slice(0, 500).trim();
}

/** Convert an NwsAlert into a NewArticle ready for insertArticle(). */
export async function buildAlertArticle(alert: NwsAlert): Promise<NewArticle> {
  const primaryCounty = alert.counties[0] ?? null;

  // Use the NWS API URL only for dedup hashing — it's a stable unique identifier.
  // The canonical URL is set to a localkynews.com/manual/ path so the article is
  // treated as original content and the "Read Full Story" link stays on our site.
  // sourceUrl points to the NWS website (user-readable) for attribution.
  const nwsApiUrl = `https://api.weather.gov/alerts/${encodeURIComponent(alert.id)}`;
  const alertSlug = alert.id.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').toLowerCase().slice(0, 80);
  const canonicalUrl = `https://localkynews.com/manual/nws-${alertSlug}`;
  const urlHash = await sha256Hex(normalizeCanonicalUrl(nwsApiUrl));
  // slug for routing; use the same base as the canonical path for simplicity
  const slug = `nws-${alertSlug}`;

  // ── Title — plan §6: "{EVENT} Issued for {COUNTIES}" ────────────────────
  const countyList = alert.counties.length > 0
    ? alert.counties.join(' and ') + (alert.counties.length === 1 ? ' County' : ' Counties')
    : alert.areaDesc;
  const title = `${alert.event} Issued for ${countyList}`.slice(0, 200);

  // ── Issued-at time string ─────────────────────────────────────────────────
  const issuedAt = new Date(alert.sent || Date.now()).toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZone: 'America/New_York', timeZoneName: 'short',
  });

  const expiryPhrase = alert.expires
    ? ` until ${new Date(alert.expires).toLocaleString('en-US', {
        month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
        timeZone: 'America/New_York', timeZoneName: 'short',
      })}`
    : '';

  // ── Parse the raw NWS description into structured sections ──────────────
  //
  // NWS descriptions use three formatting conventions that need special handling:
  //
  //   1. "* LABEL..." header lines — e.g. "* WHAT...Minor flooding is occurring"
  //      These are structured fields; render as bold label + value.
  //
  //   2. "- bullet" lines — e.g. "- At 10:00 AM the stage was 39.7 feet."
  //      These appear inside the ADDITIONAL DETAILS block; render as <li>.
  //
  //   3. Leading/trailing "..." dots — NWS product formatting artifact; remove them.
  //
  // The description uses BOTH double-newline (paragraph break) and single-newline
  // (line break within a section).  We split on double-newline first, then process
  // each block's internal lines.

  function cleanDots(s: string): string {
    return s.replace(/^\.+/, '').replace(/\.+$/, '').replace(/\.\.\./g, '').trim();
  }

  // Build the HTML representation of the description
  function renderDescHtml(raw: string): string {
    const blocks = raw.split(/\n{2,}/);
    const parts: string[] = [];

    for (const block of blocks) {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) continue;

      // Check if the block is a "* LABEL...value" structured field
      const starMatch = lines[0].match(/^\*\s+([A-Z][A-Z \t]+?)\.\.\.(.*)/);
      if (starMatch) {
        const label = starMatch[1].trim();
        const rest = [starMatch[2], ...lines.slice(1)].join(' ').trim();
        // Collect any "- bullet" sub-lines that follow
        const bulletLines: string[] = [];
        const textParts: string[] = [];
        for (const item of rest.split(/\s*-\s+/).filter(Boolean)) {
          if (item.trim()) bulletLines.push(item.trim());
        }
        if (bulletLines.length > 1) {
          parts.push(`<p><strong>${label}:</strong></p>`);
          parts.push(`<ul>${bulletLines.map((b) => `<li>${cleanDots(b)}</li>`).join('')}</ul>`);
        } else {
          parts.push(`<p><strong>${label}:</strong> ${cleanDots(rest)}</p>`);
        }
        continue;
      }

      // Check if the block is entirely "- bullet" lines
      if (lines.every((l) => l.startsWith('-'))) {
        parts.push(`<ul>${lines.map((l) => `<li>${cleanDots(l.replace(/^-\s*/, ''))}</li>`).join('')}</ul>`);
        continue;
      }

      // Plain paragraph — join lines, clean dots, render.
      // For long prose blocks (3+ sentences), split into individual <p> tags.
      const text = cleanDots(lines.join(' ').replace(/\s{2,}/g, ' '));
      if (text) {
        const sentenceRe = /[^.!?]*[.!?]+(?=\s+[A-Z]|$)/g;
        const sentences = text.match(sentenceRe) ?? [text];
        if (sentences.length >= 3) {
          sentences.forEach((s) => { if (s.trim()) parts.push(`<p>${s.trim()}</p>`); });
        } else {
          parts.push(`<p>${text}</p>`);
        }
      }
    }

    return parts.join('\n');
  }

  // Build a clean plain-text version of the description (for AI summarizer)
  function renderDescText(raw: string): string {
    const blocks = raw.split(/\n{2,}/);
    const parts: string[] = [];

    for (const block of blocks) {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) continue;

      const starMatch = lines[0].match(/^\*\s+([A-Z][A-Z \t]+?)\.\.\.(.*)/);
      if (starMatch) {
        const label = starMatch[1].trim();
        const rest = [starMatch[2], ...lines.slice(1)].join(' ').trim();
        parts.push(`${label}: ${cleanDots(rest)}`);
        continue;
      }

      const text = cleanDots(lines.join(' ').replace(/\s{2,}/g, ' '));
      if (text) parts.push(text);
    }

    return parts.join('\n\n');
  }

  const descHtml = renderDescHtml(alert.description);
  const descText = renderDescText(alert.description);

  const instrParts = alert.instruction
    ? alert.instruction.split(/\n{2,}/).map((s) => cleanDots(s.replace(/\n/g, ' ')).trim()).filter(Boolean)
    : [];

  // ── Plain-text body (fed to AI summarizer) — plan §6 template ────────────
  const textLines: string[] = [
    `The National Weather Service has issued a ${alert.event} for the following areas:`,
    '',
    countyList,
    '',
    `Issued at: ${issuedAt}${expiryPhrase ? ' — expires' + expiryPhrase : ''}`,
    '',
    'Details:',
    descText,
  ];
  if (instrParts.length > 0) {
    textLines.push('', 'Instructions:', ...instrParts);
  }
  textLines.push(
    '',
    'Residents in the warned area should monitor local conditions and follow guidance from emergency officials.',
    '',
    'Stay tuned to Local KY News for additional updates.',
  );

  const contentText = textLines.join('\n').trim();

  // ── HTML — plan §6 template with labeled sections + radar ────────────────
  // derive radar image URL so we can also expose it as the article
  // preview image (front‐end uses `imageUrl` for open graph, etc).
  const radarUrl = (() => {
    const easternKyCounties = new Set([
      'Perry','Leslie','Breathitt','Knott','Letcher','Floyd','Pike','Martin',
      'Johnson','Lawrence','Magoffin','Owsley','Lee','Wolfe','Morgan','Elliott',
      'Harlan','Bell','Knox','Whitley','McCreary','Laurel','Clay','Jackson',
      'Rockcastle','Estill','Powell','Menifee','Bath','Rowan','Carter','Lewis',
    ]);
    const isEasternKy = alert.counties.some((c) => easternKyCounties.has(c));
    const radarStation = isEasternKy ? 'KJKL' : 'KLVX';
    return `https://radar.weather.gov/ridge/standard/${radarStation}_loop.gif`;
  })();

  const radarHtml = getRadarImageHtml(alert.counties);

  const instrHtml = instrParts.length > 0
    ? `<p><strong>Instructions:</strong></p>\n<ul>${instrParts.map((p) => `<li>${p}</li>`).join('\n')}</ul>`
    : '';

  const contentHtml = [
    `<p>The National Weather Service has issued a <strong>${alert.event}</strong> for the following areas:</p>`,
    `<p><strong>${countyList}</strong></p>`,
    `<p><em>Issued at: ${issuedAt}${expiryPhrase ? ' — expires' + expiryPhrase : ''}</em></p>`,
    `<p><strong>Details:</strong></p>`,
    descHtml,
    instrHtml,
    `<p>Residents in the warned area should monitor local conditions and follow guidance from emergency officials.</p>`,
    `<p><strong>Radar:</strong></p>`,
    radarHtml,
    `<p>Stay tuned to Local KY News for additional updates.</p>`,
  ].filter(Boolean).join('\n');

  // ── Metadata ─────────────────────────────────────────────────────────────
  const seoDescription = `${alert.event} issued for ${countyList}. Check Local KY News for details and safety instructions.`.slice(0, 300);
  const now = new Date().toISOString();

  return {
    canonicalUrl,
    sourceUrl: 'https://www.weather.gov/',
    urlHash,
    title,
    author: 'National Weather Service',
    publishedAt: alert.sent || now,
    category: 'weather',
    isKentucky: true,
    isNational: false,
    county: primaryCounty,
    counties: alert.counties,
    city: null,
    slug,
    // Fallback summary — overwritten by summarizeArticle() in processNwsAlerts().
    // Build a concise human-readable sentence rather than collapsing the entire
    // content blob into one run-on string.
    summary: buildAlertSummary(alert, countyList, issuedAt, expiryPhrase),
    seoDescription,
    rawWordCount: contentText.split(/\s+/).filter(Boolean).length,
    summaryWordCount: 0,
    contentText,
    contentHtml,
    imageUrl: 'https://www.spc.noaa.gov/products/watch/ww.png',
    rawR2Key: null,
    contentHash: await sha256Hex(contentText.slice(0, 3000)),
    alertGeojson: alert.geometry ? JSON.stringify(alert.geometry) : null,
  };
}

/**
 * Check the NWS API for new Kentucky alerts and publish any that haven't been
 * seen before. Called from the scheduled handler via ctx.waitUntil().
 */
export async function processNwsAlerts(env: Env): Promise<{ published: number; skipped: number }> {
  let published = 0;
  let skipped = 0;

  let alerts: NwsAlert[];
  try {
    alerts = await fetchActiveKyAlerts();
  } catch (err) {
    console.error('[NWS] fetchActiveKyAlerts failed', err);
    return { published: 0, skipped: 0 };
  }

  for (const alert of alerts) {
    try {
      // 1. KV dedup — skip if we've already published this NWS alert ID
      const isNew = await markAlertIfNew(env, alert.id);
      if (!isNew) {
        skipped++;
        continue;
      }

      // 2. Build the base article record
      const article = await buildAlertArticle(alert);

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
      console.log(`[NWS] Published alert: "${article.title}" → id=${id} counties=${(article.counties ?? []).join(', ')}`);
    } catch (err) {
      console.error(`[NWS] Failed to publish alert ${alert.id}:`, err);
    }
  }

  return { published, skipped };
}

// ─── NWS product (HWO) ingestion ──────────────────────────────────────────

// Offices we care about for hazardous weather outlooks
// KJKL = Jackson KY (Eastern KY), KLMK = Louisville (Central/Western KY), KPAH = Paducah (Western KY)
const NWS_HWO_OFFICES = ['KJKL', 'KLMK', 'KPAH'];

/** Human-friendly office names used in article titles */
const OFFICE_NAMES: Record<string, string> = {
  KJKL: 'Jackson, KY',
  KLMK: 'Louisville, KY',
  KPAH: 'Paducah, KY',
};

/** Radar image to embed for each office's coverage area */
const OFFICE_RADAR: Record<string, { station: string; label: string }> = {
  KJKL: { station: 'KJKL', label: 'Eastern Kentucky' },
  KLMK: { station: 'KLVX', label: 'Central Kentucky (Louisville)' },
  KPAH: { station: 'KPAH', label: 'Western Kentucky (Paducah)' },
};

export interface NwsProduct {
  /** Full API URL, e.g. https://api.weather.gov/products/XXXXXXXX-XXXX-... */
  id: string;
  office: string;
  issuanceTime: string;
  productText: string;
}

/**
 * Fetch the HWO product list for an office, then fetch the full text of
 * each product.  The list endpoint returns lightweight stubs; full text
 * lives at the individual product URL (e.g. /products/{id}).
 */
export async function fetchHwoProducts(office: string): Promise<NwsProduct[]> {
  const listUrl = `https://api.weather.gov/products?office=${office}&type=HWO`;
  let listData: any;
  try {
    const res = await fetch(listUrl, {
      headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) return [];
    listData = await res.json();
  } catch (err) {
    console.error(`[NWS] fetchHwoProducts list(${office}) failed`, err);
    return [];
  }

  // The API returns { '@graph': [...] } with product stubs
  const stubs: any[] = Array.isArray(listData?.['@graph'])
    ? listData['@graph']
    : Array.isArray(listData?.products)
    ? listData.products
    : [];

  // Only fetch the latest (most recent) product per office to avoid flooding
  // the feed — HWOs are reissued multiple times a day.
  const latest = stubs
    .filter((s) => s?.['@id'] || s?.id)
    .sort((a, b) => {
      const ta = new Date(a.issuanceTime || a.issued || 0).getTime();
      const tb = new Date(b.issuanceTime || b.issued || 0).getTime();
      return tb - ta; // newest first
    })
    .slice(0, 3); // at most 3 recent HWOs per office

  const results: NwsProduct[] = [];
  for (const stub of latest) {
    const productUrl: string = String(stub['@id'] || stub.id || '');
    if (!productUrl) continue;

    let productText = '';
    let issuanceTime = String(stub.issuanceTime || stub.issued || new Date().toISOString());

    // Fetch full product text if not already embedded in the stub
    if (stub.productText) {
      productText = String(stub.productText);
    } else {
      try {
        const pRes = await fetch(productUrl, {
          headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/json' },
        });
        if (pRes.ok) {
          const pData: any = await pRes.json();
          productText = String(pData.productText || pData.body || pData.text || '');
          if (!issuanceTime || issuanceTime === 'undefined') {
            issuanceTime = String(pData.issuanceTime || pData.issued || new Date().toISOString());
          }
        }
      } catch {
        // product fetch failed — skip
        continue;
      }
    }

    if (!productText.trim()) continue;

    results.push({ id: productUrl, office, issuanceTime, productText });
  }

  return results;
}

/** KV dedup key for a product (keyed by product ID URL). */
export async function productDedupeKey(productId: string): Promise<string> {
  return `nws:product:${await sha256Hex(productId)}`;
}

/** Returns true if the product is new (and marks it seen in KV). */
export async function markProductIfNew(env: Env, productId: string): Promise<boolean> {
  if (!env.CACHE) return true;
  const key = await productDedupeKey(productId);
  if (await env.CACHE.get(key)) return false;
  // 24h TTL — HWOs reissued every few hours; we only want the first publish
  await env.CACHE.put(key, '1', { expirationTtl: 86400 });
  return true;
}

/** Simple Kentucky keyword gate. */
function isKentuckyProduct(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('kentucky') || /\bky\b/.test(lower);
}

/**
 * Parse the raw NWS product text (pre-formatted plain text with VTEC headers,
 * dot-separated sections, etc.) into readable paragraphs.
 *
 * NWS product text looks like:
 *   000
 *   FXUS63 KLMK 101140
 *   HWOLMK
 *
 *   HAZARDOUS WEATHER OUTLOOK
 *   ...
 *   .DAY ONE...Today and Tonight.
 *   No hazardous weather expected.
 *   .DAYS TWO THROUGH SEVEN...
 *   ...
 *   $$
 */
function parseHwoText(raw: string): { sections: Array<{ heading: string; body: string }>; plain: string } {
  // Strip the WMO/AWIPS header lines (first 3–4 lines before the product name)
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim());

  // Find the line that says "HAZARDOUS WEATHER OUTLOOK" (product name)
  const titleIdx = lines.findIndex((l) => /HAZARDOUS WEATHER OUTLOOK/i.test(l));
  const body = titleIdx >= 0 ? lines.slice(titleIdx + 1) : lines;

  // Split on section headers that begin with a dot e.g. ".DAY ONE..."
  const sectionRegex = /^\.([A-Z][^.]+?)\.{3}/;
  const sections: Array<{ heading: string; body: string }> = [];
  let current: { heading: string; lines: string[] } | null = null;

  for (const line of body) {
    if (line === '$$') break; // end-of-product marker

    const m = sectionRegex.exec(line);
    if (m) {
      if (current) sections.push({ heading: current.heading, body: current.lines.join(' ').replace(/\s{2,}/g, ' ').trim() });
      // The rest of the line after the heading may include inline text
      const rest = line.slice(m[0].length).trim();
      current = { heading: m[1].trim(), lines: rest ? [rest] : [] };
    } else if (current) {
      if (line) current.lines.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.lines.join(' ').replace(/\s{2,}/g, ' ').trim() });

  // Build a plain-text version for the AI summarizer
  const plain = sections
    .filter((s) => s.body && !/^no hazardous weather/i.test(s.body))
    .map((s) => `${s.heading}:\n${s.body}`)
    .join('\n\n');

  return { sections, plain };
}

/**
 * Derive a human-readable title from the HWO product and office.
 * e.g. "Hazardous Weather Outlook – NWS Louisville, KY"
 */
function buildHwoTitle(office: string, issuanceTime: string): string {
  const officeLabel = OFFICE_NAMES[office] ?? office;
  const dateStr = new Date(issuanceTime).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  return `Hazardous Weather Outlook – NWS ${officeLabel} – ${dateStr}`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

/**
 * Build a full NewArticle from a fetched HWO product.
 */
export async function buildHwoArticle(product: NwsProduct): Promise<NewArticle> {
  const { sections, plain } = parseHwoText(product.productText);

  const title = buildHwoTitle(product.office, product.issuanceTime);
  const issuedAt = new Date(product.issuanceTime).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });

  const officeLabel = OFFICE_NAMES[product.office] ?? product.office;
  const radar = OFFICE_RADAR[product.office] ?? { station: 'KLVX', label: 'Kentucky' };
  const radarUrl = `https://radar.weather.gov/ridge/standard/${radar.station}_loop.gif`;

  // ── Plain-text body (for AI summarizer) ───────────────────────────────────
  const hasSubstantiveContent = sections.some(
    (s) => s.body && !/^no hazardous weather/i.test(s.body),
  );

  const introText = `The National Weather Service office in ${officeLabel} has issued a Hazardous Weather Outlook for ${product.office === 'KJKL' ? 'Eastern Kentucky' : product.office === 'KPAH' ? 'Western Kentucky and the Purchase Area' : 'Central and Southern Kentucky'}.`;

  const textLines: string[] = [
    introText,
    '',
    `Issued: ${issuedAt}`,
    '',
  ];

  if (hasSubstantiveContent) {
    for (const s of sections) {
      if (!s.body) continue;
      textLines.push(`${s.heading}:`);
      textLines.push(s.body);
      textLines.push('');
    }
  } else {
    textLines.push('No hazardous weather is expected at this time for this area.');
    textLines.push('');
  }

  textLines.push('Residents should continue to monitor local conditions and check back for updates.');
  textLines.push('');
  textLines.push('Stay tuned to Local KY News for the latest weather information.');

  const contentText = textLines.join('\n').trim();

  // ── HTML body ─────────────────────────────────────────────────────────────
  // Render each HWO section heading + body. Long bodies (multi-sentence outlooks)
  // are split into individual <p> tags so they don't render as a wall of text.
  function renderHwoSectionHtml(heading: string, body: string): string {
    const sentenceRe = /[^.!?]*[.!?]+(?=\s+[A-Z]|$)/g;
    const sentences = body.match(sentenceRe) ?? [body];
    if (sentences.length <= 1) {
      return `<p><strong>${heading}:</strong> ${body}</p>`;
    }
    return `<p><strong>${heading}:</strong></p>\n${sentences.map((s) => `<p>${s.trim()}</p>`).join('\n')}`;
  }

  const sectionHtml = hasSubstantiveContent
    ? sections
        .filter((s) => s.body)
        .map((s) => renderHwoSectionHtml(s.heading, s.body))
        .join('\n')
    : `<p>No hazardous weather is expected at this time for this area.</p>`;

  const contentHtml = [
    `<p>${introText}</p>`,
    `<p><em>Issued: ${issuedAt}</em></p>`,
    sectionHtml,
    `<p>Residents should continue to monitor local conditions and check back for updates.</p>`,
    `<p><strong>Current Radar (${radar.label}):</strong><br><img src="${radarUrl}" alt="NWS Radar for Kentucky" style="max-width:100%;height:auto;border:1px solid #ccc;border-radius:4px;"></p>`,
    `<p>Stay tuned to Local KY News for the latest weather information.</p>`,
    `<p><small>Source: <a href="${product.id}" target="_blank" rel="noopener">National Weather Service – ${officeLabel}</a></small></p>`,
  ].join('\n');

  // ── Metadata ───────────────────────────────────────────────────────────────
  const canonicalUrl = `https://localkynews.com/manual/hwo-${product.office.toLowerCase()}-${new Date(product.issuanceTime).toISOString().slice(0, 10)}`;
  const urlHash = await sha256Hex(normalizeCanonicalUrl(product.id));
  const baseSlug = slugify(title);
  const slug = `${baseSlug}-${urlHash.slice(0, 8)}`;

  const seoDescription = `${title}. Issued ${issuedAt}. ${plain.slice(0, 200).replace(/\n/g, ' ')}`.slice(0, 300);

  const now = new Date().toISOString();

  return {
    canonicalUrl,
    sourceUrl: 'https://www.weather.gov/',
    urlHash,
    title,
    author: `NWS ${officeLabel}`,
    publishedAt: product.issuanceTime || now,
    category: 'weather',
    isKentucky: true,
    isNational: false,
    county: null,
    counties: [],
    city: null,
    slug,
    summary: contentText.replace(/\n+/g, ' ').slice(0, 800).trim(),
    seoDescription,
    rawWordCount: contentText.split(/\s+/).filter(Boolean).length,
    summaryWordCount: 0,
    contentText,
    contentHtml,
    imageUrl: radarUrl,
    rawR2Key: null,
    contentHash: await sha256Hex(contentText.slice(0, 3000)),
    alertGeojson: null,
  };
}

/**
 * Poll each office's HWO feed and insert any new products as articles.
 * Uses the same pattern as processNwsAlerts and processSpcFeed —
 * direct DB insert with AI summarization rather than the generic ingestSingleUrl
 * scraper which cannot parse NWS JSON API responses.
 */
export async function processNwsProducts(env: Env): Promise<{ published: number; skipped: number }> {
  let published = 0;
  let skipped = 0;

  for (const office of NWS_HWO_OFFICES) {
    let products: NwsProduct[];
    try {
      products = await fetchHwoProducts(office);
    } catch (err) {
      console.error(`[NWS HWO] fetchHwoProducts(${office}) failed`, err);
      continue;
    }

    for (const prod of products) {
      if (!prod.id) continue;

      try {
        // 1. KV dedup — skip if we've already published this product URL
        const isNew = await markProductIfNew(env, prod.id);
        if (!isNew) {
          skipped++;
          continue;
        }

        // 2. Kentucky gate — product text must mention KY
        if (!isKentuckyProduct(prod.productText)) {
          console.log(`[NWS HWO] Skipped non-KY product: ${prod.id}`);
          skipped++;
          continue;
        }

        // 3. Build the article record
        const article = await buildHwoArticle(prod);

        // 4. DB dedup — check url_hash in case KV was cleared
        const existing = await findArticleByHash(env, article.urlHash);
        if (existing) {
          skipped++;
          continue;
        }

        // 5. AI summarization
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

        // 6. Insert into D1
        const id = await insertArticle(env, article);
        published++;
        console.log(`[NWS HWO] Published: "${article.title}" → id=${id} office=${office}`);
      } catch (err) {
        console.error(`[NWS HWO] Failed to publish product ${prod.id}:`, err);
      }
    }
  }

  return { published, skipped };
}


// ─── helpers ────────────────────────────────────────────────────────────────

function extractKyCountiesFromAreaDesc(areaDesc: string): string[] {
  const countySet = new Set(KY_COUNTIES);
  const found: string[] = [];
  const seenLower = new Set<string>();

  const tokens = areaDesc
    .replace(/\bCounty\b/gi, '')
    .replace(/\bCounties\b/gi, '')
    .replace(/,\s*Kentucky\b/gi, '')
    .replace(/,\s*KY\b/gi, '')
    .split(/[;,]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const name = token.replace(/\bKY\b/gi, '').replace(/\bIN\b/gi, '').trim();
    if (!name) continue;
    const normalized = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    const matched = countySet.has(normalized)
      ? normalized
      : KY_COUNTIES.find((c) => c.toLowerCase() === normalized.toLowerCase());
    if (matched && !seenLower.has(matched.toLowerCase())) {
      seenLower.add(matched.toLowerCase());
      found.push(matched);
    }
  }

  return found;
}

const WEATHER_EVENT_TYPES = new Set([
  'Tornado Warning',
  'Tornado Watch',
  'Severe Thunderstorm Warning',
  'Severe Thunderstorm Watch',
  'Flash Flood Warning',
  'Flash Flood Watch',
  'Flood Warning',
  'Flood Watch',
  'Flood Advisory',
  'Winter Storm Warning',
  'Winter Storm Watch',
  'Winter Weather Advisory',
  'Ice Storm Warning',
  'Blizzard Warning',
  'High Wind Warning',
  'High Wind Watch',
  'Wind Advisory',
  'Excessive Heat Warning',
  'Excessive Heat Watch',
  'Heat Advisory',
  'Dense Fog Advisory',
  'Freeze Warning',
  'Frost Advisory',
  'Special Weather Statement',
  'Hazardous Weather Outlook',
]);

function isWeatherEventType(event: string): boolean {
  return WEATHER_EVENT_TYPES.has(event);
}

/** Radar image HTML based on which part of Kentucky the alert covers. */
function getRadarImageHtml(counties: string[]): string {
  const easternKyCounties = new Set([
    'Perry','Leslie','Breathitt','Knott','Letcher','Floyd','Pike','Martin',
    'Johnson','Lawrence','Magoffin','Owsley','Lee','Wolfe','Morgan','Elliott',
    'Harlan','Bell','Knox','Whitley','McCreary','Laurel','Clay','Jackson',
    'Rockcastle','Estill','Powell','Menifee','Bath','Rowan','Carter','Lewis',
  ]);
  const isEasternKy = counties.some((c) => easternKyCounties.has(c));
  const radarStation = isEasternKy ? 'KJKL' : 'KLVX';
  const radarLabel = isEasternKy ? 'Jackson, KY' : 'Louisville, KY';
  return `<p><strong>Current Radar (${radarLabel}):</strong><br><img src="https://radar.weather.gov/ridge/standard/${radarStation}_loop.gif" alt="NWS Radar for Kentucky" style="max-width:100%;height:auto;border:1px solid #ccc;border-radius:4px;"></p>`;
}
