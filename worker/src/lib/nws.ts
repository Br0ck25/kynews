// worker/src/lib/nws.ts — NWS Weather Alert auto-ingestion for Kentucky
import { KY_COUNTIES } from '../data/ky-geo';
import type { NewArticle } from '../types';
import { sha256Hex, normalizeCanonicalUrl } from './http';
import { findArticleByHash, insertArticle } from './db';
import { insertWeatherAlertPost } from './weatherAlerts';
// ingestSingleUrl intentionally not imported — HWO products are built directly

// ─── Live Weather Alerts Facebook auto-post KV flag keys ─────────────────
// Three independent flags controlling which alert categories are auto-posted
// to the separate "Live Weather Alerts" Facebook page.
export const LIVE_ALERT_AUTOPOST_KEYS = {
  warnings: 'live:alerts:autopost:warnings',
  watches:  'live:alerts:autopost:watches',
  others:   'live:alerts:autopost:others',
} as const;

export const LIVE_ALERT_AUTOPOST_START_KEY = 'live:alerts:autopost:start';

export type LiveAlertCategory = keyof typeof LIVE_ALERT_AUTOPOST_KEYS;

/** Returns true (default) when the KV flag is absent or set to any value other than "false". */
export async function getLiveAlertAutopostFlag(env: Env, category: LiveAlertCategory): Promise<boolean> {
  if (!env.CACHE) return true;
  const raw = await (env.CACHE as any).get(LIVE_ALERT_AUTOPOST_KEYS[category]);
  if (raw === null || raw === undefined) return true;
  return String(raw).toLowerCase() !== 'false';
}

/** Returns start Date for which alerts are eligible for auto-posting. */
export async function getLiveAlertAutopostStart(env: Env): Promise<Date | null> {
  if (!env.CACHE) return null;
  const raw = await (env.CACHE as any).get(LIVE_ALERT_AUTOPOST_START_KEY);
  if (!raw) return null;
  const parsed = new Date(String(raw));
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

export async function setLiveAlertAutopostStart(env: Env, value: string | null): Promise<void> {
  if (!env.CACHE) return;
  if (!value) {
    await (env.CACHE as any).delete(LIVE_ALERT_AUTOPOST_START_KEY);
    return;
  }
  await (env.CACHE as any).put(LIVE_ALERT_AUTOPOST_START_KEY, String(value));
}

export async function setLiveAlertAutopostFlag(env: Env, category: LiveAlertCategory, enabled: boolean): Promise<void> {
  if (!env.CACHE) return;
  await (env.CACHE as any).put(LIVE_ALERT_AUTOPOST_KEYS[category], enabled ? 'true' : 'false');
}

/**
 * KV state stored per active alert thread (key: `live_alert:{ugcCode}:{eventSlug}`).
 * Tracks the anchor Facebook post and current NWS alert ID so that NWS reissues
 * are posted as comments rather than new posts.
 */
export interface ActiveAlertState {
  nwsAlertId: string;   // current NWS alert ID
  fbPostId: string;     // Facebook post ID to comment on
  expiresAt: number;    // Unix timestamp (seconds); 0 = unknown
  ugcCode: string;      // e.g. "KYC095"
  eventType: string;    // e.g. "Flood Warning"
  areaDesc: string;     // e.g. "Pike, KY"
  updateCount: number;  // how many update comments have been posted on this anchor post
  lastUpdated?: string; // optional properties.updated for update detection
}

/** Classify an NWS event string into one of the three categories. */
export function classifyAlertCategory(event: string): LiveAlertCategory {
  const lower = event.toLowerCase();
  if (lower.includes('warning')) return 'warnings';
  if (lower.includes('watch'))   return 'watches';
  return 'others';
}

const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active?area=KY';
const NWS_ALL_ALERTS_URL = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update';
const NWS_RSS_URL = 'https://api.weather.gov/alerts/active.atom';
const NWS_RSS_USER_AGENT = 'LocalKYNews (contact@localkynews.com)';
const NWS_RSS_ACCEPT = 'application/atom+xml';
// NWS docs specify format: (website, contact_email)
const NWS_USER_AGENT = '(localkynews.com, news@localkynews.com)';

function buildNwsRequestHeaders(): Record<string, string> {
  return {
    'Accept': 'application/geo+json',
    'User-Agent': NWS_USER_AGENT,
  };
}

export interface NationalRssEntry {
  id: string;
  updated: string;
}

export async function fetchNationalRssFeed(): Promise<NationalRssEntry[]> {
  const maxAttempts = 3;
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
    try {
      const res = await fetch(NWS_RSS_URL, {
        headers: {
          'User-Agent': NWS_RSS_USER_AGENT,
          'Accept': NWS_RSS_ACCEPT,
        },
      });

      if (!res.ok) {
        lastError = `RSS ${res.status} ${res.statusText}`;
        console.warn(`[LIVE-ALERTS-FB] fetchNationalRssFeed attempt ${attempt} got status ${res.status}`);
        if (attempt < maxAttempts) continue;
        return [];
      }

      const text = await res.text();
      const feedEntries: NationalRssEntry[] = [];

      try {
        const entryRegexp = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
        let entryMatch: RegExpExecArray | null;

        while ((entryMatch = entryRegexp.exec(text)) !== null) {
          const entryXml = entryMatch[1];

          const idMatch = entryXml.match(/<id[^>]*>([\s\S]*?)<\/id>/i);
          const updatedMatch = entryXml.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i);

          if (!idMatch || !updatedMatch) continue;

          const idText = (idMatch[1] || '').trim();
          const updatedText = (updatedMatch[1] || '').trim();

          if (!idText || !updatedText) continue;

          feedEntries.push({ id: idText, updated: updatedText });
        }

        return feedEntries;
      } catch (err) {
        lastError = err;
        console.error('[LIVE-ALERTS-FB] fetchNationalRssFeed XML parse failed', err);
        if (attempt < maxAttempts) continue;
        return [];
      }
    } catch (err) {
      lastError = err;
      console.error(`[LIVE-ALERTS-FB] fetchNationalRssFeed attempt ${attempt} failed`, err);
      if (attempt < maxAttempts) continue;
      return [];
    }
  }

  console.error('[LIVE-ALERTS-FB] fetchNationalRssFeed failed all attempts', lastError);
  return [];
}

export async function getNewNationalAlertIds(env: Env, rssEntries: NationalRssEntry[]): Promise<string[]> {
  if (!env.CACHE) {
    return rssEntries.map((entry) => entry.id);
  }

  const newIds: string[] = [];

  for (const entry of rssEntries) {
    if (!entry.id || !entry.updated) continue;

    const hash = await sha256Hex(entry.id);
    const key = `rss:national:seen:${hash}`;
    const existing = await env.CACHE.get(key);

    const existingUpdated = existing ? String(existing).trim() : null;
    if (!existingUpdated || new Date(entry.updated).getTime() > new Date(existingUpdated).getTime()) {
      newIds.push(entry.id);
      await env.CACHE.put(key, entry.updated, { expirationTtl: 172800 });
    }
  }

  return newIds;
}

export async function fetchAlertById(alertId: string): Promise<NwsAlert | null> {
  return fetchNwsAlertById(alertId);
}

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
  updated: string;
  status: string;
  messageType: string;
  ugcCodes: string[];
  counties: string[];
  /** Raw GeoJSON geometry from the NWS feature (Polygon or MultiPolygon). Null when absent. */
  geometry: any | null;
}

/** Fetch active Kentucky alerts from the NWS API. */
function mapNwsFeatureToAlert(f: any): NwsAlert | null {
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
    updated: String(p.updated ?? p.sent ?? p.effective ?? new Date().toISOString()),
    status: String(p.status ?? 'Actual'),
    messageType: String(p.messageType ?? 'Alert'),
    ugcCodes: Array.isArray(p.geocode?.UGC) ? (p.geocode.UGC as string[]) : [],
    counties: extractKyCountiesFromAreaDesc(String(p.areaDesc ?? '')),
    geometry: f.geometry ?? null,
  };
}

/**
 * Fetch active Kentucky alerts from the NWS API.
 */
export async function fetchActiveKyAlerts(): Promise<NwsAlert[]> {
  const res = await fetch(NWS_ALERTS_URL, { headers: buildNwsRequestHeaders() });

  if (!res.ok) {
    console.error(`[NWS] fetchActiveKyAlerts returned http ${res.status}`);
    if (res.status === 403) {
      console.error('[NWS] NWS 403 indicates possible API blocking/rate-limiting for this worker IP');
    }
    return [];
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    return [];
  }

  const features: any[] = Array.isArray(data?.features) ? data.features : [];

  return features
    .map(mapNwsFeatureToAlert)
    .filter((a): a is NwsAlert => a !== null)
    // Hard KY gate: require at least one recognized KY county, or the area
    // description must explicitly mention Kentucky or ", KY".  This prevents
    // border-area alerts with no KY county names from being published.
    .filter((a) =>
      a.counties.length > 0 ||
      /\bkentucky\b|,\s*ky\b/i.test(a.areaDesc)
    );
}

/**
 * Fetch ALL active NWS alerts nationwide (no state gate).
 * Used exclusively for the Live Weather Alerts Facebook page auto-posting.
 * Article ingestion is still KY-only via fetchActiveKyAlerts().
 */
export async function fetchAllActiveAlerts(): Promise<NwsAlert[]> {
  const res = await fetch(NWS_ALL_ALERTS_URL, { headers: buildNwsRequestHeaders() });

  if (!res.ok) {
    console.error(`[LIVE-ALERTS-FB] fetchAllActiveAlerts returned http ${res.status}`);
    if (res.status === 403) {
      console.error('[LIVE-ALERTS-FB] NWS 403 indicates possible API blocking/rate-limiting for this worker IP');
    }
    return [];
  }

  let data: any;
  try {
    data = await res.json();
  } catch (err) {
    console.error('[LIVE-ALERTS-FB] fetchAllActiveAlerts JSON parse failed', err);
    return [];
  }

  const features: any[] = Array.isArray(data?.features) ? data.features : [];

  return features
    .map(mapNwsFeatureToAlert)
    .filter((a): a is NwsAlert => a !== null);
}

/**
 * Fetch a single alert from the NWS API by its alert ID.
 */
export async function fetchNwsAlertById(alertId: string): Promise<NwsAlert | null> {
  if (!alertId) return null;
  // If the caller passes the full NWS URL, use it directly; otherwise build
  // the URL from the bare resource ID (e.g. "urn:oid:...").
  const url = alertId.startsWith('https://')
    ? alertId
    : `https://api.weather.gov/alerts/${encodeURIComponent(alertId)}`;
  const res = await fetch(url, { headers: buildNwsRequestHeaders() });
  if (!res.ok) return null;

  let data: any;
  try {
    data = await res.json();
  } catch {
    return null;
  }

  // The response may be a single feature or a feature collection.
  const feature = Array.isArray(data?.features) ? data.features[0] : data;
  return mapNwsFeatureToAlert(feature);
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
 * Parse structured NWS "* LABEL...value" fields from an alert description.
 *
 * NWS warning products use all-caps structured labels such as WHAT, HAZARD,
 * WHERE, WHEN, IMPACTS, IMPACT, SOURCE, etc., each separated from its value
 * by "...". The value may span multiple lines until the next "* LABEL" block
 * or a blank line.
 *
 * Returns a Map of UPPERCASE_LABEL → cleaned value string.
 *
 * Example input line:  "* HAZARD...60 mph wind gusts."
 * Example output:      Map { "HAZARD" => "60 mph wind gusts." }
 */
function parseNwsFields(description: string): Map<string, string> {
  const fields = new Map<string, string>();
  if (!description) return fields;

  // Match each "* LABEL...value" block; value ends at the next "* LABEL" or blank line.
  const fieldRe = /^\*\s+([A-Z][A-Z /]+?)\.\.\.([\s\S]*?)(?=^\*\s+[A-Z]|\n{2,}|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = fieldRe.exec(description)) !== null) {
    const label = match[1].trim().toUpperCase();
    const value = match[2]
      .replace(/\n+/g, ' ')    // collapse line breaks within value
      .replace(/\.{2,}/g, '')  // strip NWS "..." artifacts
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (value) fields.set(label, value);
  }
  return fields;
}

/**
 * Build a short, readable plain-text summary for an NWS alert.
 *
 * Extracts the WHAT/HAZARD and IMPACTS/IMPACT structured fields from the NWS
 * description and composes them into a clean prose sentence. This prevents the
 * previous bug where collapsing all newlines caused label names (HAZARD, SOURCE,
 * IMPACT) to concatenate directly with their values, producing output like
 * "HAZARD60 mph wind gusts SOURCERadar indicated IMPACTExpect damage to trees."
 *
 * Falls back gracefully when no structured fields are present (e.g. narrative-
 * style products) by stripping ALL "* LABEL..." lines before extracting the
 * first prose sentence, so the same run-on bug cannot occur there either.
 */
function buildAlertSummary(
  alert: NwsAlert,
  countyList: string,
  issuedAt: string,
  expiryPhrase: string,
): string {
  const base = `The National Weather Service has issued a ${alert.event} for ${countyList}${expiryPhrase ? ', in effect' + expiryPhrase : ''}.`;

  if (!alert.description) return base;

  const fields = parseNwsFields(alert.description);
  const parts: string[] = [];

  // Primary hazard: prefer WHAT (used by flood/winter products), fall back to HAZARD
  const what = fields.get('WHAT') || fields.get('HAZARD');
  if (what) parts.push(what);

  // Human impact: prefer IMPACTS (plural), fall back to IMPACT
  const impact = fields.get('IMPACTS') || fields.get('IMPACT');
  if (impact) parts.push(impact);

  if (parts.length > 0) {
    return `${base} ${parts.join(' ')}`.slice(0, 500).trim();
  }

  // No structured fields — fall back to first clean prose sentence, but
  // strip ALL "* LABEL..." lines first so they never bleed into the output.
  const narrative = alert.description
    .replace(/\*\s+[A-Z][A-Z /]+?\.\.\.[^\n]*/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\.{2,}/g, '')
    .trim();
  const firstSentence = narrative.match(/[^.!?]{20,}[.!?]/)?.[0]?.trim() ?? '';
  if (firstSentence) return `${base} ${firstSentence}`.slice(0, 500).trim();

  return base;
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

  const imageAlt = [title, primaryCounty ? `${primaryCounty} County, Kentucky` : null].filter(Boolean).join(' — ') || null;

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
    imageAlt,
    rawR2Key: null,
    contentHash: await sha256Hex(contentText.slice(0, 3000)),
    alertGeojson: alert.geometry ? JSON.stringify(alert.geometry) : null,
  };
}

// ─── Facebook auto-post for weather alerts ────────────────────────────────

/** Public URL for the default weather-alert banner image (fallback). */
const WEATHER_ALERT_IMAGE_URL = 'https://localkynews.com/img/weather-alert.jpg';

/** Base URL for the public image folder. */
const IMG_BASE = 'https://localkynews.com/img';

/** Maps 2-letter NWS state/territory codes to lowercase names used in image filenames. */
const STATE_CODE_TO_NAME: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california',
  CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia',
  HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa',
  KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi',
  MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new-hampshire',
  NJ: 'new-jersey', NM: 'new-mexico', NY: 'new-york', NC: 'north-carolina',
  ND: 'north-dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhode-island', SC: 'south-carolina', SD: 'south-dakota', TN: 'tennessee',
  TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington',
  DC: 'washington', WV: 'west-virginia', WI: 'wisconsin', WY: 'wyoming',
};

/**
 * Extract the most-represented 2-letter state code from an NWS areaDesc string.
 * NWS formats area descriptions as "County, ST; County, ST; ..." — we tally
 * each state code and return whichever appears most often.  Returns null when
 * no state codes are found.
 */
export function extractPrimaryStateCode(areaDesc: string): string | null {
  if (!areaDesc) return null;
  const tally: Record<string, number> = {};
  // Match ", ST" at the end of each semicolon-separated segment
  const segmentRe = /,\s*([A-Z]{2})\s*(?:;|$)/g;
  let m: RegExpExecArray | null;
  while ((m = segmentRe.exec(areaDesc)) !== null) {
    const code = m[1];
    tally[code] = (tally[code] ?? 0) + 1;
  }
  // Also try the last token on each segment for zone-format areas ("Z001...KY")
  for (const seg of areaDesc.split(';')) {
    const stateMatch = seg.trim().match(/\b([A-Z]{2})\b/g);
    if (stateMatch) {
      for (const code of stateMatch) {
        if (STATE_CODE_TO_NAME[code]) {
          tally[code] = (tally[code] ?? 0) + 0.5; // lower weight for zone style
        }
      }
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [code, count] of Object.entries(tally)) {
    if (count > bestCount) { bestCount = count; best = code; }
  }
  return best;
}

/**
 * Return the public URL of the banner image for the given NWS alert event
 * type and optional state code.
 * Always uses the new per-state JPG images at /img/{state}/{event-slug}-{state}.jpg.
 * Falls back to the generic per-event PNG images only when no state is known.
 */
export function getWeatherAlertImageUrl(event: string, stateCode?: string): string {
  const stateName = stateCode ? (STATE_CODE_TO_NAME[stateCode.toUpperCase()] ?? null) : null;

  // ── Per-state JPG images (new naming convention) ──
  // Pattern: /img/{state}/{event-slug}-{state}.jpg
  // e.g. /img/alaska/winter-storm-warning-alaska.jpg
  if (stateName) {
    const slug = event
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (slug) {
      return `${IMG_BASE}/${stateName}/${slug}-${stateName}.jpg`;
    }
  }

  // ── Fallback: generic per-event PNG images (no state known) ──
  const map: Record<string, string> = {
    'Tornado Warning':               `${IMG_BASE}/tornado-warning.png`,
    'Tornado Watch':                 `${IMG_BASE}/Tornado-Watch.png`,
    'Severe Thunderstorm Warning':   `${IMG_BASE}/Severe-Thunderstorm-Warning.png`,
    'Severe Thunderstorm Watch':     `${IMG_BASE}/Severe-Thunderstorm-Watch.png`,
    'Flash Flood Warning':           `${IMG_BASE}/Flash-Flood-Warning.png`,
    'Flash Flood Watch':             `${IMG_BASE}/Flash-Flood-Watch.png`,
    'Flood Warning':                 `${IMG_BASE}/Flood-Statement.png`,
    'Flood Watch':                   `${IMG_BASE}/Flood-Statement.png`,
    'Flood Advisory':                `${IMG_BASE}/Flood-Statement.png`,
    'Winter Storm Warning':          `${IMG_BASE}/Winter-Storm-Warning.png`,
    'Winter Storm Watch':            `${IMG_BASE}/Winter-Storm-Watch.png`,
    'Winter Weather Advisory':       `${IMG_BASE}/Winter-Weather-Advisory.png`,
    'Ice Storm Warning':             `${IMG_BASE}/Ice-Storm-Warning.png`,
    'Blizzard Warning':              `${IMG_BASE}/Blizzard-Warning.png`,
    'High Wind Warning':             `${IMG_BASE}/Wind-Advisory.png`,
    'High Wind Watch':               `${IMG_BASE}/Wind-Advisory.png`,
    'Wind Advisory':                 `${IMG_BASE}/Wind-Advisory.png`,
    'Excessive Heat Warning':        `${IMG_BASE}/Extreme-Heat-Warning.png`,
    'Excessive Heat Watch':          `${IMG_BASE}/Extreme-Heat-Warning.png`,
    'Heat Advisory':                 `${IMG_BASE}/Heat-Advisory.png`,
    'Dense Fog Advisory':            `${IMG_BASE}/Dense-Fog-Advisory.png`,
    'Freeze Warning':                `${IMG_BASE}/Frost-Advisory.png`,
    'Frost Advisory':                `${IMG_BASE}/Frost-Advisory.png`,
    'Special Weather Statement':     `${IMG_BASE}/Special-Weather-Statement.png`,
    'Significant Weather Advisory':  `${IMG_BASE}/Significant-Weather-Advisory.png`,
    'Red Flag Warning':              `${IMG_BASE}/Red-Flag-Warning.png`,
    'Rip Current Statement':         `${IMG_BASE}/Rip-Current-Statement.png`,
  };
  return map[event] ?? '';
}

/**
 * Clean NWS alert description text:
 * - Joins hard-wrapped continuation lines back into full sentences.
 * - Converts "* WHAT...text" bullets to "WHAT: text".
 * - Strips leading/trailing "..." NWS section markers.
 * - Converts "- Label...text" sub-bullet separators to "- Label: text".
 */
function cleanNwsDescription(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const blocks = normalized.split(/\n{2,}/);

  const result = blocks.map(block => {
    const lines = block.split('\n');
    const items: string[] = [];
    let current = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\* /.test(trimmed) || /^- /.test(trimmed)) {
        if (current) items.push(current);
        current = trimmed;
      } else if (current) {
        current += ' ' + trimmed;
      } else {
        current = trimmed;
      }
    }
    if (current) items.push(current);

    return items.map(item => {
      // "* WHAT...text" → "WHAT: text"
      item = item.replace(/^\* ([A-Z ]+)\.\.\./, '$1: ');
      // "* ADDITIONAL DETAILS..." (no following text) → "ADDITIONAL DETAILS:"
      item = item.replace(/^\* ([A-Z ]+)\.\.\.$/, '$1:');
      // Strip leading "..."
      item = item.replace(/^\.\.\./, '');
      // Strip trailing "..."
      item = item.replace(/\.\.\.$/, '');
      // "- Label...text" sub-bullet separator → "- Label: text"
      item = item.replace(/^(- [A-Za-z ]+)\.\.\./, '$1: ');
      return item.trim();
    }).filter(s => s.length > 0).join('\n');
  });

  return result.filter(s => s.length > 0).join('\n\n');
}

/**
 * Build the Facebook post caption for an NWS alert.
 */
export function buildWeatherAlertFbCaption(alert: NwsAlert): string {
  // Area: NWS separates areas with "; " — replace with ",  " to match expected style
  const area = alert.areaDesc.split(/;\s*/).join(',  ');

  // Expires: "Mar 18, 5:00 AM EDT"
  let expiresLine = '';
  if (alert.expires) {
    expiresLine = new Date(alert.expires).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
      timeZoneName: 'short',
    });
  }

  const lines: string[] = [
    alert.event.toUpperCase(),
    '',
    `Area: ${area}`,
  ];
  if (expiresLine) lines.push(`Expires: ${expiresLine}`);
  lines.push(`Severity: ${alert.severity}`);
  lines.push('');
  if (alert.headline) lines.push(alert.headline);
  lines.push('');
  lines.push(cleanNwsDescription(alert.description.trim()));
  lines.push('');
  lines.push('https://localkynews.com/live-weather-alerts');
  lines.push('');
  lines.push('#weatheralert #weather #alert');

  return lines.join('\n');
}

/**
 * Wrap a base caption for a new anchor post.
 * Inserts "Updates will be posted in the comments" between the dashboard
 * link and the hashtags so followers know to watch the thread.
 */
function buildAnchorPostCaption(caption: string): string {
  const hashtagLine = '#weatheralert #weather #alert';
  const base = caption.endsWith(hashtagLine)
    ? caption.slice(0, -hashtagLine.length).trimEnd()
    : caption.trimEnd();
  return `${base}\n\n🔄 Updates will be posted in the comments as conditions change.\n\n${hashtagLine}`;
}

/**
 * Strip the dashboard link and hashtag footer from a caption for use as a
 * comment.  Comments should be self-contained text with no promotional links.
 */
function buildCommentText(caption: string): string {
  const lines = caption.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) return false;
    if (trimmed.includes('localkynews.com')) return false;
    if (trimmed.includes('weather.gov/safety')) return false;
    return true;
  });
  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') {
    filtered.pop();
  }
  return filtered.join('\n');
}

/**
 * Post a weather alert to the Facebook page as a photo post.
 * Uses the event-specific banner image when provided, otherwise falls back to
 * the generic weather-alert banner.  Silently skips if Facebook credentials
 * are not configured in the environment.
 */
export async function postFacebookPhotoCaption(env: Env, caption: string, imageUrl?: string): Promise<any> {
  const pageId = ((env as any).FACEBOOK_PAGE_ID || '').trim();
  const pageToken = ((env as any).FACEBOOK_PAGE_ACCESS_TOKEN || '').trim();
  if (!pageId || !pageToken) {
    const msg = '[NWS-FB] Facebook credentials not configured';
    console.log(msg);
    return { ok: false, error: msg };
  }

  const params = new URLSearchParams({
    url: imageUrl || WEATHER_ALERT_IMAGE_URL,
    caption,
    access_token: pageToken,
  });

  try {
    const resp = await fetch(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error(`[NWS-FB] Photo post failed (${resp.status}):`, JSON.stringify(data));
      return { ok: false, error: 'Facebook API error', details: data };
    }
    console.log(`[NWS-FB] Posted weather alert to Facebook → post id=${data?.id ?? 'unknown'}`);
    return { ok: true, result: data };
  } catch (err) {
    console.error('[NWS-FB] Unexpected error posting to Facebook:', err);
    return { ok: false, error: String(err) };
  }
}

export async function postWeatherAlertToFacebook(env: Env, alert: NwsAlert): Promise<any> {
  const caption = buildWeatherAlertFbCaption(alert);
  const stateCode = extractPrimaryStateCode(alert.areaDesc);
  const imageUrl = getWeatherAlertImageUrl(alert.event, stateCode ?? undefined);
  return postFacebookPhotoCaption(env, caption, imageUrl);
}

// ─── NWS alert ingestion ───────────────────────────────────────────────────

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

      // 6. Auto-post to Local KY News Facebook page — failure must never block ingestion
      await postWeatherAlertToFacebook(env, alert).catch((err) => {
        console.error('[NWS-FB] Auto-post failed:', err);
      });
    } catch (err) {
      console.error(`[NWS] Failed to publish alert ${alert.id}:`, err);
    }
  }

  return { published, skipped };
}

/**
 * Post an NWS alert to the Live Weather Alerts Facebook page.
 * Reads the per-category KV flag before posting; silently skips when the
 * flag is disabled or the LIVE_ALERTS_PAGE_* secrets are not configured.
 * Uses its own KV dedup key (separate from the article ingestion key) so
 * that alerts already ingested as articles still get posted here.
 */
export async function postLiveAlertToFacebook(env: Env, alert: NwsAlert): Promise<void> {
  const livePageId    = ((env as any).LIVE_ALERTS_PAGE_ID    || '').trim();
  const livePageToken = ((env as any).LIVE_ALERTS_PAGE_ACCESS_TOKEN || '').trim();
  if (!livePageId || !livePageToken) {
    console.warn('[LIVE-ALERTS-FB] Skipping — LIVE_ALERTS_PAGE_ID or LIVE_ALERTS_PAGE_ACCESS_TOKEN not configured');
    return;
  }

  // Check own FB dedup key — only skip if already successfully posted
  const cache = env.CACHE;
  const fbKey = cache ? `live:alerts:fb:${await sha256Hex(alert.id)}` : null;
  if (fbKey) {
    const alreadyPosted = await (cache as any).get(fbKey);
    if (alreadyPosted) return; // already posted, silent skip
  }

  const category = classifyAlertCategory(alert.event);
  const enabled  = await getLiveAlertAutopostFlag(env, category);
  if (!enabled) {
    console.log(`[LIVE-ALERTS-FB] Skipping "${alert.event}" — ${category} auto-post is disabled`);
    return;
  }

  const startDate = await getLiveAlertAutopostStart(env);
  if (startDate) {
    const alertSent = new Date(alert.sent);
    if (!Number.isNaN(alertSent.valueOf()) && alertSent.getTime() < startDate.getTime()) {
      console.log(`[LIVE-ALERTS-FB] Skipping "${alert.event}" sent=${alertSent.toISOString()} (before start ${startDate.toISOString()})`);
      return;
    }
  }

  const caption  = buildWeatherAlertFbCaption(alert);
  const stateCode = extractPrimaryStateCode(alert.areaDesc);
  const imageUrl = getWeatherAlertImageUrl(alert.event, stateCode ?? undefined);

  try {
    let posted = false;
    if (imageUrl) {
      const params = new URLSearchParams({ caption, url: imageUrl, access_token: livePageToken });
      const resp = await fetch(`https://graph.facebook.com/v19.0/${livePageId}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
      const data: any = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error(`[LIVE-ALERTS-FB] Photo post failed (${resp.status}) "${alert.event}":`, JSON.stringify(data));
      } else {
        console.log(`[LIVE-ALERTS-FB] Posted "${alert.event}" → id=${data?.id ?? 'unknown'}`);
        posted = true;
      }
    } else {
      const params = new URLSearchParams({ message: caption, access_token: livePageToken });
      const resp = await fetch(`https://graph.facebook.com/v19.0/${livePageId}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
      const data: any = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error(`[LIVE-ALERTS-FB] Feed post failed (${resp.status}) "${alert.event}":`, JSON.stringify(data));
      } else {
        console.log(`[LIVE-ALERTS-FB] Posted "${alert.event}" (text-only) → id=${data?.id ?? 'unknown'}`);
        posted = true;
      }
    }
    // Only mark as posted after a confirmed successful post
    if (posted && fbKey && cache) {
      await (cache as any).put(fbKey, '1', { expirationTtl: 172800 });
    }
  } catch (err) {
    console.error('[LIVE-ALERTS-FB] Unexpected error:', err);
  }
}

/**
 * Post a comment on an existing Facebook post (used for alert threading).
 * Returns the new comment ID on success, or null on failure.
 */
async function postWeatherAlertComment(
  fbPostId: string,
  message: string,
  pageId: string,
  pageToken: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const params = new URLSearchParams({
      message,
      access_token: pageToken,
    });
    const resp = await fetch(
      `https://graph.facebook.com/v19.0/${fbPostId}/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: controller.signal,
      },
    );
    const data = await resp.json() as any;
    if (!resp.ok || data?.error) {
      console.error('[LIVE-ALERTS-FB] Comment post failed:', data?.error?.message ?? resp.status);
      return null;
    }
    return String(data?.id ?? '');
  } catch (err) {
    console.error('[LIVE-ALERTS-FB] Comment post threw:', err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check ALL active NWS alerts nationwide and post any that haven't been
 * seen before to the Live Weather Alerts Facebook page.
 * Called from the scheduled handler separately from processNwsAlerts so that
 * the article ingestion pipeline (KY-only) and the Live Alerts FB feed
 * (all US) remain fully independent.
 *
 * Threading model: one Facebook post per active UGC+event combination.
 * NWS reissues are posted as comments; expiry/cancellation posts a final comment
 * then clears the KV entry so the next alert starts a fresh post.
 */
export async function processLiveAlertsNationwide(env: Env): Promise<void> {
  const livePageId    = ((env as any).LIVE_ALERTS_PAGE_ID    || '').trim();
  const livePageToken = ((env as any).LIVE_ALERTS_PAGE_ACCESS_TOKEN || '').trim();
  if (!livePageId || !livePageToken) {
    console.warn('[LIVE-ALERTS-FB] Skipping — LIVE_ALERTS_PAGE_ID or LIVE_ALERTS_PAGE_ACCESS_TOKEN not configured');
    return;
  }

  const rssEntries = await fetchNationalRssFeed();
  if (!rssEntries || rssEntries.length === 0) {
    console.log('[LIVE-ALERTS-FB] No entries found from national RSS feed');
    return;
  }

  const newIds = await getNewNationalAlertIds(env, rssEntries);
  if (!newIds || newIds.length === 0) {
    console.log('[LIVE-ALERTS-FB] No new national alert IDs since last run');
    return;
  }

  const newAlerts: NwsAlert[] = [];
  for (const id of newIds) {
    const alert = await fetchAlertById(id);
    if (!alert) {
      console.warn(`[LIVE-ALERTS-FB] Alert ${id} from RSS could not be fetched`);
      continue;
    }
    newAlerts.push(alert);
  }

  if (newAlerts.length === 0) {
    console.log('[LIVE-ALERTS-FB] No fetchable new alerts found');
    return;
  }

  console.log(`[LIVE-ALERTS-FB] processing ${newAlerts.length} new alert(s) from RSS`);

  const startDate = await getLiveAlertAutopostStart(env);

  for (const alert of newAlerts) {
    try {
      // ── Per-category autopost flag ────────────────────────────────────────
      const category = classifyAlertCategory(alert.event);
      const enabled  = await getLiveAlertAutopostFlag(env, category);
      if (!enabled) {
        console.log(`[LIVE-ALERTS-FB] Skipping "${alert.event}" — ${category} auto-post is disabled`);
        continue;
      }

      // ── Autopost start-date gate ──────────────────────────────────────────
      if (startDate) {
        const alertSent = new Date(alert.sent);
        if (!Number.isNaN(alertSent.valueOf()) && alertSent.getTime() < startDate.getTime()) {
          console.log(`[LIVE-ALERTS-FB] Skipping "${alert.event}" sent=${alertSent.toISOString()} (before start ${startDate.toISOString()})`);
          continue;
        }
      }

      // ── UGC code — required for threading ────────────────────────────────
      const ugcCode = alert.ugcCodes[0] ?? null;
      if (!ugcCode) {
        // No UGC code: fall back to the legacy one-shot post path
        await postLiveAlertToFacebook(env, alert).catch((err) =>
          console.error(`[LIVE-ALERTS-FB] Legacy fallback failed for "${alert.event}":`, err),
        );
        continue;
      }

      const eventSlug = alert.event.toLowerCase().replace(/\s+/g, '_');
      const kvKey     = `live_alert:${ugcCode}:${eventSlug}`;
      const seenKey   = `live_alert_seen:${alert.id}:${ugcCode}`;

      // ── Skip if already handled this alert ID for this UGC code this tick ─
      const alreadySeen = env.CACHE ? await env.CACHE.get(seenKey) : null;
      if (alreadySeen) continue;

      // ── Read existing thread state ────────────────────────────────────────
      const stateRaw = env.CACHE ? await env.CACHE.get(kvKey) : null;
      let state: ActiveAlertState | null = null;
      if (stateRaw) {
        try { state = JSON.parse(stateRaw) as ActiveAlertState; } catch { /* corrupt — treat as missing */ }
      }

      const expiresAtUnix = alert.expires ? Math.floor(new Date(alert.expires).getTime() / 1000) : 0;
      const nowUnix       = Math.floor(Date.now() / 1000);
      const ttl           = expiresAtUnix > nowUnix ? expiresAtUnix - nowUnix + 7200 : 7200;

      if (!state) {
        // ── New alert: create a new Facebook post ─────────────────────────────
        const caption   = buildAnchorPostCaption(buildWeatherAlertFbCaption(alert));
        const stateCode = extractPrimaryStateCode(alert.areaDesc);
        const imageUrl  = getWeatherAlertImageUrl(alert.event, stateCode ?? undefined);

        let fbPostId: string | null = null;
        if (imageUrl) {
          const params = new URLSearchParams({ caption, url: imageUrl, access_token: livePageToken });
          const resp = await fetch(`https://graph.facebook.com/v19.0/${livePageId}/photos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params,
          });
          const data: any = await resp.json().catch(() => ({}));
          if (resp.ok && data?.id) {
            fbPostId = String(data.id);
            console.log(`[LIVE-ALERTS-FB] New photo post "${alert.event}" ${ugcCode} → ${fbPostId}`);
          } else {
            console.error(`[LIVE-ALERTS-FB] Photo post failed "${alert.event}" ${ugcCode} (${resp.status}):`, JSON.stringify(data));
          }
        } else {
          const params = new URLSearchParams({ message: caption, access_token: livePageToken });
          const resp = await fetch(`https://graph.facebook.com/v19.0/${livePageId}/feed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params,
          });
          const data: any = await resp.json().catch(() => ({}));
          if (resp.ok && data?.id) {
            fbPostId = String(data.id);
            console.log(`[LIVE-ALERTS-FB] New feed post "${alert.event}" ${ugcCode} → ${fbPostId}`);
          } else {
            console.error(`[LIVE-ALERTS-FB] Feed post failed "${alert.event}" ${ugcCode} (${resp.status}):`, JSON.stringify(data));
          }
        }

        if (fbPostId && env.CACHE) {
          const newState: ActiveAlertState = {
            nwsAlertId:  alert.id,
            fbPostId,
            expiresAt:   expiresAtUnix,
            ugcCode,
            eventType:   alert.event,
            areaDesc:    alert.areaDesc,
            updateCount: 0,
            lastUpdated: alert.updated,
          };
          await env.CACHE.put(kvKey,   JSON.stringify(newState), { expirationTtl: ttl });
          await env.CACHE.put(seenKey, '1',                      { expirationTtl: ttl });
        }

        // Persist to D1 (best-effort — failure must not block the loop)
        await insertWeatherAlertPost(env, {
          nws_alert_id: alert.id,
          event:        alert.event,
          area:         alert.areaDesc,
          severity:     alert.severity,
          expires_at:   alert.expires  || null,
          sent_at:      alert.sent     || null,
          post_text:    caption,
          fb_post_id:   fbPostId,
        }).catch((err) => console.error('[LIVE-ALERTS-FB] D1 insert failed:', err));

      } else if (state.nwsAlertId === alert.id) {
        // ── Same alert ID: already posted — if updated payload shows newer data,
        // post a comment update; then mark seen.
        const lastUpdated = state.lastUpdated ? new Date(state.lastUpdated).getTime() : 0;
        const currentUpdated = alert.updated ? new Date(alert.updated).getTime() : 0;

        if (currentUpdated > lastUpdated && state.fbPostId) {
          const commentText = [
            `🔄 UPDATE — ${alert.event} for ${alert.areaDesc}`,
            '',
            buildCommentText(buildWeatherAlertFbCaption(alert)),
          ].join('\n');

          await postWeatherAlertComment(state.fbPostId, commentText, livePageId, livePageToken);

          if (env.CACHE) {
            const updatedState: ActiveAlertState = {
              ...state,
              lastUpdated: alert.updated,
            };
            await env.CACHE.put(kvKey, JSON.stringify(updatedState), { expirationTtl: ttl });
          }
        }

        if (env.CACHE) {
          await env.CACHE.put(seenKey, '1', { expirationTtl: ttl });
        }

      } else {
        // ── Reissued alert (new NWS ID, same UGC+event type) ─────────────────
        const messageType = alert.messageType ?? 'Alert';

        if (messageType === 'Cancel') {
          const commentText = [
            `✅ NWS has cancelled this ${alert.event} for ${alert.areaDesc}.`,
            'This was determined to not be an imminent threat.',
          ].join('\n');

          await postWeatherAlertComment(state.fbPostId, commentText, livePageId, livePageToken);

          if (env.CACHE) {
            await env.CACHE.delete(kvKey);
            await env.CACHE.put(seenKey, '1', { expirationTtl: ttl });
          }
        } else {
          // "Update" or reissued "Alert"
          const currentUpdateCount = state.updateCount ?? 0;

          if (currentUpdateCount < 3) {
            // Under the chain limit — post a comment on the existing anchor post
            const commentText = [
              `🔄 UPDATE — ${alert.event} for ${alert.areaDesc}`,
              '',
              buildCommentText(buildWeatherAlertFbCaption(alert)),
            ].join('\n');

            await postWeatherAlertComment(state.fbPostId, commentText, livePageId, livePageToken);

            if (env.CACHE) {
              const updatedState: ActiveAlertState = {
                ...state,
                nwsAlertId:  alert.id,
                expiresAt:   expiresAtUnix,
                areaDesc:    alert.areaDesc,
                updateCount: currentUpdateCount + 1,
              };
              await env.CACHE.put(kvKey,   JSON.stringify(updatedState), { expirationTtl: ttl });
              await env.CACHE.put(seenKey, '1',                          { expirationTtl: ttl });
            }
          } else {
            // Chain limit reached — post a transition comment and start a new anchor post
            await postWeatherAlertComment(
              state.fbPostId,
              `🔄 Continuing coverage of this ${state.eventType} has moved to a new post.`,
              livePageId,
              livePageToken,
            );

            const newCaption  = buildAnchorPostCaption(buildWeatherAlertFbCaption(alert));
            const stateCode   = extractPrimaryStateCode(alert.areaDesc);
            const imageUrl    = getWeatherAlertImageUrl(alert.event, stateCode ?? undefined);

            let newFbPostId: string | null = null;
            if (imageUrl) {
              const params = new URLSearchParams({ caption: newCaption, url: imageUrl, access_token: livePageToken });
              const resp = await fetch(`https://graph.facebook.com/v19.0/${livePageId}/photos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params,
              });
              const data: any = await resp.json().catch(() => ({}));
              if (resp.ok && data?.id) {
                newFbPostId = String(data.id);
                console.log(`[LIVE-ALERTS-FB] Chain-break new post "${alert.event}" ${ugcCode} → ${newFbPostId}`);
              } else {
                console.error(`[LIVE-ALERTS-FB] Chain-break photo post failed "${alert.event}" ${ugcCode} (${resp.status}):`, JSON.stringify(data));
              }
            } else {
              const params = new URLSearchParams({ message: newCaption, access_token: livePageToken });
              const resp = await fetch(`https://graph.facebook.com/v19.0/${livePageId}/feed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params,
              });
              const data: any = await resp.json().catch(() => ({}));
              if (resp.ok && data?.id) {
                newFbPostId = String(data.id);
                console.log(`[LIVE-ALERTS-FB] Chain-break new feed post "${alert.event}" ${ugcCode} → ${newFbPostId}`);
              } else {
                console.error(`[LIVE-ALERTS-FB] Chain-break feed post failed "${alert.event}" ${ugcCode} (${resp.status}):`, JSON.stringify(data));
              }
            }

            if (newFbPostId && env.CACHE) {
              const newState: ActiveAlertState = {
                nwsAlertId:  alert.id,
                fbPostId:    newFbPostId,
                expiresAt:   expiresAtUnix,
                ugcCode,
                eventType:   alert.event,
                areaDesc:    alert.areaDesc,
                updateCount: 0,
                lastUpdated: alert.updated,
              };
              await env.CACHE.put(kvKey,   JSON.stringify(newState), { expirationTtl: ttl });
              await env.CACHE.put(seenKey, '1',                      { expirationTtl: ttl });
            } else if (env.CACHE) {
              // New post failed — preserve old state, just mark seen
              await env.CACHE.put(seenKey, '1', { expirationTtl: ttl });
            }

            // Persist new anchor post to D1
            await insertWeatherAlertPost(env, {
              nws_alert_id: alert.id,
              event:        alert.event,
              area:         alert.areaDesc,
              severity:     alert.severity,
              expires_at:   alert.expires  || null,
              sent_at:      alert.sent     || null,
              post_text:    newCaption,
              fb_post_id:   newFbPostId,
            }).catch((err) => console.error('[LIVE-ALERTS-FB] D1 insert (chain-break) failed:', err));
          }
        }
      }
    } catch (err) {
      console.error(`[LIVE-ALERTS-FB] Error processing "${alert.event}":`, err);
    }
  }

  // ── Expiry sweep: catch alerts the NWS feed stopped returning ─────────────
  // Lists all active-thread KV keys and posts an expiry comment for any whose
  // expiresAt has passed and that NWS is no longer reissuing.
  if (env.CACHE) {
    try {
      const listResult = await env.CACHE.list({ prefix: 'live_alert:' });
      const sweepNow   = Math.floor(Date.now() / 1000);

      for (const entry of listResult.keys) {
        const raw = await env.CACHE.get(entry.name);
        if (!raw) continue;
        let s: ActiveAlertState | null = null;
        try { s = JSON.parse(raw) as ActiveAlertState; } catch { continue; }
        if (!s || s.expiresAt === 0) continue; // unknown expiry — let KV TTL clean up
        if (s.expiresAt < sweepNow) {
          const commentText = `✅ This ${s.eventType} for ${s.areaDesc} has expired.`;
          await postWeatherAlertComment(s.fbPostId, commentText, livePageId, livePageToken);
          await env.CACHE.delete(entry.name);
        }
      }
    } catch (err) {
      console.error('[LIVE-ALERTS-FB] Expiry sweep failed:', err);
    }
  }

  console.log(`[LIVE-ALERTS-FB] Tick complete: checked ${newAlerts.length} nationwide alerts`);
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
    const res = await fetch(listUrl, { headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/json' } });
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
        const pRes = await fetch(productUrl, { headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/json' } });
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

  const imageAlt = `NWS Radar for ${radar.label}`;

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
    imageAlt,
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
  'Red Flag Warning',
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
