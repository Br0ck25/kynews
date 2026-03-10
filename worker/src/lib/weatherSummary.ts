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
/**
 * Parse raw NWS HWO product text into clean forecast prose.
 *
 * A single HWO product can contain multiple zone sub-sections separated by $$,
 * each with identical or near-identical .DAY ONE / .DAYS TWO THROUGH SEVEN text.
 * This function:
 *   1. Splits on $$ to get each sub-section
 *   2. Extracts only named forecast sections (.DAY ONE, .DAYS TWO THROUGH SEVEN)
 *   3. Deduplicates section bodies that are identical across sub-sections
 *   4. Returns clean labeled prose the AI can read directly
 */
function cleanHwoText(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n');
  const subSections = normalized.split(/\$\$/).map((s) => s.trim()).filter(Boolean);

  // Map of section label -> unique body texts (deduplication across zone sub-sections)
  const sectionMap = new Map<string, Set<string>>();
  const sectionOrder: string[] = [];

  for (const sub of subSections) {
    const lines = sub.split('\n');
    let currentLabel: string | null = null;
    let currentLines: string[] = [];

    const flushSection = () => {
      if (!currentLabel) return;
      const body = currentLines
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (!body) return;
      if (!sectionMap.has(currentLabel)) {
        sectionMap.set(currentLabel, new Set());
        sectionOrder.push(currentLabel);
      }
      sectionMap.get(currentLabel)!.add(body);
    };

    for (const line of lines) {
      const t = line.trim();

      // Named section header: ".DAY ONE...Tonight." or ".DAYS TWO THROUGH SEVEN...Tuesday through Sunday."
      const sectionMatch = t.match(/^\.([A-Z][A-Z0-9 ]+?)\.{3}(.*)/);
      if (sectionMatch) {
        flushSection();
        currentLabel = sectionMatch[1].trim();
        const inline = sectionMatch[2].trim();
        currentLines = inline ? [inline] : [];
        continue;
      }

      // Skip zone code lines (e.g. "KYZ052-104-106-107-")
      if (/^[A-Z]{2,3}Z\d/.test(t)) { currentLabel = null; currentLines = []; continue; }
      // Skip county abbreviation list lines joined by dashes (e.g. "Rowan-Elliott-Morgan-")
      if (/^[A-Z][a-zA-Z]+(-[A-Z][a-zA-Z]+){2,}-?$/.test(t)) continue;
      // Skip WMO/AWIPS header lines
      if (/^[A-Z]{4,}\s+[A-Z]{4}\s+\d{6}/.test(t)) continue;
      // Skip office header line
      if (/^National Weather Service/i.test(t)) continue;
      // Skip timestamp lines like "355 PM EDT Mon Mar 9 2026"
      if (/^\d{3,4} [AP]M [A-Z]{2,4} \w+ \w+ \d+ \d{4}/.test(t)) continue;
      // Skip "This Hazardous Weather Outlook is for..." boilerplate
      if (/^This Hazardous Weather Outlook is for/i.test(t)) continue;
      // Skip forecaster initials (e.g. "HAL/MARCUS" or "DW")
      if (/^[A-Z]{2,}(\/[A-Z]{2,})?$/.test(t) && t.length < 20) continue;
      // Skip "More information" footer lines
      if (/^More information|^weather\.gov/i.test(t)) continue;

      if (currentLabel) {
        currentLines.push(t);
      }
    }
    flushSection();
  }

  // Build output prose — skip spotter statements, they add no value to a news article
  const parts: string[] = [];
  for (const label of sectionOrder) {
    if (/SPOTTER/i.test(label)) continue;
    const bodies = [...(sectionMap.get(label) ?? [])];
    if (bodies.length === 0) continue;

    // If multiple zones had different text for the same section, join them
    const combined = bodies.length === 1
      ? bodies[0]
      : bodies[0] + ' Additionally: ' + bodies.slice(1).join(' Additionally: ');

    // Pretty-print label: "DAYS TWO THROUGH SEVEN" → "Days Two Through Seven"
    const niceLabel = label
      .split(' ')
      .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
      .join(' ');

    parts.push(`${niceLabel}: ${combined}`);
  }

  return parts.join('\n\n');
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

      // Include the first 300 chars of the description so the AI has
      // river names, gauge readings, and specific details to write about
      const descSnippet = a.description
        ? a.description
            .replace(/\r?\n/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .replace(/\.\.\./g, '. ')
            .replace(/\*\s+[A-Z]+\.\.\./g, '')
            .trim()
            .slice(0, 400)
        : '';

      let entry = `${a.event} — ${countyList}${expires ? ` (through ${expires})` : ''}`;
      if (descSnippet) entry += `\n  Details: ${descSnippet}`;
      return entry;
    })
    .join('\n\n');
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

/**
 * Build the prompt sent to the AI model as the user message.
 * Kept concise to avoid hitting token limits on the model.
 */
function buildArticlePrompt(context: string): string {
  // Cap context to ~6000 chars to stay well within model token limits
  const cappedContext = context.slice(0, 6000);

  return `Write a Kentucky weather news article for Local KY News using ONLY the NWS data below.

OUTPUT FORMAT — follow exactly:
Line 1: Headline (specific to today's conditions)
Line 2: (blank)
Line 3+: Article body with these sections in order:
  - Opening paragraph citing all three NWS offices
  - "Eastern Kentucky" heading, then 1-2 paragraphs from NWS Jackson data
  - "Central Kentucky" heading, then 1-2 paragraphs from NWS Louisville data
  - "Western Kentucky" heading, then 1-2 paragraphs from NWS Paducah data
  - If alerts exist: "Current Alerts" heading, then bullet list as: * [Event] — [Counties] through [Expiry]
  - Closing paragraph summarizing what Kentucky residents should expect

Plain text only. AP news style. 350-500 words. Only facts from the data below.

NWS DATA:
${cappedContext}`;
}

async function generateWeatherArticle(
  env: Env,
  context: string,
): Promise<{ headline: string; body: string; contentText: string; contentHtml: string } | null> {
  try {
    if (!env.AI) {
      console.error('[WeatherSummary] env.AI is not available');
      return null;
    }

    const prompt = buildArticlePrompt(context);
    console.log('[WeatherSummary] Calling AI model:', MODEL);

    const aiRaw = (await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: `You are a professional weather journalist for Local KY News, a Kentucky local news website. Write clear, specific, AP-style weather news articles based only on the data provided. Never refuse. Always write the full article.` },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      seed: 42,
      max_completion_tokens: 4000,
    })) as AiResultLike;

    // Log raw response shape to diagnose empty returns
    const rawKeys = aiRaw ? Object.keys(aiRaw) : [];
    console.log('[WeatherSummary] AI raw response keys:', rawKeys.join(', '));
    if (rawKeys.length > 0) {
      const firstKey = rawKeys[0] as keyof AiResultLike;
      const firstVal = aiRaw[firstKey];
      console.log('[WeatherSummary] AI first key value (truncated):', String(firstVal).slice(0, 200));
    }

    const text = extractAiText(aiRaw).trim();
    console.log('[WeatherSummary] AI response length:', text.length, 'chars');

    if (!text || text.length < 100) {
      console.error('[WeatherSummary] AI returned empty or very short response:', text);
      return null;
    }

    return parseArticleText(text);
  } catch (err) {
    console.error('[WeatherSummary] AI generation failed:', err instanceof Error ? err.message : String(err));
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
  console.log(`[WeatherSummary] Building ${when} article. HWO offices: ${hwoData.map(h => h.office).join(', ')}. Alerts: ${alerts.length}`);

  if (env) {
    const context = buildContext(when, hwoData, alerts);
    generated = await generateWeatherArticle(env, context);
  } else {
    console.warn('[WeatherSummary] No env — skipping AI, using fallback');
  }

  if (!generated) {
    console.warn('[WeatherSummary] Using fallback article builder (AI did not produce output)');
    generated = buildFallbackArticle(when, hwoData, alerts);
  } else {
    console.log('[WeatherSummary] AI article generated successfully, headline:', generated.headline.slice(0, 80));
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
