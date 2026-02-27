import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { __testables } from '../src/index';
import { classifyArticleWithAi, detectSemanticCategory, isShortContentAllowed } from '../src/lib/classify';
import { detectCounty } from '../src/lib/geo';
import { normalizeCanonicalUrl, sha256Hex, toIsoDateOrNull } from '../src/lib/http';
import { findHighlySimilarTitle } from '../src/lib/ingest';
import {
	cleanFacebookHeadline,
	generateFacebookHook,
	generateFacebookCaption,
} from '../src/lib/facebook';

// simplified alias for testing; avoid TypeScript generics to keep Vitest happy
const IncomingRequest = Request;

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
			slug TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`).run();

	await env.ky_news_db.prepare(`DELETE FROM articles`).run();

	const now = new Date().toISOString();

	async function addArticle(values: any[]) {
		// interpolate values directly so we don't rely on parameter binding which
		// has been flaky in the test environment
		const formatted = values
			.map((v) => (v === null ? 'NULL' : JSON.stringify(v)))
			.join(', ');
		await env.ky_news_db
			.prepare(`
			INSERT INTO articles (
				canonical_url, source_url, url_hash, title, author, published_at, category,
				is_kentucky, county, city, summary, seo_description, raw_word_count,
				summary_word_count, content_text, content_html, image_url, raw_r2_key, slug
			) VALUES (${formatted})
		`)
			.run();
	}

	// insert fixtures using helper

	await addArticle([
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
		null,
	]);

	await addArticle([
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
		null,
	]);

	await addArticle([
		'https://example.com/ky-schools',
		'https://example.com',
		'hash-ky-schools',
		'Kentucky Schools Story',
		null,
		now,
		'schools',
		1,
		'Pike',
		'pikeville',
		'Summary',
		'SEO description',
		128,
		71,
		'Content body for test',
		'<p>Content body for test</p>',
		null,
		null,
		null,
	]);
	await addArticle([
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
		null,
	]);

	await addArticle([
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
		null,
	]);

	await addArticle([
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
		null,
	]);

	await addArticle([
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
		null,
	]);
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

	it('today endpoint only returns Kentucky-tagged articles', async () => {
		await ensureSchemaAndFixture();

		const response = await SELF.fetch('https://example.com/api/articles/today?limit=20');
		expect(response.status).toBe(200);

		const payload = await response.json<{
			items: Array<{ category: string; isKentucky: boolean }>;
			nextCursor: string | null;
		}>();
		expect(Array.isArray(payload.items)).toBe(true);
		expect(payload.items.length).toBe(3);
		expect(payload.items.every((item) => item.isKentucky)).toBe(true);
		expect(payload.items.some((item) => item.category === 'sports')).toBe(true);
		expect(payload.items.some((item) => item.category === 'schools')).toBe(true);
		expect(payload.items.some((item) => item.category === 'today')).toBe(true);
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

	it('schools endpoint returns kentucky-only schools articles', async () => {
		await ensureSchemaAndFixture();

		const response = await SELF.fetch('https://example.com/api/articles/schools?limit=20');
		expect(response.status).toBe(200);

		const payload = await response.json<{
			items: Array<{ category: string; isKentucky: boolean }>;
		}>();
		expect(Array.isArray(payload.items)).toBe(true);
		expect(payload.items.length).toBe(1);
		expect(payload.items[0]?.category).toBe('schools');
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

	// sources with a default county should be tagged as Kentucky only when the
	// article itself is a weather story.  we avoid blanket-tagging every post
	// from those multifaceted outlets.
	it('tags wkyt weather articles as Kentucky with Fayette county even when no KY context', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.wkyt.com/2026/02/26/high-pressure-moves-in-quiet-weather-ahead-of-cold-front/',
			title: 'High pressure moves in, quiet weather expected ahead of cold front',
			content: 'The National Weather Service has issued advisories across the region.',
		});

		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBe('Fayette');
		expect(classification.category).toBe('weather');
	});


	it('tags wymt weather articles as Kentucky with Perry county even when no KY context', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.wymt.com/2026/02/26/forecast-this-week/',
			title: 'National Weather Service issues advisory',
			content: 'Alerts are in place across multiple states.',
		});

		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBe('Perry');
	});


	// explicit city mention should map to the correct county
	it('detects Fayette county from a Lexington, KY mention', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://example.com/test',
			title: 'Heatwave hits Lexington, Ky.',
			content: 'Temperatures soared in Lexington, Ky. during the early afternoon.',
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

	it('forces non-Kentucky sports/schools/today classifications to national', async () => {
		const nonKySports = await classifyArticleWithAi(env, {
			url: 'https://example.com/out-of-state-college-football-recap',
			title: 'Ohio State beats Michigan in Big Ten football rivalry game',
			content: 'The game in Columbus drew national attention and focused on playoff implications.',
		});

		const nonKySchools = await classifyArticleWithAi(env, {
			url: 'https://example.com/out-of-state-district-policy',
			title: 'Springfield school board approves district policy changes',
			content: 'The district said the policy applies to schools across the state of Ohio.',
		});

		expect(nonKySports.isKentucky).toBe(false);
		expect(nonKySchools.isKentucky).toBe(false);
		expect(nonKySports.category).toBe('national');
		expect(nonKySchools.category).toBe('national');
	});

	it('keeps non-school profile pages out of schools category', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.whas11.com/article/about-us/team-bios/mallory-schnell/417-d50bc603-395f-48b1-87d1-fc939dcbb016',
			title: 'Mallory Schnell | Team Bios | WHAS11.com',
			content: 'Mallory Schnell is a reporter covering local and national stories for WHAS11.',
		});

		expect(classification.category).not.toBe('schools');
	});

	it('requires real weather evidence before assigning weather category', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://stateline.org/2026/02/20/repub/governors-say-trump-told-them-he-wont-force-immigration-enforcement-surges-on-states/',
			title: 'Governors say Trump told them he won’t force immigration enforcement surges on states',
			content: 'Governors discussed immigration enforcement resources and federal policy during a meeting in Washington.',
		});

		expect(classification.category).not.toBe('weather');
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

	it('normalizes canonical URLs for dedupe hashing', () => {
		expect(
			normalizeCanonicalUrl('https://www.Example.com/news/story/?utm_source=rss&fbclid=abc#section'),
		).toBe('https://example.com/news/story');
		expect(
			normalizeCanonicalUrl('https://example.com/news/story/'),
		).toBe('https://example.com/news/story');
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

	it('facebook helper functions behave as expected', () => {
		expect(cleanFacebookHeadline('Test title | Local KY News')).toBe('Test title');
		expect(generateFacebookHook('First sentence. Second one.')).toBe('First sentence.');
		// county prefix
		expect(generateFacebookHook('Something happened', 'Wake')).toMatch(/Wake County/i);
		// caption returns blank for non-KY
		expect(generateFacebookCaption({ title: 'a', summary: 'b', is_kentucky: 0 })).toBe('');
		// caption url should point at localkynews.com if slug present
		const cap = generateFacebookCaption({
			id: 7,
			title: 'Foo',
			summary: 'Bar',
			county: 'Boone',
			slug: 'foo',
			category: 'today',
			isKentucky: true,
		});
		expect(cap).toContain('https://localkynews.com/news/kentucky/boone-county/foo');

		// weather caption should include the extra hashtag
		const capWeather = generateFacebookCaption({
			id: 8,
			title: 'Storm warning',
			summary: 'Severe weather expected',
			county: 'Fayette',
			category: 'weather',
			isKentucky: true,
		});
		expect(capWeather).toContain('#Weather');
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
// --- facebook caption endpoint tests --------------------------------------------------
describe('admin facebook caption endpoint', () => {
	it('returns generated caption for kentucky article', async () => {
		await ensureSchemaAndFixture();
		const row = await env.ky_news_db
			.prepare(`SELECT id FROM articles WHERE canonical_url = ? LIMIT 1`)
			.bind('https://example.com/ky-today')
			.first<{ id: number }>();
		const articleId = Number(row?.id ?? 0);
		expect(articleId).toBeGreaterThan(0);

		const request = new IncomingRequest('https://example.com/api/admin/facebook/caption', {
			method: 'POST',
			headers: {
				'x-admin-key': 'secret',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ id: articleId }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, envWithAdminPassword('secret'), ctx);
		expect(response.status).toBe(200);
		const payload = await response.json<{ ok: boolean; caption: string }>();
		expect(payload.ok).toBe(true);
		expect(payload.caption).toContain('Fayette');
		expect(payload.caption).toContain('#KentuckyNews');
	});

	it('responds with empty caption for non-kentucky article', async () => {
		await ensureSchemaAndFixture();
		await env.ky_news_db.prepare(`
			INSERT INTO articles (
				canonical_url, source_url, url_hash, title, author, published_at, category,
				is_kentucky, county, city, summary, seo_description, raw_word_count,
				summary_word_count, content_text, content_html, image_url, raw_r2_key
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			'https://example.com/national',
			'https://example.com',
			'national-hash',
			'National Story',
			null,
			new Date().toISOString(),
			'national',
			0,
			null,
			null,
			'National summary',
			'SEO',
			100,
			50,
			'body',
			'<p>body</p>',
			null,
			null,
		).run();

		const { id: nid } = await env.ky_news_db
			.prepare(`SELECT id FROM articles WHERE canonical_url = ? LIMIT 1`)
			.bind('https://example.com/national')
			.first<{ id: number }>();

		const request = new IncomingRequest('https://example.com/api/admin/facebook/caption', {
			method: 'POST',
			headers: { 'x-admin-key': 'secret', 'content-type': 'application/json' },
			body: JSON.stringify({ id: nid }),
		});
		const ctx2 = createExecutionContext();
		const resp2 = await worker.fetch(request, envWithAdminPassword('secret'), ctx2);
		expect(resp2.status).toBe(200);
		const payload2 = await resp2.json<{ ok: boolean; caption: string }>();
		expect(payload2.ok).toBe(true);
		expect(payload2.caption).toBe('');
	});
});

// facebook posting endpoint tests

describe('admin facebook post endpoint', () => {
	it('returns error when Facebook credentials are missing', async () => {
		await ensureSchemaAndFixture();
		const row = await env.ky_news_db
			.prepare(`SELECT id FROM articles WHERE canonical_url = ? LIMIT 1`)
			.bind('https://example.com/ky-today')
			.first<{ id: number }>();
		const articleId = Number(row?.id ?? 0);
		expect(articleId).toBeGreaterThan(0);

		const request = new IncomingRequest('https://example.com/api/admin/facebook/post', {
			method: 'POST',
			headers: {
				'x-admin-key': 'secret',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ id: articleId }),
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(request, envWithAdminPassword('secret'), ctx);
		expect(resp.status).toBe(500);
		const body = await resp.json();
		expect(body.error).toMatch(/credentials/i);
	});
});
// tests for server-side social preview route

describe('social preview HTML route', () => {
	it('returns og meta tags and redirect script for kentucky article', async () => {
		await ensureSchemaAndFixture();
		// insert sample article with image and slug
		const now = new Date().toISOString();
		await env.ky_news_db.prepare(`
			INSERT INTO articles (
				canonical_url, source_url, url_hash, title, author, published_at, category,
				is_kentucky, county, city, summary, seo_description, raw_word_count,
				summary_word_count, content_text, content_html, image_url, raw_r2_key, slug
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			'https://example.com/ky-test',
			'https://example.com',
			'test-hash',
			'Test Title',
			null,
			now,
			'today',
			1,
			'Boone',
			'boone',
			'Summary',
			'SEO',
			100,
			50,
			'body',
			'<p>body</p>',
			'https://localkynews.com/img/test.jpg',
			null,
			'test-slug'
		).run();

		// determine the new article's id (autoincrement may not reset after DELETE)
		const row = await env.ky_news_db
			.prepare('SELECT id FROM articles WHERE slug = ? LIMIT 1')
			.bind('test-slug')
			.first<{ id: number }>();
		const articleId = Number(row?.id ?? 0);

		const path = '/news/kentucky/boone-county/test-slug';
		// also verify caption endpoint never returns external URL
		const captionRequest = new IncomingRequest('https://example.com/api/admin/facebook/caption', {
			method: 'POST',
			headers: { 'x-admin-key': 'secret', 'content-type': 'application/json' },
			body: JSON.stringify({ id: articleId }),
		});
		const ctx2 = createExecutionContext();
		const captionResp = await worker.fetch(captionRequest, envWithAdminPassword('secret'), ctx2);
		const capJson = await captionResp.json();
		console.log('social preview caption response', capJson);
		expect(capJson.caption).toBeDefined();
		expect(capJson.caption).toContain('https://localkynews.com');
		expect(capJson.caption).not.toContain('wnky.com');
		const response = await SELF.fetch(`https://example.com${path}`);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('<meta property="og:title" content="Test Title"');
		expect(text).toContain('<meta property="og:image" content="https://localkynews.com/img/test.jpg"');
		// redirect script should append flag to avoid infinite reloads
		expect(text).toContain('window.location.href');
		expect(text).toContain('?r=1');

		// additional request including flag should return SPA shell instead of preview
		const response2 = await SELF.fetch(`https://example.com${path}?r=1`);
		expect(response2.status).toBe(200);
		const text2 = await response2.text();
		expect(text2).toContain('<!doctype html');
		expect(text2).not.toContain('<meta property="og:title"');

		// hitting a county-level URL (no slug) should also return the SPA shell
		const countyPath = '/news/kentucky/adair-county';
		const respCounty = await SELF.fetch(`https://example.com${countyPath}`);
		expect(respCounty.status).toBe(200);
		const countyText = await respCounty.text();
		expect(countyText).toContain('<!doctype html');
	});
});
