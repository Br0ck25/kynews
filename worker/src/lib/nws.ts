// worker/src/lib/nws.ts — NWS Weather Alert auto-ingestion for Kentucky
import { KY_COUNTIES } from '../data/ky-geo';
import type { NewArticle } from '../types';
import { sha256Hex, normalizeCanonicalUrl } from './http';
import { findArticleByHash, insertArticle } from './db';

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

      // Plain paragraph — join lines, clean dots, render
      const text = cleanDots(lines.join(' ').replace(/\s{2,}/g, ' '));
      if (text) parts.push(`<p>${text}</p>`);
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
    // Fallback summary — overwritten by summarizeArticle() in processNwsAlerts()
    summary: contentText.slice(0, 800),
    seoDescription,
    rawWordCount: contentText.split(/\s+/).filter(Boolean).length,
    summaryWordCount: 0,
    contentText,
    contentHtml,
    imageUrl: radarUrl,
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
  return `<p><strong>Current Radar (${radarLabel}):</strong><br><img src="https://radar.weather.gov/ridge/standard/${radarStation}_loop.gif" alt="NWS Radar for Kentucky" style="max-width:100%;border:1px solid #ccc;border-radius:4px;"></p>`;
}
