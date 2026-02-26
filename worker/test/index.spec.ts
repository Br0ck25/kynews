import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { __testables } from '../src/index';
import { classifyArticleWithAi, detectSemanticCategory, isShortContentAllowed } from '../src/lib/classify';
import { detectCounty } from '../src/lib/geo';
import { sha256Hex, toIsoDateOrNull } from '../src/lib/http';
import { findHighlySimilarTitle } from '../src/lib/ingest';

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

	await insertFixture
		.bind(
			'https://example.com/non-ky-schools',
			'https://example.com',
			'hash-non-ky-schools',
			'Non Kentucky Schools Story',
			null,
			now,
			'schools',
			0,
			null,
			null,
			'Summary',
			'SEO description',
			115,
			65,
			'Content body for test',
			'<p>Content body for test</p>',
			null,
			null,
		)
		.run();

	await insertFixture
		.bind(
			'https://example.com/non-ky-weather',
			'https://example.com',
			'hash-non-ky-weather',
			'Non Kentucky Weather Story',
			null,
			now,
			'weather',
			0,
			null,
			null,
			'Summary',
			'SEO description',
			118,
			67,
			'Content body for test',
			'<p>Content body for test</p>',
			null,
			null,
		)
		.run();
}

function envWithAdminPassword(password: string): Env {
	return new Proxy(env as unknown as Record<string, unknown>, {
		get(target, prop, receiver) {
			if (prop === 'ADMIN_PANEL_PASSWORD') return password;
			return Reflect.get(target, prop, receiver);
		},
	}) as Env;
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

	it('today endpoint includes sports, schools, and weather alongside Kentucky-tagged stories', async () => {
		await ensureSchemaAndFixture();

		const response = await SELF.fetch('https://example.com/api/articles/today?limit=20');
		expect(response.status).toBe(200);

		const payload = await response.json<{
			items: Array<{ category: string; isKentucky: boolean }>;
			nextCursor: string | null;
		}>();
		expect(Array.isArray(payload.items)).toBe(true);
		expect(payload.items.length).toBe(5);
		expect(payload.items.some((item) => item.category === 'sports')).toBe(true);
		expect(payload.items.some((item) => item.category === 'schools')).toBe(true);
		expect(payload.items.some((item) => item.category === 'weather')).toBe(true);
		expect(payload.items.some((item) => item.category === 'today')).toBe(true);
		expect(payload.items.some((item) => item.isKentucky)).toBe(true);
		expect(payload).toHaveProperty('nextCursor');
	});

	it('national endpoint returns only national-category articles', async () => {
		await ensureSchemaAndFixture();

		const response = await SELF.fetch('https://example.com/api/articles/national?limit=20');
		expect(response.status).toBe(200);

		const payload = await response.json<{
			items: Array<{ category: string; isKentucky: boolean }>;
			nextCursor: string | null;
		}>();
		expect(Array.isArray(payload.items)).toBe(true);
		expect(payload.items.length).toBe(0);
	});

	it('ignores county filter on national endpoint', async () => {
		await ensureSchemaAndFixture();
		const unfiltered = await SELF.fetch('https://example.com/api/articles/national');
		const filtered = await SELF.fetch(
			'https://example.com/api/articles/national?counties=Fayette',
		);
		expect(unfiltered.status).toBe(200);
		expect(filtered.status).toBe(200);
		const allPayload = await unfiltered.json<{ items: Array<unknown> }>();
		const filteredPayload = await filtered.json<{ items: Array<unknown> }>();
		expect(filteredPayload.items.length).toBe(allPayload.items.length);
	});

	it('sports endpoint returns kentucky-only sports articles', async () => {
		await ensureSchemaAndFixture();

		const response = await SELF.fetch('https://example.com/api/articles/sports?limit=20');
		expect(response.status).toBe(200);

		const payload = await response.json<{
			items: Array<{ category: string; isKentucky: boolean }>;
		}>();
		expect(Array.isArray(payload.items)).toBe(true);
		expect(payload.items.length).toBe(1);
		expect(payload.items[0]?.category).toBe('sports');
		expect(payload.items[0]?.isKentucky).toBe(true);
	});
});

describe('classification utilities', () => {
	it('rejects short content under minimum threshold', () => {
		expect(isShortContentAllowed('https://facebook.com/story/123', 10)).toBe(false);
		expect(isShortContentAllowed('https://fb.watch/abc', 10)).toBe(false);
		expect(isShortContentAllowed('https://example.com/news', 10)).toBe(false);
		expect(isShortContentAllowed('https://example.com/news', 75)).toBe(true);
	});

	it('detects semantic sports category from content', () => {
		const category = detectSemanticCategory('The Wildcats won a basketball game tonight.');
		expect(category).toBe('sports');
	});

	it('ignores kentucky lantern branding in title for national stories', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://kentuckylantern.com/2026/02/03/repub/trump-doubles-down-on-calling-for-the-feds-to-take-over-state-elections/',
			title: 'Trump doubles down on calling for the feds to take over state elections • Kentucky Lantern',
			content: 'President Donald Trump repeated calls for federal control of elections in remarks focused on national policy.',
		});

		expect(classification.isKentucky).toBe(false);
		expect(classification.category).toBe('national');
	});

	it('does not detect Kentucky county when nearby out-of-state signal is present', () => {
		const text =
			'A jury in Christian County Missouri returned an indictment after a multi-state investigation.';

		expect(detectCounty(text, text)).toBeNull();
	});

	it('applies source default county fallback for Kentucky.com when KY context is present', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.kentucky.com/news/politics-government/article999999999.html',
			title: 'State budget advances in Kentucky legislature',
			content: 'Kentucky lawmakers debated fiscal priorities during the latest legislative session.',
		});

		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBe('Fayette');
	});

	it('tags kyschools.us domains as Kentucky and assigns the county from subdomain', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.ohio.kyschools.us/news/district-updates',
			title: 'District updates for students and families',
			content: 'The district shared updates about school operations and upcoming events for families.',
		});

		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBe('Ohio');
		expect(classification.category).toBe('schools');
	});
});

describe('date parsing utilities', () => {
	it('returns null for empty or invalid values in strict parser', () => {
		expect(toIsoDateOrNull(undefined)).toBeNull();
		expect(toIsoDateOrNull(null)).toBeNull();
		expect(toIsoDateOrNull('')).toBeNull();
		expect(toIsoDateOrNull('not-a-date')).toBeNull();
	});

	it('returns ISO string for valid date values in strict parser', () => {
		expect(toIsoDateOrNull('2026-02-24T12:34:56Z')).toBe('2026-02-24T12:34:56.000Z');
	});
});

describe('structured search source extraction', () => {
	it('extracts only kentucky.com article links from search html', () => {
		const html = `
			<div>
				<a href="https://www.kentucky.com/search/?q=kentucky">Search</a>
				<a href="https://www.kentucky.com/sports/college/article314814863.html">Valid article</a>
				<a href="https://www.kentucky.com/news/local/article314811957.html?taid=abc">Valid article with query</a>
				<a href="https://www.kentucky.com/news/local/">Section link</a>
			</div>
		`;

		const links = __testables.extractStructuredSearchLinks(
			'https://www.kentucky.com/search/?q=kentucky&page=1&sort=newest',
			html,
			10,
		);

		expect(links).toEqual([
			'https://www.kentucky.com/sports/college/article314814863.html',
			'https://www.kentucky.com/news/local/article314811957.html',
		]);
	});

	it('extracts only non-video wymt dated article links from search html', () => {
		const html = `
			<div>
				<a href="https://www.wymt.com/video/2026/02/24/this-day-history-february-23-1945/">Video item</a>
				<a href="https://www.wymt.com/2026/02/18/kentucky-power-asks-psc-approve-project-support-affordable-generation/">Article item</a>
				<a href="https://www.wymt.com/weather">Weather nav</a>
			</div>
		`;

		const links = __testables.extractStructuredSearchLinks(
			'https://www.wymt.com/search/?query=kentucky',
			html,
			10,
		);

		expect(links).toEqual([
			'https://www.wymt.com/2026/02/18/kentucky-power-asks-psc-approve-project-support-affordable-generation/',
		]);
	});

	it('only bypasses robots for explicitly allowed search URLs', () => {
		expect(
			__testables.isRobotsBypassAllowed('https://www.kentucky.com/search/?q=kentucky&page=1&sort=newest'),
		).toBe(true);
		expect(__testables.isRobotsBypassAllowed('https://www.wymt.com/search/?query=kentucky')).toBe(true);
		expect(__testables.isRobotsBypassAllowed('https://www.kentucky.com/search/?q=kentucky&page=2')).toBe(true);
		expect(__testables.isRobotsBypassAllowed('https://www.wymt.com/weather')).toBe(true);
	});
	it('recognizes and handles county-specific search urls as structured sources', () => {
		expect(__testables.isStructuredSearchSource('https://www.kentucky.com/search/?q=Fayette')).toBe(true);
		expect(__testables.isRobotsBypassAllowed('https://www.kentucky.com/search/?q=Fayette')).toBe(true);
		expect(__testables.isStructuredSearchSource('https://www.wymt.com/search/?query=Jefferson')).toBe(true);
		expect(__testables.isRobotsBypassAllowed('https://www.wymt.com/search/?query=Jefferson')).toBe(true);
	});

	it('buildCountySearchUrls returns both kentucky.com and wymt search strings', () => {
		const urls = __testables.buildCountySearchUrls('Fayette');
		expect(urls).toEqual([
			'https://www.kentucky.com/search/?q=Fayette&page=1&sort=newest',
			'https://www.wymt.com/search/?query=Fayette',
		]);
	});
});

// new helper tests

describe('database utilities', () => {
	it('getCountyCounts retrieves correct map', async () => {
		await ensureSchemaAndFixture();
		const map = await __testables.getCountyCounts(env);
		expect(map.get('Fayette')).toBe(1);
		expect(map.get('Jefferson')).toBe(1);
	});
});

describe('ingest source balancing', () => {
	it('prevents school-only batches when non-school sources are available', () => {
		const schoolOnlyRun = [
			'https://www.adair.kyschools.us/',
			'https://www.allen.kyschools.us/',
			'https://www.barren.kyschools.us/',
			'https://www.bell.kyschools.us/',
			'https://www.boone.kyschools.us/',
			'https://www.boyle.kyschools.us/',
			'https://www.calloway.kyschools.us/',
			'https://www.carter.kyschools.us/',
			'https://www.casey.kyschools.us/',
			'https://www.clay.kyschools.us/',
		];

		const allSources = [
			...schoolOnlyRun,
			'https://kentuckylantern.com/feed',
			'https://www.wkyt.com/arc/outboundfeeds/rss/',
		];

		const balanced = __testables.rebalanceSchoolHeavyRunSources(schoolOnlyRun, allSources, 8);
		expect(balanced.length).toBe(schoolOnlyRun.length);

		for (let i = 0; i < balanced.length; i += 8) {
			const batch = balanced.slice(i, i + 8);
			expect(batch.some((source) => !source.includes('.kyschools.us'))).toBe(true);
		}
	});
});

describe('title similarity dedupe', () => {
	it('rejects titles that are at least 90% similar to existing article titles', async () => {
		await ensureSchemaAndFixture();
		const match = await findHighlySimilarTitle(env, 'Kentucky Sports Story');
		expect(match).not.toBeNull();
		expect(match?.similarity ?? 0).toBeGreaterThanOrEqual(0.9);
	});

	it('allows distinct titles well below the threshold', async () => {
		await ensureSchemaAndFixture();
		const match = await findHighlySimilarTitle(env, 'County commission advances road paving contract');
		expect(match).toBeNull();
	});
});

// backfill endpoint tests

describe('admin backfill endpoint', () => {
	it('rejects unauthorized requests', async () => {
		const response = await SELF.fetch('https://example.com/api/admin/backfill-counties', {
			method: 'POST',
			body: JSON.stringify({ threshold: 2 }),
		});
		expect(response.status).toBe(401);
	});
});

describe('admin article link updates', () => {
	it('updates canonical/source links and recomputes hash', async () => {
		await ensureSchemaAndFixture();
		const target = await env.ky_news_db
			.prepare(`SELECT id FROM articles WHERE canonical_url = ? LIMIT 1`)
			.bind('https://example.com/ky-today')
			.first<{ id: number }>();

		const targetId = Number(target?.id ?? 0);
		expect(targetId).toBeGreaterThan(0);

		const request = new IncomingRequest('https://example.com/api/admin/article/update-links', {
			method: 'POST',
			headers: {
				'x-admin-key': 'secret',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				id: targetId,
				canonicalUrl: 'https://example.com/ky-today-updated',
				sourceUrl: 'https://feeds.example.com/ky',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, envWithAdminPassword('secret'), ctx);

		expect(response.status).toBe(200);
		const payload = await response.json<{
			ok: boolean;
			canonicalUrl: string;
			sourceUrl: string;
			urlHash: string;
		}>();
		expect(payload.ok).toBe(true);
		expect(payload.canonicalUrl).toBe('https://example.com/ky-today-updated');
		expect(payload.sourceUrl).toBe('https://feeds.example.com/ky');
		expect(payload.urlHash).toMatch(/^[a-f0-9]{64}$/);

		const row = await env.ky_news_db
			.prepare(`SELECT canonical_url, source_url, url_hash FROM articles WHERE id = ? LIMIT 1`)
			.bind(targetId)
			.first<{ canonical_url: string; source_url: string; url_hash: string }>();
		expect(row?.canonical_url).toBe('https://example.com/ky-today-updated');
		expect(row?.source_url).toBe('https://feeds.example.com/ky');
		expect(row?.url_hash).toBe(payload.urlHash);
	});

	it('rejects updates that collide with an existing canonical URL hash', async () => {
		await ensureSchemaAndFixture();
		const duplicateCanonicalUrl = 'https://example.com/ky-today';
		const duplicateHash = await sha256Hex(duplicateCanonicalUrl);
		await env.ky_news_db
			.prepare(`UPDATE articles SET url_hash = ? WHERE canonical_url = ?`)
			.bind(duplicateHash, duplicateCanonicalUrl)
			.run();

		const target = await env.ky_news_db
			.prepare(`SELECT id FROM articles WHERE canonical_url = ? LIMIT 1`)
			.bind('https://example.com/ky-sports')
			.first<{ id: number }>();

		const targetId = Number(target?.id ?? 0);
		expect(targetId).toBeGreaterThan(0);

		const request = new IncomingRequest('https://example.com/api/admin/article/update-links', {
			method: 'POST',
			headers: {
				'x-admin-key': 'secret',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				id: targetId,
				canonicalUrl: 'https://example.com/ky-today',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, envWithAdminPassword('secret'), ctx);

		expect(response.status).toBe(409);
	});
});
