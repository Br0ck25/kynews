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

async function insertArticle(article) {
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

describe('bot preview HTML', () => {
	it('returns og:image for facebook crawler requests', async () => {
		await ensureSchema();
		const now = new Date().toISOString();
		await insertArticle([
			'https://example.com/test',
			'https://example.com',
			'hash-test',
			'Test Story',
			null,
			now,
			'today',
			1,
			0,
			'Fayette',
			'lexington',
			'Summary',
			'SEO description',
			120,
			70,
			'Content',
			'<p>Content</p>',
			'https://example.com/photo.jpg',
			null,
			null,
			'test-article',
			null,
		]);

		const resp = await SELF.fetch('https://example.com/news/kentucky/fayette-county/test-article', {
			headers: {
				'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
			},
		});
		expect(resp.status).toBe(200);
		const text = await resp.text();
		expect(text).toContain('<meta property="og:image" content="https://example.com/photo.jpg"');
	});

	it('adds article-summary class to first paragraph when summary is present', async () => {
		await ensureSchema();
		const now = new Date().toISOString();
		await insertArticle([
			'https://example.com/test-summary',
			'https://example.com/test-summary',
			'hash-summary-class',
			'Test Story With Summary',
			null,
			now,
			'today',
			1,
			0,
			'Fayette',
			'lexington',
			'This is the first paragraph of the article summary text here.\n\nThis is the second paragraph of the summary.',
			'SEO description for summary test',
			250,
			50,
			'Content text here',
			'<p>Content</p>',
			null,
			null,
			null,
			'test-article-summary',
			null,
		]);

		const resp = await SELF.fetch(
			'https://example.com/news/kentucky/fayette-county/test-article-summary',
			{
				headers: {
					'User-Agent':
						'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
				},
			},
		);
		expect(resp.status).toBe(200);
		const text = await resp.text();
		expect(text).toContain('class="article-summary"');
	});

	it('renders ## markdown heading as <h2> in bot HTML output', async () => {
		await ensureSchema();
		const now = new Date().toISOString();
		await insertArticle([
			'https://example.com/test-heading',
			'https://example.com/test-heading',
			'hash-heading-h2',
			'Test Story With Heading',
			null,
			now,
			'today',
			1,
			0,
			'Fayette',
			'lexington',
			'First paragraph introduces the story.\n\n## Key details\n\nSecond paragraph provides the details.',
			'SEO description for heading test',
			250,
			50,
			'Content text here',
			'<p>Content</p>',
			null,
			null,
			null,
			'test-article-heading',
			null,
		]);

		const resp = await SELF.fetch(
			'https://example.com/news/kentucky/fayette-county/test-article-heading',
			{
				headers: {
					'User-Agent':
						'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
				},
			},
		);
		expect(resp.status).toBe(200);
		const text = await resp.text();
		expect(text).toContain('<h2>Key details</h2>');
		expect(text).not.toContain('## Key details');
	});
});
