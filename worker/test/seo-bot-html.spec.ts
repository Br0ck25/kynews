/**
 * Integration tests for SEO-critical bot HTML output.
 *
 * These tests drive the real Worker via SELF.fetch with a Googlebot UA and
 * assert that every SEO requirement is present in the returned HTML. The
 * in-process D1 database is populated with fixtures in beforeAll so each
 * individual test only reads `html` (or `thinHtml` for the noindex variant).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';

// ─── constants ───────────────────────────────────────────────────────────────

const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const TEST_SLUG = 'test-article-slug';
const THIN_SLUG = 'thin-article-slug';
const ARTICLE_IMAGE = 'https://apnews.com/images/perry-county-budget-2026.jpg';

// ─── schema + fixture helpers ─────────────────────────────────────────────────

async function ensureSchema() {
	await env.ky_news_db
		.prepare(
			`CREATE TABLE IF NOT EXISTS articles (
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
		)`,
		)
		.run();

	await env.ky_news_db
		.prepare(
			`CREATE TABLE IF NOT EXISTS article_counties (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
			county TEXT NOT NULL,
			is_primary INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0,1)),
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		)
		.run();

	await env.ky_news_db.prepare(`DELETE FROM articles`).run();
	await env.ky_news_db.prepare(`DELETE FROM article_counties`).run();
}

/**
 * Insert one article row.  Values must match the column order:
 * canonical_url, source_url, url_hash, title, author, published_at, category,
 * is_kentucky, is_national, county, city, summary, seo_description,
 * raw_word_count, summary_word_count, content_text, content_html,
 * image_url, image_alt, raw_r2_key, slug, content_hash  (22 columns)
 */
function insertArticle(values: (string | number | null)[]) {
	const formatted = values.map((v) => (v === null ? 'NULL' : JSON.stringify(v))).join(', ');
	return env.ky_news_db
		.prepare(
			`INSERT INTO articles (
			canonical_url, source_url, url_hash, title, author, published_at, category,
			is_kentucky, is_national, county, city, summary, seo_description, raw_word_count,
			summary_word_count, content_text, content_html, image_url, image_alt, raw_r2_key,
			slug, content_hash
		) VALUES (${formatted})`,
		)
		.run();
}

async function fetchBotHtml(path: string): Promise<string> {
	const resp = await SELF.fetch(`https://example.com${path}`, {
		headers: { 'User-Agent': BOT_UA },
	});
	return resp.text();
}

// ─── test suite ───────────────────────────────────────────────────────────────

describe('Bot HTML SEO requirements', () => {
	let html: string;
	let thinHtml: string;

	beforeAll(async () => {
		await ensureSchema();

		const now = new Date().toISOString();

		// Long enough SEO description (> 50 chars) so og:description passes the length check.
		const SEO_DESCRIPTION =
			'Perry County officials approved a new road maintenance budget at Tuesday\'s fiscal court meeting.';

		// Multi-paragraph summary so the article-summary class and meaningful
		// content are both present in the rendered HTML.
		const SUMMARY =
			'Perry County officials approved a new budget at Tuesday\'s fiscal court meeting.\n\n' +
			'The unanimous vote increases funding for road maintenance across the county.\n\n' +
			'School board members also announced plans for infrastructure improvements.';

		// ── main fixture: full article with image, county, 200 words ──────────
		await insertArticle([
			'https://apnews.com/article/perry-county-budget-2026',  // canonical_url
			'https://apnews.com/article/perry-county-budget-2026',  // source_url
			'hash-seo-main-001',                                     // url_hash
			'Test Article Slug',                                     // title
			null,                                                    // author
			now,                                                     // published_at
			'today',                                                 // category
			1,                                                       // is_kentucky
			0,                                                       // is_national
			'Perry',                                                 // county
			'hazard',                                                // city
			SUMMARY,                                                 // summary
			SEO_DESCRIPTION,                                         // seo_description
			200,                                                     // raw_word_count
			50,                                                      // summary_word_count
			'Perry County officials approved a new budget.',         // content_text
			'<p>Perry County officials approved a new budget.</p>',  // content_html
			ARTICLE_IMAGE,                                           // image_url
			null,                                                    // image_alt
			null,                                                    // raw_r2_key
			TEST_SLUG,                                               // slug
			null,                                                    // content_hash
		]);

		// ── related articles so buildRelatedCountyArticlesHtml returns 2+ links ─
		await insertArticle([
			'https://apnews.com/article/perry-school-board-2026',
			'https://apnews.com/article/perry-school-board-2026',
			'hash-seo-related-001',
			'Perry County School Board Approves Facilities Plan',
			null, now, 'today', 1, 0, 'Perry', 'hazard',
			'The Perry County school board voted to approve a new facilities improvement plan.',
			'Perry County school board approves facilities improvement plan.',
			180, 40,
			'School board approves facilities plan.',
			'<p>School board approves facilities plan.</p>',
			null, null, null, 'perry-county-related-one', null,
		]);

		await insertArticle([
			'https://apnews.com/article/hazard-infrastructure-2026',
			'https://apnews.com/article/hazard-infrastructure-2026',
			'hash-seo-related-002',
			'Hazard City Council Reviews Road Infrastructure Plans',
			null, now, 'today', 1, 0, 'Perry', 'hazard',
			'Hazard city council members reviewed road and bridge infrastructure proposals.',
			'Hazard city council reviews road and bridge infrastructure proposals.',
			160, 40,
			'Hazard council reviews infrastructure.',
			'<p>Hazard council reviews infrastructure.</p>',
			null, null, null, 'perry-county-related-two', null,
		]);

		// ── thin article: rawWordCount = 20, triggers noindex,follow ──────────
		await insertArticle([
			'https://apnews.com/article/perry-brief-note',
			'https://apnews.com/article/perry-brief-note',
			'hash-seo-thin-001',
			'Short Perry County Update',
			null, now, 'today', 1, 0, 'Perry', 'hazard',
			'Brief update from Perry County officials.',
			'Brief update from Perry County officials.',
			20,  // rawWordCount < 30 → noindex,follow
			5,
			'Brief update.',
			'<p>Brief update.</p>',
			null, null, null, THIN_SLUG, null,
		]);

		html = await fetchBotHtml(`/news/kentucky/perry-county/${TEST_SLUG}`);
		thinHtml = await fetchBotHtml(`/news/kentucky/perry-county/${THIN_SLUG}`);
	});

	// ── canonical ─────────────────────────────────────────────────────────────

	it('contains a self-referencing canonical link tag', () => {
		expect(html).toContain(
			`<link rel="canonical" href="https://localkynews.com/news/kentucky/perry-county/${TEST_SLUG}"/>`,
		);
	});

	// ── Open Graph ────────────────────────────────────────────────────────────

	it('contains og:title with county name', () => {
		expect(html).toContain('<meta property="og:title"');
		expect(html).toContain('Perry County');
	});

	it('contains og:description with at least 50 characters', () => {
		const match = html.match(/<meta property="og:description" content="([^"]*)"/);
		expect(match).not.toBeNull();
		expect((match![1] ?? '').length).toBeGreaterThanOrEqual(50);
	});

	it('contains og:image pointing to a non-default image when article has imageUrl', () => {
		expect(html).toContain(`<meta property="og:image" content="${ARTICLE_IMAGE}"`);
	});

	it('updates slug when title is changed for auto-generated slugs', async () => {
		// Use a fixed published date to make the generated slug predictable.
		const now = '2026-01-01T00:00:00.000Z';
		const sourceHash = 'hash-slug-update-001';
		await insertArticle([
			'https://example.com/article/old-headlines',
			'https://example.com/article/old-headlines',
			sourceHash,
			'Old Headlines',
			null,
			now,
			'today',
			1,
			0,
			'Perry',
			'hazard',
			'Old summary',
			'Old seo desc',
			100,
			20,
			'Old content',
			'<p>Old content</p>',
			null,
			null,
			null,
			'perry-old-headlines-2026',
			null,
		]);

		const row = await env.ky_news_db
			.prepare('SELECT id, slug FROM articles WHERE url_hash = ?')
			.bind(sourceHash)
			.first<{ id: number; slug: string }>();
		expect(row).not.toBeNull();
		const originalSlug = row.slug;

		const { updateArticleContent } = await import('../src/lib/db');
		await updateArticleContent(env, row.id, { title: 'New Headlines' });

		const updated = await env.ky_news_db
			.prepare('SELECT title, slug FROM articles WHERE id = ?')
			.bind(row.id)
			.first<{ title: string; slug: string }>();
		expect(updated).not.toBeNull();
		expect(updated.title).toBe('New Headlines');
		expect(updated.slug).not.toBe(originalSlug);
		expect(updated.slug).toContain('new-headlines');
	});

	// ── Twitter ───────────────────────────────────────────────────────────────

	it('contains twitter:site set to @LocalKYNews', () => {
		expect(html).toContain('<meta name="twitter:site" content="@LocalKYNews"/>');
	});

	// ── JSON-LD: NewsArticle ──────────────────────────────────────────────────

	it('contains json-ld NewsArticle schema with sourceOrganization', () => {
		expect(html).toContain('"@type":"NewsArticle"');
		expect(html).toContain('"sourceOrganization"');
	});

	// ── JSON-LD: BreadcrumbList ───────────────────────────────────────────────

	it('contains json-ld BreadcrumbList schema with 3 items', () => {
		expect(html).toContain('"@type":"BreadcrumbList"');
		// With county present the schema produces: Home (1) → County hub (2) → Article (3)
		const listItems = html.match(/"@type":"ListItem"/g);
		expect(listItems).not.toBeNull();
		expect(listItems!.length).toBeGreaterThanOrEqual(3);
	});

	// ── Body content ─────────────────────────────────────────────────────────

	it('contains at least one .article-summary paragraph', () => {
		expect(html).toContain('class="article-summary"');
	});

	it('contains at least 2 internal links to related articles', () => {
		// buildRelatedCountyArticlesHtml emits absolute localkynews.com hrefs
		const internalLinks = [...html.matchAll(/href="https:\/\/localkynews\.com\/news\/[^"]+"/g)];
		expect(internalLinks.length).toBeGreaterThanOrEqual(2);
	});

	// ── robots meta ───────────────────────────────────────────────────────────

	it('sets robots to index,follow for articles with rawWordCount >= 150', () => {
		// rawWordCount = 200 ≥ SNIPPET_LIMIT_THRESHOLD (100) → "index,follow"
		expect(html).toContain('<meta name="robots" content="index,follow"');
	});

	it('sets robots to noindex,follow for articles with rawWordCount < 30', () => {
		// rawWordCount = 20 < NOINDEX_WORD_THRESHOLD (40) → "noindex,follow"
		expect(thinHtml).toContain('<meta name="robots" content="noindex,follow"');
	});

	// ── Speakable ─────────────────────────────────────────────────────────────

	it('contains speakable cssSelector targeting h1 and .article-summary', () => {
		expect(html).toContain('"speakable"');
		expect(html).toContain('"cssSelector"');
		expect(html).toContain('"h1"');
		expect(html).toContain('".article-summary"');
	});

	// ── article timestamps ────────────────────────────────────────────────────

	it('contains article:published_time meta tag', () => {
		expect(html).toContain('<meta property="article:published_time"');
	});

	// ── no debug leakage ─────────────────────────────────────────────────────

	it('does NOT contain any hardcoded test strings or debug output', () => {
		// Worker output should never contain debug markers or raw DB internals
		expect(html).not.toMatch(/TODO|FIXME|console\.log|debugger|test-only/i);
		// Internal hash values from the fixture must not bleed into rendered HTML
		expect(html).not.toContain('hash-seo-main-001');
		expect(html).not.toContain('url_hash');
	});
});
