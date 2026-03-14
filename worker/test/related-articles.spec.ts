import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';

async function ensureSchema() {
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
			image_alt TEXT,
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
	await env.ky_news_db.prepare(`DELETE FROM articles`).run();
	await env.ky_news_db.prepare(`DELETE FROM article_counties`).run();
}

async function insertArticle(article: (string | number | null)[]) {
	const formatted = article
		.map((v) => (v === null ? 'NULL' : JSON.stringify(v)))
		.join(', ');
	await env.ky_news_db
		.prepare(`
		INSERT INTO articles (
			canonical_url, source_url, url_hash, title, author, published_at, category,
			is_kentucky, is_national, county, city, summary, seo_description, raw_word_count,
			summary_word_count, content_text, content_html, image_url, image_alt, raw_r2_key, slug, content_hash
		) VALUES (${formatted})
	`)
		.run();
}

describe('buildRelatedCountyArticlesHtml', () => {
	it('renders section.related with absolute localkynews.com links when 2+ related articles exist', async () => {
		await ensureSchema();
		const now = new Date().toISOString();

		// The article being viewed
		await insertArticle([
			'https://localkynews.com/news/kentucky/perry-county/main-story',
			'https://source.example.com/main',
			'hash-related-main',
			'Main Story About Perry County',
			null,
			now,
			'today',
			1, 0,
			'Perry', 'hazard',
			'Main article summary text here for testing.',
			'SEO description for main story',
			300, 80,
			'Content text', '<p>Content</p>',
			null, null, null,
			'main-story', null,
		]);

		// Related article 1
		await insertArticle([
			'https://localkynews.com/news/kentucky/perry-county/related-story-one',
			'https://source.example.com/related-1',
			'hash-related-one',
			'First Related Perry County Article',
			null,
			now,
			'today',
			1, 0,
			'Perry', 'hazard',
			'Summary for related article one.',
			'SEO desc one',
			150, 40,
			'Content one', '<p>Content one</p>',
			null, null, null,
			'related-story-one', null,
		]);

		// Related article 2
		await insertArticle([
			'https://localkynews.com/news/kentucky/perry-county/related-story-two',
			'https://source.example.com/related-2',
			'hash-related-two',
			'Second Related Perry County Article',
			null,
			now,
			'today',
			1, 0,
			'Perry', 'hazard',
			'Summary for related article two.',
			'SEO desc two',
			150, 40,
			'Content two', '<p>Content two</p>',
			null, null, null,
			'related-story-two', null,
		]);

		const resp = await SELF.fetch(
			'https://example.com/news/kentucky/perry-county/main-story',
			{
				headers: {
					'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
				},
			},
		);

		expect(resp.status).toBe(200);
		const html = await resp.text();

		// section.related must be present
		expect(html).toContain('<section class="related">');

		// At least one absolute localkynews.com link must appear
		expect(html).toMatch(/<a href="https:\/\/localkynews\.com\//);

		// No relative paths in the related section
		const relatedMatch = html.match(/<section class="related">[\s\S]*?<\/section>/);
		expect(relatedMatch).not.toBeNull();
		expect(relatedMatch![0]).not.toMatch(/href="\/news\//);
	});

	it('omits section.related when fewer than 2 related articles exist', async () => {
		await ensureSchema();
		const now = new Date().toISOString();

		// The article being viewed
		await insertArticle([
			'https://localkynews.com/news/kentucky/perry-county/solo-story',
			'https://source.example.com/solo',
			'hash-solo',
			'Solo Perry County Story',
			null,
			now,
			'today',
			1, 0,
			'Perry', 'hazard',
			'Solo article summary text.',
			'SEO desc solo',
			200, 50,
			'Content', '<p>Content</p>',
			null, null, null,
			'solo-story', null,
		]);

		// Only one other article in the same county (below the 2-article minimum)
		await insertArticle([
			'https://localkynews.com/news/kentucky/perry-county/only-one-related',
			'https://source.example.com/only-one',
			'hash-only-one',
			'Only One Related Article',
			null,
			now,
			'today',
			1, 0,
			'Perry', 'hazard',
			'Summary',
			'SEO',
			100, 30,
			'Content', '<p>Content</p>',
			null, null, null,
			'only-one-related', null,
		]);

		const resp = await SELF.fetch(
			'https://example.com/news/kentucky/perry-county/solo-story',
			{
				headers: {
					'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
				},
			},
		);

		expect(resp.status).toBe(200);
		const html = await resp.text();
		expect(html).not.toContain('<section class="related">');
	});
});
