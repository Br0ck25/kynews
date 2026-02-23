import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { detectSemanticCategory, isShortContentAllowed } from '../src/lib/classify';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

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
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`).run();

	await env.ky_news_db.prepare(`DELETE FROM articles`).run();

	const insertFixture = env.ky_news_db.prepare(`
		INSERT INTO articles (
			canonical_url, source_url, url_hash, title, author, published_at, category,
			is_kentucky, county, city, summary, seo_description, raw_word_count,
			summary_word_count, content_text, content_html, image_url, raw_r2_key
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const now = new Date().toISOString();

	await insertFixture
		.bind(
			'https://example.com/ky-today',
			'https://example.com',
			'hash-ky-today',
			'Kentucky Today Story',
			null,
			now,
			'today',
			1,
			'Fayette',
			'lexington',
			'Summary',
			'SEO description',
			120,
			70,
			'Content body for test',
			'<p>Content body for test</p>',
			null,
			null,
		)
		.run();

	await insertFixture
		.bind(
			'https://example.com/ky-sports',
			'https://example.com',
			'hash-ky-sports',
			'Kentucky Sports Story',
			null,
			now,
			'sports',
			1,
			'Jefferson',
			'louisville',
			'Summary',
			'SEO description',
			130,
			72,
			'Content body for test',
			'<p>Content body for test</p>',
			null,
			null,
		)
		.run();

	await insertFixture
		.bind(
			'https://example.com/non-ky-sports',
			'https://example.com',
			'hash-non-ky-sports',
			'Non Kentucky Sports Story',
			null,
			now,
			'sports',
			0,
			null,
			null,
			'Summary',
			'SEO description',
			125,
			68,
			'Content body for test',
			'<p>Content body for test</p>',
			null,
			null,
		)
		.run();

	await insertFixture
		.bind(
			'https://example.com/non-ky-today',
			'https://example.com',
			'hash-non-ky-today',
			'Non Kentucky Today Story',
			null,
			now,
			'today',
			0,
			null,
			null,
			'Summary',
			'SEO description',
			110,
			66,
			'Content body for test',
			'<p>Content body for test</p>',
			null,
			null,
		)
		.run();
}

describe('Kentucky News worker API', () => {
	it('responds to /health (unit style)', async () => {
		const request = new IncomingRequest('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const payload = await response.json<{ ok: boolean }>();
		expect(payload.ok).toBe(true);
	});

	it('today endpoint returns kentucky-only articles regardless of category field', async () => {
		await ensureSchemaAndFixture();

		const response = await SELF.fetch('https://example.com/api/articles/today?limit=20');
		expect(response.status).toBe(200);

		const payload = await response.json<{
			items: Array<{ category: string; isKentucky: boolean }>;
			nextCursor: string | null;
		}>();
		expect(Array.isArray(payload.items)).toBe(true);
		expect(payload.items.length).toBe(2);
		expect(payload.items.every((item) => item.isKentucky)).toBe(true);
		expect(payload.items.some((item) => item.category === 'sports')).toBe(true);
		expect(payload).toHaveProperty('nextCursor');
	});

	it('national endpoint returns non-kentucky-only articles regardless of category field', async () => {
		await ensureSchemaAndFixture();

		const response = await SELF.fetch('https://example.com/api/articles/national?limit=20');
		expect(response.status).toBe(200);

		const payload = await response.json<{
			items: Array<{ category: string; isKentucky: boolean }>;
			nextCursor: string | null;
		}>();
		expect(Array.isArray(payload.items)).toBe(true);
		expect(payload.items.length).toBe(2);
		expect(payload.items.every((item) => !item.isKentucky)).toBe(true);
		expect(payload.items.some((item) => item.category === 'sports')).toBe(true);
		expect(payload.items.some((item) => item.category === 'today')).toBe(true);
	});

	it('allows county filter for any category (preferences apply globally)', async () => {
		await ensureSchemaAndFixture();
		const response = await SELF.fetch(
			'https://example.com/api/articles/national?counties=Fayette',
		);
		expect(response.status).toBe(200);
		const payload = await response.json<{ items: Array<unknown> }>();
		expect(Array.isArray(payload.items)).toBe(true);
	});
});

describe('classification utilities', () => {
	it('allows short content for facebook URLs only', () => {
		expect(isShortContentAllowed('https://facebook.com/story/123', 10)).toBe(true);
		expect(isShortContentAllowed('https://fb.watch/abc', 10)).toBe(true);
		expect(isShortContentAllowed('https://example.com/news', 10)).toBe(false);
		expect(isShortContentAllowed('https://example.com/news', 75)).toBe(true);
	});

	it('detects semantic sports category from content', () => {
		const category = detectSemanticCategory('The Wildcats won a basketball game tonight.');
		expect(category).toBe('sports');
	});
});
