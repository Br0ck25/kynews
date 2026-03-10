// worker/src/lib/weatherSummary.ts
// Generates and publishes the twice-daily Kentucky weather summary articles.
// Sources: NWS HWO products from KJKL, KLMK, KPAH + active KY alerts.
// The article is written by the Workers AI model from those live data sources.

import { fetchActiveKyAlerts, fetchHwoProducts } from './nws';
import { insertArticle, findArticleByHash } from './db';
import { sha256Hex, normalizeCanonicalUrl } from './http';
import type { NewArticle } from '../types';
import type { NwsAlert } from './nws';

const MODEL = '@cf/zai-org/glm-4.7-flash' as keyof AiModels;

// Base URL duplicated from index.ts to avoid a circular dependency at runtime.
const BASE_URL = 'https://localkynews.com';

// ─── Office metadata ──────────────────────────────────────────────────────────

const HWO_OFFICES = ['KJKL', 'KLMK', 'KPAH'] as const;

const OFFICE_LABELS: Record<string, string> = {
  KJKL: 'National Weather Service Jackson, KY',
  KLMK: 'National Weather Service Louisville, KY',
  KPAH: 'National Weather Service Paducah, KY',
};

const OFFICE_REGION: Record<string, string> = {
  KJKL: 'Eastern Kentucky',
  KLMK: 'Central Kentucky',
  KPAH: 'Western Kentucky',
};

// ─── Time helpers ─────────────────────────────────────────────────────────────

function getEasternHourMinute(): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date());
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  return { hour, minute };
}

function getEasternDateString(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

// ─── Data gathering ───────────────────────────────────────────────────────────

interface HwoData {
  office: string;
  label: string;
  region: string;
  productText: string;
  issuanceTime: string;
}

async function fetchAllHwoData(): Promise<HwoData[]> {
  const results: HwoData[] = [];
  for (const office of HWO_OFFICES) {
    try {
      const products = await fetchHwoProducts(office);
      if (products.length > 0) {
        const latest = products[0];
        results.push({
          office,
          label: OFFICE_LABELS[office] ?? office,
          region: OFFICE_REGION[office] ?? office,
          productText: latest.productText,
          issuanceTime: latest.issuanceTime,
        });
      }
    } catch (err) {
      console.warn(`[WeatherSummary] Could not fetch HWO for ${office}:`, err);
    }
  }
  return results;
}

// ─── HWO text cleaning ────────────────────────────────────────────────────────

/**
 * Strip WMO/AWIPS headers and end-of-product markers from raw NWS product text,
 * leaving only the readable forecast content.
 */
function cleanHwoText(raw: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const startIdx = lines.findIndex((l) => /HAZARDOUS WEATHER OUTLOOK/i.test(l));
  const body = startIdx >= 0 ? lines.slice(startIdx + 1) : lines;
  const endIdx = body.findIndex((l) => l.trim() === '$$');
  const trimmed = endIdx >= 0 ? body.slice(0, endIdx) : body;
  return trimmed
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n')
    .trim();
}

// ─── Context assembly ─────────────────────────────────────────────────────────

function formatAlerts(alerts: NwsAlert[]): string {
  if (alerts.length === 0) return 'No active NWS alerts for Kentucky at this time.';
  return alerts
    .map((a) => {
      const countyList =
        a.counties.length > 0
          ? a.counties.join(', ') + (a.counties.length === 1 ? ' County' : ' Counties')
          : a.areaDesc;
      const expires = a.expires
        ? new Date(a.expires).toLocaleString('en-US', {
            timeZone: 'America/New_York',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short',
          })
        : '';
      return `* ${a.event} — ${countyList}${expires ? ` through ${expires}` : ''}`;
    })
    .join('\n');
}

function buildContext(
  when: 'morning' | 'evening',
  hwoData: HwoData[],
  alerts: NwsAlert[],
): string {
  const timeLabel = when === 'morning' ? 'Morning' : 'Evening';
  const nowStr = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const hwoParts = hwoData.length > 0
    ? hwoData
        .map((h) => {
          const issuedStr = new Date(h.issuanceTime).toLocaleString('en-US', {
            timeZone: 'America/New_York',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short',
          });
          return `--- ${h.label} (${h.region}) ---\nIssued: ${issuedStr}\n\n${cleanHwoText(h.productText)}`;
        })
        .join('\n\n')
    : 'No HWO data available.';

  return `PUBLICATION: Local KY News
ARTICLE TYPE: ${timeLabel} Kentucky Weather Summary
CURRENT TIME: ${nowStr}

=== HAZARDOUS WEATHER OUTLOOKS ===

${hwoParts}

=== ACTIVE NWS ALERTS FOR KENTUCKY ===

${formatAlerts(alerts)}`;
}

// ─── AI article generation ────────────────────────────────────────────────────

const WEATHER_SYSTEM_PROMPT = `You are a professional weather journalist writing for Local KY News, a Kentucky local news website.

You will be given live National Weather Service data: Hazardous Weather Outlooks from three NWS offices covering Kentucky (Eastern, Central, and Western), plus any active NWS alerts.

Write a complete, publication-ready Kentucky weather summary article from this data. The article must:

- Begin with a strong, specific headline on the first line that reflects what the data actually says — no generic titles
- Follow with a blank line, then the article body
- Open with a lede paragraph summarizing the statewide weather picture and naming all three NWS offices as the source
- Include a separate section for Eastern Kentucky (NWS Jackson), Central Kentucky (NWS Louisville), and Western Kentucky (NWS Paducah), drawing directly from each office's HWO text
- If active alerts exist, include an "Active Alerts" section listing each alert with county names and expiry times, formatted as bullet points using * prefix
- Close with a "What to Expect" section using * bullet points summarizing key takeaways for Kentucky residents
- Be 350-600 words, AP-style, factual, specific — grounded entirely in the source data provided
- Use plain text only — no HTML, no markdown, no bylines, no datelines

Only report what the source data says. Do not invent forecasts or add generic filler sentences. If an office's HWO says no hazards are expected, state that briefly for that region.

Output format: First line is the headline. Then a blank line. Then the article body.`;

type AiResultLike = {
  response?: string;
  result?: { response?: string };
  output_text?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
};

function extractAiText(raw: AiResultLike): string {
  if (raw?.response) return String(raw.response);
  if (raw?.result?.response) return String(raw.result.response);
  if (raw?.output_text) return String(raw.output_text);
  if (Array.isArray(raw?.choices) && raw.choices[0]?.message?.content) {
    return String(raw.choices[0].message.content);
  }
  return '';
}

async function generateWeatherArticle(
  env: Env,
  context: string,
): Promise<{ headline: string; body: string; contentText: string; contentHtml: string } | null> {
  try {
    const aiRaw = (await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: WEATHER_SYSTEM_PROMPT },
        { role: 'user', content: context },
      ],
      max_completion_tokens: 1500,
    })) as AiResultLike;

    const text = extractAiText(aiRaw).trim();
    if (!text) return null;

    return parseArticleText(text);
  } catch (err) {
    console.error('[WeatherSummary] AI generation failed:', err);
    return null;
  }
}

// ─── Text → structured article ────────────────────────────────────────────────

function parseArticleText(raw: string): {
  headline: string;
  body: string;
  contentText: string;
  contentHtml: string;
} {
  const trimmed = raw.trim();
  const newlineIdx = trimmed.indexOf('\n');

  let headline: string;
  let body: string;

  if (newlineIdx > 0) {
    headline = trimmed.slice(0, newlineIdx).trim();
    body = trimmed.slice(newlineIdx + 1).replace(/^\n+/, '');
  } else {
    headline = trimmed.slice(0, 120);
    body = trimmed;
  }

  const contentText = `${headline}\n\n${body}`;
  const contentHtml = buildHtml(headline, body);

  return { headline, body, contentText, contentHtml };
}

function buildHtml(headline: string, body: string): string {
  const parts: string[] = [`<h2>${esc(headline)}</h2>`];
  let inList = false;

  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) {
      if (inList) { parts.push('</ul>'); inList = false; }
      continue;
    }
    if (t.startsWith('* ')) {
      if (!inList) { parts.push('<ul>'); inList = true; }
      parts.push(`<li>${esc(t.slice(2).trim())}</li>`);
    } else {
      if (inList) { parts.push('</ul>'); inList = false; }
      // Short lines without terminal punctuation are treated as section headings
      if (t.length < 60 && !/[.!?,]$/.test(t) && /^[A-Z]/.test(t)) {
        parts.push(`<h3>${esc(t)}</h3>`);
      } else {
        parts.push(`<p>${esc(t)}</p>`);
      }
    }
  }
  if (inList) parts.push('</ul>');

  return parts.join('\n');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Fallback (no AI response) ────────────────────────────────────────────────

/**
 * If AI is unavailable or returns empty output, build a structured article
 * directly from source data so the scheduled publish never silently fails.
 */
function buildFallbackArticle(
  when: 'morning' | 'evening',
  hwoData: HwoData[],
  alerts: NwsAlert[],
): { headline: string; body: string; contentText: string; contentHtml: string } {
  const dateLabel = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const timeLabel = when === 'morning' ? 'Morning' : 'Evening';
  const headline = `Kentucky ${timeLabel} Weather Briefing — ${dateLabel}`;

  const lines: string[] = [];
  lines.push(
    `The National Weather Service has issued Hazardous Weather Outlooks for Kentucky. Below is a summary of the latest forecasts and active alerts.`,
  );

  for (const h of hwoData) {
    lines.push('');
    lines.push(h.region);
    lines.push(cleanHwoText(h.productText).slice(0, 500));
  }

  if (alerts.length > 0) {
    lines.push('');
    lines.push('Active NWS Alerts');
    for (const a of alerts) {
      const countyList = a.counties.length > 0 ? a.counties.join(', ') + ' County' : a.areaDesc;
      const expires = a.expires
        ? new Date(a.expires).toLocaleString('en-US', {
            timeZone: 'America/New_York',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short',
          })
        : '';
      lines.push(`* ${a.event} for ${countyList}${expires ? ` through ${expires}` : ''}`);
    }
  }

  lines.push('');
  lines.push('Stay tuned to Local KY News for continuing weather coverage.');

  const body = lines.join('\n');
  const contentText = `${headline}\n\n${body}`;
  const contentHtml = buildHtml(headline, body);

  return { headline, body, contentText, contentHtml };
}

// ─── Main article builder ─────────────────────────────────────────────────────

export async function buildDailyWeatherArticle(
  env: Env | undefined,
  when: 'morning' | 'evening',
): Promise<NewArticle> {
  const dateStr = getEasternDateString();

  // Fetch all live data concurrently
  const [hwoData, alerts] = await Promise.all([
    fetchAllHwoData(),
    fetchActiveKyAlerts().catch((): NwsAlert[] => []),
  ]);

  // Build context string from live source data, then let AI write the article
  let generated: ReturnType<typeof buildFallbackArticle> | null = null;

  if (env) {
    const context = buildContext(when, hwoData, alerts);
    generated = await generateWeatherArticle(env, context);
  }

  if (!generated) {
    generated = buildFallbackArticle(when, hwoData, alerts);
  }

  const { headline, contentText, contentHtml } = generated;

  // Pick radar image based on where active alerts are concentrated
  const hasEasternAlert = alerts.some((a) =>
    a.counties.some((c) =>
      ['Perry', 'Floyd', 'Pike', 'Harlan', 'Letcher', 'Knott', 'Breathitt',
       'Magoffin', 'Johnson', 'Lawrence', 'Martin', 'Leslie', 'Lee', 'Owsley'].includes(c),
    ),
  );
  const hasWesternAlert = alerts.some((a) =>
    a.counties.some((c) =>
      ['McCracken', 'Graves', 'Calloway', 'Marshall', 'Daviess', 'Henderson',
       'Union', 'Crittenden', 'Trigg', 'Lyon', 'Ballard', 'Carlisle', 'Hickman', 'Fulton'].includes(c),
    ),
  );
  const radarStation = hasEasternAlert ? 'KJKL' : hasWesternAlert ? 'KPAH' : 'KLVX';
  const imageUrl = `https://radar.weather.gov/ridge/standard/${radarStation}_loop.gif`;

  const slugBase = `kentucky-weather-${when}-${dateStr}`;
  const canonicalUrl = `${BASE_URL}/manual/${slugBase}`;
  const urlHash = await sha256Hex(normalizeCanonicalUrl(canonicalUrl));
  const nowIso = new Date().toISOString();

  const seoDescription = contentText
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 160)
    .trim();

  return {
    canonicalUrl,
    sourceUrl: BASE_URL,
    urlHash,
    title: headline,
    author: 'Local KY News',
    publishedAt: nowIso,
    category: 'weather',
    isKentucky: true,
    isNational: false,
    county: null,
    counties: [],
    city: null,
    slug: slugBase,
    summary: contentText.slice(0, 800),
    seoDescription,
    rawWordCount: contentText.split(/\s+/).filter(Boolean).length,
    summaryWordCount: 0,
    contentText,
    contentHtml,
    imageUrl,
    rawR2Key: null,
    contentHash: await sha256Hex(contentText.slice(0, 3000)),
  };
}

// ─── Publish + scheduling ─────────────────────────────────────────────────────

export async function publishWeatherSummary(env: Env, when: 'morning' | 'evening'): Promise<void> {
  const article = await buildDailyWeatherArticle(env, when);
  const existing = await findArticleByHash(env, article.urlHash);
  if (existing) return;
  await insertArticle(env, article);
}

/**
 * Called on every scheduled tick. Publishes at 6:00-6:02 AM and 6:00-6:02 PM
 * Eastern. KV ensures exactly-once publication per day per slot.
 */
export async function maybeRunWeatherSummary(env: Env): Promise<void> {
  const { hour, minute } = getEasternHourMinute();
  const dateStr = getEasternDateString();

  if (hour === 6 && minute < 3) {
    await runIfNew(env, 'morning', dateStr);
  } else if (hour === 18 && minute < 3) {
    await runIfNew(env, 'evening', dateStr);
  }
}

async function runIfNew(env: Env, when: 'morning' | 'evening', dateStr: string): Promise<void> {
  const key = `weatherSummary:${when}:${dateStr}`;
  if (env.CACHE) {
    const prev = await env.CACHE.get(key);
    if (prev) return;
    await env.CACHE.put(key, '1', { expirationTtl: 86400 });
  }
  await publishWeatherSummary(env, when);
}
