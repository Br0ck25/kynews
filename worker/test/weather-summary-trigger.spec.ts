import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// this file runs outside the huge index.spec.ts suite so unrelated failures
// won't block execution.  we create a fresh in-memory database and KV cache
// and then call our helper to publish a summary.  running this script
// in node/`npm run test` will simulate a manual trigger.

describe('manual weather summary trigger', () => {
  it('publishes a morning summary article', async () => {
    // ensure schema exists in sqlite
    await env.ky_news_db.prepare(`
      CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_url TEXT NOT NULL,
        source_url TEXT NOT NULL,
        url_hash TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        author TEXT,
        published_at TEXT NOT NULL,
        category TEXT NOT NULL,
        is_kentucky INTEGER NOT NULL,
        is_national INTEGER NOT NULL DEFAULT 0,
        county TEXT,
        city TEXT,
        summary TEXT NOT NULL,
        seo_description TEXT NOT NULL,
        raw_word_count INTEGER NOT NULL,
        summary_word_count INTEGER NOT NULL,
        content_text TEXT NOT NULL,
        content_html TEXT NOT NULL,
        image_url TEXT,
        raw_r2_key TEXT,
        slug TEXT,
        content_hash TEXT,
        alert_geojson TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // clear KV flag if present
    if (env.CACHE) {
      await env.CACHE.delete(`weatherSummary:morning:${new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date())}`).catch(() => {});
    }

    // stub fetch for NWS endpoints (simple minimal stub returning empty data)
    const origFetch = global.fetch;
    global.fetch = async (url: any) => {
      return { ok: true, json: async () => ({ features: [], properties: {} }) } as any;
    };

    const { publishWeatherSummary } = await import('../src/lib/weatherSummary');

    await publishWeatherSummary(env, 'morning');

    const rows = await env.ky_news_db.prepare('SELECT title FROM articles').all();
    expect(rows.results.length).toBeGreaterThan(0);
    console.log('Inserted article title:', rows.results[0].title);

    global.fetch = origFetch;
  });
});
