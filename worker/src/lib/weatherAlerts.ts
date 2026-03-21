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

/** Update the post_text of an existing post. Optionally backfills fb_post_id when it was previously null. */
export async function updateWeatherAlertPostText(
  env: Env,
  id: number,
  post_text: string,
  fb_post_id?: string | null,
): Promise<boolean> {
  const result = await env.ky_news_db
    .prepare('UPDATE weather_alert_posts SET post_text = ?, fb_post_id = COALESCE(?, fb_post_id) WHERE id = ?')
    .bind(post_text, fb_post_id ?? null, id)
    .run();
  return ((result.meta as any)?.changes ?? 0) > 0;
}

// ─── Comment tracking ───────────────────────────────────────────────────────

export interface NewWeatherAlertComment {
  fb_post_id: string;
  ugc_code?: string | null;
  event: string;
  area: string;
  comment_type: 'update' | 'cancel' | 'expiry' | 'chain_transition';
  comment_text: string;
}

/** Record a comment that was successfully posted to a Facebook anchor post. */
export async function insertWeatherAlertComment(
  env: Env,
  comment: NewWeatherAlertComment,
): Promise<void> {
  await env.ky_news_db
    .prepare(
      `INSERT INTO weather_alert_comments
         (fb_post_id, ugc_code, event, area, comment_type, comment_text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      comment.fb_post_id,
      comment.ugc_code ?? null,
      comment.event,
      comment.area,
      comment.comment_type,
      comment.comment_text,
    )
    .run();
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
