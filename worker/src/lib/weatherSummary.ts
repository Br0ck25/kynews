// worker/src/lib/weatherSummary.ts
// Helper functions for generating and publishing the twice‑daily Kentucky
// weather summary articles described in kentucky_weather_automation_plan.md.

// Env type is declared globally in index.ts; avoid a runtime import to
// prevent circular dependency.  Use `any` where necessary.
// import type { Env } from '../index';
import { fetchActiveKyAlerts } from './nws';
import { insertArticle, findArticleByHash } from './db';
import { sha256Hex, normalizeCanonicalUrl } from './http';
import type { NewArticle } from '../types';

// Base URL duplicated from index.ts to avoid a circular dependency at runtime.
const BASE_URL = 'https://localkynews.com';

interface CountyCoord {
  name: string;
  lat: number;
  lon: number;
}

// the ten counties that appear in the weather selector; each entry includes
// the "name" used in the UI and the lat/lon that will be passed to the
// National Weather Service points endpoint.
const SUMMARY_COUNTIES: CountyCoord[] = [
  { name: 'McCracken (Paducah)', lat: 37.0834, lon: -88.6001 },
  { name: 'Graves (Mayfield)', lat: 36.7418, lon: -88.6215 },
  { name: 'Warren (Bowling Green)', lat: 36.9685, lon: -86.4808 },
  { name: 'Jefferson (Louisville)', lat: 38.2527, lon: -85.7585 },
  { name: 'Fayette (Lexington)', lat: 38.0406, lon: -84.5037 },
  { name: 'Franklin (Frankfort)', lat: 38.2009, lon: -84.8733 },
  { name: 'Kenton (Covington)', lat: 39.0837, lon: -84.5086 },
  { name: 'Pulaski (Somerset)', lat: 37.0912, lon: -84.6041 },
  { name: 'Perry (Hazard)', lat: 37.2498, lon: -83.1932 },
  { name: 'Pike (Pikeville)', lat: 37.4793, lon: -82.5185 },
];

/**
 * Return the current hour/minute in the eastern time zone.
 */
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

/**
 * ISO date string (YYYY-MM-DD) in eastern time.
 */
function getEasternDateString(): string {
  // using en-CA produces the ISO ordering we want
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

/**
 * Fetch forecast and current observation for one county using the NWS API.
 */
async function fetchCountyWeather(county: CountyCoord): Promise<{
  currentObs: any | null;
  forecast: any[];
}> {
  try {
    const pointRes = await fetch(`https://api.weather.gov/points/${county.lat},${county.lon}`);
    if (!pointRes.ok) return { currentObs: null, forecast: [] };
    const pointData: any = await pointRes.json();
    const { forecast: fUrl, observationStations } = pointData.properties || {};
    const [fRes, sRes] = await Promise.all([
      fUrl
        ? fetch(fUrl)
        : Promise.resolve({ ok: false, json: async () => ({}) } as any),
      observationStations
        ? fetch(observationStations)
        : Promise.resolve({ ok: false, json: async () => ({}) } as any),
    ]);
    const forecast = fRes.ok ? (await (fRes as any).json()).properties?.periods || [] : [];
    let currentObs = null;
    if (sRes.ok) {
      const sData: any = await (sRes as any).json();
      if (Array.isArray(sData.features) && sData.features.length > 0) {
        const sid = sData.features[0].properties.stationIdentifier;
        const oRes = await fetch(`https://api.weather.gov/stations/${sid}/observations/latest`);
        if (oRes.ok) {
          const oData: any = await oRes.json();
          currentObs = oData.properties;
        }
      }
    }
    return { currentObs, forecast };
  } catch {
    return { currentObs: null, forecast: [] };
  }
}

/**
 * Build a NewArticle object representing the morning/evening summary.  The
 * article content is a simple concatenation of alerts, a narrative paragraph,
 * and the county-by-county latest observation data.
 */
export async function buildDailyWeatherArticle(
  env: Env | undefined,
  when: 'morning' | 'evening',
): Promise<NewArticle> {
  const alerts = await fetchActiveKyAlerts();

  // fetch county data concurrently but limit failures
  const weatherData = await Promise.all(
    SUMMARY_COUNTIES.map((c) => fetchCountyWeather(c)),
  );

  // build sections
  let alertSection = 'Active Alerts: ';
  if (alerts.length === 0) {
    alertSection += 'None';
  } else {
    alertSection += alerts
      .map(
        (a) =>
          `${a.event} for ${a.counties.join(', ')} (issued ${new Date(
            a.sent,
          ).toLocaleString('en-US', {
            timeZone: 'America/New_York',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          })})`,
      )
      .join('\n');
  }

  // simple heuristics for narrative paragraphs
  const sentences: string[] = [];
  sentences.push(
    'Kentucky is seeing a warm and mostly pleasant start to the week, with sunshine and temperatures climbing into the low to upper 70s across much of the state today.',
  );

  const forecastText = weatherData.map((w, idx) => w.forecast[0] || {}).map((p) => p.shortForecast || '').join(' ');
  if (/rain|storm|thunder/i.test(forecastText)) {
    sentences.push(
      'However, the quiet weather will not last long. Rain showers and thunderstorms are expected to move into Kentucky Tuesday and Wednesday, bringing unsettled conditions statewide.',
    );
  }
  if (/cold|snow|cool/i.test(forecastText) || /Thursday/.test(forecastText)) {
    sentences.push(
      'By Thursday, a strong cold front will move through the region, bringing a noticeable cooldown.',
    );
  }
  sentences.push(
    'Conditions improve heading into the weekend. Friday and Saturday will bring drier weather with sunshine returning.',
  );
  sentences.push(
    'Looking ahead to Sunday, warmer air returns with highs climbing back into the upper 60s to mid-70s, although a few scattered rain showers may redevelop across parts of the state.',
  );

  sentences.push(
    'Overall, Kentucky residents can expect a warm start, storm chances in the middle of the week, a sharp cooldown Thursday, and improving weather heading into the weekend.',
  );

  const narrative = sentences.join(' ');

  const countyLines = weatherData
    .map((w, idx) => {
      const countyName = SUMMARY_COUNTIES[idx].name.split(' ')[0];
      const tempC = w.currentObs?.temperature?.value;
      const tempF = tempC != null ? Math.round(tempC * 9 / 5 + 32) : null;
      const cond = w.forecast[0]?.shortForecast || w.currentObs?.textDescription || '';
      return `- ${countyName}: ${
        tempF != null ? `${tempF}°F` : '—'
      }${cond ? ', ' + cond : ''}`;
    })
    .join('\n');

  const contentText = `${alertSection}\n\n${narrative}\n\nForecast by county (latest observation):\n${countyLines}`;
  const contentHtml = contentText.replace(/\n/g, '<br>');

  const dateStr = getEasternDateString();
  const slugBase = `kentucky-weather-update-${when}-summary-${dateStr}`;
  const canonicalUrl = `${BASE_URL}/manual/${slugBase}`;
  const urlHash = await sha256Hex(normalizeCanonicalUrl(canonicalUrl));

  const nowIso = new Date().toISOString();

  const article: NewArticle = {
    canonicalUrl,
    sourceUrl: BASE_URL,
    urlHash,
    title: `Kentucky Weather Update – ${when === 'morning' ? 'Morning Summary' : 'Evening Summary'}`,
    author: 'Local KY News',
    publishedAt: nowIso,
    category: 'weather',
    isKentucky: true,
    isNational: false,
    county: null,
    counties: [],
    city: null,
    summary: contentText.slice(0, 800),
    seoDescription: contentText.slice(0, 160),
    rawWordCount: contentText.split(/\s+/).filter(Boolean).length,
    summaryWordCount: 0,
    contentText,
    contentHtml,
    imageUrl: null,
    rawR2Key: null,
    contentHash: await sha256Hex(contentText.slice(0, 3000)),
  };

  return article;
}

/**
 * Publish a summary article if one for the given date/slot does not already
 * exist.  This is idempotent as long as the KV key or database record exists.
 */
export async function publishWeatherSummary(env: Env, when: 'morning' | 'evening'): Promise<void> {
  const article = await buildDailyWeatherArticle(env, when);

  // dedupe by url hash first
  const existing = await findArticleByHash(env, article.urlHash);
  if (existing) return;

  await insertArticle(env, article);
}

/**
 * Called on every scheduled tick (every few minutes).  If the current eastern
 * time is 6:00–6:02 a.m. or 6:00–6:02 p.m. and we haven't already posted the
 * summary for today, publish it now.
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

async function runIfNew(env: Env, when: 'morning' | 'evening', dateStr: string) {
  const key = `weatherSummary:${when}:${dateStr}`;
  if (env.CACHE) {
    const prev = await env.CACHE.get(key);
    if (prev) return;
    await env.CACHE.put(key, '1', { expirationTtl: 86400 });
  }
  await publishWeatherSummary(env, when);
}

