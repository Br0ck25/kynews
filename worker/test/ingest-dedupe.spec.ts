import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { ingestSingleUrl } from '../src/lib/ingest';
import { sha256Hex } from '../src/lib/http';
import { findArticleByHash, insertArticle } from '../src/lib/db';
import * as classifyModule from '../src/lib/classify';
import * as aiModule from '../src/lib/ai';

// replicate minimal schema setup from index.spec.ts
async function ensureSchemaAndFixture() {
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
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `).run();
    await env.ky_news_db.prepare(`
        CREATE TABLE IF NOT EXISTS article_counties (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
            county TEXT NOT NULL,
            is_primary INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0,1)),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `).run();
    await env.ky_news_db.prepare(`
        CREATE TABLE IF NOT EXISTS url_hashes (
            hash TEXT PRIMARY KEY,
            article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE
        )
    `).run();

    await env.ky_news_db.prepare(`DELETE FROM article_counties`).run();
    await env.ky_news_db.prepare(`DELETE FROM articles`).run();
    await env.ky_news_db.prepare(`DELETE FROM url_hashes`).run();
}

// stubbed fetch response used in tests
const basicHtml = '<html><body><p>content</p></body></html>';

describe('ingest deduplication helpers', () => {
    it('dedupes syndicated wire articles via URL path slug', async () => {
        await ensureSchemaAndFixture();
        const originalFetch = global.fetch;
        global.fetch = async () => new Response(basicHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
        vi.spyOn(classifyModule, 'classifyArticleWithAi').mockResolvedValue({
            category: 'today', isKentucky: true, isNational: false, county: null, counties: [], city: null,
        });
        vi.spyOn(aiModule, 'summarizeArticle').mockResolvedValue({ summary: 'x', seoDescription: 'y', summaryWordCount: 1 });

        const r1 = await ingestSingleUrl(env, { url: 'https://wbko.com/2026/03/03/this-is-a-very-long-slug-for-testing-dedup', allowShortContent: true });
        console.log('r1 result', r1);
        expect(r1.status).toBe('inserted');
        const r2 = await ingestSingleUrl(env, { url: 'https://wymt.com/2026/03/03/this-is-a-very-long-slug-for-testing-dedup', allowShortContent: true });
        console.log('r2 result', r2);
        expect(r2.status).toBe('duplicate');
        expect(r2.reason).toMatch(/syndicated wire/);

        const pathHash = await sha256Hex('path:/2026/03/03/this-is-a-very-long-slug-for-testing-dedup');
        const dup = await findArticleByHash(env, pathHash);
        expect(dup?.id).toBe(1);

        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('content fingerprint write occurs immediately and still duplicates', async () => {
        await ensureSchemaAndFixture();
        const originalFetch = global.fetch;
        global.fetch = async () => new Response(basicHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
        vi.spyOn(classifyModule, 'classifyArticleWithAi').mockResolvedValue({
            category: 'today', isKentucky: true, isNational: false, county: null, counties: [], city: null,
        });
        vi.spyOn(aiModule, 'summarizeArticle').mockResolvedValue({ summary: 'x', seoDescription: 'y', summaryWordCount: 1 });

        const r1 = await ingestSingleUrl(env, { url: 'https://a.com/1', allowShortContent: true });
        console.log('fingerprint r1', r1);
        expect(r1.status).toBe('inserted');
        const r2 = await ingestSingleUrl(env, { url: 'https://b.com/2', allowShortContent: true });
        console.log('fingerprint r2', r2);
        expect(r2.status).toBe('duplicate');
        expect(r2.reason).toMatch(/content fingerprint/);

        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });
});
