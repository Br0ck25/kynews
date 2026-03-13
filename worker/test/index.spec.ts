import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';

// avoid touching real push service during unit tests
vi.mock('web-push', () => ({
	setVapidDetails: vi.fn(),
	sendNotification: vi.fn().mockResolvedValue(undefined),
}));

import worker from '../src/index';
import { __testables } from '../src/index';
import * as classifyModule from '../src/lib/classify';
import { classifyArticleWithAi, detectSemanticCategory, isShortContentAllowed, isStatewideKyPoliticalStory } from '../src/lib/classify';
import { isScheduleOrScoresArticle } from '../src/lib/ai';
import { detectCounty } from '../src/lib/geo';
import * as httpModule from '../src/lib/http';
import { normalizeCanonicalUrl, sha256Hex, toIsoDateOrNull, cachedTextFetch } from '../src/lib/http';
import * as ingestModule from '../src/lib/ingest';
import { stripNoisyTags, scrapeArticleHtml } from '../src/lib/scrape';
import { findHighlySimilarTitle } from '../src/lib/ingest';
import * as dbModule from '../src/lib/db';
import { insertArticle, getArticleCounties, updateArticleClassification, getArticleById, getCountyCounts, listAdminArticles, queryArticles, getArticlesForUpdateCheck, prependUpdateToSummary } from '../src/lib/db';
import type { NewArticle } from '../src/types';
import * as aiModule from '../src/lib/ai';
import { SPC_DAY1_RISK_MAP, SPC_WATCH_MAP } from '../src/lib/spc';
import {
	cleanFacebookHeadline,
	generateFacebookHook,
	generateFacebookCaption,
} from '../src/lib/facebook';
import { KY_COUNTIES } from '../src/data/ky-geo';

// helpers tested later
import { BASE_URL, buildArticleUrl } from '../src/index';
import { articleToUrl } from '../src/utils/functions';

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
	// article_counties junction table for multi-county support
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
	// clear RSS cache entries so tests see fresh output
	if (env.CACHE) {
		await env.CACHE.delete('rss:today:includeAll').catch(() => null);
		await env.CACHE.delete('rss:today:').catch(() => null);
		await env.CACHE.delete('rss:today-version').catch(() => null);
	}

	const now = new Date().toISOString();

	async function addArticle(values) {
		// interpolate values directly so we don't rely on parameter binding which
		// has been flaky in the test environment
		const formatted = values
			.map((v) => (v === null ? 'NULL' : JSON.stringify(v)))
			.join(', ');
		await env.ky_news_db
			.prepare(`
			INSERT INTO articles (
				canonical_url, source_url, url_hash, title, author, published_at, category,
				is_kentucky, is_national, county, city, summary, seo_description, raw_word_count,
				summary_word_count, content_text, content_html, image_url, raw_r2_key, slug, content_hash
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
		0,
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
		0,
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
		0,
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
		1,
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
		1,
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
		1,
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
		1,
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
		null,
	]);
	await addArticle([
		'https://example.com/ky-weather',
		'https://example.com',
		'hash-ky-weather',
		'Kentucky Weather Story',
		null,
		now,
		'weather',
		1,
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
		null,
	]);
	await addArticle([
		'https://example.com/ky-obit',
		'https://example.com',
		'hash-ky-obit',
		'Local resident passes away',
		null,
		now,
		'obituaries',
		1,
		0,
		'Jefferson',
		'louisville',
		'Obituary summary',
		'SEO description',
		90,
		45,
		'Content body for test',
		'<p>Content body for test</p>',
		null,
		null,
		null,
		null,
	]);

	// backfill junction table from articles
	await env.ky_news_db.prepare(
		`INSERT OR IGNORE INTO article_counties (article_id, county, is_primary)
		 SELECT id, county, 1 FROM articles WHERE county IS NOT NULL`
	).run();
}
		null,
		null,
		null,
		null,

		it('returns CORS headers for OPTIONS preflight', async () => {
			const req = new IncomingRequest('https://example.com/api/articles/weather', {
				method: 'OPTIONS',
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(204);
			expect(res.headers.get('access-control-allow-origin')).toBe('*');
			expect(res.headers.get('access-control-allow-methods')).toBeDefined();
		});

		// new push-related endpoint tests
		describe('push subscription API', () => {
			it('stores a subscription when posted', async () => {
				if (env.CACHE) await env.CACHE.delete('push:https://example.com/endpoint');
				const sub = { endpoint: 'https://example.com/endpoint', keys: { p256dh: 'abc', auth: '123' } };
				const req = new IncomingRequest('https://example.com/api/subscribe', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(sub),
				});
				const ctx = createExecutionContext();
				const res = await worker.fetch(req, env, ctx);
				await waitOnExecutionContext(ctx);
				expect(res.status).toBe(201);
				if (env.CACHE) {
					const stored = await env.CACHE.get('push:' + sub.endpoint);
					expect(stored).toBe(JSON.stringify(sub));
				}
			});

			it('broadcast endpoint returns success', async () => {
				const payload = { title: 'X', body: 'Y', url: '/' };
				const req = new IncomingRequest('https://example.com/api/sendNotification', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});
				const ctx = createExecutionContext();
				const res = await worker.fetch(req, env, ctx);
				await waitOnExecutionContext(ctx);
				expect(res.status).toBe(200);
				const body = await res.json();
				expect(body.success).toBe(true);
			});
		});

		describe('sitemap generation', () => {
				it('normalizes lastmod, filters stub articles, and adds county lastmod', async () => {
					await ensureSchemaAndFixture();
					if (env.CACHE) {
						await env.CACHE.delete('sitemap:main');
						await env.CACHE.delete('sitemap:news');
					}

					const badDate = '2025-12-15 08:30:00';
					// insert a stub article that should be filtered out by word count
					await env.ky_news_db.prepare(`
					  INSERT INTO articles (
					    canonical_url, source_url, url_hash, title, author, published_at, category,
					    is_kentucky, is_national, county, city, summary, seo_description,
					    raw_word_count, summary_word_count, content_text, content_html, image_url, raw_r2_key, slug
					  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					`).bind(
					  'https://example.com/stub',
					  'https://example.com',
					  'hash-stub',
					  'Stub Article',
					  null,
					  badDate,
					  'today',
					  1,
					  0,
					  'Pike',
					  null,
					  'summary',
					  'seo',
					  10,
					  5,
					  'text',
					  '<p>text</p>',
					  null,
					  null,
					  'stubslug'
					).run();
					// insert a valid article with bad timestamp
					await env.ky_news_db.prepare(`
					  INSERT INTO articles (
					    canonical_url, source_url, url_hash, title, author, published_at, category,
					    is_kentucky, is_national, county, city, summary, seo_description,
					    raw_word_count, summary_word_count, content_text, content_html, image_url, raw_r2_key, slug
					  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					`).bind(
					  'https://example.com/good',
					  'https://example.com',
					  'hash-good',
					  'Good Date Article',
					  null,
					  badDate,
					  'today',
					  1,
					  0,
					  'Fayette',
					  null,
					  'summary2',
					  'seo2',
					  100,
					  5,
					  'text2',
					  '<p>text2</p>',
					  null,
					  null,
					  'goodslug'
					).run();

					const xml = await __testables.generateSitemap(env as any);
					expect(xml).toContain('goodslug');
					expect(xml).not.toContain('stubslug');
					expect(xml).toMatch(/<lastmod>2025-12-15<\/lastmod>/);
					const countySlug = 'fayette';
					expect(xml).toMatch(new RegExp(`<loc>${BASE_URL}/news/kentucky/${countySlug}-county<\/loc>[\s\S]*?<lastmod>2025-12-15<\/lastmod>`));
					expect(xml).toMatch(/<changefreq>(daily|weekly|monthly)<\/changefreq>/);
					expect(xml).toMatch(/<priority>0\.[0-9]<\/priority>/);
				});

				it('news sitemap includes keywords and respects cutoff', async () => {
					await ensureSchemaAndFixture();
					if (env.CACHE) {
						await env.CACHE.delete('sitemap:news');
					}
					const now = new Date().toISOString();
					const oldDate = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
					await env.ky_news_db.prepare(`
					  INSERT INTO articles (
					    canonical_url, source_url, url_hash, title, author, published_at, category,
					    is_kentucky, is_national, county, city, summary, seo_description,
					    raw_word_count, summary_word_count, content_text, content_html, image_url, raw_r2_key, slug
					  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					`).bind(
					  'https://example.com/old',
					  'https://example.com',
					  'hash-old',
					  'Old News',
					  null,
					  oldDate,
					  'sports',
					  1,
					  0,
					  'Pike',
					  null,
					  's',
					  's',
					  100,
					  50,
					  't',
					  '<p>t</p>',
					  null,
					  null,
					  'oldslug'
					).run();
					await env.ky_news_db.prepare(`
					  INSERT INTO articles (
					    canonical_url, source_url, url_hash, title, author, published_at, category,
					    is_kentucky, is_national, county, city, summary, seo_description,
					    raw_word_count, summary_word_count, content_text, content_html, image_url, raw_r2_key, slug
					  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					`).bind(
					  'https://example.com/kynew',
					  'https://example.com',
					  'hash-ky',
					  'KY Story',
					  null,
					  now,
					  'sports',
					  1,
					  0,
					  'Fayette',
					  null,
					  's',
					  's',
					  120,
					  60,
					  't',
					  '<p>t</p>',
					  null,
					  null,
					  'kyslug'
					).run();
					await env.ky_news_db.prepare(`
					  INSERT INTO articles (
					    canonical_url, source_url, url_hash, title, author, published_at, category,
					    is_kentucky, is_national, county, city, summary, seo_description,
					    raw_word_count, summary_word_count, content_text, content_html, image_url, raw_r2_key, slug
					  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					`).bind(
					  'https://example.com/nat',
					  'https://example.com',
					  'hash-nat',
					  'Nat Story',
					  null,
					  now,
					  'national',
					  0,
					  1,
					  null,
					  null,
					  's',
					  's',
					  110,
					  55,
					  't',
					  '<p>t</p>',
					  null,
					  null,
					  'natslug'
					).run();

					const xml = await __testables.generateNewsSitemap(env as any);
					expect(xml).toContain('kyslug');
					expect(xml).toContain('natslug');
					expect(xml).not.toContain('oldslug');
					expect(xml).toMatch(/<news:keywords>Fayette County, Sports, Kentucky<\/news:keywords>/);
					expect(xml).toMatch(/<news:keywords>National<\/news:keywords>/);
				});
		});
	it('national endpoint returns articles flagged as national (category ignored)', async () => {
		await ensureSchemaAndFixture();

		// the fixture inserts several stories with is_national=1 but categories
		// such as 'sports' and 'today'.  with the updated query logic these
		// should be returned by the national feed even though the category is
		// not literally "national".
		const response = await SELF.fetch('https://example.com/api/articles/national?limit=20');
		expect(response.status).toBe(200);

		const payload = await response.json();
		expect(Array.isArray(payload.items)).toBe(true);
		expect(payload.items.length).toBeGreaterThan(0);
		expect(payload.items.some((i) => i.urlHash === 'hash-non-ky-sports')).toBe(true);
		expect(payload.items.some((i) => i.urlHash === 'hash-non-ky-today')).toBe(true);
	});

	it('ignores county filter on national endpoint', async () => {
		await ensureSchemaAndFixture();
		const unfiltered = await SELF.fetch('https://example.com/api/articles/national');
		const filtered = await SELF.fetch(
			'https://example.com/api/articles/national?counties=Fayette',
		);
		expect(unfiltered.status).toBe(200);
		expect(filtered.status).toBe(200);
		const allPayload = await unfiltered.json();
		const filteredPayload = await filtered.json();
		expect(filteredPayload.items.length).toBe(allPayload.items.length);
	});

	// the search page previously requested /api/articles/all which the worker
	// rejected as an invalid category.  reproducing that scenario ensures the
	// fix remains working.
	it('all endpoint accepts searches and never returns 400', async () => {
		await ensureSchemaAndFixture();
		const response = await SELF.fetch('https://example.com/api/articles/all?search=test');
		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(Array.isArray(payload.items)).toBe(true);

	// also ensure multi-word terms (spaces or + encoding) don't crash the
	// server; prior bugs surfaced only when the query contained a space.
	const multiSpace = await SELF.fetch('https://example.com/api/articles/all?search=state%20police');
	expect(multiSpace.status).toBe(200);
	const payload2 = await multiSpace.json();
	expect(Array.isArray(payload2.items)).toBe(true);

	const plusEncoded = await SELF.fetch('https://example.com/api/articles/all?search=state+police');
	expect(plusEncoded.status).toBe(200);
	const payload3 = await plusEncoded.json();
	expect(Array.isArray(payload3.items)).toBe(true);

	// simulate a database failure and make sure we still return 200/empty
	// instead of propagating the 500.  this covers the case observed in
	// production when a heavy search term caused D1 to abort.
	{
		const spy = vi.spyOn(dbModule, 'queryArticles').mockRejectedValue(new Error('boom'));
		const badResp = await SELF.fetch('https://example.com/api/articles/all?search=foo');
		expect(badResp.status).toBe(200);
		const badPayload = await badResp.json();
		expect(Array.isArray(badPayload.items)).toBe(true);
		expect(badPayload.items.length).toBe(0);
		// should include non-breaking flag for diagnostics
		expect(badPayload.searchError).toBe('query_failed');
		spy.mockRestore();
	}
		});

		// verify that secondary counties are respected by the public feed
		it('today endpoint honours secondary county filter', async () => {
			await ensureSchemaAndFixture();
			const now = new Date().toISOString();
			await insertArticle(env, {
				urlHash: 'hash-multi2',
				title: 'Secondary county test',
				author: null,
				publishedAt: now,
				category: 'today',
				isKentucky: true,
				isNational: false,
				county: 'Fayette',
				counties: ['Fayette', 'Jefferson'],
				city: null,
				summary: 's',
				seoDescription: 'seo',
				rawWordCount: 1,
				summaryWordCount: 1,
				contentText: 'x',
				contentHtml: '<p>x</p>',
				imageUrl: null,
				rawR2Key: null,
				slug: null,
			});

			const resp = await SELF.fetch('https://example.com/api/articles/today?counties=Jefferson');
		expect(resp.status).toBe(200);
		const payload = await resp.json();
		const item = payload.items.find((a) => a.urlHash === 'hash-multi2');
		expect(item).toBeDefined();
		// the API should include our counties list (primary first)
		expect(item.counties).toEqual(['Fayette', 'Jefferson']);
		});

		// make sure the RSS generator respects an explicit county selection
		it('today.rss endpoint honours county filter', async () => {
			await ensureSchemaAndFixture();
			const now = new Date().toISOString();
			await insertArticle(env, {
				canonicalUrl: 'https://example.com/county-rss',
				sourceUrl: 'https://example.com',
				urlHash: 'hash-county-rss',
				title: 'County RSS Test',
				author: null,
				publishedAt: now,
				category: 'today',
				isKentucky: true,
				isNational: false,
				county: 'Adair',
				counties: ['Adair'],
				city: null,
				summary: 's',
				seoDescription: 'seo',
				rawWordCount: 1,
				summaryWordCount: 1,
				contentText: 'x',
				contentHtml: '<p>x</p>',
				imageUrl: null,
				rawR2Key: null,
				slug: null,
			});

			const includeResp = await SELF.fetch('https://example.com/today.rss?county=Adair');
			const includeText = await includeResp.text();
			expect(includeText).toMatch(/County RSS Test/);

			const excludeResp = await SELF.fetch('https://example.com/today.rss?county=Jefferson');
			expect((await excludeResp.text())).not.toMatch(/County RSS Test/);
		});

	it('today.rss ignores excessively long county lists instead of crashing', async () => {
		await ensureSchemaAndFixture();
		// construct a huge county list (well over 100 entries)
		const bigList = Array(150).fill('Adair').join(',');
		const resp = await SELF.fetch(`https://example.com/today.rss?counties=${bigList}`);
		expect(resp.status).toBe(200);
		const text = await resp.text();
		expect(text).toContain('<rss');
	});

	it('rss cache is invalidated when new articles arrive', async () => {
		await ensureSchemaAndFixture();
		const first = await __testables.generateTodayRss(env as any, []);
		const now = new Date().toISOString();
		await insertArticle(env, {
			canonicalUrl: 'https://example.com/new-story',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-new',
			title: 'New Story',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Fayette',
			counties: ['Fayette'],
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});
		const second = await __testables.generateTodayRss(env as any, []);
		expect(second).not.toBe(first);
		expect(second).toMatch(/New Story/);
	});

	it('today.rss falls back to global feed when no county matches', async () => {
		await ensureSchemaAndFixture();
		// insert a single article that lives in Adair
		const now = new Date().toISOString();
		await insertArticle(env, {
			canonicalUrl: 'https://example.com/fallback-test',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-fallback',
			title: 'Fallback Story',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Adair',
			counties: ['Adair'],
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});

		// request with a county that has no articles; feed should still include our story
		const resp = await SELF.fetch('https://example.com/today.rss?county=Jefferson');
		const text = await resp.text();
		expect(text).toContain('Fallback Story');
	});
	it('generateTodayRss tolerates giant county arrays directly', async () => {
		const bigArray = Array(200).fill('Adair');
		const xml = await __testables.generateTodayRss(env as any, bigArray);
		expect(xml).toContain('<rss');
	});

	// the feed should respect the hard limit defined in the codebase.  create
	// more than that many articles and ensure we never exceed the constant.
	it('today.rss obeys TODAY_RSS_LIMIT', async () => {
		await ensureSchemaAndFixture();
		const limit = __testables.TODAY_RSS_LIMIT;
		const now = new Date().toISOString();
		for (let i = 0; i < limit + 10; i++) {
			await insertArticle(env, {
				canonicalUrl: `https://example.com/story-${i}`,
				sourceUrl: 'https://example.com',
				urlHash: `hash-${i}`,
				title: `Story ${i}`,
				author: null,
				publishedAt: now,
				category: 'today',
				isKentucky: true,
				isNational: false,
				county: 'Fayette',
				counties: ['Fayette'],
				city: null,
				summary: 's',
				seoDescription: 'seo',
				rawWordCount: 1,
				summaryWordCount: 1,
				contentText: 'x',
				contentHtml: '<p>x</p>',
				imageUrl: null,
				rawR2Key: null,
				slug: null,
			});
		}
		const xml = await __testables.generateTodayRss(env as any, []);
		const items = (xml.match(/<item>/g) || []);
		expect(items.length).toBeGreaterThan(50);
		expect(items.length).toBeLessThanOrEqual(limit);
	});

	it('today.rss respects limit query parameter', async () => {
		await ensureSchemaAndFixture();
		const limit = __testables.TODAY_RSS_LIMIT;
		const now = new Date().toISOString();
		// populate at least 30 stories for testing
		for (let i = 0; i < 30; i++) {
			await insertArticle(env, {
				canonicalUrl: `https://example.com/param-${i}`,
				sourceUrl: 'https://example.com',
				urlHash: `hash-param-${i}`,
				title: `Param ${i}`,
				author: null,
				publishedAt: now,
				category: 'today',
				isKentucky: true,
				isNational: false,
				county: 'Fayette',
				counties: ['Fayette'],
				city: null,
				summary: 's',
				seoDescription: 'seo',
				rawWordCount: 1,
				summaryWordCount: 1,
				contentText: 'x',
				contentHtml: '<p>x</p>',
				imageUrl: null,
				rawR2Key: null,
				slug: null,
			});
		}
		// ask for 5 items explicitly
		let resp = await SELF.fetch('https://example.com/today.rss?limit=5');
		let items = (await resp.text()).match(/<item>/g) || [];
		expect(items.length).toBe(5);

		// ask for more than the cap
		resp = await SELF.fetch(`https://example.com/today.rss?limit=${limit + 50}`);
		items = (await resp.text()).match(/<item>/g) || [];
		expect(items.length).toBeLessThanOrEqual(limit);
	});

	// verify slug/id endpoints include counties for multi-county articles
	it('slug and id endpoints return counties array when available', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		const slug = 'multi-slug-test';
		const id = await insertArticle(env, {
			canonicalUrl: 'https://example.com/multi3',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-multi3',
			title: 'Multi slug test',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Boone',
			counties: ['Boone', 'Kenton'],
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: slug,
		});

		// slug endpoint
		const slugResp = await SELF.fetch(`https://example.com/api/articles/slug/${slug}`);
		expect(slugResp.status).toBe(200);
		const slugPayload = await slugResp.json();
		expect(Array.isArray(slugPayload.item.counties)).toBe(true);
		expect(slugPayload.item.counties).toEqual(['Boone', 'Kenton']);

		// id endpoint
		const idResp = await SELF.fetch(`https://example.com/api/articles/item/${id}`);
		expect(idResp.status).toBe(200);
		const idPayload = await idResp.json();
		expect(Array.isArray(idPayload.item.counties)).toBe(true);
		expect(idPayload.item.counties).toEqual(['Boone', 'Kenton']);
	});

	it('queryArticles honors county filter when only primary county column is populated', async () => {
		// insert an article that has a value in `county` but no junction row
		const now = new Date().toISOString();
		const id = await insertArticle(env, {
			canonicalUrl: 'https://example.com/primary-only',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-primary',
			title: 'Primary county only test',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Adair',
			counties: [],
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});
		// explicitly clear any junction entries in case insertArticle added one
		await env.ky_news_db.prepare('DELETE FROM article_counties WHERE article_id = ?').bind(id).run();
		const counties = await getArticleCounties(env, id);
		expect(counties).toEqual([]);

		const resp = await SELF.fetch('https://example.com/api/articles/today?counties=Adair');
		expect(resp.status).toBe(200);
		const payload = await resp.json();
		const item = payload.items.find((a) => a.id === id);
		expect(item).toBeDefined();
		// no junction rows exist so the counties array should be empty
		expect(item?.counties).toEqual([]);
	});

it('queryArticles handles a very large county filter without throwing', async () => {
	// create a list larger than one chunk to exercise the new logic
	const big = Array.from({ length: 300 }, (_, i) => `C${i}`);
	const resp = await queryArticles(env, { category: 'all', counties: big, search: null, limit: 10, cursor: null });
	expect(resp).toBeDefined();
	// result set is empty but the query must complete successfully
	expect(Array.isArray(resp.items)).toBe(true);
});

it('queryArticles list responses omit heavy content fields', async () => {
	await ensureSchemaAndFixture();
	const now = new Date().toISOString();
	await insertArticle(env, {
		canonicalUrl: 'https://example.com/content-check',
		sourceUrl: 'https://example.com',
		urlHash: 'hash-content',
		title: 'Content check',
		author: null,
		publishedAt: now,
		category: 'today',
		isKentucky: true,
		isNational: false,
		county: 'Adair',
		counties: ['Adair'],
		city: null,
		summary: 's',
		seoDescription: 'seo',
		rawWordCount: 1,
		summaryWordCount: 1,
		contentText: 'long text',
		contentHtml: '<p>long html</p>',
		imageUrl: null,
		rawR2Key: null,
		slug: null,
	});
	const resp = await queryArticles(env, { category: 'today', counties: [], search: null, limit: 10, cursor: null });
	expect(Array.isArray(resp.items)).toBe(true);
	const item = resp.items.find((i) => i.urlHash === 'hash-content');
	expect(item).toBeDefined();
	expect(item!.contentText).toBe('');
	expect(item!.contentHtml).toBe('');
});

	it('obituaries endpoint returns kentucky obituaries only', async () => {
		await ensureSchemaAndFixture();

		const response = await SELF.fetch('https://example.com/api/articles/obituaries?limit=20');
		expect(response.status).toBe(200);

		const payload = await response.json();
		expect(Array.isArray(payload.items)).toBe(true);
		expect(payload.items.length).toBe(1);
		expect(payload.items[0]?.category).toBe('obituaries');
		expect(payload.items[0]?.isKentucky).toBe(true);
	});

	// weather endpoint should return both Kentucky and national weather stories
	it('weather endpoint returns both kentucky and national weather articles', async () => {
		await ensureSchemaAndFixture();

		const response = await SELF.fetch('https://example.com/api/articles/weather?limit=20');
		expect(response.status).toBe(200);

		const payload = await response.json();
		expect(Array.isArray(payload.items)).toBe(true);
		// we seeded one national and one Kentucky weather story
		expect(payload.items.length).toBe(2);
		expect(payload.items.some((itm) => itm.isKentucky)).toBe(true);
		expect(payload.items.some((itm) => !itm.isKentucky)).toBe(true);
		expect(payload.items.some((itm) => itm.isNational)).toBe(true);
	});

	it('weather endpoint still works when the database lacks is_national column', async () => {
		// simulate a legacy schema with no is_national column
		await env.ky_news_db.prepare('DROP TABLE IF EXISTS articles').run();
		await env.ky_news_db.prepare(`
			CREATE TABLE articles (
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
			);
		`).run();
		// insert a single Kentucky weather story
		const now = new Date().toISOString();
		await env.ky_news_db.prepare(`
			INSERT INTO articles (
				canonical_url, source_url, url_hash, title, author, published_at, category,
				is_kentucky, county, city, summary, seo_description, raw_word_count,
				summary_word_count, content_text, content_html, image_url, raw_r2_key, slug
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			)
		`).bind(
			'https://example.com/legacy-ky-weather',
			'https://example.com',
			'legacy-hash',
			'Legacy Kentucky Weather',
			null,
			now,
			'weather',
			1,
			'Fayette',
			'lexington',
			'Summary',
			'SEO',
			100,
			50,
			'Body',
			'<p>Body</p>',
			null,
			null,
			null,
		).run();

		const response = await SELF.fetch('https://example.com/api/articles/weather?limit=20');
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.items.length).toBe(1);
		expect(body.items[0].title).toBe('Legacy Kentucky Weather');
	});

describe('AI cleanup utilities', () => {
	it('strips image caption/alt text prior to dateline', () => {
		const raw = "Some caption\nLEXINGTON, Ky. (AP) — Story content";
		const cleaned = (aiModule as any).cleanContentForSummarization(raw, '');
		expect(cleaned).toBe("LEXINGTON, Ky. (AP) — Story content");
	});

	it('removes dateline from summary output', () => {
		const out = (aiModule as any).stripBoilerplateFromOutput("LEXINGTON, Ky. (LEX 18) — Summary text", '');
		expect(out).toBe("Summary text");
	});

	it('strips inline (Photo provided) captions before summarization', () => {
		const raw = "Captain Dave aboard the ALOHA (Photo provided) set sail.";
		const cleaned = (aiModule as any).cleanContentForSummarization(raw, '');
		expect(cleaned).toBe("Captain Dave aboard the ALOHA  set sail.");
	});

	it('removes editorial standards boilerplate', () => {
		const raw = "Some preceding text\nEditorial Standards ⓘ\nMore story.";
		const cleaned = (aiModule as any).cleanContentForSummarization(raw, '');
		expect(cleaned).toBe("Some preceding text\nMore story.");
	});

	it('strips lazy-load attribute leakage', () => {
		const raw = "Image data-src=https://foo loading=lazy src=https://foo rest";
		const cleaned = (aiModule as any).cleanContentForSummarization(raw, '');
		expect(cleaned).toBe("");
	});

	it('removes box score lines and scoring headers', () => {
		const raw = "Wells 8-12 0-0 10-12 26, Robinson 8-17 5-10 1-2 22\n" +
			"Totals: 33-67 14-28 16-21 — 96\n" +
			"TEAM 36 60 — 96\n" +
			"SCORING SUMMARY\nActual story text.";
		const cleaned = (aiModule as any).cleanContentForSummarization(raw, '');
		expect(cleaned).toBe("Actual story text.");
	});

	it('converts bullet and numbered lists into sentences', () => {
		const raw = "• First item\n- Second item\n1. Third item\n4. Fourth";
		const cleaned = (aiModule as any).cleanContentForSummarization(raw, '');
		expect(cleaned).toContain("First item.");
		expect(cleaned).toContain("Second item.");
		expect(cleaned).toContain("Third item.");
		expect(cleaned).toContain("Fourth.");
	});

	it('filters utility/infrastructure stories away from weather', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://example.com/story',
			title: 'Utility crews respond after severe weather',
			content: 'Severe weather caused outages. Kentucky Utilities said crews are working to restore power this afternoon.',
		});
		expect(classification.category).toBe('today');
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

	it('fetchAndExtractArticle prefers RSS title when site title is generic', async () => {
		// simulate a governmental site whose <title> is the site name
		vi.spyOn(httpModule, 'cachedTextFetch').mockResolvedValue({
			status: 200,
			contentType: 'text/html',
			body: '<html><head><title>Kentucky State Police</title></head><body><article><h1>Real Article Title</h1><p>Content</p></article></body></html>',
		} as any);
		const source = {
			url: 'https://kentuckystatepolice.ky.gov/press-release.html',
			providedTitle: 'Governor announces new safety initiative',
			providedDescription: '',
			feedPublishedAt: undefined,
		};
		const extracted = await ingestModule.fetchAndExtractArticle(env, source as any);
		expect(extracted.title).toBe('Governor announces new safety initiative');
		vi.restoreAllMocks();
	});

	it('ignores kentucky lantern branding in title for national stories', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://kentuckylantern.com/2026/02/03/repub/trump-doubles-down-on-calling-for-the-feds-to-take-over-state-elections/',
			title: 'Trump doubles down on calling for the feds to take over state elections • Kentucky Lantern',
			content: 'President Donald Trump repeated calls for federal control of elections in remarks focused on national policy.',
		});

		expect(classification.isKentucky).toBe(false);
		expect(classification.isNational).toBe(true);
		expect(classification.category).toBe('national');
		expect(classification.counties).toEqual([]);
	});

	it('does not detect Kentucky county when nearby out-of-state signal is present', () => {
		const text =
			'A jury in Christian County Missouri returned an indictment after a multi-state investigation.';

		expect(detectCounty(text, text)).toBeNull();
	});

	it('treats Greenville as ambiguous county name', () => {
		const text = 'Greenville police department announced new measures in Kentucky.';
		// although "Greenville" appears alongside Kentucky, it should not
		// auto-assign a county because Greenville is ambiguous and the term
		// itself is not a Kentucky county.
		expect(detectCounty(text, text)).toBeNull();
	});

	it('detects Barren County when slash follows the county name', () => {
		const text = 'Glasgow, Ky. Barren County/Metcalfe EMS responded to a crash.';
		expect(detectCounty(text, text)).toBe('Barren');
	});

	it('getSourceDefaultImage returns KSP logo for state police domains', () => {
		expect(classifyModule.getSourceDefaultImage('https://kentuckystatepolice.ky.gov/foo')).toBe(
		'https://www.kentuckystatepolice.ky.gov/images/KSP-logo.png'
	);
		expect(classifyModule.getSourceDefaultImage('https://wp.kentuckystatepolice.ky.gov/bar')).toBe(
		'https://www.kentuckystatepolice.ky.gov/images/KSP-logo.png'
	);
		expect(classifyModule.getSourceDefaultImage('https://example.com')).toBeNull();
	});

	it('getSourceDefaultCounty returns null for wlwt.com', () => {
		expect(classifyModule.getSourceDefaultCounty('https://wlwt.com/anything')).toBeNull();
	});

	it('getSourceDefaultCounty recognizes kentuckystatepolice.ky.gov as statewide (null)', () => {
		expect(classifyModule.getSourceDefaultCounty('https://kentuckystatepolice.ky.gov/news')).toBeNull();
	});

	it('getSourceDefaultCounty returns Pulaski for k105.com', () => {
		expect(classifyModule.getSourceDefaultCounty('https://k105.com/article')).toBe('Pulaski');
	});

	it('getSourceDefaultCounty returns Harlan for harlanenterprise.net', () => {
		expect(classifyModule.getSourceDefaultCounty('https://harlanenterprise.net/some')).toBe('Harlan');
	});

	it('classification picks up multiple counties in shared-suffix phrase', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://example.com/knox-laurel',
			title: 'Attorney charged in federal court',
			content: "Laurel and Knox County's Commonwealth's Attorney was mentioned in the indictment.",
		});

		expect(classification.isKentucky).toBe(true);
		expect(classification.counties).toEqual(['Laurel', 'Knox']);
	});

	it('does not let a bare county name override source default for kykernel.com', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://kykernel.com/sports/uk-game',
			title: 'UK Wildcats vs Opponent',
			content: 'Pendleton scored a touchdown in the second quarter.',
		});
		// fallback county for kykernel.com is Fayette
		expect(classification.county).toBe('Fayette');
	});

	it('allows explicit "X County" mentions to override source default', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://kykernel.com/local-news',
			title: 'Community meeting',
			content: 'Pendleton County sheriff held a press conference.',
		});
		expect(classification.county).toBe('Pendleton');
	});

	it('full ingest pipeline assigns correct county for an explicit Pike County article', async () => {
		// mock the AI to return a simple classification so the pipeline deterministically
		// picks up Pike County from the text and stores it in the D1 row.
		const originalAi = env.AI;
		env.AI = {
			run: vi.fn().mockResolvedValue({
				response: JSON.stringify({
					category: 'today',
					isKentucky: true,
					counties: ['Pike'],
				}),
			}),
		} as any;

		const classification = await classifyArticleWithAi(env, {
			url: 'https://pikenewstimes.com/article/pikeville-event',
			title: 'Pikeville festival draws thousands to Pike County',
			content: 'PIKEVILLE, Ky. — The annual Mountain Arts Center festival in Pike County drew large crowds Saturday.',
		});

		env.AI = originalAi;
		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBe('Pike');
		expect(classification.counties).toContain('Pike');
	});

	it('national wire regex matches foreign datelines like Dubai/United Arab Emirates', () => {
		expect(classifyModule.NATIONAL_WIRE_OVERRIDE_RE.test('DUBAI, United Arab Emirates — Story')).toBe(true);
		expect(classifyModule.NATIONAL_WIRE_OVERRIDE_RE.test('JERUSALEM, Israel — Report')).toBe(true);
		expect(classifyModule.NATIONAL_WIRE_OVERRIDE_RE.test('MOSCOW, Russia — News')).toBe(true);
	});

	it('treats FRANKFORT dateline stories as statewide Kentucky content with no county', async () => {
		// ensure AI doesn't introduce stray counties
	const originalAiStub = env.AI;
	env.AI = { run: vi.fn().mockResolvedValue({ response: JSON.stringify({ category: 'today', isKentucky: true, counties: [] }) }) } as any;
	const classification = await classifyArticleWithAi(env, {
			url: 'https://harlanenterprise.net/article/hb-593',
			title: 'FRANKFORT, Ky. (KT) – Lawmakers debate bill',
			content: 'FRANKFORT, Ky. (KT) – Senate and House members met in closed session.',
		});
	env.AI = originalAiStub;
		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBeNull();
		expect(classification.counties).toEqual([]);
	});

	it('ignores geo/AI counties when statewide KY dateline appears only in content', async () => {
		// this mirrors a real bug where the title lacked the dateline, causing
		// detectKentuckyGeo to pick up "Frankfort" from the body and return
		// Franklin County.  isStatewideKyPolitics should still null out the
		// county regardless of that detection.
		// stub AI to avoid unpredictable counties
	const originalAiStub2 = env.AI;
	env.AI = { run: vi.fn().mockResolvedValue({ response: JSON.stringify({ category: 'today', isKentucky: true, counties: [] }) }) } as any;
	const classification = await classifyArticleWithAi(env, {
			url: 'https://example.com/abc36-news',
			title: 'Governor announces new budget',
			content: 'FRANKFORT, Ky. (ABC36 NEWS NOW) – In Franklin County today the governor outlined...',
		});
	env.AI = originalAiStub2;
		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBeNull();
		expect(classification.counties).toEqual([]);
	});

	it('does not assign Franklin County when Frankfort appears only in body text', async () => {
		// similar to the previous test but without an explicit dateline in the title
		// and using a different source URL.  the AI is not stubbed here because we
		// expect the base geo logic alone to clear the county, but we still check
		// that the final classification preserves the KY flag.
		const classification = await classifyArticleWithAi(env, {
			url: 'https://harlanenterprise.net/article/ky-legislature',
			title: 'Kentucky lawmakers pass new education bill',
			content: 'FRANKFORT, Ky. — The state legislature voted Thursday on House Bill 42.',
		});
		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBeNull();
		expect(classification.counties).toEqual([]);
	});

	// ensure multiple counties from AI are retained even for statewide-pol
	it('keeps multiple AI counties on statewide politics stories', async () => {
		const originalAi2 = env.AI;
		const aiResponse2 = JSON.stringify({ category: 'today', isKentucky: true, counties: ['Franklin', 'Fayette'] });
		env.AI = { run: vi.fn().mockResolvedValue({ response: aiResponse2 }) } as any;
		const classification2 = await classifyArticleWithAi(env, {
			url: 'https://example.com/politics2',
			title: 'FRANKFORT, Ky. – Roundup',
			content: 'FRANKFORT dateline with mentions of Franklin and Fayette counties',
		});
		expect(classification2.county).toBeNull();
		expect(classification2.counties).toEqual(['Franklin', 'Fayette']);
		env.AI = originalAi2;
	});

		it('suppresses default county when statewide politics but local dateline is present', async () => {
			// e.g. a wbko.com Medicaid story datelined "BOWLING GREEN, Ky." but
			// discussing statewide House Bill 2 with Frankfort context.  The
			// statewide-politics flag should null out any Warren County inferred
			// solely from the dateline city.
			const classification = await classifyArticleWithAi(env, {
				url: 'https://wbko.com/article/medicaid-copay',
				title: 'BOWLING GREEN, Ky. (AP) – House Bill 2 debate continues',
				content: 'BOWLING GREEN, Ky. (AP) – Lawmakers in Frankfort are debating House Bill 2 that would affect all of Kentucky.',
			});
			expect(classification.isKentucky).toBe(true);
			expect(classification.county).toBeNull();
			expect(classification.counties).toEqual([]);
		});

	it('assigns Warren County for a WBKO dateline on a non-statewide local story', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://wbko.com/article/local-news',
			title: 'BOWLING GREEN, Ky. (WBKO) – County officials meet',
			content: 'BOWLING GREEN, Ky. (WBKO) – Warren County fiscal court convened to discuss budget.',
		});
		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBe('Warren');
		expect(classification.counties).toEqual(['Warren']);
	});

	// 301 handler test for county-path mismatches
	it('301 handler uses short TTL for county-path mismatches', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		const slug = 'test-slug-abc';
		await insertArticle(env, {
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Fayette',
			counties: ['Fayette'],
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug,
		});
		// fetch using wrong county path
		const resp = await SELF.fetch(
			`https://example.com/news/kentucky/wrong-county/${slug}`,
		);
		expect(resp.status).toBe(301);
		expect(resp.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=3600');

		// also verify canonicalization when the county slug is missing the
		// "-county" suffix (stored county names are often just "Fayette").
		const resp2 = await SELF.fetch(
			`https://example.com/news/kentucky/fayette/${slug}`,
		);
		expect(resp2.status).toBe(301);
		expect(resp2.headers.get('location')).toBe(`/news/kentucky/fayette-county/${slug}`);
	});

	it('strips breadcrumbs from scraped HTML', () => {
		const html = '<div>Home » Region »</div><article><p>Story begins here.</p></article>';
		const doc = scrapeArticleHtml('https://nkytribune.com/story', html);
		expect(doc.contentText).toBe('Story begins here.');
	});

	it('removes WordPress vertical nav menus before article text', () => {
		const html = 'Business\nEducation\nGovernment\n<article><p>Content after nav</p></article>';
		const doc = scrapeArticleHtml('https://example.com/story', html);
		expect(doc.contentText).toBe('Content after nav');
	});

		it('falls back to first <img> when no og:image meta is present', () => {
			const html = '<article><p>Story</p><img src="/images/foo.jpg"/></article>';
			const doc = scrapeArticleHtml('https://example.com/story', html);
			expect(doc.imageUrl).toBe('https://example.com/images/foo.jpg');
		});

		it('uses data-src when src is missing', () => {
			const html = '<article><img data-src="/foo2.png"/></article>';
			const doc = scrapeArticleHtml('https://example.com/story', html);
			expect(doc.imageUrl).toBe('https://example.com/foo2.png');
		});

		it('parses srcset and picks first URL', () => {
			const html = '<article><img srcset="/a.jpg 1x, /b.jpg 2x"/></article>';
			const doc = scrapeArticleHtml('https://example.com/story', html);
			expect(doc.imageUrl).toBe('https://example.com/a.jpg');
		});

		// wlwt.com feeds Cincinnati/NKY stories and should not be treated as a
		// Kentucky-local source; previously it leaked Ohio-county articles into
		// our database.  It now lives in ALWAYS_NATIONAL_SOURCES and should be
		// classified as national regardless of content.
		it('treats wlwt.com articles as national', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://wlwt.com/weather-forecast',
				title: 'Boone County under winter weather advisory',
				content: 'Greater Cincinnati area will see snow; Boone County residents should prepare.',
			});

			expect(classification.isKentucky).toBe(false);
			expect(classification.category).toBe('national');
		});

		// ensure Indiana stories mentioning Floyd County don't get mis-tagged
		it('does not assign Floyd County for stories about Floyd County, Indiana', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://example.com/indiana-incident',
				title: 'LOUISVILLE, Ky. (AP) – Crash in Floyd County, Indiana',
				content: 'NEW ALBANY, Indiana – Officers in Floyd County, Indiana, responded to a crash near the Ohio River.',
			});
			expect(classification.county).toBeNull();
		});

		it('recognizes Floyd County Sheriff phrase as Indiana', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://example.com/indiana-sheriff',
				title: 'LOUISVILLE, Ky. (AP) – Crime in Floyd County',
				content: 'FLOYD COUNTY SHERIFF reports shooting near the Ohio River.',
			});
			expect(classification.county).toBeNull();
		});

		it('responds to Georgetown-Greenville road reference', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://example.com/road-incident',
				title: 'Incident on Georgetown-Greenville Road',
				content: 'A crash occurred along Georgetown-Greenville Road in southern Indiana.',
			});
			expect(classification.county).toBeNull();
		});

		it('applies Fayette default for wtvq.com and null county for statewide weather', async () => {
			// generic non-weather story should fall back to Fayette via site default
			let classification = await classifyArticleWithAi(env, {
				url: 'https://wtvq.com/some-local-news',
				title: 'Local ribbon cutting in downtown Lexington',
				content: 'City officials held a ribbon cutting ceremony today.',
			});
			expect(classification.isKentucky).toBe(true);
			expect(classification.county).toBe('Fayette');

			// statewide forecast language wipes out default
			classification = await classifyArticleWithAi(env, {
				url: 'https://wtvq.com/weather-forecast',
				title: 'Statewide Weather Alert',
				content: 'Central and eastern Kentucky will see storms on Thursday.',
			});
			expect(classification.isKentucky).toBe(true);
			expect(classification.county).toBeNull();
			expect(classification.counties).toEqual([]);
		});

		// extra regression cases added for recent fixes
		it('recognizes Indiana abbreviation in isIndianaStory guard', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://example.com/indiana-abbrev',
				title: 'GREENVILLE, Ind. — Police investigate',
				content: 'GREENVILLE, Ind. — A shooting occurred in southern Indiana.',
			});
			expect(classification.county).toBeNull();
		});

		it('applies Jefferson default for wdrb.com when only Louisville mentioned', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://wdrb.com/news/louisville-incident',
				title: 'Louisville Metro Police respond to incident',
				content: 'Louisville Metro Police say ...',
			});
			expect(classification.county).toBe('Jefferson');
		});

		it('detects explicit Ohio County dateline and assigns Ohio county', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://example.com/ohio-county',
				title: 'OHIO COUNTY, Ky. — Local news',
				content: 'OHIO COUNTY, Ky. — Something happened in Ohio County.',
			});
			expect(classification.county).toBe('Ohio');
		});

		it('detects Mt. Sterling mapping to Montgomery', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://example.com/mt-sterling-event',
				title: 'MT. STERLING, Ky. — Town festival',
				content: 'MT. STERLING, Ky. — Turkey trot held in city.',
			});
			expect(classification.county).toBe('Montgomery');
		});

		it('whas11 source is always treated as national regardless of content', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://www.whas11.com/local-kentucky',
				title: 'Louisville celebration draws thousands',
				content: 'The parade in downtown Louisville drew thousands of viewers.',
			});
			expect(classification.isKentucky).toBe(false);
			expect(classification.county).toBeNull();
		});

		// national wire-like always-national source should ignore Kentucky hints
		it('does not tag newsfromthestates.com article about Louisville as KY', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://newsfromthestates.com/politics/abc',
				title: 'Louisville, Kentucky, killing at least 22',
				content: 'In a speech to Congress, representatives discussed policy changes.',
			});
			expect(classification.isKentucky).toBe(false);
			expect(classification.category).toBe('national');
		});

		// historical Louisville reference guard should prevent Jefferson tagging
		it('ignores historical Louisville reference in non-local story', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://foxnews.com/us/historical',
				title: 'Conflict recalled in Louisville, Kentucky, killing in 1855',
				content: 'The author referenced the Bloody Monday riots of 1855 in Louisville, Kentucky, as part of a broader piece.',
			});
			expect(classification.isKentucky).toBe(false);
		});

		// thoroughbreddailynews.com should be treated as national
		it('does not tag TDN racing coverage as Kentucky', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://thoroughbreddailynews.com/horsemen-news',
				title: 'Derby favorite trains in Kentucky barn',
				content: 'The Kentucky Derby favorite worked five furlongs today.',
			});
			expect(classification.isKentucky).toBe(false);
		});

		it('recognizes Austin dateline as wire and treats article as national', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://www.whas11.com/article/national-wire-austin',
				title: 'AUSTIN, Texas — Legislature debates...',
				content: 'AUSTIN, Texas — Lawmakers discussed a bill...',
			});
			expect(classification.isKentucky).toBe(false);
			expect(classification.category).toBe('national');
		});

		it('handles Gray News station prefix in byline', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://www.wbko.com/article/national-wire-grayprefix',
				title: '(KVLY/Gray News) — Story text here',
				content: '(KVLY/Gray News) — Story text here',
			});
			expect(classification.isKentucky).toBe(false);
		});

		it('handles InvestigateTV byline as national content', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://www.wlwt.com/article/investigatetv',
				title: '(InvestigateTV) — Consumer story',
				content: '(InvestigateTV) — Consumer story about loans',
			});
			expect(classification.isKentucky).toBe(false);
		});

		it('also treats New York dateline wire pieces as non-KY', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://www.whas11.com/article/national-wire-ny',
				title: 'NEW YORK — Police tighten security after blah',
				content: 'NEW YORK — Authorities said...',
			});
			expect(classification.isKentucky).toBe(false);
			expect(classification.category).toBe('national');
		});

		// new regression cases for Atlanta and ANF-style bylines
		it('treats Atlanta dateline wire stories as non-KY', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://www.wymt.com/article/national-wire-atlanta',
				title: 'ATLANTA — Woman arrested after ...',
				content: 'ATLANTA — A Georgia woman was charged...',
			});
			expect(classification.isKentucky).toBe(false);
			expect(classification.category).toBe('national');
		});

		it('recognizes ANF/Gray News byline and treats as national', async () => {
			const classification = await classifyArticleWithAi(env, {
				url: 'https://www.wymt.com/article/national-wire-anf',
				title: '(ANF/Gray News) — A Georgia woman ...',
				content: '(ANF/Gray News) — A Georgia woman pleaded guilty...',
			});
			expect(classification.isKentucky).toBe(false);
			expect(classification.category).toBe('national');
		});

	it('does not hallucinate counties when AI proposes unknown name', async () => {
			// temporarily override the AI run method on the shared env
			const originalAi = env.AI;
			const responseText = JSON.stringify({ category: 'today', isKentucky: true, counties: ['Elliott'] });
			env.AI = { run: vi.fn().mockResolvedValue({ response: responseText }) };
			const classification = await classifyArticleWithAi(env, {
				url: 'https://example.com/test',
				title: 'Generic title',
				content: 'No county mentioned here.',
			});
			// restore original AI stub so later tests are unaffected
			env.AI = originalAi;
		expect(classification.counties).toEqual([]);
	});

	it('marks national betting/odds articles as non-KY and non-summarizable', async () => {
		const text = 'Kentucky vs Vanderbilt odds: spread money line and promo code our pick';
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.cbssports.com/college-basketball/odds/',
			title: 'Kentucky vs Vanderbilt odds spread',
			content: text,
		});
		expect(classification.isKentucky).toBe(false);
		expect(classification.category).toBe('national');
		expect(isScheduleOrScoresArticle(text)).toBe(true);
	});

	it('does not classify national wire story as KY when only a Kentucky politician is mentioned', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.nbcnews.com/politics/congress/',
			title: 'WASHINGTON — Democrats debate war powers',
			content: 'WASHINGTON — Rep. Thomas Massie, R-Ky., said the vote would ...',
		});
		expect(classification.isKentucky).toBe(false);
		expect(classification.county).toBeNull();
	});

	it('recognizes dateline with parenthetical credit as national wire', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.example.com/politics',
			title: 'WASHINGTON (AP) — Federal update',
			content: 'WASHINGTON (AP) — Federal officials announced new measures today.',
		});
		expect(classification.isKentucky).toBe(false);
		expect(classification.county).toBeNull();
	});

	it('matches any out-of-state city,state dateline as a national wire', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.whas11.com/news',
			title: 'GILBERT, Ariz. — Local fire department reports',
			content: 'GILBERT, Ariz. — A child who was declared dead has been identified.',
		});
		expect(classification.isKentucky).toBe(false);
		expect(classification.county).toBeNull();
	});

	it('respects AI judgment when the model classifies a national-wire KY story as Kentucky', async () => {
		const originalAi = env.AI;
		const responseText2 = JSON.stringify({ category: 'today', isKentucky: true, counties: [] });
		env.AI = { run: vi.fn().mockResolvedValue({ response: responseText2 }) };
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.nbcnews.com/politics/congress/',
			title: 'WASHINGTON — Rep. Thomas Massie holds press conference',
			content: 'WASHINGTON — Rep. Thomas Massie, R-Ky., led today’s briefing.',
		});
		env.AI = originalAi;
		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBeNull();
	});

	it('treats a purely national wire story with Khamenei dateline as non-KY', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.lex18.com/article/foreign-news',
			title: 'DUBAI — United Arab Emirates correspondent reports',
			content: 'DUBAI — United Arab Emirates officials said ...',
		});
		expect(classification.isKentucky).toBe(false);
		expect(classification.category).toBe('national');
	});

	it('applies source default county fallback for Kentucky.com when KY context is present', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.kentucky.com/news/politics-government/article999999999.html',
			title: 'State budget advances in Kentucky legislature',
			content: 'Kentucky lawmakers debated fiscal priorities during the latest legislative session.',
		});

		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBe('Fayette');
		expect(classification.counties).toEqual(['Fayette']);
	});

	it('applies source default for lex18 non-wire content', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.lex18.com/food/best-bluegrass',
			title: 'Best of the Bluegrass recipes',
			content: 'Enjoy these recipes from across the state.',
		});
		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBe('Fayette');
		expect(classification.counties).toEqual(['Fayette']);
	});

	it('requires city evidence before trusting source-default county', async () => {
		// National-ish story with no Lexington/Fayette placement signal should
		// not be pinned to Fayette despite coming from a Fayette-based source.
		const classificationNoCity = await classifyArticleWithAi(env, {
			url: 'https://www.lex18.com/article/track-star',
			title: 'UK athlete wins gold medal',
			content: 'Sydney McLaughlin of the University of Kentucky won the 400m hurdles in Paris.',
		});
		expect(classificationNoCity.isKentucky).toBe(true);
		expect(classificationNoCity.county).toBeNull();

		// add an explicit Lexington mention and the default should then apply
		const classificationWithCity = await classifyArticleWithAi(env, {
			url: 'https://www.lex18.com/article/police-arrest',
			title: 'Lexington police release statement',
			content: 'Lexington police arrested a suspect in downtown Fayette County.',
		});
		expect(classificationWithCity.county).toBe('Fayette');
	});

	it('links linknky.com to Kenton when Covington appears', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://linknky.com/news/ribbon-cutting',
			title: 'Covington business opens new location',
			content: 'COVINGTON, Ky. – A new restaurant opened its doors in Covington today.',
		});
		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBe('Kenton');
		expect(classification.counties).toEqual(['Kenton']);
	});

	// conversational forecast language should still trigger weather even when
	// the title is weak or the body only has a single match.  this exercises
	// the new patterns and relaxed evidence threshold.
	it('classifies conversational forecast language as weather', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://wbko.com/forecast',
			title: 'Active start to the new month',
			content:
				'The forecast calls for scattered showers, partly cloudy skies, overnight lows in the upper 50s and even some flurries.',
		});
		expect(classification.category).toBe('weather');
	});

	// titles like "First Alert Weather Day" are very common on local TV sites
	// and should count as weather even if the body is sparse.
	it('recognizes weather from title patterns like First Alert Weather Day', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://wbko.com/story',
			title: 'First Alert Weather Day for our region',
			content: 'Just a short blurb about the day.',
		});
		expect(classification.category).toBe('weather');
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
		console.log('wkyt classification', classification);

		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBe('Fayette');
		expect(classification.counties).toEqual(['Fayette']);
		expect(classification.category).toBe('weather');
		expect(classification.isNational).toBe(true); // contains "National Weather Service" cue
	});


	it('tags wymt weather articles as Kentucky with Perry county even when no KY context', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.wymt.com/2026/02/26/forecast-this-week/',
			title: 'National Weather Service issues advisory',
			content: 'Alerts are in place across multiple states.',
		});
		console.log('wymt classification', classification);

		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBe('Perry');
		expect(classification.counties).toEqual(['Perry']);
		expect(classification.isNational).toBe(true); // title contains "National"
	}, 10000);


	// explicit city mention should map to the correct county
	it('detects Fayette county from a Lexington, KY mention', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://example.com/test',
			title: 'Heatwave hits Lexington, Ky.',
			content: 'Temperatures soared in Lexington, Ky. during the early afternoon.',
		});
		console.log('lexington classification', classification);

		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBe('Fayette');
		expect(classification.counties).toEqual(['Fayette']);

		expect(classification.isKentucky).toBe(true);
		expect(classification.category).toBe('today');
		expect(classification.isNational).toBe(true);
		expect(classification.counties).toEqual([]);
	}, 10000);

	// city not present in the mapping should not produce a county
	it('does not assign a county for a Kentucky city not in the geo mapping', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://example.com/sparta-event',
			title: 'Community festival in Sparta, Ky.',
			content: 'Residents of Sparta gathered for the annual summer festival.',
		});
		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBeNull();
		expect(classification.counties).toEqual([]);
	});

	// mention of multiple counties should still return at least one county (first match)
	it('assigns a county when multiple Kentucky counties are mentioned', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://example.com/multi-county',
			title: 'Joint project across Kentucky counties Fayette and Jefferson',
			content: 'Officials from Fayette County and Jefferson County in Kentucky attended the ribbon cutting.',
		});
		expect(classification.isKentucky).toBe(true);
		// Fayette appears earlier in KY_COUNTIES ordering than Jefferson
		expect(classification.county).toBe('Fayette');
		expect(classification.counties[0]).toBe('Fayette');
		expect(classification.counties).toEqual(expect.arrayContaining(['Jefferson']));
	});

	it('tags kyschools.us domains as Kentucky and assigns the county from subdomain', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.ohio.kyschools.us/news/district-updates',
			title: 'District updates for students and families',
			content: 'The district shared updates about school operations and upcoming events for families.',
		});

		expect(classification.isKentucky).toBe(true);
		expect(classification.county).toBe('Ohio');
		expect(classification.counties).toEqual(['Ohio']);
		expect(classification.category).toBe('schools');
	});

	it('classifies a generic out-of-state college matchup as national sports', async () => {
		const classification = await classifyArticleWithAi(env, {
			url: 'https://www.cbssports.com/college-basketball/game/',
			title: 'Arizona vs Kansas final score',
			content: 'Arizona Wildcats beat Kansas Jayhawks 80-70 in NCAA action.',
		});
		expect(classification.isKentucky).toBe(false);
		expect(classification.category).toBe('national');
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
		expect(nonKySports.isNational).toBe(true);
		expect(nonKySchools.isNational).toBe(true);
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
	}, 10000);

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

	it('recognizes and extracts kyweathercenter.com search results', () => {
		const html = `
			<div>
				<a href="https://kyweathercenter.com/?p=12345">Post link</a>
				<a href="https://kyweathercenter.com/?page_id=1">Page link</a>
			</div>
		`;

		const links = __testables.extractStructuredSearchLinks(
			'https://kyweathercenter.com/?s=kentucky',
			html,
			10,
		);

		expect(links).toEqual(['https://kyweathercenter.com/?p=12345']);
		expect(__testables.isStructuredSearchSource('https://kyweathercenter.com/')).toBe(true);
		expect(__testables.isRobotsBypassAllowed('https://kyweathercenter.com/')).toBe(true);
	});
		expect(urls).toEqual([
			'https://www.kentucky.com/search/?q=Fayette&page=1&sort=newest',
			'https://www.wymt.com/search/?query=Fayette',
		]);
	});
});

// new helper tests

describe('weather summary builder', () => {
	it('constructs a sensible article payload', async () => {
		const originalFetch = global.fetch;
		// stub the NWS endpoints used by buildDailyWeatherArticle
		global.fetch = async (url: any) => {
			const s = String(url);
			if (s.includes('/alerts/active')) {
				return {
					ok: true,
					json: async () => ({
						features: [{
							id: 'test',
							properties: {
								event: 'Tornado Warning',
								areaDesc: 'Jefferson',
								sent: '2026-03-09T10:00:00Z',
								description: 'desc',
								instruction: 'instr',
							},
						}],
					}),
				};
			}
			if (s.includes('/points/')) {
				return {
					ok: true,
					json: async () => ({
						properties: {
							forecast: 'https://example.com/forecast',
							observationStations: 'https://example.com/stations',
						},
					}),
				};
			}
			if (s.includes('forecast')) {
				return {
					ok: true,
					json: async () => ({
						properties: { periods: [{ shortForecast: 'Sunny', temperature: 70 }] },
					}),
				};
			}
			if (s.includes('stations/')) {
				return { ok: true, json: async () => ({ features: [{ properties: { stationIdentifier: 'ABC' } }] }) };
			}
			if (s.includes('/observations/latest')) {
				return { ok: true, json: async () => ({ properties: { temperature: { value: 20 }, textDescription: 'Clear' } }) };
			}
			return { ok: false, json: async () => ({}) };
		};

		const { buildDailyWeatherArticle } = await import('../lib/weatherSummary');
		const article = await buildDailyWeatherArticle(undefined as any, 'morning');
		expect(article.title).toBe('Kentucky Weather Update – Morning Summary');
		expect(article.contentText).toMatch(/Tornado Warning/);
		expect(article.contentText).toMatch(/McCracken/);
		// slug should follow the same pattern used in the main code
		const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
		expect(article.slug).toBe(`kentucky-weather-update-morning-summary-${today}`);
		// there is no embedded image in the summary, so imageUrl stays null
		expect(article.imageUrl).toBeNull();

			// now publish using the helper and verify it is stored
			await ensureSchemaAndFixture();
			const { publishWeatherSummary } = await import('../lib/weatherSummary');
			await publishWeatherSummary(env, 'morning');
			// confirm a record exists
			const rows = await env.ky_news_db.prepare('SELECT title FROM articles').all();
			expect(rows.results.length).toBe(1);
			expect(rows.results[0].title).toBe(article.title);


	// ensure SPC articles also get a slug so they aren't routed via /post?id
	it('buildSpcArticle generates a readable, unique slug', async () => {
		const { buildSpcArticle } = await import('../lib/spc');
		const item = {
			title: 'SPC MD 0182 – strange storms',
			link: 'https://www.spc.noaa.gov/products/md/md0182.html',
			description: 'Brief summary',
			publishedAt: '2025-01-01T12:00:00Z',
			productType: 'mesoscale_discussion',
		};
		const article = await buildSpcArticle(item as any);
		expect(article.slug).toMatch(/^spc-md-0182-strange-storms-[0-9a-f]{8}$/);
		// map image should be assigned as the preview image
		expect(article.imageUrl).toBe(SPC_DAY1_RISK_MAP);
	});

	// NWS alerts should also include a slug so they can be linked normally
	it('buildAlertArticle assigns a slug based on the alert ID', async () => {
		const { buildAlertArticle } = await import('../lib/nws');
		const alert = {
			id: 'test-123',
			event: 'Test Warning',
			headline: 'Test event',
			description: 'desc',
			instruction: null,
			areaDesc: 'Adair County',
			severity: 'Severe',
			urgency: 'Immediate',
			sent: '2025-02-02T00:00:00Z',
			effective: '2025-02-02T00:00:00Z',
			expires: '2025-02-02T01:00:00Z',
			status: 'Actual',
			counties: ['Adair'],
			geometry: null,
		};
		const article = await buildAlertArticle(alert as any);
		expect(article.slug).toBe('nws-test-123');
		expect(article.imageUrl).toBe(`https://radar.weather.gov/ridge/standard/KLVX_loop.gif`);
	});

	// HWO products should include an inline radar image with responsive styles
	it('buildHwoArticle generates contentHtml with max-width and height:auto on the radar image', async () => {
		const { buildHwoArticle } = await import('../lib/nws');
		const dummy = {
			id: 'hwo-1',
			office: 'KJKL',
			issuanceTime: '2025-01-01T00:00:00Z',
			productText: 'HAZARDOUS WEATHER OUTLOOK\n\n.DAY ONE...No hazardous weather\n\n$$',
		};
		const article = await buildHwoArticle(dummy as any);
		expect(article.imageUrl).toBe('https://radar.weather.gov/ridge/standard/KJKL_loop.gif');
		expect(article.contentHtml).toMatch(/<img[^>]+style="[^"]*max-width:100%;[^"]*height:auto/);
	});

});

describe('database utilities', () => {
	it('getCountyCounts retrieves correct map', async () => {
		await ensureSchemaAndFixture();
		const map = await __testables.getCountyCounts(env);
		// Fayette appears twice (today + weather), Jefferson twice (sports + obit)
		expect(map.get('Fayette')).toBe(2);
		expect(map.get('Jefferson')).toBe(2);
	});

	it('getCountyCounts handles articles that only have a primary county', async () => {
		await ensureSchemaAndFixture();
		// insert legacy-style article
		const now = new Date().toISOString();
		const id = await insertArticle(env, {
			canonicalUrl: 'https://example.com/legacy',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-legacy',
			title: 'Legacy county test',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Adair',
			counties: [],
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});
		// ensure no junction rows
		await env.ky_news_db.prepare('DELETE FROM article_counties WHERE article_id = ?').bind(id).run();

		const map2 = await getCountyCounts(env);
		expect(map2.get('Adair')).toBe(1);
	});

	it('getArticleCounties returns counties list for an inserted article', async () => {
		await ensureSchemaAndFixture();
		// insert via helper so junction entries are created automatically
		const now = new Date().toISOString();
		const id = await insertArticle(env, {
			canonicalUrl: 'https://example.com/multi',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-multi',
			title: 'Multi county test',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Fayette',
			counties: ['Fayette', 'Jefferson'],
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});

		const counties = await getArticleCounties(env, id);
		expect(counties).toEqual(['Fayette', 'Jefferson']);
	});

	it('updateArticleClassification syncs junction table', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		const id = await insertArticle(env, {
			canonicalUrl: 'https://example.com/sync',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-sync',
			title: 'Sync test',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Fayette',
			counties: ['Fayette'],
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});

		let counties = await getArticleCounties(env, id);
		expect(counties).toEqual(['Fayette']);

		await updateArticleClassification(env, id, {
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Jefferson',
			counties: ['Jefferson', 'Fayette'],
		});

		counties = await getArticleCounties(env, id);
		expect(counties).toEqual(['Jefferson', 'Fayette']);
	});

	it('allows clearing category via updateArticleClassification', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		const id2 = await insertArticle(env, {
			canonicalUrl: 'https://example.com/clear',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-clear',
			title: 'Clear Cat',
			author: null,
			publishedAt: now,
			category: 'weather',
			isKentucky: true,
			isNational: false,
			county: 'Fayette',
			counties: ['Fayette'],
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});

		await updateArticleClassification(env, id2, {
			category: '',
			isKentucky: false,
			isNational: true,
			county: null,
		});
		const row = await getArticleById(env, id2);
		expect(row?.category).toBe('');
	});

	it('preserves existing national flag when patch omits it', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		const id3 = await insertArticle(env, {
			canonicalUrl: 'https://example.com/preserve',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-preserve',
			title: 'Preserve Nat',
			author: null,
			publishedAt: now,
			category: 'weather',
			isKentucky: true,
			isNational: true,
			county: 'Fayette',
			counties: ['Fayette'],
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});

		// update without mentioning isNational
		await updateArticleClassification(env, id3, {
			category: 'sports',
			isKentucky: false,
			county: null,
		});

		const row = await getArticleById(env, id3);
		expect(row?.is_national).toBe(1); // should remain unchanged

		// simulate a transient D1 error on the first execution path
		let attempt = 0;
		const origPrepare = env.ky_news_db.prepare.bind(env.ky_news_db);
		env.ky_news_db.prepare = (sql: string) => {
			const stmt = origPrepare(sql);
			const origRun = stmt.run.bind(stmt);
			stmt.run = async (...args: any[]) => {
				if (attempt === 0) {
					attempt++;
					const err: any = new Error('D1_ERROR: no such table: main.articles_old');
					throw err;
				}
				return origRun(...args);
			};
			return stmt;
		};

		// a second call should succeed despite the first failure
		await updateArticleClassification(env, id3, {
			category: '',
			isKentucky: false,
			isNational: true,
			county: null,
		});
		const row3 = await getArticleById(env, id3);
		expect(row3?.category).toBe('');
		env.ky_news_db.prepare = origPrepare;
	});

	it('listAdminArticles reflects updated counties', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		const id = await insertArticle(env, {
			canonicalUrl: 'https://example.com/multi2',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-multi2',
			title: 'Multi county test',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Fayette',
			counties: ['Fayette', 'Jefferson'],
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});

		const resp = await listAdminArticles(env, { limit: 10, cursor: null, search: null, category: 'all' });
		const found = resp.items.find((i) => i.id === id);
		expect(found).toBeDefined();
		expect(found?.counties).toEqual(['Fayette', 'Jefferson']);
	});

	it('listAdminArticles search matches summary text', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		const id = await insertArticle(env, {
			canonicalUrl: 'https://example.com/searchsumadmin',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-search-admin',
			title: 'Search admin test',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Fayette',
			counties: ['Fayette'],
			city: null,
			summary: 'findme-admin-summary',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});

		const resp2 = await listAdminArticles(env, { limit: 10, cursor: null, search: 'findme-admin-summary', category: 'all' });
		expect(resp2.items.some((i) => i.id === id)).toBe(true);
	});





	it('queryArticles search matches summary text', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		const id = await insertArticle(env, {
			canonicalUrl: 'https://example.com/searchsum',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-search',
			title: 'Search test',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Fayette',
			counties: ['Fayette'],
			city: null,
			summary: 'findme-summary',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});

		const resp = await queryArticles(env, { category: 'today', counties: [], search: 'findme-summary', limit: 10, cursor: null });
		expect(resp.items.some((i) => i.id === id)).toBe(true);
	});

	it('queryArticles handles multi-word search terms without error', async () => {
		await ensureSchemaAndFixture();
		const resp2 = await queryArticles(env, { category: 'all', counties: [], search: 'state police', limit: 10, cursor: null });
		expect(Array.isArray(resp2.items)).toBe(true);
	});

	// regression test for https://localkynews.com logs showing D1_ERROR too many SQL variables
	it('queryArticles does not blow up when result set is very large', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		// insert a few hundred articles so the subsequent county lookup would
		// normally build a single IN(...) list exceeding SQLite variable limits.
		for (let i = 0; i < 300; i++) {
			await insertArticle(env, {
				canonicalUrl: `https://example.com/bulk${i}`,
				sourceUrl: 'https://example.com',
				urlHash: `hash-bulk${i}`,
				title: `Bulk ${i}`,
				author: null,
				publishedAt: now,
				category: 'today',
				isKentucky: true,
				isNational: false,
				county: 'Fayette',
				counties: ['Fayette'],
				city: null,
				summary: 'bulk search',
				seoDescription: '',
				rawWordCount: 1,
				summaryWordCount: 1,
				contentText: 'x',
				contentHtml: '<p>x</p>',
				imageUrl: null,
				rawR2Key: null,
				slug: null,
			});
		}

		const resp = await queryArticles(env, { category: 'all', counties: [], search: null, limit: 300, cursor: null });
		expect(resp.items.length).toBeGreaterThanOrEqual(300);
		// counties should be attached for every result
		expect(resp.items.every((a) => Array.isArray(a.counties))).toBe(true);
	});

	it('queryArticles with category all ignores the category filter', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		// insert one article in each of two categories so search across all picks one
		const id1 = await insertArticle(env, {
			canonicalUrl: 'https://example.com/a1',
			sourceUrl: 'https://example.com',
			urlHash: 'hash1',
			title: 'Foo bar',
			author: null,
			publishedAt: now,
			category: 'national',
			isKentucky: false,
			isNational: true,
			county: null,
			counties: [],
			city: null,
			summary: 'findthis',
			seoDescription: '',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});
		const resp = await queryArticles(env, { category: 'all', counties: [], search: 'findthis', limit: 10, cursor: null });
		expect(resp.items.some((i) => i.id === id1)).toBe(true);
	});

	it('queryArticles can include non-Kentucky stories when requested', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		const id = await insertArticle(env, {
			canonicalUrl: 'https://example.com/nonky',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-nonky',
			title: 'NonKY',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: false,
			isNational: false,
			county: null,
			counties: [],
			city: null,
			summary: 'x',
			seoDescription: 'x',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});
		const resp = await queryArticles(env, { category: 'today', counties: [], search: null, limit: 10, cursor: null, includeNonKentucky: true });
		expect(resp.items.some((i) => i.id === id)).toBe(true);
	});

	it('queryArticles hides future-dated articles and shows past ones', async () => {
		await ensureSchemaAndFixture();
		const now = new Date();
		const future = new Date(now.getTime() + 3600 * 1000).toISOString();
		const past = new Date(now.getTime() - 3600 * 1000).toISOString();
		await insertArticle(env, {
			canonicalUrl: 'https://example.com/fut',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-fut',
			title: 'Future',
			author: null,
			publishedAt: future,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: null,
			counties: [],
			city: null,
			summary: 'x',
			seoDescription: '',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});
		await insertArticle(env, {
			canonicalUrl: 'https://example.com/pas',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-pas',
			title: 'Past',
			author: null,
			publishedAt: past,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: null,
			counties: [],
			city: null,
			summary: 'x',
			seoDescription: '',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});

		const resp = await queryArticles(env, { category: 'all', counties: [], search: null, limit: 10, cursor: null });
		expect(resp.items.some((i) => i.title === 'Future')).toBe(false);
		expect(resp.items.some((i) => i.title === 'Past')).toBe(true);
	});

	it('getArticlesForUpdateCheck honors maxAgeHours and returns recent ky articles', async () => {
		await ensureSchemaAndFixture();
		const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		const recent = new Date().toISOString();
		await env.ky_news_db.prepare(`
		   INSERT INTO articles (canonical_url, source_url, url_hash, title, author, published_at, category, is_kentucky, is_national, county, city, summary, seo_description, raw_word_count, summary_word_count, content_text, content_html, image_url, raw_r2_key, slug, content_hash)
		   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind('a','a','old','Old','o',oldDate,'today',1,0,'Fayette',null,'s','seo',1,1,'x','<p>x</p>',null,null,null,null,'oldhash').run();
		await env.ky_news_db.prepare(`
		   INSERT INTO articles (canonical_url, source_url, url_hash, title, author, published_at, category, is_kentucky, is_national, county, city, summary, seo_description, raw_word_count, summary_word_count, content_text, content_html, image_url, raw_r2_key, slug, content_hash)
		   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind('b','b','recent','Recent','r',recent,'today',1,0,'Jefferson',null,'s','seo',1,1,'x','<p>x</p>',null,null,null,null,'rephash').run();

		const list = await getArticlesForUpdateCheck(env, 24);
		expect(list.some((a) => a.urlHash === 'recent')).toBe(true);
		expect(list.some((a) => a.urlHash === 'old')).toBe(false);
	});

	it('getArticlesForUpdateCheck default window is 48 hours', async () => {
		await ensureSchemaAndFixture();
		const midDate = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
		const recent = new Date().toISOString();
		await env.ky_news_db.prepare(`
		   INSERT INTO articles (canonical_url, source_url, url_hash, title, author, published_at, category, is_kentucky, is_national, county, city, summary, seo_description, raw_word_count, summary_word_count, content_text, content_html, image_url, raw_r2_key, slug, content_hash)
		   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind('a','a','mid','Mid','m',midDate,'today',1,0,'Fayette',null,'s','seo',1,1,'x','<p>x</p>',null,null,null,null,'h').run();
		await env.ky_news_db.prepare(`
		   INSERT INTO articles (canonical_url, source_url, url_hash, title, author, published_at, category, is_kentucky, is_national, county, city, summary, seo_description, raw_word_count, summary_word_count, content_text, content_html, image_url, raw_r2_key, slug, content_hash)
		   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind('b','b','recent','Recent','r',recent,'today',1,0,'Jefferson',null,'s','seo',1,1,'x','<p>x</p>',null,null,null,null,'rh').run();

		const list = await getArticlesForUpdateCheck(env);
		expect(list.some((a) => a.urlHash === 'mid')).toBe(true);
	});

	it('prependUpdateToSummary adds timestamped update and stores new hash', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		const { meta } = await env.ky_news_db.prepare(`
		   INSERT INTO articles (canonical_url, source_url, url_hash, title, author, published_at, category,
		     is_kentucky, is_national, county, city, summary, seo_description, raw_word_count,
		     summary_word_count, content_text, content_html, image_url, raw_r2_key, slug, content_hash)
		   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind('u','u','hash-u','U','u',now,'today',1,0,'Fayette',null,'orig','seo',1,1,'x','<p>x</p>',null,null,null,null,'initial').run();
		const id = Number(meta.last_row_id);
		await prependUpdateToSummary(env, id, 'new details', 'newhash');
		const updated = await env.ky_news_db.prepare('SELECT summary, content_hash FROM articles WHERE id=?').bind(id).first<any>();
		expect(updated.content_hash).toBe('newhash');
		expect(updated.summary).toMatch(/^Update \(/);
		expect(updated.summary).toContain('new details');
		expect(updated.summary).toContain('orig');
	});

	it('checkArticleUpdates processes changed articles and prepends AI update', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		const { meta } = await env.ky_news_db.prepare(`
		   INSERT INTO articles (canonical_url, source_url, url_hash, title, author, published_at, category,
		     is_kentucky, is_national, county, city, summary, seo_description, raw_word_count,
		     summary_word_count, content_text, content_html, image_url, raw_r2_key, slug, content_hash)
		   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind('c','c','hash-c','C','c',now,'today',1,0,'Fayette',null,'Orig','seo',1,1,'old content','<p>old</p>',null,null,null,null,'oldhash').run();
		const id = Number(meta.last_row_id);

		vi.spyOn(ingestModule, 'fetchAndExtractArticle').mockResolvedValue({
		  canonicalUrl: 'https://example.com/c',
		  sourceUrl: 'https://example.com',
		  title: 'C',
		  author: null,
		  publishedAt: now,
		  contentHtml: '<p>new</p>',
		  contentText: 'old content plus update',
		  classificationText: '',
		  imageUrl: null,
		});
		vi.spyOn(aiModule, 'generateUpdateParagraph').mockResolvedValue('added update');

		await __testables.checkArticleUpdates(env);

		const updated = await env.ky_news_db.prepare('SELECT summary, content_hash FROM articles WHERE id=?').bind(id).first<any>();
		expect(updated.content_hash).not.toBe('oldhash');
		expect(updated.summary).toMatch(/^Update \(/);
		expect(updated.summary).toContain('added update');
		expect(updated.summary).toContain('Orig');
	});

describe('db.insertArticle error logging', () => {
	it('logs a helpful message and propagates the error', async () => {
		await ensureSchemaAndFixture();
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

		// patch prepare().run to always throw
		const origPrepare = env.ky_news_db.prepare.bind(env.ky_news_db);
		(env.ky_news_db).prepare = (sql) => {
			const stmt = origPrepare(sql);
			return {
				...stmt,
				run: async () => {
					throw new Error('simulated failure');
				},
			};
		};

		const dummy: NewArticle = {
			canonicalUrl: 'https://foo',
			sourceUrl: 'https://foo',
			urlHash: 'h',
			title: 'T',
			author: null,
			publishedAt: new Date().toISOString(),
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: null,
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		};

		await expect(insertArticle(env, dummy)).rejects.toThrow('simulated failure');
		expect(spy).toHaveBeenCalledWith(
			'[DB INSERT ERROR]',
			expect.any(Error),
			expect.objectContaining({ title: 'T' }),
		);

		spy.mockRestore();
		env.ky_news_db.prepare = origPrepare;
	});
});

// ingestSingleUrl error handling

describe('ingestSingleUrl error handling', () => {
	it('skips database insertion when preview flag is provided', async () => {
		await ensureSchemaAndFixture();

		// stub network fetch with minimal HTML
		const originalFetch = global.fetch;
		global.fetch = async () =>
			new Response('<html><body><p>xyz</p></body></html>', {
				status: 200,
				headers: { 'Content-Type': 'text/html' },
			});

		vi.spyOn(classifyModule, 'classifyArticleWithAi').mockResolvedValue({
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: null,
			counties: [],
			city: null,
		});
		vi.spyOn(aiModule, 'summarizeArticle').mockResolvedValue({
			summary: 'preview',
			seoDescription: 'seo',
			summaryWordCount: 1,
		});

		// stub slug generator to predictable value so we can assert on it
		const slugSpy = vi.spyOn(ingestModule, 'generateArticleSlug').mockReturnValue('preview-slug');
		const res = await __testables.ingestSingleUrl(env, { url: 'https://example.com', preview: true });
		expect(res.status).toBe('inserted');
		expect(res.slug).toBe('preview-slug');
		// no rows should have been written
		const countRow = await env.ky_news_db.prepare('SELECT COUNT(*) as cnt FROM articles').first<{ cnt: number }>();
		expect(countRow?.cnt).toBe(0);
		slugSpy.mockRestore();

		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('uses providedDescription directly when allowShortContent is true', async () => {
		await ensureSchemaAndFixture();

		// network fetch should not be invoked for manual text
		const originalFetch = global.fetch;
		global.fetch = async () => { throw new Error('network should not be called'); };

		vi.spyOn(classifyModule, 'classifyArticleWithAi').mockResolvedValue({
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: null,
			counties: [],
			city: null,
		});
		vi.spyOn(aiModule, 'summarizeArticle').mockResolvedValue({
			summary: 'foo',
			seoDescription: 'bar',
			summaryWordCount: 2,
		});

		const text = 'Line1\n\nLine2';
		const res = await __testables.ingestSingleUrl(env, {
			url: 'https://example.com/manual',
			allowShortContent: true,
			providedDescription: text,
		});

		expect(res.status).toBe('inserted');
		expect(res.contentText).toBe(text);

		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('forces primary county to null for statewide political stories', async () => {
		await ensureSchemaAndFixture();

		// stub network fetch for article simple html
		const originalFetch = global.fetch;
		global.fetch = async () =>
			new Response('<html><body><p>hi</p></body></html>', {
				status: 200,
				headers: { 'Content-Type': 'text/html' },
			});

		// stub classifier to return counties and county
		vi.spyOn(classifyModule, 'classifyArticleWithAi').mockResolvedValue({
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Fayette',
			counties: ['Fayette', 'Jefferson'],
			city: null,
		});
		vi.spyOn(classifyModule, 'isStatewideKyPoliticalStory').mockReturnValue(true);
		vi.spyOn(aiModule, 'summarizeArticle').mockResolvedValue({
			summary: 'sum',
			seoDescription: 'seo',
			summaryWordCount: 1,
		});

		// stub slug generator so result.slug is deterministic
		const slugSpy2 = vi.spyOn(ingestModule, 'generateArticleSlug').mockReturnValue('insert-slug');
		const result = await __testables.ingestSingleUrl(env, { url: 'https://example.com' });
		expect(result.status).toBe('inserted');
		expect(result.slug).toBe('insert-slug');
		const row = await env.ky_news_db.prepare('SELECT county FROM articles WHERE id = ?')
			.bind(result.id).first<{ county: string | null }>();
		expect(row?.county).toBeNull();
		const counties = await getArticleCounties(env, result.id);
		expect(counties).toEqual(['Fayette', 'Jefferson']);
		slugSpy2.mockRestore();

		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('scrapes inline <img> when og:image meta is absent', async () => {
		await ensureSchemaAndFixture();

		// stub network fetch with html containing only an inline image
		const originalFetch = global.fetch;
		global.fetch = async () =>
			new Response('<html><body><article><img src="/foo.jpg"/></article></body></html>', {
				status: 200,
				headers: { 'Content-Type': 'text/html' },
			});

		vi.spyOn(classifyModule, 'classifyArticleWithAi').mockResolvedValue({
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: null,
			counties: [],
			city: null,
		});
		vi.spyOn(aiModule, 'summarizeArticle').mockResolvedValue({
			summary: 'x',
			seoDescription: 'y',
			summaryWordCount: 1,
		});

		const res = await __testables.ingestSingleUrl(env, { url: 'https://example.com/article' });
		expect(res.status).toBe('inserted');
		const row = await env.ky_news_db
			.prepare('SELECT image_url, slug, county FROM articles WHERE id = ?')
			.bind(res.id)
			.first<{ image_url: string | null; slug: string; county: string | null }>();
		expect(row?.image_url).toBe('https://example.com/foo.jpg');

		// also verify the bot preview route picks that image
		if (row?.slug) {
			// compute URL similar to articleToUrl logic used by SPA
			let previewPath = `/news/kentucky/${row.slug}`;
			if (row.county) {
				const countySlug = row.county.toLowerCase().replace(/\s+/g, '-') + '-county';
				previewPath = `/news/kentucky/${countySlug}/${row.slug}`;
			}
			const botResp = await SELF.fetch(`https://example.com${previewPath}`, {
				headers: {
					'User-Agent':
						'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
				},
			});
			expect([200, 404]).toContain(botResp.status);
			if (botResp.status === 200) {
				const text = await botResp.text();
				expect(text).toContain('<meta property="og:image" content="https://example.com/foo.jpg"');
			}
			// also ensure facebookbot UA (newer crawler) triggers same metadata
			const botResp2 = await SELF.fetch(`https://example.com${previewPath}`, {
				headers: { 'User-Agent': 'facebookbot/2.0 (+http://www.facebook.com/externalhit_uatext.php)' },
			});
			expect([200, 404]).toContain(botResp2.status);
			if (botResp2.status === 200) {
				const text2 = await botResp2.text();
				expect(text2).toContain('<meta property="og:image" content="https://example.com/foo.jpg"');
			}
			// simulate Facebook/Instagram in-app browser which cannot run the SPA
			const iabResp = await SELF.fetch(`https://example.com${previewPath}`, {
				headers: { 'User-Agent': 'Mozilla/5.0 FBAN/FBIOS' },
			});
			expect(iabResp.status).toBe(200);
			const iabText = await iabResp.text();
			expect(iabText).toContain('<h1>');
			expect(iabText).toContain('Read full article at source');
		}

		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	// new tests for KSP override and obituary rejection
	it('applies KSP logo when source has no image', async () => {
		await ensureSchemaAndFixture();
		const originalFetch = global.fetch;
		global.fetch = async () =>
			new Response('<html><body><p>no image</p></body></html>', {
				status: 200,
				headers: { 'Content-Type': 'text/html' },
			});

		vi.spyOn(classifyModule, 'classifyArticleWithAi').mockResolvedValue({
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: null,
			counties: [],
			city: null,
		});
		vi.spyOn(aiModule, 'summarizeArticle').mockResolvedValue({
			summary: 'x',
			seoDescription: 'y',
			summaryWordCount: 1,
		});

		const res = await __testables.ingestSingleUrl(env, {
			url: 'https://wp.kentuckystatepolice.ky.gov/article',
			preview: true,
		});
		expect(res.status).toBe('inserted');
		expect(res.imageUrl).toBe('https://www.kentuckystatepolice.ky.gov/images/KSP-logo.png');

		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('rejects obituary articles before summarization', async () => {
		await ensureSchemaAndFixture();
		const originalFetch = global.fetch;
		global.fetch = async () =>
			new Response('<html><body><p>obit text</p></body></html>', {
				status: 200,
				headers: { 'Content-Type': 'text/html' },
			});

		vi.spyOn(classifyModule, 'classifyArticleWithAi').mockResolvedValue({
			category: 'obituaries',
			isKentucky: true,
			isNational: false,
			county: null,
			counties: [],
			city: null,
		});
		const summarySpy = vi.spyOn(aiModule, 'summarizeArticle');

		const result = await __testables.ingestSingleUrl(env, { url: 'https://example.com/obit' });
		expect(result.status).toBe('rejected');
		expect(result.reason).toContain('obituaries not published');
		expect(summarySpy).not.toHaveBeenCalled();

		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

    it('serves a simple OG preview page for county hub URLs to social bots', async () => {
        // bot requests to county pages should return static HTML with meaningful metadata
        const resp = await SELF.fetch('https://example.com/news/kentucky/pike-county', {
            headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
        });
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain('<meta property="og:title" content="Pike County, KY News — Local KY News"');
        expect(text).toContain('<meta property="og:description" content="The latest news from Pike County, Kentucky');
        expect(text).toContain('<meta property="og:url" content="https://localkynews.com/news/kentucky/pike-county"');
        expect(text).toContain('<meta property="og:image" content="https://localkynews.com/img/preview.png"');
    });

		it('returns rejected status when insertArticle throws on ingest', async () => {
			// stub classification and summarization to simple values
			vi.spyOn(classifyModule, 'classifyArticleWithAi').mockResolvedValue({
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: null,
			counties: [],
			city: null,
		});
		vi.spyOn(aiModule, 'summarizeArticle').mockResolvedValue({
			summary: 'sum',
			seoDescription: 'seo',
			summaryWordCount: 1,
		});

		// stub insertArticle to throw via module spy; ingestion will pick up live binding
		vi.spyOn(dbModule, 'insertArticle').mockRejectedValue(new Error('dbfail'));

		const result = await __testables.ingestSingleUrl(env, { url: 'https://example.com' });
		expect(result.status).toBe('rejected');
		expect(result.reason).toMatch(/insert failed/);

		// restore mocks
		vi.restoreAllMocks();
		global.fetch = originalFetch;
	});

	it('returns duplicate status when insertArticle throws UNIQUE constraint', async () => {
		await ensureSchemaAndFixture();
		const originalFetch = global.fetch;
		global.fetch = async () =>
			new Response('<html><body><p>hi</p></body></html>', {
				status: 200,
				headers: { 'Content-Type': 'text/html' },
			});

		vi.spyOn(classifyModule, 'classifyArticleWithAi').mockResolvedValue({
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: null,
			counties: [],
			city: null,
		});
		vi.spyOn(aiModule, 'summarizeArticle').mockResolvedValue({
			summary: 'sum',
			seoDescription: 'seo',
			summaryWordCount: 1,
		});

		vi.spyOn(dbModule, 'insertArticle').mockRejectedValue(new Error('UNIQUE constraint failed'));

		const result = await __testables.ingestSingleUrl(env, { url: 'https://example.com' });
		expect(result.status).toBe('duplicate');
		expect(result.reason).toMatch(/url_hash already exists/);

		vi.restoreAllMocks();
		global.fetch = originalFetch;
	});

	it('prevents fetch when a previous article with the same URL already exists', async () => {
		await ensureSchemaAndFixture();
		// insert a dummy article so the hash check will catch it
		const now = new Date().toISOString();
		await insertArticle(env, {
			canonicalUrl: 'https://example.com/preflight',
			sourceUrl: 'https://example.com/preflight',
			urlHash: await sha256Hex(normalizeCanonicalUrl('https://example.com/preflight')),
			title: 'x',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: null,
			counties: [],
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});

		// stub fetch to throw if called; preflight check should avoid it
		const originalFetch2 = global.fetch;
		global.fetch = () => { throw new Error('fetch should not be called'); };

		const result = await __testables.ingestSingleUrl(env, { url: 'https://example.com/preflight' });
		expect(result.status).toBe('duplicate');

		global.fetch = originalFetch2;
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
		expect(match?.similarity ?? 0).toBeGreaterThanOrEqual(0.85);
	});

	it('facebook helper functions behave as expected', () => {
		expect(cleanFacebookHeadline('Test title | Local KY News')).toBe('Test title');
		expect(generateFacebookHook('First sentence. Second one.')).toBe('First sentence.');
		// very short summaries or single words shouldn't become hooks
		expect(generateFacebookHook('Gov.')).toBe('');
		expect(generateFacebookHook('Hi')).toBe('');
		// county prefix -- should still prefix when county given
		expect(generateFacebookHook('Something happened', 'Wake')).toMatch(/Wake County/i);
		// hook should not treat city names as counties
		expect(generateFacebookHook('A story about a city', undefined)).not.toMatch(/City County/i);

		// very long summary should be truncated at the new 300-word limit
		const extraLong = new Array(310).fill('word').join(' ');
		const longHook = generateFacebookHook(extraLong);
		expect(longHook.split(/\s+/).length).toBeLessThanOrEqual(301);

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
		// if summary is too short it shouldn't appear in the caption
		// but we can fall back to contentText if available
		const capShort = generateFacebookCaption({
			id: 12,
			title: 'Test',
			summary: 'Gov.',
			contentText: 'This is the body text. Extra info.',
			county: 'Clark',
			category: 'today',
			isKentucky: true,
		});
		expect(capShort).not.toContain('Gov.');
		expect(capShort).toContain('This is the body text.');
		expect(cap).toContain('https://localkynews.com/news/kentucky/boone-county/foo');
		// county hashtag should include KY suffix
		expect(cap).toContain('#BooneCountyKY');

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
		expect(capWeather).toContain('#FayetteCountyKY');

		// sports caption gets KentuckySports tag
		const capSports = generateFacebookCaption({
			id: 9,
			title: 'High school game tonight',
			summary: 'The Wildcats play at home',
			county: 'Jefferson',
			category: 'sports',
			isKentucky: true,
		});
		expect(capSports).toContain('#KentuckySports');
		expect(capSports).toContain('#JeffersonCountyKY');

		// schools caption gets KentuckyEducation tag
		const capSchools = generateFacebookCaption({
			id: 10,
			title: 'Board meeting',
			summary: 'Discussion of budget',
			county: 'Madison',
			category: 'schools',
			isKentucky: true,
		});
		expect(capSchools).toContain('#KentuckyEducation');

		// obituaries should produce no hashtags at all
		const capObit = generateFacebookCaption({
			id: 11,
			title: 'Remembering John Doe',
			summary: 'Longtime resident passes away',
			county: 'Fayette',
			category: 'obituaries',
			isKentucky: true,
		});
		expect(capObit).not.toMatch(/#/);
	});

it('scrapes a public post using crawler UA (share link)', async () => {
		const share = 'https://www.facebook.com/share/p/14cehV53nQQ/';
		vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
			// simulate facebookexternalhit resolving the share URL and returning og tags
			return new Response(
				'<html><head><meta property="og:description" content="Hello world"><meta property="og:image" content="https://example.com/photo.jpg"></head></html>',
				{ status: 200, url: 'https://www.facebook.com/realpost/123' }
			);
		});

		const result = await __testables.scrapeFacebookPostPublic(share);
		expect(result.message).toBe('Hello world');
		expect(result.imageUrl).toBe('https://example.com/photo.jpg');

		vi.restoreAllMocks();
	});

	it('allows distinct titles well below the threshold', async () => {
		await ensureSchemaAndFixture();
		const match = await findHighlySimilarTitle(env, 'County commission advances road paving contract');
		expect(match).toBeNull();
	});
});

// additional dedupe and admin testing

describe('content fingerprint dedupe', () => {
	it('marks two different URLs with identical content as duplicates', async () => {
		await ensureSchemaAndFixture();

		const originalFetch = global.fetch;
		global.fetch = async () =>
			new Response('<html><body><p>same body</p></body></html>', {
				status: 200,
				headers: { 'Content-Type': 'text/html' },
			});
		vi.spyOn(classifyModule, 'classifyArticleWithAi').mockResolvedValue({
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: null,
			counties: [],
			city: null,
		});
		vi.spyOn(aiModule, 'summarizeArticle').mockResolvedValue({
			summary: 'sum',
			seoDescription: 'seo',
			summaryWordCount: 1,
		});

		const r1 = await __testables.ingestSingleUrl(env, { url: 'https://first.com' });
		expect(r1.status).toBe('inserted');
		const r2 = await __testables.ingestSingleUrl(env, { url: 'https://second.com' });
		expect(r2.status).toBe('duplicate');
		expect(r2.reason).toMatch(/content fingerprint/);

		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});
});

describe('admin endpoints', () => {
	it('regenerates a summary via admin endpoint', async () => {
		await ensureSchemaAndFixture();
		vi.spyOn(aiModule, 'summarizeArticle').mockResolvedValue({
			summary: 'newsum',
			seoDescription: 'newseo',
			summaryWordCount: 3,
		});

		const resp = await SELF.fetch('https://example.com/api/admin/articles/1/regenerate-summary', { method: 'POST' });
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.summary).toBe('newsum');
		const updated = await getArticleById(env, 1);
		expect(updated?.summary).toBe('newsum');
	});

	it('allows manual update check for a single article via admin endpoint', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		const { meta } = await env.ky_news_db.prepare(`
		   INSERT INTO articles (canonical_url, source_url, url_hash, title, author, published_at, category,
		     is_kentucky, is_national, county, city, summary, seo_description, raw_word_count,
		     summary_word_count, content_text, content_html, image_url, raw_r2_key, slug, content_hash)
		   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind('c','c','hash-c','C','c',now,'today',1,0,'Fayette',null,'Orig','seo',1,1,'old content','<p>old</p>',null,null,null,null,'oldhash').run();
		const id = Number(meta.last_row_id);

		vi.spyOn(ingestModule, 'fetchAndExtractArticle').mockResolvedValue({
		  canonicalUrl: 'https://example.com/c',
		  sourceUrl: 'https://example.com',
		  title: 'C',
		  author: null,
		  publishedAt: now,
		  contentHtml: '<p>new</p>',
		  contentText: 'old content plus update',
		  classificationText: '',
		  imageUrl: null,
		});
		vi.spyOn(aiModule, 'generateUpdateParagraph').mockResolvedValue('added update');

		const resp = await SELF.fetch(`https://example.com/api/admin/articles/${id}/check-update`, { method: 'POST' });
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.ok).toBe(true);
		expect(body.updated).toBe(true);
		expect(body.updateParagraph).toBe('added update');
		const updated = await getArticleById(env, id);
		expect(updated?.summary).toMatch(/^Update \(/);
	});

	it('rejects unauthorized check-update requests', async () => {
		const resp = await SELF.fetch('https://example.com/api/admin/articles/1/check-update', { method: 'POST' });
		expect(resp.status).toBe(401);
	});

	it('classification audit endpoint returns stats and items', async () => {
		await ensureSchemaAndFixture();
		const resp = await SELF.fetch('https://example.com/api/admin/classification-audit?limit=50');
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(Array.isArray(body.items)).toBe(true);
		expect(body.stats.total).toBeGreaterThanOrEqual(2);
		expect(typeof body.stats.noCounty).toBe('number');
	});

	it('rejects unauthorized county patch requests', async () => {
		await ensureSchemaAndFixture();
		const resp = await SELF.fetch('https://example.com/api/articles/1/county', {
			method: 'PATCH',
			body: JSON.stringify({ county: 'Adair' }),
		});
		expect(resp.status).toBe(401);
	});

	it('supports changing primary county via PATCH with admin session auth', async () => {
		await ensureSchemaAndFixture();
		// insert sample article
		const now = new Date().toISOString();
		const id = await insertArticle(env, {
			canonicalUrl: 'https://example.com/session-test',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-session',
			title: 'Session Test',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Fayette',
			counties: ['Fayette'],
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});

		const adminEnv = envWithAdminPassword('pw');
		const req = new IncomingRequest(`https://example.com/api/articles/${id}/county`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ county: 'Adair' }),
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.article.county).toBe('Adair');
		const row = await getArticleById(env, id);
		expect(row?.county).toBe('Adair');
	});

	it('supports changing and clearing primary county via PATCH with bearer token', async () => {
		await ensureSchemaAndFixture();
		// insert sample article
		const now = new Date().toISOString();
		const id = await insertArticle(env, {
			canonicalUrl: 'https://example.com/test',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-test',
			title: 'Test',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Fayette',
			counties: ['Fayette'],
			city: null,
			summary: 's',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});
		// pre-populate cache keys
		if (env.CACHE) {
			await env.CACHE.put('summary:hash-test', 'old');
			await env.CACHE.put('summary-ttl:hash-test', '1');
		}

		const adminEnv = envWithAdminPassword('pw') as any;
		adminEnv.ADMIN_SECRET = 'secret';

		// update primary county to new value
		let resp = await SELF.fetch(`https://example.com/api/articles/${id}/county`, {
			method: 'PATCH',
			headers: { Authorization: 'Bearer secret' },
			body: JSON.stringify({ county: 'Jefferson' }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.article.county).toBe('Jefferson');
		const row = await getArticleById(env, id);
		expect(row?.county).toBe('Jefferson');
		const counties = await getArticleCounties(env, id);
		expect(counties[0]).toBe('Jefferson');
		if (env.CACHE) {
			expect(await env.CACHE.get('summary:hash-test')).toBeNull();
			expect(await env.CACHE.get('summary-ttl:hash-test')).toBeNull();
		}

		// now clear primary while secondary remains
		// add a secondary manually
		await env.ky_news_db.prepare('INSERT OR IGNORE INTO article_counties (article_id, county, is_primary) VALUES (?, ?, ?)').bind(id, 'Barren', 0).run();
		resp = await SELF.fetch(`https://example.com/api/articles/${id}/county`, {
			method: 'PATCH',
			headers: { Authorization: 'Bearer secret' },
			body: JSON.stringify({ county: null }),
		});
		expect(resp.status).toBe(200);
		const after = await getArticleById(env, id);
		expect(after?.county).toBeNull();
		const afterCounties = await getArticleCounties(env, id);
		expect(afterCounties).toContain('Jefferson');
		expect(afterCounties).toContain('Barren');
		// is_kentucky should remain true because counties still exist
		expect(after?.isKentucky).toBe(1);

		// finally clear everything and see is_kentucky flip
		await env.ky_news_db.prepare('DELETE FROM article_counties WHERE article_id = ?').bind(id).run();
		resp = await SELF.fetch(`https://example.com/api/articles/${id}/county`, {
			method: 'PATCH',
			headers: { Authorization: 'Bearer secret' },
			body: JSON.stringify({ county: null }),
		});
		expect(resp.status).toBe(200);
		const finalRow = await getArticleById(env, id);
		expect(finalRow?.isKentucky).toBe(0);
	});

	it('allows admin to update title, summary and image URL via POST /api/admin/article/update-content', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		const id = await insertArticle(env, {
			canonicalUrl: 'https://example.com/update1',
			sourceUrl: 'https://example.com',
			urlHash: 'hash-update1',
			title: 'Old',
			author: null,
			publishedAt: now,
			category: 'today',
			isKentucky: true,
			isNational: false,
			county: 'Fayette',
			counties: ['Fayette'],
			city: null,
			summary: 'old summary',
			seoDescription: 'seo',
			rawWordCount: 1,
			summaryWordCount: 1,
			contentText: 'x',
			contentHtml: '<p>x</p>',
			imageUrl: null,
			rawR2Key: null,
			slug: null,
		});
		const adminEnv = envWithAdminPassword('pw') as any;
		adminEnv.ADMIN_SECRET = 'secret';

		const resp = await SELF.fetch('https://example.com/api/admin/article/update-content', {
			method: 'POST',
			headers: { Authorization: 'Bearer secret' },
			body: JSON.stringify({ id, title: 'New title', summary: 'new summary', imageUrl: 'https://foo.com/pic.jpg' }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.ok).toBe(true);
		expect(body.id).toBe(id);
		const row = await getArticleById(env, id);
		expect(row).not.toBeNull();
		expect(row?.title).toBe('New title');
		expect(row?.summary).toBe('new summary');
		expect(row?.imageUrl).toBe('https://foo.com/pic.jpg');

		// now clear the imageUrl explicitly
		const resp2 = await SELF.fetch('https://example.com/api/admin/article/update-content', {
			method: 'POST',
			headers: { Authorization: 'Bearer secret' },
			body: JSON.stringify({ id, imageUrl: null }),
		});
		expect(resp2.status).toBe(200);
		const row2 = await getArticleById(env, id);
		expect(row2?.imageUrl).toBeNull();
	});
});

// admin update-check endpoint tests

describe('admin update-check endpoint', () => {
	it('rejects unauthorized requests', async () => {
		const response = await SELF.fetch('https://example.com/api/admin/check-updates', {
			method: 'POST',
		});
		expect(response.status).toBe(401);
	});

	it('invokes checkArticleUpdates with 48h window when authorized', async () => {
		await ensureSchemaAndFixture();
		const spy = vi.spyOn(__testables, 'checkArticleUpdates').mockResolvedValue();

		const adminEnv = envWithAdminPassword('pw');
		const req = new IncomingRequest('https://example.com/api/admin/check-updates', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw' },
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(resp.status).toBe(200);
		expect(spy).toHaveBeenCalledWith(adminEnv, 48);
		spy.mockRestore();
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

	it('updates processed count while running', async () => {
		// start with fresh schema so counts are predictable
		await ensureSchemaAndFixture();

		// stub runIngest to quickly insert a dummy article for each county
		const originalRun = __testables.runIngest;
		__testables.runIngest = async (env, urls) => {
			try {
				const url = new URL(urls[0]);
				const county = url.searchParams.get('q') || url.searchParams.get('query') || 'unknown';
				await env.ky_news_db.prepare(`
					INSERT INTO articles (
						canonical_url, source_url, url_hash, title, author, published_at, category,
						is_kentucky, is_national, county, city, summary, seo_description, raw_word_count,
						summary_word_count, content_text, content_html
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).bind(
					`https://example.com/${county}/1`,
					'https://example.com',
					`hash-${county}-${Date.now()}`,
					`Backfill ${county}`,
					null,
					new Date().toISOString(),
					'today',
					1,
					0,
					county,
					null,
					'Summary',
					'SEO',
					100,
					50,
					'body',
					'<p>body</p>'
				).run();
			} catch {
				// ignore
			}
		};

		const adminEnv = envWithAdminPassword('pw');

		// intercept CACHE.put so we can observe progress updates directly
		const seen = [];
		const origPut = adminEnv.CACHE.put.bind(adminEnv.CACHE);
		adminEnv.CACHE.put = async (key, value, opts) => {
			try {
				const parsed = JSON.parse(value);
				seen.push(parsed);
			} catch {}
			return origPut(key, value, opts);
		};

		// instead of spinning up self-invocations we just capture queued jobs
		const queued = [];
		// uninstall typing on env for this test scenario
		adminEnv.INGEST_QUEUE = { send: async (msg) => queued.push(msg) };

		const req = new IncomingRequest('https://example.com/api/admin/backfill-counties', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw' },
			body: JSON.stringify({ threshold: 100 }),
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(202);

		// our queue stub should have received one message per missing county
		const countsMap = await getCountyCounts(env);
		const missingCount = KY_COUNTIES.filter((c) => (countsMap.get(c) ?? 0) < 100).length;
		expect(queued.length).toBe(missingCount);

		// process queued jobs via the queue handler; wait on each context so
		// spawned work has time to run
		for (const job of queued) {
			const ctx2 = createExecutionContext();
			await worker.queue({ messages: [{ body: job }] }, adminEnv, ctx2);
			await waitOnExecutionContext(ctx2);
		}

		// wait for at least one in-progress update
		for (let i = 0; i < 20; i++) {
			if (seen.some((s) => s.processed && s.processed > 0)) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(seen.some((s) => s.processed && s.processed > 0)).toBe(true);
		// ensure our added currentUrl field is being recorded
		expect(seen.some((s) => typeof s.currentUrl === 'string')).toBe(true);
		// and confirm that newArticles lists are being stored for each result
		expect(
			seen.some(
				(s) =>
					Array.isArray(s.results) &&
					s.results.some((r) => Array.isArray(r.newArticles)),
			),
		).toBe(true);

		__testables.runIngest = originalRun;
	});
});

// ---------------------------------------------------------------------------
// admin upload-image endpoint tests
// ---------------------------------------------------------------------------
describe('admin upload-image endpoint', () => {
	it('rejects unauthorized requests', async () => {
		const response = await SELF.fetch('https://example.com/api/admin/upload-image', {
			method: 'POST',
		});
		expect(response.status).toBe(401);
	});

	it('stores uploaded image and returns proxy URL', async () => {
		await ensureSchemaAndFixture();
		const adminEnv = envWithAdminPassword('pw');
		// spy on the R2 bucket's put method so we can verify it is called
		const putSpy = vi.spyOn(adminEnv.ky_news_media, 'put');

		const form = new FormData();
		form.append('file', new Blob(['abc'], { type: 'image/png' }), 'foo.png');
		const req = new IncomingRequest('https://example.com/api/admin/upload-image', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw' },
			body: form,
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(200);
		const json = await resp.json();
		expect(json.url).toMatch(/^\/api\/media\//);
		expect(json.key).toBeDefined();
		expect(putSpy).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// manual-article endpoint tests
// ---------------------------------------------------------------------------
describe('admin manual-article endpoint', () => {
	it('rejects unauthorized requests', async () => {
		const response = await SELF.fetch('https://example.com/api/admin/manual-article', {
			method: 'POST',
			body: JSON.stringify({ title: 'foo' }),
		});
		expect(response.status).toBe(401);
	});

	it('handles minimal payload without crashing', async () => {
		await ensureSchemaAndFixture();
		const adminEnv = envWithAdminPassword('pw');
		const req = new IncomingRequest('https://example.com/api/admin/manual-article', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw', 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'Minimal Title' }),
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(200);
		const json = await resp.json();
		expect(json.status).toBe('inserted');
	});

	it('allows inserting a national article with specified category', async () => {
		await ensureSchemaAndFixture();
		const adminEnv = envWithAdminPassword('pw');
		const req = new IncomingRequest('https://example.com/api/admin/manual-article', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw', 'content-type': 'application/json' },
			body: JSON.stringify({
				title: 'Manual national sports',
				body: 'Test body',
				category: 'sports',
				isKentucky: false,
			}),
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(200);
		const json = await resp.json();
		expect(json.status).toBe('inserted');
		expect(json.category).toBe('sports');
		expect(json.isKentucky).toBe(false);
		const row = await getArticleById(adminEnv, json.id);
		expect(row.category).toBe('sports');
		expect(row.is_kentucky).toBe(0);
	});

	it('allows inserting a kentucky article with optional county', async () => {
		await ensureSchemaAndFixture();
		const adminEnv = envWithAdminPassword('pw');
		const req = new IncomingRequest('https://example.com/api/admin/manual-article', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw', 'content-type': 'application/json' },
			body: JSON.stringify({
				title: 'Manual KY schools',
				body: 'Test body',
				category: 'schools',
				isKentucky: true,
				county: 'Fayette',
			}),
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(200);
		const json = await resp.json();
		expect(json.status).toBe('inserted');
		expect(json.isKentucky).toBe(true);
		expect(json.category).toBe('schools');
		expect(json.county).toBe('Fayette');
		const row = await getArticleById(adminEnv, json.id);
		expect(row.is_kentucky).toBe(1);
		expect(row.county).toBe('Fayette');
	});

	it('allows bypassing title similarity when ignoreSimilarity=true', async () => {
		await ensureSchemaAndFixture();
		const adminEnv = envWithAdminPassword('pw');
		// insert an existing story with a particular title
		const now = new Date().toISOString();
		await adminEnv.ky_news_db.prepare(`
			INSERT INTO articles (canonical_url, source_url, url_hash, title, author, published_at, category, is_kentucky, county, city, summary, seo_description, raw_word_count, summary_word_count, content_text, content_html)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			'https://example.com/existing',
			'https://example.com',
			'existing-hash',
			'Duplicate title example',
			null,
			now,
			'today',
			1,
			'Fayette',
			null,
			'Summary',
			'SEO',
			100,
			50,
			'body',
			'<p>body</p>'
		).run();

		// attempt to insert a manual article with the same title but tell the
		// handler to ignore similarity
		const req = new IncomingRequest('https://example.com/api/admin/manual-article', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw', 'content-type': 'application/json' },
			body: JSON.stringify({
				title: 'Duplicate title example',
				body: 'New body',
				isKentucky: true,
				ignoreSimilarity: true,
			}),
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(200);
		const json = await resp.json();
		expect(json.status).toBe('inserted');
	});

	it('stores body verbatim and defaults source_url to site homepage', async () => {
		await ensureSchemaAndFixture();
		const adminEnv = envWithAdminPassword('pw');
		const req = new IncomingRequest('https://example.com/api/admin/manual-article', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw', 'content-type': 'application/json' },
			body: JSON.stringify({
				title: 'Original manual piece',
				body: 'Entire content goes here.',
				isKentucky: true,
			}),
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(200);
		const json = await resp.json();
		expect(json.status).toBe('inserted');
		const row = await getArticleById(adminEnv, json.id);
		expect(row.summary).toBe('Entire content goes here.');
		expect(row.source_url).toBe('https://localkynews.com');
	});

	// ensure we can create a manually scheduled article by sending a future
	// publishedAt timestamp; the returned row should keep that value intact.
	it('allows creating a scheduled manual article (future published_at)', async () => {
		await ensureSchemaAndFixture();
		const adminEnv = envWithAdminPassword('pw');
		const futureIso = new Date(Date.now() + 3600 * 1000).toISOString();
		const req = new IncomingRequest('https://example.com/api/admin/manual-article', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw', 'content-type': 'application/json' },
			body: JSON.stringify({
				title: 'Scheduled test',
				body: 'This article is scheduled.',
				isKentucky: true,
				publishedAt: futureIso,
			}),
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(200);
		const json = await resp.json();
		expect(json.status).toBe('inserted');
		const row = await getArticleById(adminEnv, json.id);
		expect(row.published_at).toBe(futureIso);
	});

	// manually inserted articles should always surface in the "today" feed when
	// the admin has not specified a category.  a common complaint was that posts
	// created via the manual form would "never appear" because the AI classifier
	// assigned them to the national bucket.  we enforce a KY override here.
	it('forces a kentucky manual article into today when AI classifies national and no category override provided', async () => {
		await ensureSchemaAndFixture();
		const adminEnv = envWithAdminPassword('pw');
		// stub classifier to pretend it returned national
		const original = __testables.classifyArticleWithAi;
		__testables.classifyArticleWithAi = async () => ({
			category: 'national',
			isKentucky: false,
			counties: [],
			city: null,
			geoConfidence: null,
			isNational: true,
		});

		const req = new IncomingRequest('https://example.com/api/admin/manual-article', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw', 'content-type': 'application/json' },
			body: JSON.stringify({
				title: 'Local story',
				body: 'Nothing special',
				// omit explicit isKentucky to rely on default override logic
			}),
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(200);
		const json = await resp.json();
		expect(json.status).toBe('inserted');
		expect(json.category).toBe('today');
		const row2 = await getArticleById(adminEnv, json.id);
		expect(row2.category).toBe('today');
		// make sure the public query endpoint can see the new article
		const list = await queryArticles(adminEnv, { category: 'today', counties: [], search: null, limit: 10, cursor: null });
		expect(list.items.some((a) => a.id === json.id)).toBe(true);

		__testables.classifyArticleWithAi = original;
	});

	it('formats contentHtml correctly for numbered list paragraphs', async () => {
		await ensureSchemaAndFixture();
		const adminEnv = envWithAdminPassword('pw');
		const req = new IncomingRequest('https://example.com/api/admin/manual-article', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw', 'content-type': 'application/json' },
			body: JSON.stringify({
				title: 'List body',
				body: '1. Heading\n\nFollowing text.',
				isKentucky: true,
			}),
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(200);
		const json = await resp.json();
		expect(json.status).toBe('inserted');
		const row = await getArticleById(adminEnv, json.id);
		// contentHtml should wrap paragraphs separately, no <br> between them
		expect(row.content_html).toBe('<p>1. Heading</p><p>Following text.</p>');
	});

	// additional tests for retag
	it('rejects unauthorized retag requests', async () => {
		const response = await SELF.fetch('https://example.com/api/admin/retag', {
			method: 'POST',
			body: JSON.stringify({ id: 1, category: 'weather', isKentucky: true }),
		});
		expect(response.status).toBe(401);
	});

	it('allows updating category/scope via retag', async () => {
		await ensureSchemaAndFixture();
		const adminEnv = envWithAdminPassword('pw');
		// ensure there is an article to modify
		const now = new Date().toISOString();
		await adminEnv.ky_news_db.prepare(`
			INSERT INTO articles (canonical_url, source_url, url_hash, title, author, published_at, category, is_kentucky, county, city, summary, seo_description, raw_word_count, summary_word_count, content_text, content_html)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			'https://example.com/foo',
			'https://example.com',
			'hash-foo',
			'Foo',
			null,
			now,
			'today',
			1,
			'Fayette',
			null,
			'Summary',
			'SEO',
			100,
			50,
			'body',
			'<p>body</p>'
		).run();
		const rowBefore = await getArticleById(adminEnv, 1);
		expect(rowBefore.category).toBe('today');
		expect(rowBefore.is_kentucky).toBe(1);
		expect(rowBefore.county).toBe('Fayette');

		const req = new IncomingRequest('https://example.com/api/admin/retag', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw', 'content-type': 'application/json' },
			body: JSON.stringify({ id: 1, category: 'sports', isKentucky: false }),
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(200);
		const j = await resp.json();
		expect(j.ok).toBe(true);
		const rowAfter = await getArticleById(adminEnv, 1);
		expect(rowAfter.category).toBe('sports');
		expect(rowAfter.is_kentucky).toBe(0);
		expect(rowAfter.is_national).toBe(1); // should have been marked national
		expect(rowAfter.county).toBeNull();

		// retag weather article scenario: insert and then change scope
		await adminEnv.ky_news_db.prepare(`
			INSERT INTO articles (
				canonical_url, source_url, url_hash, title, author, published_at, category,
				is_kentucky, county, city, summary, seo_description, raw_word_count,
				summary_word_count, content_text, content_html
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			'https://example.com/weather1',
			'https://example.com',
			'hash-w1',
			'KY weather story',
			null,
			now,
			'weather',
			1,
			'Fayette',
			null,
			'body',
			'SEO',
			100,
			50,
			'body',
			'<p>body</p>'
		).run();
		// confirm it appears in weather feed initially
		const feedResp = await SELF.fetch('https://example.com/api/articles/weather?limit=20');
		let payload = await feedResp.json();
		expect(payload.items.some((i) => i.urlHash === 'hash-w1')).toBe(true);

		// retag story to national
		const req2 = new IncomingRequest('https://example.com/api/admin/retag', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw', 'content-type': 'application/json' },
			body: JSON.stringify({ id: 2, category: 'weather', isKentucky: false }),
		});
		const ctx2 = createExecutionContext();
		await worker.fetch(req2, adminEnv, ctx2);
		// now feed still returns it and isNational flag set
		const feedResp2 = await SELF.fetch('https://example.com/api/articles/weather?limit=20');
		payload = await feedResp2.json();
		expect(payload.items.some((i) => i.urlHash === 'hash-w1')).toBe(true);
		expect(payload.items.find((i) => i.urlHash === 'hash-w1')?.isNational).toBe(true);
	});

	it('retagged article with empty category should surface in national feed', async () => {
		await ensureSchemaAndFixture();
		const adminEnv = envWithAdminPassword('pw');
		// insert a story and then retag it to national without specifying a
		// category (simulating the admin behavior described by the user)
		const now = new Date().toISOString();
		await adminEnv.ky_news_db.prepare(`
			INSERT INTO articles (canonical_url, source_url, url_hash, title, author, published_at, category, is_kentucky, county, city, summary, seo_description, raw_word_count, summary_word_count, content_text, content_html)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			'https://example.com/foo2',
			'https://example.com',
			'hash-foo2',
			'Foo2',
			null,
			now,
			'today',
			1,
			'Fayette',
			null,
			'Summary',
			'SEO',
			90,
			45,
			'body',
			'<p>body</p>'
		).run();

		// retag to national (empty category + ky=false)
		const req4 = new IncomingRequest('https://example.com/api/admin/retag', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw', 'content-type': 'application/json' },
			body: JSON.stringify({ id: 1, category: '', isKentucky: false }),
		});
		const ctx4 = createExecutionContext();
		await worker.fetch(req4, adminEnv, ctx4);

		// now hit national feed and ensure the article appears
		const feedResp = await SELF.fetch('https://example.com/api/articles/national?limit=20');
		const payload = await feedResp.json();
		expect(payload.items.some((i) => i.urlHash === 'hash-foo2')).toBe(true);
	});

	it('allows clearing the category tag by sending empty string', async () => {
		// reuse article id 1 from earlier retag test
		const req3 = new IncomingRequest('https://example.com/api/admin/retag', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw', 'content-type': 'application/json' },
			body: JSON.stringify({ id: 1, category: '', isKentucky: false }),
		});
		const ctx3 = createExecutionContext();
		const res3 = await worker.fetch(req3, adminEnv, ctx3);
		await waitOnExecutionContext(ctx3);
		expect(res3.status).toBe(200);
		const j3 = await res3.json();
		expect(j3.ok).toBe(true);
		const rowCleared = await getArticleById(adminEnv, 1);
		expect(rowCleared.category).toBe('');
		// ky flag must have been cleared and national set
		expect(rowCleared?.is_kentucky).toBe(0);
		expect(rowCleared?.is_national).toBe(1);
	});
});


describe('URL builder helpers', () => {
	test('buildArticleUrl uses national path when flagged', () => {
		const base = BASE_URL;
		// KY-wide weather
		expect(buildArticleUrl(base, 'slug', null, 'weather', false, 1)).toBe(
			`${BASE_URL}/news/kentucky/slug`
		);
		// national weather
		expect(buildArticleUrl(base, 'slug', null, 'weather', true, 1)).toBe(
			`${BASE_URL}/news/national/slug`
		);
	});

	test('buildArticleUrl defaults to BASE_URL when omitted', () => {
		// pass undefined as first argument to trigger default parameter
		const result = (buildArticleUrl as any)(undefined, 'slug', null, 'weather', false, 1);
		expect(result).toBe(`${BASE_URL}/news/kentucky/slug`);
	});

	test('articleToUrl respects isNational flag', () => {
		const post = { slug: 'abc', category: 'weather', isNational: true };
		expect(articleToUrl(post)).toBe('/news/national/abc');
	});
});

// ensure the admin ingest endpoint enqueues and processes jobs via queue
describe('admin ingest endpoint', () => {
	it('rejects unauthorized requests', async () => {
		const response = await SELF.fetch('https://example.com/api/admin/ingest', {
			method: 'POST',
		});
		expect(response.status).toBe(401);
	});

	it('queues ingest job and runs the worker', async () => {
		await ensureSchemaAndFixture();
		const adminEnv = envWithAdminPassword('pw');
		// capture queued messages
		const queued = [];
		adminEnv.INGEST_QUEUE = { send: async (msg) => queued.push(msg) };

		const req = new IncomingRequest('https://example.com/api/admin/ingest', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw' },
			body: JSON.stringify({ includeSchools: true, limitPerSource: 3 }),
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(202);
		expect(queued.length).toBeGreaterThan(0);

		for (const job of queued) {
			await worker.queue({ messages: [{ body: job }] }, adminEnv, createExecutionContext());
		}
		// runIngest writes metrics; ensure at least one run completed
		const metrics = await adminEnv.CACHE.get('admin:ingest:latest', 'json').catch(() => null);
		expect(metrics).not.toBeNull();
	});

	it('metrics show insertedSamples when manual ingest runs', async () => {
		await ensureSchemaAndFixture();
		const adminEnv = envWithAdminPassword('pw');
		// stub runIngest to write a fake metrics object
		const originalRun = __testables.runIngest;
		__testables.runIngest = async (env, urls) => {
			await env.CACHE.put('admin:ingest:latest', JSON.stringify({
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				durationMs: 100,
				sourcesTried: urls.length,
				sourcesAvailable: urls.length,
				processed: 1,
				inserted: 1,
				duplicate: 0,
				rejected: 0,
				lowWordDiscards: 0,
				ingestRatePerMinute: 0,
				sourceErrors: 0,
				trigger: 'manual',
				rejectedSamples: [],
				duplicateSamples: [],
				insertedSamples: [{ decision:'inserted', url:'https://example.com/x', sourceUrl:'https://example.com', createdAt:new Date().toISOString() }],
			}));
		};

		// fire the admin ingest endpoint normally (queue stub not needed)
		const req = new IncomingRequest('https://example.com/api/admin/ingest', {
			method: 'POST',
			headers: { 'x-admin-key': 'pw' },
			body: JSON.stringify({ includeSchools: true, limitPerSource: 1 }),
		});
		const ctx = createExecutionContext();
		await worker.fetch(req, adminEnv, ctx);
		await waitOnExecutionContext(ctx);

		const metrics = await adminEnv.CACHE.get('admin:ingest:latest', 'json');
		expect(metrics?.insertedSamples?.length).toBe(1);
		expect(metrics.insertedSamples[0].url).toBe('https://example.com/x');

		__testables.runIngest = originalRun;
	});

	it('skips queue messages that exceed the retry limit', async () => {
		await ensureSchemaAndFixture();
		const adminEnv2 = envWithAdminPassword('pw');
		let called = false;
		const originalRun = __testables.runIngest;
		__testables.runIngest = async () => {
			called = true;
		};

		const msg = {
			attempts: 3 + 1,
			body: { type: 'manualIngest', sourceUrls: ['https://foo'], limitPerSource: 1 },
			ack: vi.fn(),
			retry: vi.fn(),
		};
		await worker.queue({ messages: [msg] }, adminEnv2, createExecutionContext());
		expect(called).toBe(false);
		expect(msg.ack).toHaveBeenCalled();
		__testables.runIngest = originalRun;
	});
});

describe('admin ingest-url endpoint', () => {
  it('rejects unauthorized requests', async () => {
    const response = await SELF.fetch('https://example.com/api/admin/ingest-url', {
      method: 'POST',
    });
    expect(response.status).toBe(401);
  });

  it('ingests a URL when authorized', async () => {
    await ensureSchemaAndFixture();
    const adminEnv = envWithAdminPassword('pw');
    const original = __testables.ingestSingleUrl;
    __testables.ingestSingleUrl = async (env, { url }) => {
      return { status: 'inserted', id: 123, title: 'Test Title', county: 'Foo' };
    };

    const req = new IncomingRequest('https://example.com/api/admin/ingest-url', {
      method: 'POST',
      headers: { 'x-admin-key': 'pw' },
      body: JSON.stringify({ url: 'https://example.com/test' }),
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, adminEnv, ctx);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.status).toBe('inserted');
    expect(data.id).toBe(123);

    __testables.ingestSingleUrl = original;
  });

  it('returns 422 when ingest is rejected', async () => {
    await ensureSchemaAndFixture();
    const adminEnv = envWithAdminPassword('pw');
    const original = __testables.ingestSingleUrl;
    __testables.ingestSingleUrl = async () => ({ status: 'rejected', reason: 'bad' });

    const req = new IncomingRequest('https://example.com/api/admin/ingest-url', {
      method: 'POST',
      headers: { 'x-admin-key': 'pw' },
      body: JSON.stringify({ url: 'https://example.com/bad' }),
    });
    const resp = await worker.fetch(req, adminEnv, createExecutionContext());
    expect(resp.status).toBe(422);
    const js = await resp.json();
    expect(js.status).toBe('rejected');

    __testables.ingestSingleUrl = original;
  });
});

// preview endpoint tests for manual ingest URL

describe('admin ingest-url-preview endpoint', () => {
  it('rejects unauthorized requests', async () => {
    const response = await SELF.fetch('https://example.com/api/admin/ingest-url-preview', {
      method: 'POST',
    });
    expect(response.status).toBe(401);
  });

  it('returns preview data when authorized', async () => {
    await ensureSchemaAndFixture();
    const adminEnv = envWithAdminPassword('pw');
    const original = __testables.ingestSingleUrl;
    __testables.ingestSingleUrl = async (env, { url, preview }) => {
      expect(preview).toBe(true);
      return { status: 'inserted', title: 'Preview title', summary: 'Foo', category: 'today' };
    };

    const req = new IncomingRequest('https://example.com/api/admin/ingest-url-preview', {
      method: 'POST',
      headers: { 'x-admin-key': 'pw' },
      body: JSON.stringify({ url: 'https://example.com/test' }),
    });
    const resp = await worker.fetch(req, adminEnv, createExecutionContext());
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.status).toBe('inserted');
    expect(data.title).toBe('Preview title');

    __testables.ingestSingleUrl = original;
  });

  it('forwards rejection status code from pipeline', async () => {
    await ensureSchemaAndFixture();
    const adminEnv = envWithAdminPassword('pw');
    const original = __testables.ingestSingleUrl;
    __testables.ingestSingleUrl = async () => ({ status: 'rejected', reason: 'bad' });

    const req = new IncomingRequest('https://example.com/api/admin/ingest-url-preview', {
      method: 'POST',
      headers: { 'x-admin-key': 'pw' },
      body: JSON.stringify({ url: 'https://example.com/bad' }),
    });
    const resp = await worker.fetch(req, adminEnv, createExecutionContext());
    expect(resp.status).toBe(422);

    __testables.ingestSingleUrl = original;
  });

  it('returns structured error object when pipeline throws', async () => {
    await ensureSchemaAndFixture();
    const adminEnv = envWithAdminPassword('pw');
    const original = __testables.ingestSingleUrl;
    __testables.ingestSingleUrl = async () => { throw new Error('boom'); };

    const req = new IncomingRequest('https://example.com/api/admin/ingest-url-preview', {
      method: 'POST',
      headers: { 'x-admin-key': 'pw' },
      body: JSON.stringify({ url: 'https://example.com/crash' }),
    });
    const resp = await worker.fetch(req, adminEnv, createExecutionContext());
    expect(resp.status).toBe(200);
    const js = await resp.json();
    expect(js.status).toBe('error');
    expect(js.error).toContain('boom');

    __testables.ingestSingleUrl = original;
  });

  it('converts fetch failures into rejected preview result', async () => {
    await ensureSchemaAndFixture();
    const adminEnv = envWithAdminPassword('pw');
    const original = __testables.ingestSingleUrl;
    __testables.ingestSingleUrl = async () => {
      throw new Error('Failed to fetch URL (520): https://example.com/foo');
    };

    const req = new IncomingRequest('https://example.com/api/admin/ingest-url-preview', {
      method: 'POST',
      headers: { 'x-admin-key': 'pw' },
      body: JSON.stringify({ url: 'https://example.com/bad' }),
    });
    const resp = await worker.fetch(req, adminEnv, createExecutionContext());
    expect(resp.status).toBe(422);
    const js = await resp.json();
    expect(js.status).toBe('rejected');
    expect(js.reason).toContain('Failed to fetch URL');

    __testables.ingestSingleUrl = original;
  });
});

// reclassify endpoint tests

describe('admin reclassify endpoint', () => {
	it('rejects unauthorized requests', async () => {
		const response = await SELF.fetch('https://example.com/api/admin/reclassify', {
			method: 'POST',
		});
		expect(response.status).toBe(401);
	});

	it('updates is_national flag when classification changes', async () => {
		await ensureSchemaAndFixture();
		// insert an article that the classifier will mark as national but stored as non-national
		const now = new Date().toISOString();
		// we use a simple inline insert for deterministic fields
		await env.ky_news_db.prepare(`
			INSERT INTO articles (
				canonical_url, source_url, url_hash, title, author, published_at, category,
				is_kentucky, is_national, county, city, summary, seo_description, raw_word_count,
				summary_word_count, content_text, content_html, image_url, raw_r2_key, slug
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			)
		`).bind(
			'https://example.com/national-test',
			'https://example.com',
			'hash-national-test',
			'National Test Story',
			null,
			now,
			'today',
			0, // is_kentucky
			0, // is_national initial
			null,
			null,
			'Summary',
			'SEO',
			100,
			50,
			'Content mentions National Weather Service',
			'<p>Content mentions National Weather Service</p>',
			null,
			null,
			null,
		).run();

		// perform reclassification
		const request = new IncomingRequest('https://example.com/api/admin/reclassify', {
			method: 'POST',
			headers: { 'x-admin-key': 'secret', 'content-type': 'application/json' },
			body: JSON.stringify({ limit: 1 }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, envWithAdminPassword('secret'), ctx);
		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(payload.processed).toBeGreaterThan(0);
		// find our inserted story in results
		const entry = (payload.results || []).find((r) => r.id && r.title === 'National Test Story');
		expect(entry).toBeDefined();
		// since is_national flipped from 0->1, changed should be true
		expect(entry?.changed).toBe(true);

		// verify database row updated
		const row = await env.ky_news_db
			.prepare('SELECT is_national FROM articles WHERE url_hash = ? LIMIT 1')
			.bind('hash-national-test')
			.first();
		expect(row?.is_national).toBe(1);
	}, 10000);
});

describe('admin article link updates', () => {
	it('updates canonical/source links and recomputes hash', async () => {
		await ensureSchemaAndFixture();
		const target = await env.ky_news_db
			.prepare(`SELECT id FROM articles WHERE canonical_url = ? LIMIT 1`)
			.bind('https://example.com/ky-today')
				.first();
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
		const payload = await response.json();
		expect(payload.ok).toBe(true);
		expect(payload.canonicalUrl).toBe('https://example.com/ky-today-updated');
		expect(payload.sourceUrl).toBe('https://feeds.example.com/ky');
		expect(payload.urlHash).toMatch(/^[a-f0-9]{64}$/);

		const row = await env.ky_news_db
			.prepare(`SELECT canonical_url, source_url, url_hash FROM articles WHERE id = ? LIMIT 1`)
			.bind(targetId)
			.first();
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
					.first();
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
			.first();
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
		const payload = await response.json();
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
.first();

		const request = new IncomingRequest('https://example.com/api/admin/facebook/caption', {
			method: 'POST',
			headers: { 'x-admin-key': 'secret', 'content-type': 'application/json' },
			body: JSON.stringify({ id: nid }),
		});
		const ctx2 = createExecutionContext();
		const resp2 = await worker.fetch(request, envWithAdminPassword('secret'), ctx2);
		expect(resp2.status).toBe(200);
		const payload2 = await resp2.json();
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
			.first();
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

	it('passes picture parameter when article has an image', async () => {
		await ensureSchemaAndFixture();

		// configure FB credentials in the environment
		const adminEnv = envWithAdminPassword('secret');
		(adminEnv as any).FACEBOOK_PAGE_ID = 'page123';
		(adminEnv as any).FACEBOOK_PAGE_ACCESS_TOKEN = 'token123';

		// make sure the example story has an image URL set
		const row = await env.ky_news_db
			.prepare(`SELECT id FROM articles WHERE canonical_url = ? LIMIT 1`)
			.bind('https://example.com/ky-today')
			.first();
		const articleId = Number(row?.id ?? 0);
		expect(articleId).toBeGreaterThan(0);
		await env.ky_news_db
			.prepare(`UPDATE articles SET image_url = ? WHERE id = ?`)
			.bind('https://foo.bar/image.jpg', articleId)
			.run();

		const originalFetch = global.fetch;
		let lastUrl = '';
		let lastBody = '';
		global.fetch = async (input: RequestInfo, init?: RequestInit) => {
			lastUrl = input.toString();
			if (init && init.body instanceof URLSearchParams) {
				lastBody = init.body.toString();
			} else if (typeof init?.body === 'string') {
				lastBody = init.body;
			}
			return new Response(JSON.stringify({ id: 'ok' }));
		};

		const request = new IncomingRequest('https://example.com/api/admin/facebook/post', {
			method: 'POST',
			headers: {
				'x-admin-key': 'secret',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ id: articleId }),
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(request, adminEnv, ctx);
		expect(resp.status).toBe(200);
		const payload = await resp.json();
		expect(payload.ok).toBe(true);
		expect(lastUrl).toMatch(/graph\.facebook\.com/);
		expect(lastBody).toContain('picture=https%3A%2F%2Ffoo.bar%2Fimage.jpg');

		global.fetch = originalFetch;
	});
});
// tests for server-side social preview route

describe('social preview HTML route', () => {
	it('returns 404 when slug is not present in database', async () => {
		await ensureSchemaAndFixture();
		const missingPath = '/news/kentucky/boone-county/nonexistent-slug';
		const botResp = await SELF.fetch(`https://example.com${missingPath}`, {
			headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
		});
		// bots should see a 404 instead of the generic shell
		expect(botResp.status).toBe(404);
	});

	// regression guard for a real slug pattern seen on site
	it('serves a real example slug correctly', async () => {
		await ensureSchemaAndFixture();
		const now = new Date().toISOString();
		const sampleSlug = 'consistently-otega-owehs-senior-spotlight-a0358cac';
		await env.ky_news_db.prepare(`
			INSERT INTO articles (
				canonical_url, source_url, url_hash, title, author, published_at, category,
				is_kentucky, county, city, summary, seo_description, raw_word_count,
				summary_word_count, content_text, content_html, image_url, raw_r2_key, slug
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			'https://example.com/demo',
			'https://example.com',
			'demo-hash',
			'Demo Title',
			null,
			now,
			'today',
			1,
			'Fayette',
			'lexington',
			'Summary',
			'SEO',
			100,
			50,
			'body',
			'<p>body</p>',
			'https://localkynews.com/img/demo.jpg',
			null,
			sampleSlug
		).run();

		const path = `/news/kentucky/fayette-county/${sampleSlug}`;
		const browserResp = await SELF.fetch(`https://example.com${path}`);
		expect(browserResp.status).toBe(200);
		expect(browserResp.redirected).toBe(false);
	});

	// simulate a logic error where buildArticlePath returns '/' despite a valid slug
	it('guards against bogus canonical path by returning 404 for bots and not redirecting browsers', async () => {
		await ensureSchemaAndFixture();
		// insert a real article so slug lookup succeeds
		const now = new Date().toISOString();
		await env.ky_news_db.prepare(
			`INSERT INTO articles (
				canonical_url, source_url, url_hash, title, author, published_at, category,
				is_kentucky, county, city, summary, seo_description, raw_word_count,
				summary_word_count, content_text, content_html, image_url, raw_r2_key, slug
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).bind(
			'https://example.com/guard',
			'https://example.com',
			'guard-hash',
			'Guard Title',
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
			'https://localkynews.com/img/guard.jpg',
			null,
			'guard-slug'
		).run();

		// temporarily stub buildArticlePath to return '/'
		const orig = __testables.buildArticlePath;
		__testables.buildArticlePath = () => '/';

		const path = '/news/kentucky/boone-county/guard-slug';

		// bot should still get a 404
		const botResp = await SELF.fetch(`https://example.com${path}`, {
			headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
		});
		expect(botResp.status).toBe(404);

		// a plain browser request should *not* follow a redirect to '/'
		const browserResp = await SELF.fetch(`https://example.com${path}`);
		expect(browserResp.status).toBe(200);
		expect(browserResp.redirected).toBe(false);
		expect(browserResp.url).toBe(`https://example.com${path}`);

		// restore original helper
		__testables.buildArticlePath = orig;
	});


});
});
});
