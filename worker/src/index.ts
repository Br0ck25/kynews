import { queryArticles } from './lib/db';
import { MASTER_SOURCE_SEEDS, SCHOOL_SOURCE_SEEDS } from './data/source-seeds';
import { badRequest, corsPreflightResponse, isAllowedCategory, json, parseCommaList, parseJsonBody, parsePositiveInt } from './lib/http';
import { ingestSingleUrl } from './lib/ingest';
import { normalizeCountyList } from './lib/geo';
import { fetchAndParseFeed, resolveFeedUrls } from './lib/rss';

// county filtering is now allowed for any category; preferences are handled on the client
const COUNTY_FILTER_ALLOWED = new Set(['today', 'sports', 'schools', 'obituaries', 'national', 'weather']);
const DEFAULT_SEED_LIMIT_PER_SOURCE = 12;
const MAX_SEED_LIMIT_PER_SOURCE = 50;

interface SeedSourceStatus {
	sourceUrl: string;
	discoveredFeeds: number;
	selectedFeed: string | null;
	fallbackUsed: boolean;
	processed: number;
	inserted: number;
	duplicate: number;
	rejected: number;
	errors: string[];
}

export default {
	async fetch(request, env): Promise<Response> {
		// Handle CORS preflight requests
		if (request.method === 'OPTIONS') {
			return corsPreflightResponse();
		}

		const url = new URL(request.url);

		if ((url.pathname === '/' || url.pathname === '/health') && request.method === 'GET') {
			return json({
				ok: true,
				service: 'kentucky-news-worker',
				date: new Date().toISOString(),
			});
		}

		if (url.pathname === '/api/ingest/url' && request.method === 'POST') {
			const body = await parseJsonBody<{ url?: string }>(request);
			const articleUrl = body?.url?.trim();

			if (!articleUrl) return badRequest('Missing required field: url');
			if (!isHttpUrl(articleUrl)) return badRequest('url must be an absolute http(s) URL');

			try {
				const result = await ingestSingleUrl(env, { url: articleUrl });
				return json(result, result.status === 'rejected' ? 422 : 200);
			} catch (error) {
				return json({ error: 'ingest failed', details: safeError(error) }, 500);
			}
		}

		if (url.pathname === '/api/ingest/rss' && request.method === 'POST') {
			const body = await parseJsonBody<{ feedUrl?: string; sourceUrl?: string }>(request);
			const feedUrl = body?.feedUrl?.trim();
			const sourceUrl = body?.sourceUrl?.trim();

			if (!feedUrl && !sourceUrl) {
				return badRequest('Provide feedUrl or sourceUrl');
			}

			const feedCandidates = feedUrl
				? [feedUrl]
				: await resolveFeedUrls(env, sourceUrl as string);

			const uniqueFeeds = [...new Set(feedCandidates.filter(isHttpUrl))];
			if (uniqueFeeds.length === 0) return badRequest('No valid feed URLs found');

			let selectedFeed: string | null = null;
			let items = [] as Awaited<ReturnType<typeof fetchAndParseFeed>>;

			for (const candidate of uniqueFeeds) {
				const parsed = await fetchAndParseFeed(env, candidate);
				if (parsed.length > 0) {
					selectedFeed = candidate;
					items = parsed;
					break;
				}
			}

			if (!selectedFeed) {
				return json({ error: 'Unable to parse feed', feedCandidates: uniqueFeeds }, 422);
			}

			const limitedItems = items.slice(0, 12);
			const results = [] as Awaited<ReturnType<typeof ingestSingleUrl>>[];

			for (const item of limitedItems) {
				try {
					const result = await ingestSingleUrl(env, {
						url: item.link,
						sourceUrl: sourceUrl ?? selectedFeed,
						feedPublishedAt: item.publishedAt,
						providedTitle: item.title,
						providedDescription: item.description,
					});
					results.push(result);
				} catch (error) {
					results.push({
						status: 'rejected',
						reason: safeError(error),
					});
				}
			}

			return json({
				feed: selectedFeed,
				totalItems: items.length,
				processed: limitedItems.length,
				inserted: results.filter((r) => r.status === 'inserted').length,
				duplicate: results.filter((r) => r.status === 'duplicate').length,
				rejected: results.filter((r) => r.status === 'rejected').length,
				results,
			});
		}

		if (url.pathname === '/api/ingest/seed' && request.method === 'POST') {
			const body = await parseJsonBody<{ includeSchools?: boolean; limitPerSource?: number }>(request);
			const includeSchools = body?.includeSchools === true;
			const limitPerSource = normalizeLimitPerSource(body?.limitPerSource);

			const candidateSources = includeSchools
				? [...MASTER_SOURCE_SEEDS, ...SCHOOL_SOURCE_SEEDS]
				: MASTER_SOURCE_SEEDS;
			const sourceUrls = [...new Set(candidateSources.map((item) => item.trim()).filter(isHttpUrl))];

			const statuses: SeedSourceStatus[] = [];

			for (const sourceUrl of sourceUrls) {
				statuses.push(await ingestSeedSource(env, sourceUrl, limitPerSource));
			}

			return json({
				sourcesTried: sourceUrls.length,
				includeSchools,
				limitPerSource,
				inserted: statuses.reduce((sum, status) => sum + status.inserted, 0),
				duplicate: statuses.reduce((sum, status) => sum + status.duplicate, 0),
				rejected: statuses.reduce((sum, status) => sum + status.rejected, 0),
				processed: statuses.reduce((sum, status) => sum + status.processed, 0),
				failedSources: statuses.filter((status) => status.errors.length > 0).length,
				statuses,
			});
		}

		const categoryMatch = url.pathname.match(/^\/api\/articles\/([a-z-]+)$/i);
		if (categoryMatch && request.method === 'GET') {
			const category = categoryMatch[1]?.toLowerCase();
			if (!category || !isAllowedCategory(category)) {
				return badRequest('Invalid category. Allowed: today|national|sports|weather|schools|obituaries');
			}

			// support both ?counties=Foo,Bar (existing) and the shorthand ?county=Foo
			const rawCounties = parseCommaList(
				url.searchParams.get('counties') || url.searchParams.get('county'),
			);
			const counties = normalizeCountyList(rawCounties);

			// no longer reject based on category; any category may be filtered by counties
			// (client will simply pass selected preferences)

			const search = url.searchParams.get('search')?.trim() ?? null;
			const limit = parsePositiveInt(url.searchParams.get('limit'), 20, 100);
			const cursor = url.searchParams.get('cursor');
			const result = await queryArticles(env, {
				category,
				counties,
				search,
				limit,
				cursor,
			});

			return json(result);
		}

		return json({ error: 'Not found' }, 404);
	},
} satisfies ExportedHandler<Env>;

function isHttpUrl(input: string): boolean {
	try {
		const parsed = new URL(input);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

function safeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return 'unknown error';
}

function normalizeLimitPerSource(limitPerSource: number | undefined): number {
	if (!Number.isFinite(limitPerSource)) return DEFAULT_SEED_LIMIT_PER_SOURCE;
	const numeric = Math.floor(limitPerSource as number);
	if (numeric <= 0) return DEFAULT_SEED_LIMIT_PER_SOURCE;
	return Math.min(numeric, MAX_SEED_LIMIT_PER_SOURCE);
}

async function ingestSeedSource(env: Env, sourceUrl: string, limitPerSource: number): Promise<SeedSourceStatus> {
	const status: SeedSourceStatus = {
		sourceUrl,
		discoveredFeeds: 0,
		selectedFeed: null,
		fallbackUsed: false,
		processed: 0,
		inserted: 0,
		duplicate: 0,
		rejected: 0,
		errors: [],
	};

	try {
		const feedCandidates = await resolveFeedUrls(env, sourceUrl);
		const uniqueFeeds = [...new Set(feedCandidates.filter(isHttpUrl))];
		status.discoveredFeeds = uniqueFeeds.length;

		let feedItems = [] as Awaited<ReturnType<typeof fetchAndParseFeed>>;
		for (const feedUrl of uniqueFeeds) {
			try {
				const parsedItems = await fetchAndParseFeed(env, feedUrl);
				if (parsedItems.length > 0) {
					status.selectedFeed = feedUrl;
					feedItems = parsedItems;
					break;
				}
			} catch (error) {
				status.errors.push(`feed parse failed (${feedUrl}): ${safeError(error)}`);
			}
		}

		if (status.selectedFeed && feedItems.length > 0) {
			const limitedItems = feedItems.slice(0, limitPerSource);
			for (const item of limitedItems) {
				try {
					const result = await ingestSingleUrl(env, {
						url: item.link,
						sourceUrl,
						feedPublishedAt: item.publishedAt,
						providedTitle: item.title,
						providedDescription: item.description,
					});
					status.processed += 1;
					if (result.status === 'inserted') status.inserted += 1;
					if (result.status === 'duplicate') status.duplicate += 1;
					if (result.status === 'rejected') status.rejected += 1;
				} catch (error) {
					status.processed += 1;
					status.rejected += 1;
					status.errors.push(`ingest failed (${item.link}): ${safeError(error)}`);
				}
			}

			return status;
		}

		status.fallbackUsed = true;
		try {
			const fallbackResult = await ingestSingleUrl(env, { url: sourceUrl, sourceUrl });
			status.processed += 1;
			if (fallbackResult.status === 'inserted') status.inserted += 1;
			if (fallbackResult.status === 'duplicate') status.duplicate += 1;
			if (fallbackResult.status === 'rejected') status.rejected += 1;
		} catch (error) {
			status.processed += 1;
			status.rejected += 1;
			status.errors.push(`fallback ingest failed (${sourceUrl}): ${safeError(error)}`);
		}
	} catch (error) {
		status.fallbackUsed = true;
		status.processed += 1;
		status.rejected += 1;
		status.errors.push(`source failed (${sourceUrl}): ${safeError(error)}`);
	}

	return status;
}
