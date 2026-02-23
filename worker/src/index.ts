import {
	getSourceStats,
	listAdminArticles,
	listArticlesForReclassify,
	queryArticles,
	updateArticleClassification,
} from './lib/db';
import {
	HIGH_PRIORITY_SOURCE_SEEDS,
	MASTER_SOURCE_SEEDS,
	NORMAL_PRIORITY_SOURCE_SEEDS,
	SCHOOL_SOURCE_SEEDS,
} from './data/source-seeds';
import { badRequest, corsPreflightResponse, isAllowedCategory, json, parseCommaList, parseJsonBody, parsePositiveInt } from './lib/http';
import { ingestSingleUrl } from './lib/ingest';
import { normalizeCountyList } from './lib/geo';
import { fetchAndParseFeed, resolveFeedUrls } from './lib/rss';
import { classifyArticleWithAi } from './lib/classify';
import type { Category } from './types';

// county filtering is now allowed for any category; preferences are handled on the client
const COUNTY_FILTER_ALLOWED = new Set(['today', 'sports', 'schools', 'obituaries', 'national', 'weather']);
const DEFAULT_SEED_LIMIT_PER_SOURCE = 100;
const MAX_SEED_LIMIT_PER_SOURCE = 500;

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

/** All route handling extracted so the outer fetch() can wrap it in a try/catch
 *  that guarantees CORS headers on every response, even unhandled exceptions. */
async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
const includeSchools = body?.includeSchools !== false;
const limitPerSource = normalizeLimitPerSource(body?.limitPerSource);

const candidateSources = includeSchools
? [...MASTER_SOURCE_SEEDS, ...SCHOOL_SOURCE_SEEDS]
: MASTER_SOURCE_SEEDS;
const sourceUrls = [...new Set(candidateSources.map((item) => item.trim()).filter(isHttpUrl))];

// Respond immediately - processing continues in the background via waitUntil
// so the request never times out even with 50+ sources.
ctx.waitUntil(runIngest(env, sourceUrls, limitPerSource));

return json({
message: 'Ingestion started in background',
sourcesTried: sourceUrls.length,
includeSchools,
limitPerSource,
}, 202);
}
	if (url.pathname === '/api/admin/reclassify' && request.method === 'POST') {
		if (!isAdminAuthorized(request, env)) {
			return json({ error: 'Unauthorized' }, 401);
		}
		// Re-classify existing articles using AI (GLM-4.7-Flash).
		// Pass { limit: 20, beforeId: <lastId from previous response> } to page through.
		// Process runs inline (not waitUntil) so the response includes results.
		const body = await parseJsonBody<{ limit?: number; beforeId?: number | null }>(request);
		const limit = Math.min(Math.max(Number(body?.limit ?? 10), 1), 20);
		const beforeId = body?.beforeId ?? null;

		const articles = await listArticlesForReclassify(env, { limit, beforeId });
		if (articles.length === 0) {
			return json({ message: 'No more articles to reclassify', lastId: null });
		}

		type ReclassifyResult = { id: number; title: string; oldCategory: string; newCategory: string; changed: boolean };
		const results: ReclassifyResult[] = [];
		for (const article of articles) {
			try {
				const classification = await classifyArticleWithAi(env, {
					url: article.canonicalUrl,
					title: article.title,
					content: article.contentText,
				});
				const changed =
					classification.category !== article.category ||
					classification.isKentucky !== article.isKentucky ||
					classification.county !== article.county;
				if (changed) {
					await updateArticleClassification(env, article.id, classification);
				}
				results.push({ id: article.id, title: article.title, oldCategory: article.category, newCategory: classification.category, changed });
			} catch (err) {
				results.push({ id: article.id, title: article.title, oldCategory: article.category, newCategory: article.category, changed: false });
			}
		}

		const lastId = articles[articles.length - 1]?.id ?? null;
		return json({ processed: articles.length, lastId, results });
	}

if (url.pathname === '/api/admin/articles' && request.method === 'GET') {
if (!isAdminAuthorized(request, env)) {
return json({ error: 'Unauthorized' }, 401);
}
const limit = parsePositiveInt(url.searchParams.get('limit'), 25, 100);
const cursor = url.searchParams.get('cursor');
const search = url.searchParams.get('search')?.trim() ?? null;
const categoryQuery = (url.searchParams.get('category') || 'all').toLowerCase();
const category = categoryQuery === 'all' ? 'all' : (isAllowedCategory(categoryQuery) ? categoryQuery : 'all');

const result = await listAdminArticles(env, {
limit,
cursor,
search,
category: category as Category | 'all',
});

return json(result);
}

if (url.pathname === '/api/admin/sources' && request.method === 'GET') {
if (!isAdminAuthorized(request, env)) {
return json({ error: 'Unauthorized' }, 401);
}
const stats = await getSourceStats(env);
const configuredSources = [...new Set([...MASTER_SOURCE_SEEDS, ...SCHOOL_SOURCE_SEEDS].map((s) => s.trim()).filter(isHttpUrl))];
const statsMap = new Map(stats.map((item) => [item.sourceUrl, item]));

const merged = configuredSources
	.map((sourceUrl) => {
		const found = statsMap.get(sourceUrl);
		return found ?? {
			sourceUrl,
			articleCount: 0,
			latestPublishedAt: '',
			status: 'idle' as const,
		};
	})
	.sort((a, b) => b.articleCount - a.articleCount || a.sourceUrl.localeCompare(b.sourceUrl));

return json({
totalConfiguredSources: configuredSources.length,
activeSources: merged.filter((s) => s.articleCount > 0).length,
inactiveSources: merged.filter((s) => s.articleCount === 0).length,
items: merged,
});
}

if (url.pathname === '/api/admin/retag' && request.method === 'POST') {
if (!isAdminAuthorized(request, env)) {
return json({ error: 'Unauthorized' }, 401);
}
const body = await parseJsonBody<{ id?: number; category?: string; isKentucky?: boolean; county?: string | null }>(request);
const id = Number(body?.id ?? 0);
if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid article id');

const category = (body?.category || '').toLowerCase();
if (!isAllowedCategory(category)) return badRequest('Invalid category');

await updateArticleClassification(env, id, {
category: category as Category,
isKentucky: Boolean(body?.isKentucky),
county: typeof body?.county === 'string' && body.county.trim() ? body.county.trim() : null,
});

return json({ ok: true, id });
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
}

export default {
async fetch(request, env, ctx): Promise<Response> {
// Handle CORS preflight requests first
if (request.method === 'OPTIONS') {
return corsPreflightResponse();
}

// Top-level catch: ensures CORS headers are present on every response,
// including unhandled runtime exceptions, so browsers can read the error.
try {
return await handleRequest(request, env, ctx);
} catch (err) {
return json({ error: 'Internal server error', details: safeError(err) }, 500);
}
},
async scheduled(_event, env, ctx): Promise<void> {
// Tiered polling: high-priority every 5 min, normal every 15 min.
const cron = (_event as ScheduledEvent).cron || '';

if (cron === '*/5 * * * *') {
const sourceUrls = [...new Set(HIGH_PRIORITY_SOURCE_SEEDS.map((s) => s.trim()).filter(isHttpUrl))];
ctx.waitUntil(runIngest(env, sourceUrls, Math.max(DEFAULT_SEED_LIMIT_PER_SOURCE, 30)));
return;
}

const sourceUrls = [...new Set(NORMAL_PRIORITY_SOURCE_SEEDS.map((s) => s.trim()).filter(isHttpUrl))];
ctx.waitUntil(runIngest(env, sourceUrls, DEFAULT_SEED_LIMIT_PER_SOURCE));
},
} satisfies ExportedHandler<Env>;

/** Process sources sequentially and store results - used by both HTTP seed endpoint and cron. */
async function runIngest(env: Env, sourceUrls: string[], limitPerSource: number): Promise<void> {
for (const sourceUrl of sourceUrls) {
try {
await ingestSeedSource(env, sourceUrl, limitPerSource);
} catch {
// swallow per-source errors so one bad source does not abort the rest
}
}
}

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

function isAdminAuthorized(request: Request, env: Env): boolean {
	const configured = ((env as unknown as { ADMIN_PANEL_PASSWORD?: string }).ADMIN_PANEL_PASSWORD || '').trim();
	if (!configured) {
		// If no password is configured in worker secrets, keep admin endpoints closed.
		return false;
	}

	const provided = (request.headers.get('x-admin-key') || '').trim();
	return provided.length > 0 && provided === configured;
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
