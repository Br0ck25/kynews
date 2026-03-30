// worker/src/lib/weatherAlerts.ts
//
// Database helpers for the weather_alert_posts table.
// Called by route handlers in index.ts — never write raw queries inline.

export interface WeatherAlertPost {
  id: number;
  nws_alert_id: string | null;
  event: string;
  area: string;
  severity: string;
  expires_at: string | null;
  sent_at: string | null;
  post_text: string;
  fb_post_id: string | null;
  created_at: string;
}

export const WEATHER_ALERT_AUTOPOST_KEYS = {
  warnings: 'admin:weather-alert-posts:autopost:warnings',
  watches: 'admin:weather-alert-posts:autopost:watches',
  others: 'admin:weather-alert-posts:autopost:others',
} as const;

export type WeatherAlertAutopostCategory = keyof typeof WEATHER_ALERT_AUTOPOST_KEYS;

export type WeatherAlertAutopostSettings = Record<WeatherAlertAutopostCategory, boolean>;

const DEFAULT_WEATHER_ALERT_AUTOPOST_SETTINGS: WeatherAlertAutopostSettings = {
  warnings: false,
  watches: false,
  others: false,
};

/** Return all posts ordered newest-first. */
export async function listWeatherAlertPosts(env: Env): Promise<WeatherAlertPost[]> {
  const result = await env.ky_news_db
    .prepare('SELECT * FROM weather_alert_posts ORDER BY COALESCE(sent_at, created_at) DESC, id DESC')
    .all<WeatherAlertPost>();
  return result.results ?? [];
}

/** Return a single post by its id. */
export async function getWeatherAlertPostById(env: Env, id: number): Promise<WeatherAlertPost | null> {
  const result = await env.ky_news_db
    .prepare('SELECT * FROM weather_alert_posts WHERE id = ?')
    .bind(id)
    .first<WeatherAlertPost>();
  return result || null;
}

/** Return a single post by its NWS alert id. */
export async function getWeatherAlertPostByNwsAlertId(env: Env, nwsAlertId: string): Promise<WeatherAlertPost | null> {
  const trimmed = String(nwsAlertId || '').trim();
  if (!trimmed) return null;
  const result = await env.ky_news_db
    .prepare('SELECT * FROM weather_alert_posts WHERE nws_alert_id = ? ORDER BY id DESC LIMIT 1')
    .bind(trimmed)
    .first<WeatherAlertPost>();
  return result || null;
}

/** Return the set of nws_alert_ids already stored (for duplicate prevention). */
export async function getPostedNwsAlertIds(env: Env): Promise<Set<string>> {
  const result = await env.ky_news_db
    .prepare("SELECT nws_alert_id FROM weather_alert_posts WHERE nws_alert_id IS NOT NULL")
    .all<{ nws_alert_id: string }>();
  return new Set((result.results ?? []).map((r) => r.nws_alert_id));
}

export interface NewWeatherAlertPost {
  nws_alert_id: string | null;
  event: string;
  area: string;
  severity: string;
  expires_at: string | null;
  sent_at: string | null;
  post_text: string;
  fb_post_id?: string | null;
}

/** Insert a new post. Returns the inserted row id. */
export async function insertWeatherAlertPost(
  env: Env,
  post: NewWeatherAlertPost,
): Promise<number> {
  const result = await env.ky_news_db
    .prepare(
      `INSERT INTO weather_alert_posts
         (nws_alert_id, event, area, severity, expires_at, sent_at, post_text, fb_post_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      post.nws_alert_id ?? null,
      post.event,
      post.area,
      post.severity,
      post.expires_at ?? null,
      post.sent_at ?? null,
      post.post_text,
      post.fb_post_id ?? null,
    )
    .run();
  return Number((result.meta as any)?.last_row_id ?? 0);
}

/**
 * Update the post_text of an existing post.
 * When fb_post_id is provided and the current value is NULL, also sets fb_post_id
 * (backfill for rows created before comment threading was added).
 */
export async function updateWeatherAlertPostText(
  env: Env,
  id: number,
  post_text: string,
  fb_post_id?: string | null,
): Promise<boolean> {
  const result = fb_post_id != null
    ? await env.ky_news_db
        .prepare('UPDATE weather_alert_posts SET post_text = ?, fb_post_id = COALESCE(fb_post_id, ?) WHERE id = ?')
        .bind(post_text, fb_post_id, id)
        .run()
    : await env.ky_news_db
        .prepare('UPDATE weather_alert_posts SET post_text = ? WHERE id = ?')
        .bind(post_text, id)
        .run();
  return ((result.meta as any)?.changes ?? 0) > 0;
}

/** Delete a post by id. */
export async function deleteWeatherAlertPost(env: Env, id: number): Promise<boolean> {
  const result = await env.ky_news_db
    .prepare('DELETE FROM weather_alert_posts WHERE id = ?')
    .bind(id)
    .run();
  return ((result.meta as any)?.changes ?? 0) > 0;
}

/** Delete ALL posts (used to clear the table before a fresh fetch). */
export async function deleteAllWeatherAlertPosts(env: Env): Promise<number> {
  const result = await env.ky_news_db
    .prepare('DELETE FROM weather_alert_posts')
    .run();
  return (result.meta as any)?.changes ?? 0;
}

export async function getWeatherAlertAutopostFlag(
  env: Env,
  category: WeatherAlertAutopostCategory,
): Promise<boolean> {
  if (!env.CACHE) return DEFAULT_WEATHER_ALERT_AUTOPOST_SETTINGS[category];
  const raw = await (env.CACHE as any).get(WEATHER_ALERT_AUTOPOST_KEYS[category]);
  if (raw === null || raw === undefined) return DEFAULT_WEATHER_ALERT_AUTOPOST_SETTINGS[category];
  return String(raw).toLowerCase() === 'true';
}

export async function setWeatherAlertAutopostFlag(
  env: Env,
  category: WeatherAlertAutopostCategory,
  enabled: boolean,
): Promise<void> {
  if (!env.CACHE) return;
  await (env.CACHE as any).put(WEATHER_ALERT_AUTOPOST_KEYS[category], enabled ? 'true' : 'false');
}

export async function getWeatherAlertAutopostSettings(env: Env): Promise<WeatherAlertAutopostSettings> {
  const [warnings, watches, others] = await Promise.all([
    getWeatherAlertAutopostFlag(env, 'warnings'),
    getWeatherAlertAutopostFlag(env, 'watches'),
    getWeatherAlertAutopostFlag(env, 'others'),
  ]);
  return { warnings, watches, others };
}

export function classifyWeatherAlertAutopostCategory(event: string): WeatherAlertAutopostCategory {
  const lower = String(event || '').toLowerCase();
  if (lower.includes('warning')) return 'warnings';
  if (lower.includes('watch')) return 'watches';
  return 'others';
}

function parseWeatherAlertDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  if (/[zZ]$/.test(dateStr) || /[+-]\d{2}:\d{2}$/.test(dateStr)) {
    const parsed = new Date(dateStr);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(`${dateStr}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatWeatherAlertExpires(dateStr: string | null | undefined): string | null {
  const date = parseWeatherAlertDate(dateStr);
  if (!date) return null;
  try {
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/New_York',
      timeZoneName: 'short',
    });
  } catch {
    return String(dateStr);
  }
}

function formatWeatherAlertBullets(text: string): string {
  return String(text || '')
    .replace(/\*/g, '')
    .replace(/^\s*([A-Z][A-Z\s]{1,30})\.\.\./gm, (_match, key) => `\n\n${String(key).trim()}: `)
    .replace(/\n(WHAT|WHERE|WHEN|IMPACTS|PRECAUTIONARY ACTIONS|ADDITIONAL DETAILS):/g, '\n\n$1:')
    .replace(/\n{3,}/g, '\n\n')
    .trimStart();
}

export function buildWeatherAlertPostText(alert: {
  event?: string | null;
  areaDesc?: string | null;
  expires?: string | null;
  severity?: string | null;
  headline?: string | null;
  description?: string | null;
  instruction?: string | null;
}): string {
  const event = String(alert.event ?? 'Weather Alert');
  const area = String(alert.areaDesc ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join(', ');
  const expires = formatWeatherAlertExpires(alert.expires);
  const headline = String(alert.headline ?? '').trim();
  const desc = formatWeatherAlertBullets(String(alert.description ?? '').trim());
  const instruction = formatWeatherAlertBullets(String(alert.instruction ?? '').trim());

  const lines: string[] = [];
  lines.push(event.toUpperCase());
  lines.push('');
  if (area) lines.push(`Area: ${area}`);
  if (expires) lines.push(`Expires: ${expires}`);
  if (alert.severity) lines.push(`Severity: ${String(alert.severity)}`);
  if (headline && headline !== event) {
    lines.push('');
    lines.push(headline);
  }
  if (desc) {
    lines.push('');
    lines.push(desc);
  }
  if (instruction) {
    lines.push('');
    lines.push(instruction);
  }
  lines.push('');
  lines.push('#localkynews #kentuckyalerts #weatheralert #kentuckyweather');
  return lines.join('\n');
}
