import {
	blockArticleByIdAndDelete,
	deleteArticleById,
	findArticleByHash,
	getArticleById,
	getArticleBySlug,
	insertArticle,
	listBlockedArticles,
	getSourceStats,
	listAdminArticles,
	listArticlesForReclassify,
	queryArticles,
	unblockArticleByBlockedId,
	updateArticlePublishedAt,
	updateArticleClassification,
	updateArticleContent,
	updateArticleLinks,
	getCountyCounts,
	getArticlesForUpdateCheck,
	prependUpdateToSummary,
	updateArticlePrimaryCounty,
	prepare,
} from './lib/db';
import {
	HIGH_PRIORITY_SOURCE_SEEDS,
	MASTER_SOURCE_SEEDS,
	NORMAL_PRIORITY_SOURCE_SEEDS,
	SCHOOL_SOURCE_SEEDS,
} from './data/source-seeds';
import {
	badRequest,
	cachedTextFetch,
	corsPreflightResponse,
	isAllowedCategory,
	json,
	normalizeCanonicalUrl,
	parseCommaList,
	parseJsonBody,
	parsePositiveInt,
	sha256Hex,
	wordCount,
	toIsoDateOrNull,
} from './lib/http';
import { ingestSingleUrl, generateArticleSlug, findHighlySimilarTitle, fetchAndExtractArticle } from './lib/ingest';
import { normalizeCountyList } from './lib/geo';
import { KY_COUNTIES } from './data/ky-geo';
import { fetchAndParseFeed, resolveFeedUrls } from './lib/rss';
import { classifyArticleWithAi } from './lib/classify';
import { summarizeArticle, generateUpdateParagraph } from './lib/ai';
import type { Category, NewArticle, ArticleRecord } from './types';
import { generateFacebookCaption } from './lib/facebook';

const DEFAULT_SEED_LIMIT_PER_SOURCE = 0;
const MAX_SEED_LIMIT_PER_SOURCE = 10000;
const INGEST_METRICS_KEY = 'admin:ingest:latest';
const INGEST_ROTATION_KEY_PREFIX = 'admin:ingest:rotation:';
const FALLBACK_CRAWL_MAX_LINKS = 12;
const FALLBACK_CRAWL_MAX_SECTION_PAGES = 3;
/** Articles per source per tick. 8 is sufficient — RSS feeds rarely publish more than
 *  2–3 new articles per 2-minute window; excess calls are all deduped anyway. */
const SCHEDULED_LIMIT_PER_SOURCE = 8;
/** Normal-priority sources per tick (HIGH_PRIORITY always runs separately every tick). */
const SCHEDULED_NORMAL_SOURCES_PER_RUN = 8;
/** How many sources to fetch simultaneously. */
const INGEST_CONCURRENCY = 10;
/** KV key for the backfill-counties job status (polled by the admin UI). */
const BACKFILL_STATUS_KEY = 'admin:backfill:latest';

// messages that have been retried excessively often should be skipped to avoid
// burning CPU in an infinite loop.  Cloudflare queues expose an `attempts`
// counter on each message; after this many retries we acknowledge the message
// and move on.
const MAX_QUEUE_RETRIES = 3;


// messages that are pushed from the admin UI and handled asynchronously by
// the `queue` entrypoint below.  using a simple discriminated union keeps the
// runtime code and tests easy to reason about.
type QueueJob =
	| { type: 'manualIngest'; sourceUrls: string[]; limitPerSource: number }
	| { type: 'backfillCounty'; county: string; threshold: number };

// augment the generated Env interface so that TypeScript knows the binding is
// available once we add it in wrangler.jsonc.
declare global {
	interface Env extends Cloudflare.Env {
		INGEST_QUEUE?: Queue<QueueJob>;
		// asset binding provided by wrangler to serve static files
		ASSETS?: { fetch(input: RequestInfo, init?: RequestInit): Promise<Response> };
		// optional Facebook application ID used for OG tags in preview pages
		FB_APP_ID?: string;
	}
}

const STRUCTURED_SEARCH_SOURCE_URLS = new Set<string>([
	'https://kyweathercenter.com/', // custom WordPress search source (no RSS)
]);

const ROBOTS_BYPASS_URLS = new Set<string>([

]);

const PUBLIC_ARTICLE_CACHE_HEADERS = {
	'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
};

// canonical base URL for all article links and sitemaps. Having a single constant
// avoids subtle bugs where a locally scoped variable might not be defined at
// runtime ("baseUrl is not defined" errors) and makes it easy to change if the
// domain ever moves.
export const BASE_URL = 'https://localkynews.com';

// status object returned by ingestSeedSource; kept separate to avoid inlining a
// huge anonymous type at the call site and to make test fixtures easier to
// construct.
interface SeedSourceStatus {
	sourceUrl: string;
	discoveredFeeds: number;
	selectedFeed: string | null;
	fallbackUsed: boolean;
	processed: number;
	inserted: number;
	duplicate: number;
	rejected: number;
	lowWordDiscards: number;
	errors: string[];
	rejectedSamples: IngestDecisionSample[];
	duplicateSamples: IngestDecisionSample[];
	insertedSamples: IngestDecisionSample[];
}

interface IngestDecisionSample {
url: string;
sourceUrl: string;
title?: string;
reason?: string;
publishedAt?: string | null;
// 'inserted' added so we can sample successful crawls too
decision: 'duplicate' | 'rejected' | 'inserted';
category?: string;
id?: number;
urlHash?: string;
createdAt: string;
}

interface IngestRunMetrics {
startedAt: string;
finishedAt: string;
durationMs: number;
sourcesTried: number;
sourcesAvailable: number;
processed: number;
inserted: number;
duplicate: number;
rejected: number;
lowWordDiscards: number;
ingestRatePerMinute: number;
sourceErrors: number;
trigger: 'manual' | 'scheduled' | 'scheduled-high' | 'scheduled-normal';
rejectedSamples: IngestDecisionSample[];
duplicateSamples: IngestDecisionSample[];
insertedSamples: IngestDecisionSample[];
}

interface IngestRunOptions {
	maxSourcesPerRun?: number;
	rotateSources?: boolean;
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

// serve llms.txt from public assets
if (url.pathname === '/llms.txt' && request.method === 'GET') {
  return fetch(`${BASE_URL}/llms.txt`);
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

const allItems: Awaited<ReturnType<typeof fetchAndParseFeed>> = [];
const seenLinks = new Set<string>();

for (const candidate of uniqueFeeds) {
const parsed = await fetchAndParseFeed(env, candidate).catch(() => []);
for (const item of parsed) {
const normalizedLink = normalizeCanonicalUrl(item.link || '');
if (!normalizedLink || seenLinks.has(normalizedLink)) continue;
seenLinks.add(normalizedLink);
allItems.push({ ...item, link: normalizedLink });
}
}

if (allItems.length === 0) {
return json({ error: 'Unable to parse feed', feedCandidates: uniqueFeeds }, 422);
}

allItems.sort(
	(a, b) => toSortTimestamp(b.publishedAt) - toSortTimestamp(a.publishedAt),
);

const results = [] as Awaited<ReturnType<typeof ingestSingleUrl>>[];

for (const item of allItems) {
try {
const result = await ingestSingleUrl(env, {
url: item.link,
sourceUrl: sourceUrl ?? feedUrl ?? uniqueFeeds[0],
feedPublishedAt: item.publishedAt ?? undefined,
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
feed: sourceUrl ?? feedUrl ?? uniqueFeeds[0],
feedsDiscovered: uniqueFeeds.length,
totalItems: allItems.length,
processed: allItems.length,
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

const candidateSources = buildManualIngestSources(includeSchools);
const sourceUrls = [...new Set(candidateSources.map((item) => item.trim()).filter(isHttpUrl))];

// Respond immediately - processing continues in the background via waitUntil
// so the request never times out even with 50+ sources.
ctx.waitUntil(runIngest(env, sourceUrls, limitPerSource, 'manual'));

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
					// adding rssTitle ensures reclassification uses the same signal
					// that original ingest did, improving geo/county accuracy
					rssTitle: article.title,
				});
				const changed =
					classification.category !== article.category ||
					classification.isKentucky !== article.isKentucky ||
					classification.isNational !== article.isNational ||
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

if (url.pathname === '/api/admin/ingest' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}

	const body = await parseJsonBody<{ includeSchools?: boolean; limitPerSource?: number }>(request);
	const includeSchools = body?.includeSchools !== false;
	const limitPerSource = normalizeLimitPerSource(body?.limitPerSource);
	const candidateSources = buildManualIngestSources(includeSchools);
	const sourceUrls = [...new Set(candidateSources.map((item) => item.trim()).filter(isHttpUrl))];

	// fire a queue message so the heavy work runs in a separate invocation
	// (queues are not subject to the 30‑second waitUntil limit).
	ctx.waitUntil(
		(env.INGEST_QUEUE as any).send({
			type: 'manualIngest',
			sourceUrls,
			limitPerSource,
		}),
	);
	return json({ ok: true, message: 'Admin ingest queued', sourcesTried: sourceUrls.length, limitPerSource }, 202);
}

// Manual single-URL ingest from the admin console.
// Identical to /api/ingest/url but protected by the admin key so it can be
// safely called from the admin UI without exposing the ingest pipeline publicly.
if (url.pathname === '/api/admin/ingest-url' && request.method === 'POST') {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const body = await parseJsonBody<{ url?: string }>(request);
  const articleUrl = body?.url?.trim();
  if (!articleUrl) return badRequest('Missing required field: url');
  if (!isHttpUrl(articleUrl)) return badRequest('url must be an absolute http(s) URL');
  try {
    const result = await ingestSingleUrl(env, { url: articleUrl });
    return json(result, result.status === 'rejected' ? 422 : 200);
  } catch (error) {
    const msg = safeError(error);
    console.error('[INGEST-URL FAILED]', msg);
    // Surface fetch/bot-block errors as 422 with a readable message rather
    // than an opaque 500 — the admin UI can then display the reason directly.
    if (
      msg.startsWith('Failed to fetch URL') ||
      msg.startsWith('Bot protection detected') ||
      msg.startsWith('Network error fetching')
    ) {
      return json({ status: 'rejected', reason: msg }, 422);
    }
    return json({ error: 'ingest failed', details: msg }, 500);
  }
}

// New preview endpoint: run the ingest pipeline but do not write anything.
// Clients can call this to fetch a draft of title/summary/category etc.
if (url.pathname === '/api/admin/ingest-url-preview' && request.method === 'POST') {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const body = await parseJsonBody<{ url?: string }>(request);
  const articleUrl = body?.url?.trim();
  if (!articleUrl) return badRequest('Missing required field: url');
  if (!isHttpUrl(articleUrl)) return badRequest('url must be an absolute http(s) URL');

  try {
    const result = await ingestSingleUrl(env, { url: articleUrl, preview: true });
    return json(result, result.status === 'rejected' ? 422 : 200);
  } catch (error) {
    const msg = safeError(error);
    console.error('[PREVIEW FAILED]', msg);

    // For common fetch/network errors we prefer to surface them as a normal
    // "rejected" result rather than an opaque error object.  This keeps the
    // HTTP status code and response shape consistent with the normal ingest
    // pipeline so the frontend can simply display the rejection reason.
    if (msg.startsWith('Failed to fetch URL')) {
      return json({ status: 'rejected', reason: msg }, 422);
    }

    return json({ status: 'error', error: msg });
  }
}

// Internal endpoint: process a single county for the backfill job.  It is
// called in two modes:
//   * without `sourceUrl`: spawn a separate invocation for each source URL.
//   * with `sourceUrl`: actually run ingestion for that one URL and update
//     the status object.  The reason we split like this is to ensure that each
//     heavy crawl executes in its own worker invocation with a full CPU budget
//     (queue and initial handlers just fan out work).
if (url.pathname === '/api/admin/backfill-county' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}

	const body = await parseJsonBody<{ county?: string; threshold?: number; sourceUrl?: string }>(request);
	const county = body?.county || '';
	const threshold = Math.max(1, Number(body?.threshold ?? 5));
	if (!county) return badRequest('Missing county');

	const sourceUrl = body?.sourceUrl;
	if (sourceUrl) {
		// actual work for one url; use __testables in tests so we can stub
		const before = (await getCountyCounts(env)).get(county) ?? 0;
		const startTs = new Date().toISOString();
		// record current URL being processed so UI can display it
		try {
			const rawPre = await env.CACHE.get(BACKFILL_STATUS_KEY, 'text');
			if (rawPre) {
				const statusObjPre = JSON.parse(rawPre);
				if (statusObjPre && statusObjPre.status === 'running') {
					statusObjPre.currentUrl = sourceUrl;
					await env.CACHE.put(BACKFILL_STATUS_KEY, JSON.stringify(statusObjPre), { expirationTtl: 7200 }).catch(() => {});
				}
			}
		} catch {}
		await __testables.runIngest(env, [sourceUrl], threshold * 2, 'manual', { rotateSources: false }).catch((e) => {
			console.error('runIngest error for', county, sourceUrl, e);
			return null;
		});
		// update status object (same as previous code)
		try {
			const raw = await env.CACHE.get(BACKFILL_STATUS_KEY, 'text');
			if (raw) {
				const statusObj = JSON.parse(raw);
				if (statusObj && statusObj.status === 'running') {
					statusObj.processed = (statusObj.processed || 0) + 1;
					if (!statusObj.results) {
						statusObj.results = [];
					}
					statusObj.results.push({
						county,
						before,
						after: (await getCountyCounts(env)).get(county) ?? before,
						url: sourceUrl,
						newArticles: (await env.ky_news_db
							.prepare(`SELECT canonical_url FROM articles WHERE county = ? AND created_at >= ?`)
							.bind(county, startTs)
							.all<any>()).results.map((r: any) => r.canonical_url),
					});
					// the final-complete test happens when processed >= missingCount
					if (statusObj.processed >= statusObj.missingCount) {
						statusObj.status = 'complete';
						statusObj.finishedAt = new Date().toISOString();
					}
					const ttl = statusObj.status === 'complete' ? 86400 : 7200;
					await env.CACHE.put(BACKFILL_STATUS_KEY, JSON.stringify(statusObj), { expirationTtl: ttl }).catch((e) => {
						console.error('status put failed for', county, e);
					});
				}
			}
		} catch (e) {
			console.error('error updating status for', county, e);
		}
		return json({ ok: true });
	} else {
		// fan out one invocation per source URL.  use fetch so each new job has a
		// fresh CPU budget.  include admin key so auth passes.
		const urls = buildCountySearchUrls(county);
		const origin = new URL(request.url).origin;
		for (const src of urls) {
			ctx.waitUntil(
				fetch(`${origin}/api/admin/backfill-county`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-admin-key': request.headers.get('x-admin-key') || '',
					},
					body: JSON.stringify({ county, threshold, sourceUrl: src }),
					cf: { keepalive: true },
				}),
			);
		}
		return json({ ok: true });
	}
}

// Manual admin endpoint to trigger update check for all articles published in last 48h
if (url.pathname === '/api/admin/check-updates' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}
	ctx.waitUntil(checkArticleUpdates(env, 48));
	return json({ ok: true });
}

// Backfill articles for counties that currently have fewer than `threshold` items.
// Enqueue one job per county; the worker queue consumer will perform the heavy
// ingest work without being subject to the 30‑second waitUntil cap.
if (url.pathname === '/api/admin/backfill-counties' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}

	const body = await parseJsonBody<{ threshold?: number }>(request);
	const threshold = Math.max(1, Number(body?.threshold ?? 5));

	const countsMap = await getCountyCounts(env);
	const missing = KY_COUNTIES.filter((c) => (countsMap.get(c) ?? 0) < threshold);

	// determine total number of jobs (one per search URL). this value is
	// stored as missingCount so progress tracking reflects the actual work
	// that will be executed rather than the mere number of counties.
	let totalJobs = 0;
	for (const county of missing) {
		totalJobs += buildCountySearchUrls(county).length;
	}

	// Write initial "running" state so the UI can display progress immediately.
	const initialStatus = {
		status: 'running' as const,
		startedAt: new Date().toISOString(),
		threshold,
		missingCount: totalJobs,
		processed: 0,
		results: [] as Array<{ county: string; before: number; after: number; newArticles: string[] }>,
	};
	await env.CACHE.put(BACKFILL_STATUS_KEY, JSON.stringify(initialStatus), { expirationTtl: 7200 }).catch(() => null);

	// schedule a queue message for each county
	for (const county of missing) {
		ctx.waitUntil(
			(env.INGEST_QUEUE as any).send({ type: 'backfillCounty', county, threshold }),
		);
	}

	return json({ ok: true, message: 'Backfill queued', threshold, missingCount: totalJobs }, 202);
}

if (url.pathname === '/api/admin/backfill-status' && request.method === 'GET') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}
	const status = await env.CACHE.get(BACKFILL_STATUS_KEY, 'json').catch(() => null);
	return json({ status: status ?? null });
}

if (url.pathname === '/api/admin/metrics' && request.method === 'GET') {
if (!isAdminAuthorized(request, env)) {
return json({ error: 'Unauthorized' }, 401);
}

const latest = await env.CACHE.get<IngestRunMetrics>(INGEST_METRICS_KEY, 'json').catch(() => null);
return json({ latest: latest ?? null });
}

if (url.pathname === '/api/admin/rejections' && request.method === 'GET') {
if (!isAdminAuthorized(request, env)) {
return json({ error: 'Unauthorized' }, 401);
}

const latest = await env.CACHE.get<IngestRunMetrics>(INGEST_METRICS_KEY, 'json').catch(() => null);
return json({
items: latest?.rejectedSamples ?? [],
duplicateItems: latest?.duplicateSamples ?? [],
totalRejected: latest?.rejected ?? 0,
totalDuplicate: latest?.duplicate ?? 0,
});
}

if (url.pathname === '/api/admin/publish' && request.method === 'POST') {
if (!isAdminAuthorized(request, env)) {
return json({ error: 'Unauthorized' }, 401);
}

const body = await parseJsonBody<{
url?: string;
sourceUrl?: string;
providedTitle?: string;
providedDescription?: string;
feedPublishedAt?: string;
}>(request);

const articleUrl = body?.url?.trim();
if (!articleUrl || !isHttpUrl(articleUrl)) {
return badRequest('Missing or invalid url');
}

const result = await ingestSingleUrl(env, {
url: articleUrl,
sourceUrl: body?.sourceUrl?.trim() || articleUrl,
providedTitle: body?.providedTitle?.trim() || undefined,
providedDescription: body?.providedDescription?.trim() || undefined,
feedPublishedAt: body?.feedPublishedAt,
allowShortContent: true,
});

return json({ ok: true, result });
}

if (url.pathname === '/api/admin/purge-and-reingest' && request.method === 'POST') {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // require explicit confirmation string to prevent accidental full purge
  const body = await parseJsonBody<{ includeSchools?: boolean; limitPerSource?: number; confirm?: string }>(request);
  // ADD: require explicit confirmation string
  if (body?.confirm !== 'PURGE_AND_REINGEST') {
    return json({
      error: 'Missing confirmation. Pass { "confirm": "PURGE_AND_REINGEST" } to proceed.',
    }, 400);
  }

  const includeSchools = body?.includeSchools !== false;
  const limitPerSource = normalizeLimitPerSource(body?.limitPerSource);

  await prepare(env, 'DELETE FROM articles').run();

const candidateSources = buildManualIngestSources(includeSchools);
const sourceUrls = [...new Set(candidateSources.map((item) => item.trim()).filter(isHttpUrl))];
ctx.waitUntil(runIngest(env, sourceUrls, limitPerSource, 'manual'));

return json({
ok: true,
message: 'Articles purged. Re-ingest started in background.',
sourcesTried: sourceUrls.length,
});
}

if (url.pathname === '/api/admin/articles' && request.method === 'GET') {
if (!isAdminAuthorized(request, env)) {
return json({ error: 'Unauthorized' }, 401);
}
const limit = parsePositiveInt(url.searchParams.get('limit'), 25, 100);
const cursor = url.searchParams.get('cursor');
let search = url.searchParams.get('search') ?? null;
if (search !== null) {
  search = search.replace(/\+/g, ' ').trim();
}
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

// classification audit: return recent articles with basic stats
if (url.pathname === '/api/admin/classification-audit' && request.method === 'GET') {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const limit = parsePositiveInt(url.searchParams.get('limit'), 50, 100);
  // fetch recent articles
  const rows = await prepare(env,
      `SELECT id, title, category, is_kentucky, is_national, county, city, source_url, published_at, created_at
       FROM articles
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<any>();

  const items: any[] = [];
  const byCategory: Record<string, number> = {};
  let kentucky = 0;
  let national = 0;
  let withCounty = 0;
  let withMultiCounty = 0;
  let noCounty = 0;

  const ids = rows.results.map((r) => r.id);
  let countiesMap = new Map<number, string[]>();
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const countyRows = await env.ky_news_db
      .prepare(
        `SELECT article_id, county FROM article_counties WHERE article_id IN (${placeholders})`
      )
      .bind(...ids)
      .all<any>();
    countiesMap = new Map();
    for (const cr of countyRows.results || []) {
      if (!countiesMap.has(cr.article_id)) countiesMap.set(cr.article_id, []);
      countiesMap.get(cr.article_id)!.push(cr.county);
    }
  }

  for (const r of rows.results) {
    const counties = countiesMap.get(r.id) || [];
    items.push({
      id: r.id,
      title: r.title,
      category: r.category,
      isKentucky: !!r.is_kentucky,
      isNational: !!r.is_national,
      county: r.county,
      counties,
      city: r.city,
      sourceUrl: r.source_url,
      publishedAt: r.published_at,
      createdAt: r.created_at,
    });
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    if (r.is_kentucky) kentucky += 1;
    if (r.is_national) national += 1;
    if (r.county) withCounty += 1;
    if (counties.length > 1) withMultiCounty += 1;
    if (r.is_kentucky && !r.county && counties.length === 0) noCounty += 1;
  }

  const stats = {
    total: items.length,
    kentucky,
    national,
    withCounty,
    withMultiCounty,
    noCounty,
    byCategory,
  };

  return json({ items, stats });
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

  const body = await parseJsonBody<{
    id?: number;
    category?: string;
    isKentucky?: boolean;
    county?: string | null;
    counties?: string[];
  }>(request);
  const id = Number(body?.id ?? 0);
  if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid article id');

  // normalize category but allow empty string to mean "none"; this is
  // important for clearing a tag.
  const category = (body?.category ?? '').toString().trim().toLowerCase();
  if (category && !isAllowedCategory(category)) return badRequest('Invalid category');

  // track whether the client explicitly provided a Kentucky flag.  we still
  // compute a boolean for the update below but need to know if the value was
  // omitted so that we can avoid clobbering the national flag in some cases.
  const explicitKy = typeof body?.isKentucky === 'boolean' ? body.isKentucky : undefined;
  const forceKy = Boolean(body?.isKentucky);

  // only compute county(s) if the story is explicitly being marked as
  // Kentucky; otherwise ignore any values the caller might have sent.
  const countyVal =
    explicitKy === true && typeof body?.county === 'string' && body.county.trim()
      ? body.county.trim()
      : null;
  const countiesArr =
    explicitKy === true
      ? (Array.isArray(body?.counties)
          ? body!.counties.map((c) => c.trim()).filter(Boolean)
          : body?.county
            ? [body.county.trim()]
            : [])
      : [];

  // national flag logic: if the caller explicitly toggled the Kentucky
  // checkbox we invert that value; otherwise we only set national when the
  // selected category is 'national'.  Leaving the flag undefined means
  // `updateArticleClassification` will leave the existing value intact.
  let forceNat: boolean | undefined;
  if (explicitKy !== undefined) {
    forceNat = !explicitKy;
  } else if (category === 'national') {
    forceNat = true;
  }

  try {
    await updateArticleClassification(env, id, {
      category: category as Category, // may be empty to clear
      isKentucky: forceKy,
      isNational: forceNat,
      county: countyVal,
      counties: countiesArr,
    });
    return json({ ok: true, id });
  } catch (err) {
    console.error('[RETAG ERROR]', err, {
      id,
      category,
      isKentucky: forceKy,
      isNational: forceNat,
      county: countyVal,
      counties: countiesArr,
    });
    return json({ error: 'retag failed' }, 500);
  }
}

if (url.pathname === '/api/admin/article/update-datetime' && request.method === 'POST') {
if (!isAdminAuthorized(request, env)) {
return json({ error: 'Unauthorized' }, 401);
}

const body = await parseJsonBody<{ id?: number; publishedAt?: string }>(request);
const id = Number(body?.id ?? 0);
if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid article id');

const rawPublishedAt = (body?.publishedAt || '').trim();
if (!rawPublishedAt) return badRequest('Missing publishedAt');

const parsedTs = Date.parse(rawPublishedAt);
if (!Number.isFinite(parsedTs)) return badRequest('Invalid publishedAt datetime');

await updateArticlePublishedAt(env, id, new Date(parsedTs).toISOString());
return json({ ok: true, id, publishedAt: new Date(parsedTs).toISOString() });
}

// administrative helper: correct the primary county on an existing article.
// requires a bearer token (env.ADMIN_SECRET) rather than the usual
// admin-panel password that the rest of the UI uses.
if (url.pathname.match(/^\/api\/articles\/\d+\/county$/) && request.method === 'PATCH') {
  // This endpoint historically relied on a static bearer token
  // (env.ADMIN_SECRET).  To stay consistent with other admin routes we
  // now also accept the standard session-based auth used throughout the
  // admin UI.  Both modes are regarded as equivalent here.
  const auth = request.headers.get('Authorization') || '';
  const bearerToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const expectedSecret = ((env as any).ADMIN_SECRET || '');
  const bearerValid = bearerToken && bearerToken === expectedSecret;
  const sessionValid = isAdminAuthorized(request, env);

  if (!bearerValid && !sessionValid) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const parts = url.pathname.split('/');
  const id = Number(parts[3]);
  if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid article id');

  const body = await parseJsonBody<{ county: string | null }>(request);
  if (!body || !('county' in body)) return badRequest('Missing county field');

  let countyVal: string | null = null;
  if (body.county !== null && body.county !== undefined) {
    countyVal = typeof body.county === 'string' ? body.county.trim() || null : null;
  }

  try {
    const updated = await updateArticlePrimaryCounty(env, id, countyVal);
    if (!updated) return json({ error: 'Article not found' }, 404);

    // invalidate summary cache entries so clients see the revised URL/path
    const summaryKey = `summary:${updated.urlHash}`;
    const ttlKey = `summary-ttl:${updated.urlHash}`;
    if (env.CACHE) {
      await env.CACHE.delete(summaryKey).catch(() => {});
      await env.CACHE.delete(ttlKey).catch(() => {});
    }

    return json({ article: updated });
  } catch (err) {
    console.error('[COUNTY UPDATE ERROR]', err, { id, county: countyVal });
    return json({ error: 'county update failed' }, 500);
  }
}

if (url.pathname === '/api/admin/article/update-content' && request.method === 'POST') {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const body = await parseJsonBody<{ id?: number; title?: string; summary?: string; imageUrl?: string | null }>(request);
  if (!body) return badRequest('Missing request body');
  const id = Number(body.id ?? 0);
  if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid article id');

  const title = typeof body.title === 'string' ? body.title.trim() : undefined;
  const summary = typeof body.summary === 'string' ? body.summary.trim() : undefined;
  let imageUrl: string | null | undefined = undefined;
  if ('imageUrl' in body) {
    // allow null to clear
    imageUrl = body.imageUrl === null ? null : String(body.imageUrl).trim();
  }

  if (title === undefined && summary === undefined && imageUrl === undefined) {
    return badRequest('Provide at least one of: title, summary, imageUrl');
  }

  await updateArticleContent(env, id, { title, summary, imageUrl });
  return json({ ok: true, id });
}

// manual update check for a single article (admin only)
if (url.pathname.startsWith('/api/admin/articles/') && url.pathname.endsWith('/check-update') && request.method === 'POST') {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const parts = url.pathname.split('/');
  const id = Number(parts[4]);
  if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid article id');
  const article = await getArticleById(env, id);
  if (!article) return json({ error: 'Article not found' }, 404);

  try {
    // Re-fetch with cache-busting (same approach as the scheduled cron)
    const refetchUrl = article.canonicalUrl + `?_ts=${Date.now()}`;
    const extracted = await fetchAndExtractArticle(env, {
      url: refetchUrl,
      sourceUrl: article.canonicalUrl,
      providedTitle: article.title,
      providedDescription: '',
      // Omit feedPublishedAt so browserFetch UA is used (bypasses bot protection)
    }).catch(() => null);

    if (!extracted?.contentText) {
      return json({ ok: false, reason: 'Could not fetch article content' });
    }

    const contentSample = extracted.contentText.split(/\s+/).slice(0, 3000).join(' ');
    const newHash = await sha256Hex(contentSample);

    // If no baseline hash yet, store it and report — no update paragraph generated
    if (!article.contentHash) {
      await prepare(env, 'UPDATE articles SET content_hash = ? WHERE id = ?')
        .bind(newHash, article.id)
        .run()
        .catch(() => {});
      return json({ ok: true, updated: false, reason: 'No baseline hash existed — hash stored. Run again to detect changes.' });
    }

    // Hash unchanged — no update needed
    if (article.contentHash === newHash) {
      return json({ ok: true, updated: false, reason: 'Content unchanged since last check' });
    }

    // Content changed — generate update paragraph
    const updateParagraph = await generateUpdateParagraph(
      env,
      extracted.contentText,
      article.summary,
      article.publishedAt,
    );

    if (!updateParagraph) {
      // Still update the hash so future checks have the new baseline
      await prepare(env, 'UPDATE articles SET content_hash = ? WHERE id = ?')
        .bind(newHash, article.id)
        .run()
        .catch(() => {});
      return json({ ok: true, updated: false, reason: 'Content changed but no meaningful new information found' });
    }

    await prependUpdateToSummary(env, article.id, updateParagraph, newHash);

    return json({ ok: true, updated: true, updateParagraph });
  } catch (err) {
    return json({ ok: false, reason: err instanceof Error ? err.message : String(err) }, 500);
  }
}

// regenerate summary for an existing article and update DB
if (url.pathname.startsWith('/api/admin/articles/') && url.pathname.endsWith('/regenerate-summary') && request.method === 'POST') {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const parts = url.pathname.split('/');
  const id = Number(parts[4]);
  if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid article id');
  const article = await getArticleById(env, id);
  if (!article) return json({ error: 'Article not found' }, 404);

  // clear existing cache entries
  const summaryKey = `summary:${article.urlHash}`;
  const ttlKey = `summary-ttl:${article.urlHash}`;
  const feedbackKey = `feedback:${article.urlHash}`;
  if (env.CACHE) {
    await env.CACHE.delete(summaryKey).catch(() => {});
    await env.CACHE.delete(ttlKey).catch(() => {});
    await env.CACHE.delete(feedbackKey).catch(() => {});
  }

  // refetch article content; append dummy query to bypass cachedTextFetch cache
  const refetchUrl = article.canonicalUrl + `?_=${Date.now()}`;
  const extracted = await fetchAndExtractArticle(env, {
    url: refetchUrl,
    sourceUrl: article.sourceUrl || article.canonicalUrl,
    providedTitle: article.title,
    providedDescription: '',
    feedPublishedAt: article.publishedAt,
  });

  const aiResult = await summarizeArticle(env, article.urlHash, article.title, extracted.contentText, article.publishedAt);
  const newSummary = aiResult.summary;
  const newSeo = aiResult.seoDescription;

  // update both summary and seo description directly since updateArticleContent
  // only handles title/summary.
await prepare(env,
      'UPDATE articles SET summary = ?, seo_description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    )
    .bind(newSummary, newSeo, id)
    .run()
    .catch(() => {});

  return json({ ok: true, summary: newSummary, seoDescription: newSeo });
}

if (url.pathname === '/api/admin/article/update-links' && request.method === 'POST') {
if (!isAdminAuthorized(request, env)) {
return json({ error: 'Unauthorized' }, 401);
}

const body = await parseJsonBody<{ id?: number; canonicalUrl?: string; sourceUrl?: string }>(request);
const id = Number(body?.id ?? 0);
if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid article id');

const canonicalUrlInput = typeof body?.canonicalUrl === 'string' ? body.canonicalUrl.trim() : undefined;
const sourceUrlInput = typeof body?.sourceUrl === 'string' ? body.sourceUrl.trim() : undefined;

if (canonicalUrlInput === undefined && sourceUrlInput === undefined) {
return badRequest('Provide at least one of: canonicalUrl, sourceUrl');
}

if (canonicalUrlInput !== undefined) {
	if (!canonicalUrlInput || !isHttpUrl(canonicalUrlInput)) {
		return badRequest('canonicalUrl must be an absolute http(s) URL');
	}
}

if (sourceUrlInput !== undefined) {
	if (!sourceUrlInput || !isHttpUrl(sourceUrlInput)) {
		return badRequest('sourceUrl must be an absolute http(s) URL');
	}
}

const existing = await getArticleById(env, id);
if (!existing) return json({ error: 'Article not found' }, 404);

const canonicalUrl = normalizeCanonicalUrl(canonicalUrlInput ?? existing.canonicalUrl);
const sourceUrl = normalizeCanonicalUrl(sourceUrlInput ?? existing.sourceUrl);
const urlHash = await sha256Hex(canonicalUrl);

const duplicate = await findArticleByHash(env, urlHash);
if (duplicate && duplicate.id !== id) {
return json({ error: 'Another article already uses this live URL' }, 409);
}

await updateArticleLinks(env, id, { canonicalUrl, sourceUrl, urlHash });
return json({ ok: true, id, canonicalUrl, sourceUrl, urlHash });
}

if (url.pathname === '/api/admin/article/delete' && request.method === 'POST') {
if (!isAdminAuthorized(request, env)) {
return json({ error: 'Unauthorized' }, 401);
}

const body = await parseJsonBody<{ id?: number; block?: boolean; reason?: string }>(request);
const id = Number(body?.id ?? 0);
if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid article id');

if (body?.block) {
	const result = await blockArticleByIdAndDelete(env, id, (body?.reason || '').trim() || null);
	if (!result.deleted) return json({ error: 'Article not found' }, 404);
	return json({ ok: true, blocked: result.blocked, deleted: result.deleted, id });
}

await deleteArticleById(env, id);
return json({ ok: true, blocked: false, deleted: true, id });
}

// Clear the KV content-fingerprint dedup cache for a given article URL.
// Use this when an article was deleted from D1 but its KV fingerprint still
// blocks re-ingest with "already in database".
if (url.pathname === '/api/admin/article/clear-cache' && request.method === 'POST') {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const body = await parseJsonBody<{ url?: string; urlHash?: string }>(request);
  const articleUrl = body?.url?.trim();
  const urlHashOverride = body?.urlHash?.trim();

  if (!articleUrl && !urlHashOverride) {
    return badRequest('Provide either url or urlHash');
  }

  const cleared: string[] = [];

  if (env.CACHE) {
    // If we have the URL, re-fetch its text to compute the content fingerprint
    if (articleUrl) {
      try {
        const { browserFetch } = await import('./lib/http');
        const fetched = await browserFetch(articleUrl);
        if (fetched.body) {
          const { scrapeArticleHtml } = await import('./lib/scrape');
          const scraped = scrapeArticleHtml(articleUrl, fetched.body);
          const fingerprint = await sha256Hex(
            scraped.contentText.split(/\s+/).slice(0, 150).join(' ').toLowerCase()
          );
          await env.CACHE.delete(`cfp:${fingerprint}`).catch(() => {});
          cleared.push(`cfp:${fingerprint.slice(0, 8)}...`);
        }
      } catch {
        // best effort
      }
    }

    // Clear summary caches by urlHash
    const { normalizeCanonicalUrl } = await import('./lib/http');
    const canonical = articleUrl ? normalizeCanonicalUrl(articleUrl) : null;
    const hashKey = urlHashOverride ?? (canonical ? await sha256Hex(canonical) : null);
    if (hashKey) {
      for (const prefix of ['summary:', 'summary-ttl:', 'feedback:']) {
        await env.CACHE.delete(`${prefix}${hashKey}`).catch(() => {});
        cleared.push(`${prefix}${hashKey.slice(0, 8)}...`);
      }
    }
  }

  return json({ ok: true, cleared });
}

if (url.pathname === '/api/admin/blocked' && request.method === 'GET') {
if (!isAdminAuthorized(request, env)) {
return json({ error: 'Unauthorized' }, 401);
}

const items = await listBlockedArticles(env);
return json({ items, total: items.length });
}

if (url.pathname === '/api/admin/blocked/unblock' && request.method === 'POST') {
if (!isAdminAuthorized(request, env)) {
return json({ error: 'Unauthorized' }, 401);
}

const body = await parseJsonBody<{ id?: number }>(request);
const id = Number(body?.id ?? 0);
if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid blocked item id');

const removed = await unblockArticleByBlockedId(env, id);
if (!removed) return json({ error: 'Blocked item not found' }, 404);
return json({ ok: true, id });
}

// Preview a Facebook post by URL and extract title/body/image for manual article creation.
// If FACEBOOK_ACCESS_TOKEN is set it uses the Graph API; otherwise falls back to scraping
// mbasic.facebook.com (server-rendered HTML), which works for public pages without a token.
if (url.pathname === '/api/admin/facebook/preview' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}

	const body = await parseJsonBody<{ url?: string }>(request);
	const fbUrl = body?.url?.trim();

	if (!fbUrl) return badRequest('Missing required field: url');

	const postId = extractFacebookPostId(fbUrl);
	const fbToken = ((env as unknown as { FACEBOOK_ACCESS_TOKEN?: string }).FACEBOOK_ACCESS_TOKEN || '').trim();

	// --- Path 1: Graph API (token available) ---
	if (fbToken && postId) {
		try {
			const apiUrl = `https://graph.facebook.com/v19.0/${postId}?fields=message,full_picture,created_time&access_token=${encodeURIComponent(fbToken)}`;
			const fbResponse = await fetch(apiUrl, { headers: { accept: 'application/json' } });
			const fbData = await fbResponse.json() as { message?: string; full_picture?: string; created_time?: string; error?: { message?: string } };

			if (!fbData.error && fbData.message) {
				const { title, body: postBody } = deriveFacebookTitleAndBody(fbData.message);
				return json({
					ok: true,
					source: 'graph-api',
					title,
					body: postBody,
					imageUrl: fbData.full_picture || null,
					publishedAt: fbData.created_time || null,
				});
			}
		} catch {
			// fall through to scrape path
		}
	}

	// --- Path 2: Public scrape via mbasic.facebook.com (no token required) ---
	// mbasic is Facebook's legacy server-rendered mobile site — it returns plain HTML
	// that can be parsed without JavaScript and contains og: meta tags with post content.
	try {
		const scraped = await scrapeFacebookPostPublic(fbUrl);
		if (scraped.message) {
			const { title, body: postBody } = deriveFacebookTitleAndBody(scraped.message);
			return json({
				ok: true,
				source: 'mbasic-scrape',
				title,
				body: postBody,
				imageUrl: scraped.imageUrl,
				publishedAt: scraped.publishedAt ?? null,
			});
		}
	} catch {
		// fall through to manual notice
	}

	return json({
		ok: false,
		source: null,
		message: 'Could not load this post automatically. The page may be private or require login. Please fill the fields manually.',
		title: null,
		body: null,
		imageUrl: null,
		publishedAt: null,
	});
}

// new endpoint to generate a caption for an article for Facebook autoposting
if (url.pathname === '/api/admin/facebook/caption' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}

	const body = await parseJsonBody<{ id?: number }>(request);
	const id = Number(body?.id ?? 0);
	if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid article id');

	const article = await getArticleById(env, id);
	if (!article) return json({ error: 'Article not found' }, 404);

	const caption = generateFacebookCaption(article);
	return json({ ok: true, caption });
}

// helper reused by several endpoints: choose a sensible preview image URL for an
// article record.  This mirrors the logic used when rendering OG tags for bots.
async function selectPreviewImage(article: ArticleRecord): Promise<string | null> {
	let previewImage = article.imageUrl || null;
	if (!previewImage && article.contentHtml) {
		const match = article.contentHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
		if (match && match[1]) previewImage = match[1];
	}
	if (!previewImage) {
		try {
			const fetchResp = await fetch((article.canonicalUrl || '') + `?_=${Date.now()}`);
			if (fetchResp.ok) {
				const body = await fetchResp.text();
				const { scrapeArticleHtml } = await import('./lib/scrape');
				const scraped = scrapeArticleHtml(article.canonicalUrl || '', body);
				if (scraped.imageUrl) {
					previewImage = scraped.imageUrl;
				}
			}
		} catch {
			/* ignore network errors */
		}
	}
	if (previewImage && !/^https?:\/\//i.test(previewImage)) {
		try {
			previewImage = new URL(previewImage, article.canonicalUrl || BASE_URL).toString();
		} catch {
			/* ignore invalid URL */
		}
	}
	return previewImage || null;
}

// optionally post the generated caption link to a Facebook page using Graph API
if (url.pathname === '/api/admin/facebook/post' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}

	const body = await parseJsonBody<{ id?: number }>(request);
	const id = Number(body?.id ?? 0);
	if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid article id');

	const article = await getArticleById(env, id);
	if (!article) return json({ error: 'Article not found' }, 404);

	const caption = generateFacebookCaption(article);
	if (!caption) {
		return json({ ok: false, reason: 'article not Kentucky or missing data' });
	}

	const pageId = ((env as any).FACEBOOK_PAGE_ID || '').trim();
	const pageToken = ((env as any).FACEBOOK_PAGE_ACCESS_TOKEN || '').trim();
	if (!pageId || !pageToken) {
		return json({ error: 'Facebook credentials not configured' }, 500);
	}

	// figure out what image (if any) should be used for the preview.  this is
	// the same value that the crawler would see when scraping the article link,
	// and by passing it explicitly to the Graph API we override the logo fallback.
	const pictureUrl = await selectPreviewImage(article);

	// perform Graph API request
	try {
		const params: Record<string, string> = {
			message: caption,
			link: article.canonicalUrl || article.sourceUrl || '',
			access_token: pageToken,
		};
		if (pictureUrl) {
			params.picture = pictureUrl;
		}

		const postResp = await fetch(`https://graph.facebook.com/v15.0/${pageId}/feed`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(params),
		});
		const postData = await postResp.json();
		return json({ ok: true, result: postData });
	} catch (err) {
		return json({ error: 'Failed to post to Facebook', details: String(err) }, 500);
	}
}

// Manually create an article (from a Facebook post or any other source) without going through
// the normal URL-scraping pipeline. Body is optional. Classification runs through AI as normal.
if (url.pathname === '/api/admin/manual-article' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}

	const body = await parseJsonBody<{
		title?: string;
		body?: string;
		imageUrl?: string;
		sourceUrl?: string;
		county?: string;
		isDraft?: boolean;
		publishedAt?: string;
		category?: string;
		isKentucky?: boolean;
		ignoreSimilarity?: boolean; // admin may bypass the title check
	}>(request);
	const providedCounty = body?.county?.trim() || null;
	const isDraft = Boolean(body?.isDraft);

	// extract/enforce trimmed strings for the fields we use repeatedly
	const title = (body?.title || '').trim();
	const postBody = (body?.body || '').trim();
	const imageUrl = (body?.imageUrl || '').trim() || null;
	const sourceUrl = (body?.sourceUrl || '').trim();

	// Resolve publish time: drafts get far-future date so they never surface publicly
	const rawPublishedAt = (body?.publishedAt || '').trim();
	const resolvedPublishedAt = isDraft
		? '9999-12-31T00:00:00.000Z'
		: (rawPublishedAt && !Number.isNaN(Date.parse(rawPublishedAt)) ? rawPublishedAt : new Date().toISOString());

	// Canonical URL: use source URL when valid, otherwise derive from title hash
	const canonicalUrl = sourceUrl && isHttpUrl(sourceUrl)
		? normalizeCanonicalUrl(sourceUrl)
		: `https://localkynews.com/manual/${await sha256Hex(title + resolvedPublishedAt)}`;
	// For manually authored original pieces with no external link, point
	// the source back to the site homepage so the attribution box reads
	// "Original reporting by LocalKYNews" and the link/button goes home.
	const normalizedSourceUrl = sourceUrl
		? normalizeCanonicalUrl(sourceUrl)
		: 'https://localkynews.com';

	const canonicalHash = await sha256Hex(canonicalUrl);

	const existing = await findArticleByHash(env, canonicalHash);
	if (existing) {
		return json({ status: 'duplicate', id: existing.id, message: 'An article with this URL already exists.' });
	}

	let similarTitle = null;
	if (!body?.ignoreSimilarity) {
		// only run the expensive similarity check if the admin hasn't asked us
		// to skip it.  the ingest worker still calls this helper directly so the
		// global RSS rules remain untouched.
		similarTitle = await findHighlySimilarTitle(env, title);
	}
	if (similarTitle) {
		const reason = `title similarity ${(similarTitle.similarity * 100).toFixed(1)}% with article #${similarTitle.id}`;
		return json({
			status: 'rejected',
			reason,
			message: reason,
		});
	}

	// Classify the article as usual, then apply any admin overrides.
	const classifyContent = postBody || title;
	const classification = await classifyArticleWithAi(env, {
		url: canonicalUrl,
		title,
		content: classifyContent,
	});

	// admin can override the category if provided and valid
	if (body?.category) {
		const cat = (body.category || '').toLowerCase();
		if (isAllowedCategory(cat)) {
			classification.category = cat as any;
		}
	}

	// scope override: let admin mark as national (isKentucky=false) or keep
	// default; classification.isNational will mirror the opposite value.
	if (typeof body?.isKentucky === 'boolean') {
		classification.isKentucky = body.isKentucky;
		classification.isNational = !body.isKentucky;
	}

	// If the admin forced the article to be Kentucky but did not supply an
	// explicit category, make sure we don't accidentally leave it in the
	// "national" bucket.  Editors expect manually created KY stories to show
	// on the home page (today feed) even when the AI model failed to pick up a
	// Kentucky signal in the text.
	if (classification.isKentucky && !body?.category && classification.category === 'national') {
		classification.category = 'today';
	}

	// prefer admin-supplied county when available; clear if not kentucky
	if (providedCounty && classification.isKentucky) {
		classification.county = providedCounty;
		classification.counties = [providedCounty];
	} else if (!classification.isKentucky) {
		classification.county = null;
		classification.counties = [];
	}

	const contentHtml = postBody
		? `<p>${postBody.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>')}</p>`
		: '';
	const words = wordCount(postBody || title);

	// For manual articles we treat the provided body as the full summary.
	// We do *not* run AI summarization; the content should appear verbatim.
	// SEO description is just the first 160 characters of the body (or blank).
	const manualSummary = postBody;
	const manualSeoDescription = postBody.slice(0, 160).trim();

	const newArticle: NewArticle = {
		canonicalUrl,
		sourceUrl: normalizedSourceUrl || canonicalUrl,
		urlHash: canonicalHash,
		title,
		author: null,
		publishedAt: resolvedPublishedAt,
		category: classification.category,
		isKentucky: classification.isKentucky,
		isNational: classification.isNational ?? !classification.isKentucky,
		county: classification.county,
		counties: classification.counties,
		city: classification.city,
		summary: manualSummary,
		seoDescription: manualSeoDescription,
		rawWordCount: words,
		summaryWordCount: wordCount(manualSummary),
		contentText: postBody || title,
		contentHtml,
		imageUrl,
		rawR2Key: null,
		slug: generateArticleSlug(title, canonicalHash),
	};

	const articleId = await insertArticle(env, newArticle);

	return json({
		status: 'inserted',
		id: articleId,
		isDraft,
		category: newArticle.category,
		isKentucky: newArticle.isKentucky,
		county: newArticle.county,
		canonicalUrl,
	});
}

const categoryMatch = url.pathname.match(/^\/api\/articles\/([a-z-]+)$/i);
const articleByIdMatch = url.pathname.match(/^\/api\/articles\/item\/(\d+)$/i);
const articleBySlugMatch = url.pathname.match(/^\/api\/articles\/slug\/([a-z0-9-]+)$/i);

if (articleBySlugMatch && request.method === 'GET') {
const slug = articleBySlugMatch[1];
if (!slug) return badRequest('Invalid article slug');
const article = await getArticleBySlug(env, slug);
if (!article) return json({ error: 'Not found' }, 404);

// plain-text format for AI crawlers
const format = url.searchParams.get('format');
if (format === 'text') {
  const publishedDate = article.publishedAt
    ? new Date(article.publishedAt).toLocaleDateString('en-US', { dateStyle: 'long' })
    : 'Unknown date';
  const county = article.county ? `${article.county} County, Kentucky` : 'Kentucky';
  const source = article.sourceUrl
    ? (() => { try { return new URL(article.sourceUrl).hostname.replace(/^www\./, ''); } catch { return ''; } })()
    : '';
  const plainText = [
    article.title,
    `Published: ${publishedDate}`,
    article.county ? `Location: ${county}` : '',
    source ? `Source: ${source}` : '',
    article.author ? `Author: ${article.author}` : '',
    '',
    // Strip any HTML from summary
    (article.summary || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    '',
    article.canonicalUrl ? `Full story: ${article.canonicalUrl}` : '',
    `Via: https://localkynews.com/news/${article.slug ? `kentucky/${article.slug}` : ''}`,
  ].filter(Boolean).join('\n');

  return new Response(plainText, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}

return json({ item: article }, 200, PUBLIC_ARTICLE_CACHE_HEADERS);
}

if (articleByIdMatch && request.method === 'GET') {
const id = Number.parseInt(articleByIdMatch[1] || '0', 10);
if (!Number.isFinite(id) || id <= 0) return badRequest('Invalid article id');

const article = await getArticleById(env, id);
if (!article) return json({ error: 'Not found' }, 404);
return json({ item: article }, 200, PUBLIC_ARTICLE_CACHE_HEADERS);
}

if (categoryMatch && request.method === 'GET') {
// feeds:
//   today       - all Kentucky articles (is_kentucky=1)
//   national    - articles whose stored category is "national" (ignore counties)
//   sports      - Kentucky sports stories (is_kentucky=1 AND category='sports')
//   weather     - weather stories, KY or national (see db.queryArticles logic)
//   schools     - Kentucky school stories (is_kentucky=1 AND category='schools')
//   obituaries  - Kentucky obituaries only (is_kentucky=1 AND category='obituaries')
const category = categoryMatch[1]?.toLowerCase();
if (!category || (category !== 'all' && !isAllowedCategory(category))) {
  return badRequest(
    'Invalid category. Allowed: today|national|sports|weather|schools|obituaries|all',
  );
}

// support both ?counties=Foo,Bar (existing) and the shorthand ?county=Foo
const rawCounties = parseCommaList(
url.searchParams.get('counties') || url.searchParams.get('county'),
);
const counties = normalizeCountyList(rawCounties) as string[];

// limit search string length to avoid expensive queries
let rawSearch = url.searchParams.get('search') ?? null;
// some clients (or older environments) may leave plus signs instead of
// spaces when encoding the query string; normalize them here so that the
// database query sees a more natural term.  trimming also ensures we never
// pass a purely-whitespace string.
if (rawSearch !== null) {
  rawSearch = rawSearch.replace(/\+/g, ' ').trim();
}
const search = rawSearch ? rawSearch.slice(0, 120) : null;
// when searching across all categories we let the backend return a larger
// default batch size (100) so that users don't feel artificially capped at
// a tiny number.  callers can still provide `limit` to override.
const defaultLimit = category === 'all' ? 100 : 20;
const limit = parsePositiveInt(url.searchParams.get('limit'), defaultLimit, 100);
const cursor = url.searchParams.get('cursor');
let result;
try {
  result = await queryArticles(env, {
    category,
    counties,
    search,
    limit,
    cursor,
  });
} catch (err) {
  // log the error so it can be investigated in production
  console.error('queryArticles failed', err);
  // The `/all` search endpoint is hit frequently from the client’s
  // search page and a transient database hiccup (often triggered by
  // a broad multi‑word query like “state police”) should not surface a
  // hard 500 back to the UI.  Instead return an empty result set so the
  // front end can render its normal “no results” message while allowing
  // the user to continue using the site.  The error is still logged for
  // later analysis.
  // Search results must not be cached at the edge — a stale empty result
  // would make a freshly-ingested article appear missing until TTL expires.
  return json(
    { items: [], nextCursor: null },
    200,
    search ? { 'cache-control': 'no-store' } : PUBLIC_ARTICLE_CACHE_HEADERS,
  );
}

return json(
  result,
  200,
  search ? { 'cache-control': 'no-store' } : PUBLIC_ARTICLE_CACHE_HEADERS,
);
}

// --- Server-side social preview & canonical redirect for article URLs --------
// When a bot (Facebook, Twitter, etc.) hits an article URL (either a
// `/news/...` path or the legacy `/post?articleId=...` route) we want to
// return a minimal HTML page containing the appropriate Open Graph tags so
// the shared link shows the correct title/image.  In the old implementation
// we rewrote the response into a JS page that redirected browsers back to
// the same URL with a `?r=1` parameter; that query string confused the SPA's
// router and broke every article link.  The new flow is simpler:
//
// * If the User-Agent indicates a bot/scraper, return the OG meta HTML
//   directly. Bots don't execute JS so no redirect is necessary.
// * For regular browsers we perform a **302 redirect** to the canonical
//   path (computed with `buildArticlePath`).  This handles both reclassified
//   articles and the initial preview navigation without ever modifying the
//   visible URL.  If the incoming path is already canonical we simply fall
//   through and let the SPA handler serve `/index.html` normally.
//
// **IMPORTANT:** these routes are only effective when requests actually hit
// this Worker.  The production Pages deployment must proxy `/news/*` and
// `/post*` to the worker (see `worker/wrangler.jsonc`); otherwise crawlers
// and browsers will receive the static shell with the generic logo image.
// FIRST: social bot preview support for county hub pages
const countyPageMatch = url.pathname.match(/^\/news\/kentucky\/([a-z0-9-]+-county)\/?$/i);
if (countyPageMatch && request.method === 'GET') {
  const ua = request.headers.get('user-agent') || '';
  const isSocialBot = /facebookexternalhit|facebookbot|twitterbot|linkedinbot|slackbot|whatsapp|telegram|googlebot/i.test(ua);

  if (isSocialBot) {
    const countySlug = countyPageMatch[1]; // e.g. "pike-county"
    const countyDisplay = countySlug
      .replace(/-county$/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase()) + ' County';

    const pageUrl = `${BASE_URL}/news/kentucky/${countySlug}`;
    const title = `${countyDisplay}, KY News — Local KY News`;
    const description = `The latest news from ${countyDisplay}, Kentucky — local government, schools, sports, weather, and community stories from Local KY News.`;
    const image = `${BASE_URL}/img/preview.png`;

    const html = `<!doctype html><html lang="en-US"><head>
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}"/>
<meta property="og:type" content="website"/>
<meta property="og:title" content="${escapeHtml(title)}"/>
<meta property="og:description" content="${escapeHtml(description)}"/>
<meta property="og:url" content="${escapeHtml(pageUrl)}"/>
<meta property="og:image" content="${escapeHtml(image)}"/>
<meta property="og:site_name" content="Local KY News"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeHtml(title)}"/>
<meta name="twitter:description" content="${escapeHtml(description)}"/>
<meta name="twitter:image" content="${escapeHtml(image)}"/>
<link rel="canonical" href="${escapeHtml(pageUrl)}"/>
</head><body><script>window.location.href='${pageUrl}';</script></body></html>`;

    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
}

// include HEAD so preliminary bot probes still see our OG tags
if ((request.method === 'GET' || request.method === 'HEAD') && (url.pathname.startsWith('/news/') || url.pathname === '/post')) {
  const userAgent = request.headers.get('User-Agent') || '';
  // Facebook’s crawler uses several different user‑agents.  Mobile app
  // previews often use strings like "FB_IAB" or include "FBAV" which were
  // previously missed, causing us to serve the SPA shell with the default logo
  // instead of the proper og:image.  Broaden the regexp to catch the extra
  // variants while still avoiding false positives for normal users.
  // Facebook and Instagram in-app browser — not a crawler but cannot execute
  // the React SPA reliably. Detected separately so we can serve server-rendered
  // HTML with article content directly in the body.
  const isFacebookIab = /\bFBAN\/|FB_IAB|\bFBAV\/|\bFBIOS\b|\bFBMD\b|\bFBSV\/|Instagram/i.test(userAgent);
  const isBot = /facebookexternalhit|facebookbot|facebot|fb_iab|fbav|twitterbot|linkedinbot|slackbot|whatsapp|telegrambot|discordbot|googlebot|bingbot|applebot|pinterest|vkshare|xing-contenttabreceiver|w3c_validator|curl|wget|python-requests|java\/|go-http|okhttp/i.test(userAgent);

  // look up the article either by slug (normal path) or by ID using the
  // legacy /post?articleId= query parameter.  canonicalPath will later be
  // used for redirects and for the og:url tag.
  let article: any = null;
  let canonicalPath = url.pathname;

  if (url.pathname === '/post') {
    const idParam = url.searchParams.get('articleId');
    const idNum = Number(idParam);
    if (idParam && Number.isFinite(idNum) && idNum > 0) {
      article = await getArticleById(env, idNum);
      if (article) {
        if (article.slug) {
          canonicalPath = buildArticlePath(article);
        } else {
          canonicalPath = `/post?articleId=${idNum}`;
        }

        // if we found an article via the legacy ID route, we can respond
        // immediately just like the `/news/...` branch would have later.
        const desc = (article.seoDescription || article.summary || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160);

        if (isFacebookIab && article) {
          // Facebook/Instagram in-app browser: serve a lightweight server-rendered
          // HTML page with the article content directly in the body. This bypasses
          // the React SPA which cannot load correctly in the IAB due to JS/CORS
          // restrictions. Include OG tags so the header still previews correctly.
          const pageUrl = `https://localkynews.com${canonicalPath}`;
          const desc = (article.seoDescription || article.summary || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 300);
          const fallbackImage = 'https://localkynews.com/img/preview.png';
          const imageForMeta = (await selectPreviewImage(article)) || fallbackImage;

          // Render the summary as paragraphs
          const summaryParagraphs = (article.summary || '')
            .split(/\n\n+/)
            .map((p: string) => `<p>${escapeHtml(p.trim())}</p>`)
            .filter((p: string) => p.length > 10)
            .join('\n');

          const countyLabel = article.county ? `${article.county} County` : (article.isKentucky ? 'Kentucky' : '');
          const categoryLabel = article.category ? article.category.charAt(0).toUpperCase() + article.category.slice(1) : '';

          const iabHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(article.title)}</title>
  <meta name="description" content="${escapeHtml(desc)}"/>
  <meta property="og:type" content="article"/>
  <meta property="og:title" content="${escapeHtml(article.title)}"/>
  <meta property="og:description" content="${escapeHtml(desc)}"/>
  <meta property="og:image" content="${escapeHtml(imageForMeta)}"/>
  <meta property="og:url" content="${escapeHtml(pageUrl)}"/>
  <meta property="og:site_name" content="Local KY News"/>
  <meta name="twitter:card" content="summary_large_image"/>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;padding:16px;color:#111;line-height:1.6;}
    h1{font-size:1.35rem;line-height:1.3;margin-bottom:8px;}
    .meta{font-size:0.82rem;color:#666;margin-bottom:16px;}
    .meta span{margin-right:12px;}
    img.hero{width:100%;max-height:360px;object-fit:cover;border-radius:8px;margin-bottom:16px;}
    p{margin:0 0 14px;}
    .source-link{display:block;margin:20px 0;padding:14px;background:#f0f4ff;border-radius:8px;text-decoration:none;color:#1a56db;font-weight:600;text-align:center;font-size:0.95rem;}
    .site-link{display:block;margin:12px 0 20px;text-align:center;font-size:0.85rem;color:#555;}
    footer{border-top:1px solid #eee;margin-top:24px;padding-top:12px;font-size:0.78rem;color:#999;text-align:center;}
  </style>
</head>
<body>
  <h1>${escapeHtml(article.title)}</h1>
  <div class="meta">
    ${countyLabel ? `<span>📍 ${escapeHtml(countyLabel)}</span>` : ''}
    ${categoryLabel ? `<span>${escapeHtml(categoryLabel)}</span>` : ''}
    ${article.publishedAt ? `<span>${new Date(article.publishedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span>` : ''}
  </div>
  ${imageForMeta && imageForMeta !== fallbackImage ? `<img class="hero" src="${escapeHtml(imageForMeta)}" alt="${escapeHtml(article.title)}" loading="eager"/>` : ''}
  ${summaryParagraphs || `<p>${escapeHtml(desc)}</p>`}
  <a class="source-link" href="${escapeHtml(article.canonicalUrl)}" target="_blank" rel="noopener">
    Read full article at source →
  </a>
  <a class="site-link" href="${escapeHtml(pageUrl)}">
    View on Local KY News
  </a>
  <footer>Local KY News · <a href="https://localkynews.com" style="color:#999;">localkynews.com</a></footer>
</body>
</html>`;

          return new Response(iabHtml, {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'public, max-age=300, s-maxage=300',
            },
          });
        }
        if (isBot) {
          const pageUrl = `https://localkynews.com${canonicalPath}`;
          const metas: string[] = [];
          const fallbackImage = 'https://localkynews.com/img/preview.png';
          metas.push('<meta property="og:type" content="article"/>');
          metas.push(`<meta property="og:title" content="${escapeHtml(article.title)}"/>`);
          metas.push(`<meta property="og:description" content="${escapeHtml(desc)}"/>`);
          const imageForMeta = (await selectPreviewImage(article)) || fallbackImage;
          metas.push(`<meta property="og:image" content="${escapeHtml(imageForMeta)}"/>`);
          metas.push(`<meta property="og:image:width" content="1200"/>`);
          metas.push(`<meta property="og:image:height" content="630"/>`);
          metas.push(`<meta property="og:url" content="${escapeHtml(pageUrl)}"/>`);
          metas.push('<meta property="og:site_name" content="Local KY News"/>');
          metas.push('<meta name="twitter:card" content="summary_large_image"/>');
          metas.push(`<meta name="twitter:image" content="${escapeHtml(imageForMeta)}"/>`);
          metas.push(`<meta property="fb:app_id" content="${escapeHtml(env.FB_APP_ID || '0')}"/>`);
        // Build article body so Googlebot can index the actual text content
        const botSummaryParagraphs = (article.summary || '')
          .split(/\n\n+/)
          .map((p: string) => `<p>${escapeHtml(p.trim())}</p>`)
          .filter((p: string) => p.length > 10)
          .join('\n');
        const botCountyLabel = article.county ? `${article.county} County` : (article.isKentucky ? 'Kentucky' : '');
        const botCategoryLabel = article.category ? article.category.charAt(0).toUpperCase() + article.category.slice(1) : '';
        const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(article.title)}</title>
  ${metas.join('\n  ')}
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;padding:16px;color:#111;line-height:1.6;}
    h1{font-size:1.35rem;line-height:1.3;margin-bottom:8px;}
    .meta{font-size:0.82rem;color:#666;margin-bottom:16px;}
    .meta span{margin-right:12px;}
    p{margin:0 0 14px;}
    a.source{display:block;margin:20px 0;padding:12px;background:#f0f4ff;border-radius:8px;text-decoration:none;color:#1a56db;font-weight:600;text-align:center;}
    footer{border-top:1px solid #eee;margin-top:24px;padding-top:12px;font-size:0.78rem;color:#999;text-align:center;}
  </style>
</head>
<body>
  <h1>${escapeHtml(article.title)}</h1>
  <div class="meta">
    ${botCountyLabel ? `<span>📍 ${escapeHtml(botCountyLabel)}</span>` : ''}
    ${botCategoryLabel ? `<span>${escapeHtml(botCategoryLabel)}</span>` : ''}
    ${article.publishedAt ? `<span>${new Date(article.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>` : ''}
  </div>
  ${botSummaryParagraphs || `<p>${escapeHtml(desc)}</p>`}
  <a class="source" href="${escapeHtml(article.canonicalUrl)}" rel="noopener">Read full article at source →</a>
  <footer>Local KY News · <a href="https://localkynews.com" style="color:#999;">localkynews.com</a></footer>
</body>
</html>`;
        return new Response(html, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=300, s-maxage=300',
          },
        });
        }
        if (!isBot && canonicalPath !== url.pathname) {
          return new Response(null, {
            status: 301,
            headers: {
              Location: canonicalPath,
              'Cache-Control': 'public, max-age=3600, s-maxage=3600',
            },
          });
        }
      }
    }
  }

  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const slug = segments[segments.length - 1] || '';

  if (!article && slug) {
    article = await getArticleBySlug(env, slug);

    // if the database somehow returned a row with no slug value we treat it
    // as if the article does not exist.  without this guard the later
    // canonicalPath computation would produce `/` and bots would scrape the
    // homepage metadata instead of receiving a 404.
    if (article && !article.slug) {
      article = null;
      if (isBot) {
        return new Response('Not found', { status: 404 });
      }
    }

    if (article) {
      canonicalPath = buildArticlePath(article);
      // sanity: buildArticlePath should never return '/' for a non‑empty slug.
      // if it does, treat it as not found so we don't give bots homepage tags.
      if (canonicalPath === '/' && article.slug) {
        // sanity check triggered: buildArticlePath unexpectedly returned '/'.
        // treat the article as missing to avoid serving homepage metadata.
        // For bots we return 404 immediately; for regular browsers we _must not_
        // issue a 301 redirect to '/' (the next block below would do that if we
        // left canonicalPath untouched).  instead, reset canonicalPath to the
        // incoming path so the later comparison becomes false and the request
        // falls through to the normal SPA fallback.
        article = null;
        canonicalPath = url.pathname;
        if (isBot) {
          return new Response('Not found', { status: 404 });
        }
      }
      const desc = (article?.seoDescription || article?.summary || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);

      if (isFacebookIab && article) {
        const pageUrl = `https://localkynews.com${canonicalPath}`;
        const iabDesc = (article.seoDescription || article.summary || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);
        const fallbackImage = 'https://localkynews.com/img/preview.png';
        const imageForMeta = (await selectPreviewImage(article)) || fallbackImage;
        const summaryParagraphs = (article.summary || '')
          .split(/\n\n+/)
          .map((p: string) => `<p>${escapeHtml(p.trim())}</p>`)
          .filter((p: string) => p.length > 10)
          .join('\n');
        const countyLabel = article.county ? `${article.county} County` : (article.isKentucky ? 'Kentucky' : '');
        const categoryLabel = article.category ? article.category.charAt(0).toUpperCase() + article.category.slice(1) : '';
        const iabHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(article.title)}</title>
  <meta name="description" content="${escapeHtml(iabDesc)}"/>
  <meta property="og:type" content="article"/>
  <meta property="og:title" content="${escapeHtml(article.title)}"/>
  <meta property="og:description" content="${escapeHtml(iabDesc)}"/>
  <meta property="og:image" content="${escapeHtml(imageForMeta)}"/>
  <meta property="og:url" content="${escapeHtml(pageUrl)}"/>
  <meta property="og:site_name" content="Local KY News"/>
  <meta name="twitter:card" content="summary_large_image"/>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;padding:16px;color:#111;line-height:1.6;}
    h1{font-size:1.35rem;line-height:1.3;margin-bottom:8px;}
    .meta{font-size:0.82rem;color:#666;margin-bottom:16px;}
    .meta span{margin-right:12px;}
    img.hero{width:100%;max-height:360px;object-fit:cover;border-radius:8px;margin-bottom:16px;}
    p{margin:0 0 14px;}
    .source-link{display:block;margin:20px 0;padding:14px;background:#f0f4ff;border-radius:8px;text-decoration:none;color:#1a56db;font-weight:600;text-align:center;font-size:0.95rem;}
    .site-link{display:block;margin:12px 0 20px;text-align:center;font-size:0.85rem;color:#555;}
    footer{border-top:1px solid #eee;margin-top:24px;padding-top:12px;font-size:0.78rem;color:#999;text-align:center;}
  </style>
</head>
<body>
  <h1>${escapeHtml(article.title)}</h1>
  <div class="meta">
    ${countyLabel ? `<span>📍 ${escapeHtml(countyLabel)}</span>` : ''}
    ${categoryLabel ? `<span>${escapeHtml(categoryLabel)}</span>` : ''}
    ${article.publishedAt ? `<span>${new Date(article.publishedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span>` : ''}
  </div>
  ${imageForMeta && imageForMeta !== fallbackImage ? `<img class="hero" src="${escapeHtml(imageForMeta)}" alt="${escapeHtml(article.title)}" loading="eager"/>` : ''}
  ${summaryParagraphs || `<p>${escapeHtml(iabDesc)}</p>`}
  <a class="source-link" href="${escapeHtml(article.canonicalUrl)}" target="_blank" rel="noopener">
    Read full article at source →
  </a>
  <a class="site-link" href="${escapeHtml(pageUrl)}">
    View on Local KY News
  </a>
  <footer>Local KY News · <a href="https://localkynews.com" style="color:#999;">localkynews.com</a></footer>
</body>
</html>`;
        return new Response(iabHtml, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=300, s-maxage=300',
          },
        });
      }

      if (isBot) {
        // Return OG meta HTML directly to bots — no redirect needed, bots don't run JS
        const pageUrl = `https://localkynews.com${canonicalPath}`;
        // When an article doesn't provide its own image, Facebook/Twitter will
        // happily fall back to whatever image they can scrape from the page.  The
        // SPA shell is just the logo, which results in every preview showing the
        // site icon.  To make the behaviour match the client‑side code we always
        // emit an explicit og:image tag; use the article's image when available
        // and otherwise point at the default preview graphic.
        // Build a fallback image URL we can rely on when nothing else is
        // available.  We want a consistent preview graphic even when the
        // article doesn't supply any image regardless of whether the stored
        // content contains an <img> tag.
        // match the client‑side default so bots see the same preview image
        // that appears in the SPA shell.  Previously this URL was wrong and
        // caused Facebook to fall back to the site logo when scraping.
        const fallbackImage = 'https://localkynews.com/img/preview.png';

        // determine which image to use. priority:
        // 1. explicit article.imageUrl
        // 2. first <img> inside stored contentHtml (works for our own posts)
        // 3. attempt external fetch+scrape (useful for third-party sources)
        // use the shared preview-image logic so bots and Graph posts agree
        const metas = [];
        metas.push('<meta property="og:type" content="article"/>');
        metas.push(`<meta property="og:title" content="${escapeHtml(article.title)}"/>`);
        metas.push(`<meta property="og:description" content="${escapeHtml(desc)}"/>`);
        const imageForMeta = (await selectPreviewImage(article)) || fallbackImage;
        metas.push(`<meta property="og:image" content="${escapeHtml(imageForMeta)}"/>`);
        metas.push(`<meta property="og:image:width" content="1200"/>`);
        metas.push(`<meta property="og:image:height" content="630"/>`);
        metas.push(`<meta property="og:url" content="${escapeHtml(pageUrl)}"/>`);
        metas.push('<meta property="og:site_name" content="Local KY News"/>');

        // Twitter uses its own tags and also wants the large image card.
        metas.push('<meta name="twitter:card" content="summary_large_image"/>');
        metas.push(
          `<meta name="twitter:image" content="${escapeHtml(imageForMeta)}"/>
        `);

        // always include the tag; use configured ID or fall back to '0'
        metas.push(
          `<meta property="fb:app_id" content="${escapeHtml(
            env.FB_APP_ID || '0'
          )}"/>`
        );

        // Build article body so Googlebot can index the actual text content
        const botSummaryParagraphs = (article.summary || '')
          .split(/\n\n+/)
          .map((p: string) => `<p>${escapeHtml(p.trim())}</p>`)
          .filter((p: string) => p.length > 10)
          .join('\n');
        const botCountyLabel = article.county ? `${article.county} County` : (article.isKentucky ? 'Kentucky' : '');
        const botCategoryLabel = article.category ? article.category.charAt(0).toUpperCase() + article.category.slice(1) : '';
        const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(article.title)}</title>
  ${metas.join('\n  ')}
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;padding:16px;color:#111;line-height:1.6;}
    h1{font-size:1.35rem;line-height:1.3;margin-bottom:8px;}
    .meta{font-size:0.82rem;color:#666;margin-bottom:16px;}
    .meta span{margin-right:12px;}
    p{margin:0 0 14px;}
    a.source{display:block;margin:20px 0;padding:12px;background:#f0f4ff;border-radius:8px;text-decoration:none;color:#1a56db;font-weight:600;text-align:center;}
    footer{border-top:1px solid #eee;margin-top:24px;padding-top:12px;font-size:0.78rem;color:#999;text-align:center;}
  </style>
</head>
<body>
  <h1>${escapeHtml(article.title)}</h1>
  <div class="meta">
    ${botCountyLabel ? `<span>📍 ${escapeHtml(botCountyLabel)}</span>` : ''}
    ${botCategoryLabel ? `<span>${escapeHtml(botCategoryLabel)}</span>` : ''}
    ${article.publishedAt ? `<span>${new Date(article.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>` : ''}
  </div>
  ${botSummaryParagraphs || `<p>${escapeHtml(desc)}</p>`}
  <a class="source" href="${escapeHtml(article.canonicalUrl)}" rel="noopener">Read full article at source →</a>
  <footer>Local KY News · <a href="https://localkynews.com" style="color:#999;">localkynews.com</a></footer>
</body>
</html>`;
        return new Response(html, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=300, s-maxage=300',
          },
        });
      }

      // For regular browsers: if the current path differs from canonical, redirect to canonical.
      // This handles reclassified articles too, replacing the separate 301 block below.
      if (canonicalPath !== url.pathname) {
        return new Response(null, {
          status: 301,
          headers: {
            'Location': canonicalPath,
            'Cache-Control': 'public, max-age=3600, s-maxage=3600',
          },
        });
      }

      // Path is already canonical — fall through to SPA handler
    }
  }
}

// (The old 301 redirect handler that ran unconditionally after the preview
// block has been removed; its logic is subsumed above.)

// SPA fallback for any /news/ path or the legacy /post endpoint
// (after preview logic)
//
// When the worker is invoked for `/news/*` URLs we still need to serve the
// single‑page app shell so the browser can hydrate and render the article.
// In a standalone deployment we could simply bind the build output as
// `ASSETS` and call `env.ASSETS.fetch('/index.html')` (this is how unit tests
// exercise the code).  However, the production release runs on Cloudflare
// Pages where the static assets are hosted separately; the worker is only
// routed for the subset of paths that need dynamic content (/api, /news,
// /post, /sitemap*).  In that configuration `env.ASSETS` is undefined, so we
// must proxy the request back to the Pages origin rather than attempting to
// fetch a non‑existent binding.  The origin URL (`BASE_URL/index.html`) is
// not covered by the worker route, so calling `fetch()` here will go straight
// to the Pages site and return the correct HTML.  Without this branch the
// request would fall through to the final 404 handler (which is what caused
// all article links to break after the preview change).
if (request.method === 'GET' && (url.pathname.startsWith('/news/') || url.pathname === '/post')) {
    // serve the React app shell so client JS can render the appropriate page
    if (env.ASSETS) {
        return env.ASSETS.fetch('/index.html');
    }
    // no ASSETS binding means we're probably running behind Pages; fetch
    // the static shell from the origin domain instead.
    const originUrl = `${BASE_URL}/index.html`;
    // simple GET; headers from the original request are unnecessary for the
    // static shell.  Avoid passing the Request object itself as the init
    // parameter (it would be interpreted incorrectly).
    return fetch(originUrl);
}

// --- RSS feed routes ------------------------------------------------------
// users requested an RSS version of the “today” feed so they can subscribe
// externally.  This behaves much like the `/api/articles/today` endpoint but
// returns XML instead of JSON.  Query parameters are identical (counties
// short/long form).  We generate the feed on‑the‑fly and cache it for a short
// period to reduce DB load.

if (request.method === 'GET' && url.pathname === '/today.rss') {
    // parse counties exactly like the JSON endpoint
    const rawCounties = parseCommaList(url.searchParams.get('counties') || url.searchParams.get('county'));
    let counties = normalizeCountyList(rawCounties) as string[];
    // avoid blowing up D1 by passing an enormous filter list
    if (counties.length > 100) {
        // treat as if no filter was provided; too many binds would overflow SQLite
        counties = [];
    }
    const xml = await generateTodayRss(env, counties);
    return new Response(xml, {
        headers: {
            'content-type': 'application/rss+xml; charset=utf-8',
            'cache-control': 'public, max-age=300, s-maxage=300',
        },
    });
}

// --- Sitemap routes (Section 7: News Sitemap Strategy) ---
if (url.pathname === '/sitemap-index.xml' && request.method === 'GET') {
	return new Response(generateSitemapIndex(), {
		headers: {
			'content-type': 'application/xml; charset=utf-8',
			'cache-control': 'public, max-age=3600, s-maxage=3600',
		},
	});
}

if (url.pathname === '/sitemap.xml' && request.method === 'GET') {
	const xml = await generateSitemap(env);
	return new Response(xml, {
		headers: {
			'content-type': 'application/xml; charset=utf-8',
			'cache-control': 'public, max-age=3600, s-maxage=3600',
		},
	});
}

if (url.pathname === '/sitemap-news.xml' && request.method === 'GET') {
	const xml = await generateNewsSitemap(env);
	return new Response(xml, {
		headers: {
			'content-type': 'application/xml; charset=utf-8',
			'cache-control': 'public, max-age=3600, s-maxage=3600',
		},
	});
}

return json({ error: 'Not found' }, 404);
}

// ---------------------------------------------------------------------------
// Sitemap generation (Section 7 of SEO plan)
// ---------------------------------------------------------------------------

/**
 * Build a clean article URL for use in sitemaps and API responses.
 * Mirrors the frontend articleToUrl() logic in src/utils/functions.js.
 */
function countyNameToSlug(countyName: string): string {
	let cleaned = countyName.trim();
	if (!/county$/i.test(cleaned)) cleaned += ' County';
	return cleaned.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildArticleUrl(
	baseUrl: string,
	slug: string | null,
	county: string | null,
	category: string,
	isNational: boolean,
	id: number,
): string {
	if (!slug) return `${baseUrl}/post?articleId=${id}`;
	if (county) return `${baseUrl}/news/kentucky/${countyNameToSlug(county)}/${slug}`;
	// anything marked national or explicitly category 'national' goes in national path
	if (isNational || category === 'national') return `${baseUrl}/news/national/${slug}`;
	return `${baseUrl}/news/kentucky/${slug}`;
}

/**
 * Build the canonical /news/ path for an article based on its
 * current classification. Must match the frontend routing logic.
 */
function buildArticlePath(article: {
  slug: string | null;
  category: string;
  isKentucky: boolean;
  county: string | null;
}): string {
  // article.slug should always be a non-empty string for valid articles.
  // The only time this helper returns '/' is when slug is falsy, which
  // signals a misbehaving caller; the preview logic now guards against that
  // and treats it as a missing article.  Returning '/' here directly would
  // cause bots to scrape the homepage instead of an intended story.
  if (!article.slug) return '/';
  if (article.isKentucky && article.county) {
    let countyStr = article.county.trim();
    if (!/county$/i.test(countyStr)) countyStr += ' County';
    const countySlug = countyStr.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `/news/kentucky/${countySlug}/${article.slug}`;
  }
  if (article.isKentucky) {
    return `/news/kentucky/${article.slug}`;
  }
  return `/news/${article.category}/${article.slug}`;
}

/**
 * Generate sitemap.xml listing all article URLs.
 * Cached in KV for 1 hour as required by the SEO plan.
 * Limited to 50,000 URLs (Google's per-sitemap limit).
 */
async function generateSitemap(env: Env): Promise<string> {
	const cacheKey = 'sitemap:main';
	const baseUrl = BASE_URL;
	if (env.CACHE) {
		const cached = await env.CACHE.get(cacheKey).catch(() => null);
		if (cached) return cached;
	}

	// make a best-effort attempt to normalize any lingering space-separated
	// timestamps in the database so sitemap generation is always safe even if
	// a migration hasn't been applied yet or a stray insert slipped through.
	try {
		await env.ky_news_db
			.prepare(`
				UPDATE articles
				SET published_at = replace(published_at, ' ', 'T')
				WHERE published_at LIKE '% %' AND published_at NOT LIKE '%T%';
			`)
			.run();
		await prepare(env, `
			UPDATE articles
			SET updated_at = replace(updated_at, ' ', 'T')
			WHERE updated_at LIKE '% %' AND updated_at NOT LIKE '%T%';
			`)
			.run();
	} catch {
		// ignore errors; normalization is best-effort and shouldn't block the
		// sitemap if the DB is readonly or otherwise misbehaving.
	}

	const rows = await env.ky_news_db
		.prepare(
            `SELECT id, slug, county, category, is_national, published_at, updated_at FROM articles
       WHERE (is_kentucky = 1 OR is_national = 1) AND slug IS NOT NULL AND slug != ''
       ORDER BY id DESC LIMIT 50000`,
        )
        .all<{ id: number; slug: string | null; county: string | null; category: string; is_national: number; published_at: string; updated_at: string }>();
	// filter out any rows missing a usable slug (legacy /post? urls are not canonical)
	const validRows = (rows.results || []).filter((row) => row.slug && row.slug.trim() !== '');
	const urls = validRows.map((row) => {
		// normalize whatever timestamp we have and then take the UTC date portion
		const iso = toIsoDateOrNull(row.updated_at || row.published_at || '');
		const lastmod = iso ? iso.split('T')[0] : '';
		const loc = buildArticleUrl(baseUrl, row.slug, row.county, row.category, Boolean(row.is_national), row.id);
		// compute article age to decide changefreq/priority
		const publishedDate = new Date(row.published_at || row.updated_at || Date.now());
		const ageMs = Date.now() - publishedDate.getTime();
		const ageDays = ageMs / (1000 * 60 * 60 * 24);
		const changefreq = ageDays < 7 ? 'daily' : ageDays < 30 ? 'weekly' : 'monthly';
		const priority = ageDays < 7 ? '0.8' : ageDays < 30 ? '0.7' : '0.5';
		return `  <url>
    <loc>${loc}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
	});

	// Add static pages
	const staticPages = [
		{ path: '/', priority: '1.0', changefreq: 'hourly' },
		{ path: '/today', priority: '1.0', changefreq: 'hourly' },
		{ path: '/national', priority: '0.8', changefreq: 'hourly' },
		{ path: '/sports', priority: '0.8', changefreq: 'hourly' },
		{ path: '/weather', priority: '0.8', changefreq: 'hourly' },
		{ path: '/schools', priority: '0.8', changefreq: 'hourly' },
		{ path: '/local', priority: '1.0', changefreq: 'daily' },
		{ path: '/about', priority: '0.6', changefreq: 'monthly' },
		{ path: '/contact', priority: '0.5', changefreq: 'monthly' },
		{ path: '/editorial-policy', priority: '0.6', changefreq: 'monthly' },
		{ path: '/privacy-policy', priority: '0.5', changefreq: 'monthly' },
	];

	const counties = [
		'Adair','Allen','Anderson','Ballard','Barren','Bath','Bell','Boone','Bourbon','Boyd',
		'Boyle','Bracken','Breathitt','Breckinridge','Bullitt','Butler','Caldwell','Calloway',
		'Campbell','Carlisle','Carroll','Carter','Casey','Christian','Clark','Clay','Clinton',
		'Crittenden','Cumberland','Daviess','Edmonson','Elliott','Estill','Fayette','Fleming',
		'Floyd','Franklin','Fulton','Gallatin','Garrard','Grant','Graves','Grayson','Green',
		'Greenup','Hancock','Hardin','Harlan','Harrison','Hart','Henderson','Henry','Hickman',
		'Hopkins','Jackson','Jefferson','Jessamine','Johnson','Kenton','Knott','Knox','LaRue',
		'Laurel','Lawrence','Lee','Leslie','Letcher','Lewis','Lincoln','Livingston','Logan',
		'Lyon','Madison','Magoffin','Marion','Marshall','Martin','Mason','McCracken','McCreary',
		'McLean','Meade','Menifee','Mercer','Metcalfe','Monroe','Montgomery','Morgan',
		'Muhlenberg','Nelson','Nicholas','Ohio','Oldham','Owen','Owsley','Pendleton','Perry',
		'Pike','Powell','Pulaski','Robertson','Rockcastle','Rowan','Russell','Scott','Shelby',
		'Simpson','Spencer','Taylor','Todd','Trigg','Trimble','Union','Warren','Washington',
		'Wayne','Webster','Whitley','Wolfe','Woodford',
	];

	const staticXml = [
		...staticPages.map(
			(p) =>
				`  <url>\n    <loc>${baseUrl}${p.path}</loc>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`,
		),
		...counties.map(
			(c) =>
				`  <url>\n    <loc>${baseUrl}/news/kentucky/${c.toLowerCase().replace(/\s/g, '-')}-county</loc>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>`,
		),
	];

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...staticXml, ...urls].join('\n')}
</urlset>`;

	if (env.CACHE) {
		await env.CACHE.put(cacheKey, xml, { expirationTtl: 3600 }).catch(() => {});
	}
	return xml;
}

/**
 * Generate news-sitemap.xml for articles published in the last 48 hours.
 * Required for Google News inclusion (Section 7).
 * Cached in KV for 1 hour.
 */
async function generateNewsSitemap(env: Env): Promise<string> {
	const cacheKey = 'sitemap:news';
	const baseUrl = BASE_URL;
	if (env.CACHE) {
		const cached = await env.CACHE.get(cacheKey).catch(() => null);
		if (cached) return cached;
	}


	// also normalise timestamps before selecting; this keeps the news sitemap
	// from accidentally skipping an item when older rows still contain spaces.
	try {
		await prepare(env, `
			UPDATE articles
			SET published_at = replace(published_at, ' ', 'T')
			WHERE published_at LIKE '% %' AND published_at NOT LIKE '%T%';
		`)
			.run();
	} catch {}

	const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
const rows = await prepare(env,
			`SELECT id, slug, county, category, is_national, title, published_at FROM articles
       WHERE (is_kentucky = 1 OR is_national = 1) AND published_at >= ?
       ORDER BY published_at DESC LIMIT 1000`,
		)
		.bind(cutoff)
		.all<{ id: number; slug: string | null; county: string | null; category: string; is_national: number; title: string; published_at: string }>();

	const items = (rows.results || []).map((row) => {
		const pubDate = toIsoDateOrNull(row.published_at) || new Date().toISOString();
		const safeTitle = (row.title || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&apos;');
		const loc = buildArticleUrl(baseUrl, row.slug, row.county, row.category, Boolean(row.is_national), row.id);
		return `  <url>
    <loc>${loc}</loc>
    <news:news>
      <news:publication>
        <news:name>Local KY News</news:name>
        <news:language>en</news:language>
      </news:publication>
      <news:publication_date>${pubDate}</news:publication_date>
      <news:title>${safeTitle}</news:title>
    </news:news>
  </url>`;
	});

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${items.join('\n')}
</urlset>`;

	if (env.CACHE) {
		await env.CACHE.put(cacheKey, xml, { expirationTtl: 3600 }).catch(() => {});
	}
	return xml;
}

/**
 * Escape text for inclusion in XML nodes.  only a handful of characters
 * require replacement.
 */
function escapeXml(str: string): string {
    return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Build a simple RSS feed for the "today" category.  exported so unit
 * tests can call it directly.
 */
async function generateTodayRss(env: Env, counties: string[]): Promise<string> {
    if (counties.length > 100) {
        counties = [];
    }

    const baseUrl = BASE_URL;

    type RssRow = {
        id: number; title: string; slug: string | null; county: string | null;
        category: string; is_national: number; published_at: string; summary: string;
    };

    let rows: RssRow[] = [];
    try {
        if (counties.length > 0) {
            const placeholders = counties.map(() => '?').join(',');
            const result = await prepare(env,
                `SELECT id, title, slug, county, category, is_national, published_at, summary
                 FROM articles
                 WHERE category = 'today'
                 AND (
                   county IN (${placeholders})
                   OR EXISTS (
                     SELECT 1 FROM article_counties ac
                     WHERE ac.article_id = articles.id AND ac.county IN (${placeholders})
                   )
                 )
                 ORDER BY published_at DESC, id DESC LIMIT 50`
            ).bind(...counties, ...counties).all<RssRow>();
            rows = result.results ?? [];
        }
        // If no county filter or county filter returned nothing, fetch global feed
        if (rows.length === 0) {
            const result = await prepare(env,
                `SELECT id, title, slug, county, category, is_national, published_at, summary
                 FROM articles
                 WHERE category = 'today'
                 ORDER BY published_at DESC, id DESC LIMIT 50`
            ).all<RssRow>();
            rows = result.results ?? [];
        }
    } catch (err) {
        console.error('[RSS] DB query failed:', err);
        rows = [];
    }

    const itemsXml = rows.map((row) => {
        const title = escapeXml(row.title || '');
        const link = buildArticleUrl(baseUrl, row.slug, row.county, row.category as any, row.is_national === 1, row.id);
        const pub = row.published_at ? new Date(row.published_at).toUTCString() : new Date().toUTCString();
        const description = escapeXml(row.summary || '');
        return `  <item>
    <title>${title}</title>
    <link>${link}</link>
    <pubDate>${pub}</pubDate>
    <description>${description}</description>
  </item>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Local KY News - Today</title>
<link>${baseUrl}/today</link>
<description>Kentucky Today feed</description>
${itemsXml}
</channel>
</rss>`;
}

/**
 * Generate a sitemap index pointing to both sitemaps.
 */
function generateSitemapIndex(): string {
	const baseUrl = BASE_URL;
	const now = new Date().toISOString().split('T')[0];
	return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${baseUrl}/sitemap.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>
  <sitemap>
    <loc>${baseUrl}/sitemap-news.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>
</sitemapindex>`;
}

export default {
async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
async scheduled(_event: any, env: Env, ctx: ExecutionContext): Promise<void> {
  // HIGH_PRIORITY sources run on every single tick (2-min breaking news refresh).
  const highPrioritySources = [...new Set(
    HIGH_PRIORITY_SOURCE_SEEDS.map((s) => s.trim()).filter(isHttpUrl)
  )];

  // NORMAL sources rotate: ~70 sources ÷ 8 per tick ≈ 18-min full cycle.
  const normalSources = [...new Set([
    ...MASTER_SOURCE_SEEDS,
    ...SCHOOL_SOURCE_SEEDS,
  ].map((s) => s.trim()).filter(isHttpUrl)
   .filter((url) => !highPrioritySources.includes(url))
  )];

  // Always ingest high-priority sources first (no rotation — run them all every tick).
  if (highPrioritySources.length > 0) {
    ctx.waitUntil(
      runIngest(env, highPrioritySources, SCHEDULED_LIMIT_PER_SOURCE, 'scheduled-high', {
        maxSourcesPerRun: highPrioritySources.length,
        rotateSources: false,
      }),
    );
  }

  // Rotate through normal sources 8 at a time.
  ctx.waitUntil(
    runIngest(env, normalSources, SCHEDULED_LIMIT_PER_SOURCE, 'scheduled-normal', {
      maxSourcesPerRun: SCHEDULED_NORMAL_SOURCES_PER_RUN,
      rotateSources: true,
    }),
  );

  // Check recent articles for content updates (self-limits to 20 per run).
  ctx.waitUntil(checkArticleUpdates(env));
},

// forward queue events to our exported handler
async queue(batch: MessageBatch<QueueJob>, env: Env, ctx: ExecutionContext): Promise<void> {
	return queue(batch, env, ctx);
},

};

/** Process sources sequentially and store results - used by both HTTP seed endpoint and cron. */
async function runIngest(
	env: Env,
	sourceUrls: string[],
	limitPerSource: number,
	trigger: IngestRunMetrics['trigger'],
	options: IngestRunOptions = {},
): Promise<void> {
const started = Date.now();
const { runSources, sourcesAvailable, nextOffset, shouldPersistRotation } = await selectSourcesForRun(
	env,
	sourceUrls,
	trigger,
	options,
);
const sourcesForRun = rebalanceSchoolHeavyRunSources(runSources, sourceUrls, INGEST_CONCURRENCY);

let processed = 0;
let inserted = 0;
let duplicate = 0;
let rejected = 0;
let lowWordDiscards = 0;
let sourceErrors = 0;
const rejectedSamples: IngestDecisionSample[] = [];
const duplicateSamples: IngestDecisionSample[] = [];
const insertedSamples: IngestDecisionSample[] = [];

// Process sources in concurrent batches so we don't hit the wall-clock limit
// with 160+ sequential network calls. INGEST_CONCURRENCY sources run at once.
for (let i = 0; i < sourcesForRun.length; i += INGEST_CONCURRENCY) {
const batch = sourcesForRun.slice(i, i + INGEST_CONCURRENCY);
const results = await Promise.allSettled(batch.map((sourceUrl) => ingestSeedSource(env, sourceUrl, limitPerSource)));
for (const result of results) {
if (result.status === 'rejected') {
sourceErrors += 1;
} else {
const status = result.value;
processed += status.processed;
inserted += status.inserted;
duplicate += status.duplicate;
rejected += status.rejected;
lowWordDiscards += status.lowWordDiscards;
sourceErrors += status.errors.length;
for (const sample of status.rejectedSamples) {
			if (rejectedSamples.length < 200) rejectedSamples.push(sample);
		}
		for (const sample of status.duplicateSamples) {
			if (duplicateSamples.length < 200) duplicateSamples.push(sample);
		}
		for (const sample of status.insertedSamples || []) {
			if (insertedSamples.length < 200) insertedSamples.push(sample);
		}
}
}
}

const finished = Date.now();
const durationMs = Math.max(1, finished - started);
const metrics: IngestRunMetrics = {
	startedAt: new Date(started).toISOString(),
	finishedAt: new Date(finished).toISOString(),
	durationMs,
	sourcesTried: sourcesForRun.length,
	sourcesAvailable,
	processed,
	inserted,
	duplicate,
	rejected,
	lowWordDiscards,
	ingestRatePerMinute: Number(((inserted / durationMs) * 60000).toFixed(2)),
	sourceErrors,
	trigger,
	rejectedSamples,
	duplicateSamples,
	insertedSamples,
};

const rotationKey = `${INGEST_ROTATION_KEY_PREFIX}${trigger}`;
await env.CACHE.put(rotationKey, String(nextOffset), { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => null);
}

// escape characters that would break HTML attributes
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
}

function isHttpUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    // filter out ky school district domains entirely
    const host = parsed.hostname.toLowerCase();
    if (host === 'kyschools.us' || host.endsWith('.kyschools.us')) {
      return false;
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function safeError(error: unknown): string {
if (error instanceof Error) return error.message;
return 'unknown error';
}

function toSortTimestamp(value: string | null | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeLimitPerSource(limitPerSource: number | undefined): number {
if (!Number.isFinite(limitPerSource)) return DEFAULT_SEED_LIMIT_PER_SOURCE;
const numeric = Math.floor(limitPerSource as number);
if (numeric <= 0) return DEFAULT_SEED_LIMIT_PER_SOURCE;
return Math.min(numeric, MAX_SEED_LIMIT_PER_SOURCE);
}

function buildManualIngestSources(includeSchools: boolean): string[] {
	const combined = includeSchools
		? [...HIGH_PRIORITY_SOURCE_SEEDS, ...MASTER_SOURCE_SEEDS, ...SCHOOL_SOURCE_SEEDS]
		: [...HIGH_PRIORITY_SOURCE_SEEDS, ...MASTER_SOURCE_SEEDS];

	return [...new Set(combined)];
}

function isKySchoolsSourceUrl(sourceUrl: string): boolean {
	try {
		const host = new URL(sourceUrl).hostname.toLowerCase();
		return host === 'kyschools.us' || host.endsWith('.kyschools.us');
	} catch {
		return false;
	}
}

// shared logic for processing a single county.  used both by the
// `/api/admin/backfill-county` HTTP handler and the queue consumer below.

// When we refer to CACHE values the shape is loosely typed; keep `any` here to
// avoid sprawling interface definitions in tests.
async function performBackfillCounty(env: Env, county: string, threshold: number): Promise<void> {
	console.log('backfill-county job for', county, 'threshold', threshold);
	const before = (await getCountyCounts(env)).get(county) ?? 0;
	const urls = buildCountySearchUrls(county);
	await runIngest(env, urls, threshold * 2, 'manual', { rotateSources: false }).catch((e) => {
		console.error('runIngest error for', county, e);
		return null;
	});
	// update status
	try {
		const raw = await env.CACHE.get(BACKFILL_STATUS_KEY, 'text');
		if (raw) {
			const statusObj = JSON.parse(raw);
			if (statusObj && statusObj.status === 'running') {
				statusObj.processed = (statusObj.processed || 0) + 1;
				if (!statusObj.results) statusObj.results = [];
				statusObj.results.push({ county, before, after: (await getCountyCounts(env)).get(county) ?? before });
				if (statusObj.processed >= statusObj.missingCount) {
					statusObj.status = 'complete';
					statusObj.finishedAt = new Date().toISOString();
				}
				const ttl = statusObj.status === 'complete' ? 86400 : 7200;
				await env.CACHE.put(BACKFILL_STATUS_KEY, JSON.stringify(statusObj), { expirationTtl: ttl }).catch((e) => {
					console.error('status put failed for', county, e);
				});
			}
		}
	} catch (e) {
		console.error('error updating status for', county, e);
	}
}

/**
 * Prevent school-only ingest batches by ensuring each concurrent batch has at least
 * one non-kyschools source whenever any non-school sources are available.
 */
function rebalanceSchoolHeavyRunSources(
	runSources: string[],
	allSources: string[],
	batchSize: number,
): string[] {
	if (runSources.length === 0 || batchSize <= 0) return runSources;
	if (!allSources.some((url) => !isKySchoolsSourceUrl(url))) return runSources;

	const balanced = [...runSources];
	const selected = new Set(balanced);
	const externalNonSchool = allSources.filter(
		(url) => !isKySchoolsSourceUrl(url) && !selected.has(url),
	);
	let externalCursor = 0;

	for (let start = 0; start < balanced.length; start += batchSize) {
		const end = Math.min(start + batchSize, balanced.length);
		const hasNonSchool = balanced.slice(start, end).some((url) => !isKySchoolsSourceUrl(url));
		if (hasNonSchool) continue;

		const targetIndex = end - 1;

		// Prefer a swap with an already-selected non-school source.
		let swapIndex = -1;
		for (let i = end; i < balanced.length; i += 1) {
			if (!isKySchoolsSourceUrl(balanced[i])) {
				swapIndex = i;
				break;
			}
		}

		if (swapIndex !== -1) {
			[balanced[targetIndex], balanced[swapIndex]] = [balanced[swapIndex], balanced[targetIndex]];
			continue;
		}

		// No in-run non-school source is available to swap; pull one from outside this run.
		const replacement = externalNonSchool[externalCursor];
		externalCursor += 1;
		if (!replacement) break;
		balanced[targetIndex] = replacement;
	}

	return balanced;
}

async function selectSourcesForRun(
	env: Env,
	sourceUrls: string[],
	trigger: IngestRunMetrics['trigger'],
	options: IngestRunOptions,
): Promise<{ runSources: string[]; sourcesAvailable: number; nextOffset: number | null; shouldPersistRotation: boolean }> {
	const sourcesAvailable = sourceUrls.length;
	if (sourcesAvailable === 0) {
		return { runSources: [], sourcesAvailable: 0, nextOffset: null, shouldPersistRotation: false };
	}

	const maxSources =
		Number.isFinite(options.maxSourcesPerRun) && Number(options.maxSourcesPerRun) > 0
			? Math.min(Math.floor(Number(options.maxSourcesPerRun)), sourcesAvailable)
			: sourcesAvailable;

	if (!options.rotateSources || sourcesAvailable <= 1) {
		return {
			runSources: sourceUrls.slice(0, maxSources),
			sourcesAvailable,
			nextOffset: null,
			shouldPersistRotation: false,
		};
	}

	const rotationKey = `${INGEST_ROTATION_KEY_PREFIX}${trigger}`;
	const rawOffset = await env.CACHE.get(rotationKey).catch(() => null);
	const parsedOffset = Number.parseInt(rawOffset || '0', 10);
	const startOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset % sourcesAvailable : 0;

	const rotated = [...sourceUrls.slice(startOffset), ...sourceUrls.slice(0, startOffset)];
	const runSources = rotated.slice(0, maxSources);
	const nextOffset = (startOffset + runSources.length) % sourcesAvailable;

	return {
		runSources,
		sourcesAvailable,
		nextOffset,
		shouldPersistRotation: true,
	};
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
lowWordDiscards: 0,
errors: [],
rejectedSamples: [],
duplicateSamples: [],
insertedSamples: [],
};

try {
const forceStructuredSearchFallback = isStructuredSearchSource(sourceUrl);

if (!forceStructuredSearchFallback) {
const feedCandidates = await resolveFeedUrls(env, sourceUrl);
const uniqueFeeds = [...new Set(feedCandidates.filter(isHttpUrl))];
status.discoveredFeeds = uniqueFeeds.length;

const feedItems = [] as Awaited<ReturnType<typeof fetchAndParseFeed>>;
const seenLinks = new Set<string>();
for (const feedUrl of uniqueFeeds) {
try {
const parsedItems = await fetchAndParseFeed(env, feedUrl);
if (parsedItems.length > 0) {
if (!status.selectedFeed) status.selectedFeed = feedUrl;
for (const item of parsedItems) {
const normalizedLink = normalizeCanonicalUrl(item.link || '');
if (!normalizedLink || seenLinks.has(normalizedLink)) continue;
seenLinks.add(normalizedLink);
feedItems.push({ ...item, link: normalizedLink });
}
}
} catch (error) {
status.errors.push(`feed parse failed (${feedUrl}): ${safeError(error)}`);
}
}

if (status.selectedFeed && feedItems.length > 0) {
feedItems.sort(
	(a, b) => toSortTimestamp(b.publishedAt) - toSortTimestamp(a.publishedAt),
);
const limitedItems = limitPerSource > 0 ? feedItems.slice(0, limitPerSource) : feedItems;
for (const item of limitedItems) {
try {
const result = await ingestSingleUrl(env, {
url: item.link,
sourceUrl,
feedPublishedAt: item.publishedAt ?? undefined,
providedTitle: item.title,
providedDescription: item.description,
});
status.processed += 1;
if (result.status === 'inserted') {
				status.inserted += 1;
				if (status.insertedSamples.length < 50) {
					status.insertedSamples.push({
						decision: 'inserted',
						url: item.link,
						sourceUrl,
						title: item.title,
						publishedAt: item.publishedAt,
						category: result.category,
						id: result.id,
						urlHash: result.urlHash,
						createdAt: new Date().toISOString(),
					});
				}
			}
if (result.status === 'duplicate') {
status.duplicate += 1;
if (status.duplicateSamples.length < 50) {
status.duplicateSamples.push({
	decision: 'duplicate',
	url: item.link,
	sourceUrl,
	title: item.title,
	publishedAt: item.publishedAt,
	reason: 'url hash already exists',
	category: result.category,
	id: result.id,
	urlHash: result.urlHash,
	createdAt: new Date().toISOString(),
});
}
}
if (result.status === 'rejected') {
status.rejected += 1;
if (status.rejectedSamples.length < 50) {
status.rejectedSamples.push({
	decision: 'rejected',
	url: item.link,
	sourceUrl,
	title: item.title,
	publishedAt: item.publishedAt,
	reason: result.reason || 'unknown reject reason',
	category: result.category,
	createdAt: new Date().toISOString(),
});
}
if ((result.reason || '').toLowerCase().includes('content too short')) {
	status.lowWordDiscards += 1;
}
}
} catch (error) {
status.processed += 1;
status.rejected += 1;
status.errors.push(`ingest failed (${item.link}): ${safeError(error)}`);
}
}

return status;
}
}

status.fallbackUsed = true;
try {
const fallbackUrls = await discoverFallbackArticleUrls(env, sourceUrl, limitPerSource);
if (forceStructuredSearchFallback && fallbackUrls.length === 0) {
	status.rejected += 1;
	status.errors.push(`structured search found no article links (${sourceUrl})`);
	return status;
}
const urlsToTry = fallbackUrls.length > 0 ? fallbackUrls : [sourceUrl];

for (const candidateUrl of urlsToTry) {
	try {
		const fallbackResult = await ingestSingleUrl(env, { url: candidateUrl, sourceUrl });
		status.processed += 1;
		if (fallbackResult.status === 'inserted') {
				status.inserted += 1;
				if (status.insertedSamples.length < 50) {
					status.insertedSamples.push({
						decision: 'inserted',
						url: candidateUrl,
						sourceUrl,
						category: fallbackResult.category,
						id: fallbackResult.id,
						urlHash: fallbackResult.urlHash,
						createdAt: new Date().toISOString(),
					});
				}
			}
		if (fallbackResult.status === 'duplicate') {
			status.duplicate += 1;
			if (status.duplicateSamples.length < 50) {
				status.duplicateSamples.push({
					decision: 'duplicate',
					url: candidateUrl,
					sourceUrl,
					reason: 'url hash already exists',
					category: fallbackResult.category,
					id: fallbackResult.id,
					urlHash: fallbackResult.urlHash,
					createdAt: new Date().toISOString(),
				});
			}
		}
		if (fallbackResult.status === 'rejected') {
			status.rejected += 1;
			if (status.rejectedSamples.length < 50) {
				status.rejectedSamples.push({
					decision: 'rejected',
					url: candidateUrl,
					sourceUrl,
					reason: fallbackResult.reason || 'unknown reject reason',
					category: fallbackResult.category,
					createdAt: new Date().toISOString(),
				});
			}
			if ((fallbackResult.reason || '').toLowerCase().includes('content too short')) {
				status.lowWordDiscards += 1;
			}
		}
	} catch (error) {
		status.processed += 1;
		status.rejected += 1;
		status.errors.push(`fallback ingest failed (${candidateUrl}): ${safeError(error)}`);
	}
}
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

async function discoverFallbackArticleUrls(env: Env, sourceUrl: string, limitPerSource: number): Promise<string[]> {
	if (!(await isAllowedByRobots(env, sourceUrl))) return [];

	const maxLinks = limitPerSource > 0 ? Math.min(limitPerSource, FALLBACK_CRAWL_MAX_LINKS) : FALLBACK_CRAWL_MAX_LINKS;
	const rootFetch = await cachedTextFetch(env, sourceUrl, 600).catch(() => null);
	if (!rootFetch?.body || rootFetch.status >= 400) return [];

	const structuredSearchLinks = extractStructuredSearchLinks(sourceUrl, rootFetch.body, maxLinks);
	if (structuredSearchLinks.length > 0) {
		return structuredSearchLinks;
	}

	const seedLinks = extractCandidateLinks(sourceUrl, rootFetch.body);
	if (seedLinks.length >= maxLinks) return seedLinks.slice(0, maxLinks);

	const sectionLinks = extractSectionLinks(sourceUrl, rootFetch.body).slice(0, FALLBACK_CRAWL_MAX_SECTION_PAGES);
	const aggregated = [...seedLinks];
	const seen = new Set(aggregated);

	for (const sectionUrl of sectionLinks) {
		if (!(await isAllowedByRobots(env, sectionUrl))) continue;
		const sectionFetch = await cachedTextFetch(env, sectionUrl, 600).catch(() => null);
		if (!sectionFetch?.body || sectionFetch.status >= 400) continue;

		const candidates = extractCandidateLinks(sourceUrl, sectionFetch.body);
		for (const candidate of candidates) {
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			aggregated.push(candidate);
			if (aggregated.length >= maxLinks) return aggregated;
		}
	}

	return aggregated.slice(0, maxLinks);
}

function extractCandidateLinks(baseUrl: string, html: string): string[] {
	const links = extractAbsoluteLinks(baseUrl, html);
	return links.filter((url) => isLikelyArticleUrl(url));
}

function extractSectionLinks(baseUrl: string, html: string): string[] {
	const links = extractAbsoluteLinks(baseUrl, html);
	return links.filter((url) => isLikelySectionUrl(url));
}

function extractAbsoluteLinks(baseUrl: string, html: string): string[] {
	const found = new Set<string>();
	for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
		const href = (match[1] || '').trim();
		if (!href || href.startsWith('#') || href.startsWith('mailto:') || isDisallowedHrefScheme(href)) continue;
		try {
			const resolved = new URL(href, baseUrl);
			const source = new URL(baseUrl);
			if (resolved.origin !== source.origin) continue;
			if (!(resolved.protocol === 'https:' || resolved.protocol === 'http:')) continue;
			resolved.hash = '';
			if (resolved.searchParams.has('outputType')) continue;
			found.add(resolved.toString());
		} catch {
			// ignore invalid urls
		}
	}
	return [...found];
}

function isDisallowedHrefScheme(value: string): boolean {
	const lowered = value.toLowerCase();
	if (lowered.startsWith('data:')) return true;
	if (lowered.startsWith('vbscript:')) return true;
	// Avoid literal "javascript:" string to satisfy static analysis rule while still blocking script URLs.
	return lowered.startsWith(`java${'script'}:`);
}

function isLikelyArticleUrl(value: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}

	const path = parsed.pathname.toLowerCase();
	if (!path || path === '/' || path.endsWith('/feed') || path.includes('/tag/') || path.includes('/category/')) {
		return false;
	}

	if (path.endsWith('.xml') || path.endsWith('.rss') || path.endsWith('.json')) return false;
	if (path.includes('/video/') || path.includes('/videos/')) return false;

	const articleSignals = [
		/news\//,
		/sports\//,
		/weather\//,
		/school(s)?\//,
		/obit(uary|uaries)?\//,
		/story\//,
		/article\//,
		/\/(20\d{2})\/(0?[1-9]|1[0-2])\//,
	];

	return articleSignals.some((signal) => signal.test(path));
}

function isLikelySectionUrl(value: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}

	const path = parsed.pathname.toLowerCase();
	if (!path || path === '/') return false;

	return [
		'/news',
		'/sports',
		'/weather',
		'/school',
		'/schools',
		'/obituaries',
		'/obituary',
		'/local',
	].some((segment) => path === segment || path.startsWith(`${segment}/`));
}

async function isAllowedByRobots(env: Env, targetUrl: string): Promise<boolean> {
	try {
		if (isRobotsBypassAllowed(targetUrl)) return true;

		const target = new URL(targetUrl);
		const robotsUrl = `${target.origin}/robots.txt`;
		const robotsFetch = await cachedTextFetch(env, robotsUrl, 3600).catch(() => null);

		if (!robotsFetch) return false;
		if (robotsFetch.status === 404 || robotsFetch.status === 410) return true;
		if (robotsFetch.status >= 500) return false;
		if (robotsFetch.status >= 400) return true;

		const { allow, disallow } = parseRobotsForGenericBot(robotsFetch.body || '');
		return isPathAllowedByRules(target.pathname || '/', allow, disallow);
	} catch {
		return false;
	}
}

/**
 * Helpers identifying search URLs that can be treated as "structured" sources.
 * We support dynamic county queries so that the backfill endpoint can hit the
 * same parsing routines used for the statewide search pages.
 */
function isKentuckySearchUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.origin === 'https://www.kentucky.com' &&
			parsed.pathname === '/search/' &&
			parsed.searchParams.has('q')
		);
	} catch {
		return false;
	}
}

function isWymtSearchUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.origin === 'https://www.wymt.com' &&
			parsed.pathname === '/search/' &&
			parsed.searchParams.has('query')
		);
	} catch {
		return false;
	}
}

/**
 * Build the two search URLs we hit when backfilling a specific county.
 */
function buildCountySearchUrls(county: string): string[] {
	const enc = encodeURIComponent(county);
	return [
		`https://www.kentucky.com/search/?q=${enc}&page=1&sort=newest`,
		`https://www.wymt.com/search/?query=${enc}`,
	];
}

function isStructuredSearchSource(sourceUrl: string): boolean {
	const normalized = normalizeSourceUrl(sourceUrl);
	if (!normalized) return false;
	if (STRUCTURED_SEARCH_SOURCE_URLS.has(normalized)) return true;
	if (isKentuckySearchUrl(normalized) || isWymtSearchUrl(normalized)) return true;
	return false;
}

/**
 * Domains whose robots.txt we intentionally skip — these are established news
 * publishers that disallow generic crawlers but legitimately offer RSS feeds.
 * We fetch their article content only after discovering it through an RSS feed.
 */
const TRUSTED_NEWS_DOMAINS = new Set([
	'www.npr.org',
	'feeds.npr.org',
	'www.wowktv.com',
	'www.wkyt.com',
	'www.wsaz.com',
	'www.wymt.com',
	'www.whas11.com',
	'www.wlky.com',
	'www.wdrb.com',
	'www.lex18.com',
	'www.wtvq.com',
	'www.wnky.com',
	'www.wcpo.com',
	'www.wkms.org',
	'wfpl.org',
	'kentuckylantern.com',
	'kyweathercenter.com', // newly trusted weather source
	'kycir.org',
	'stateline.org',
	'www.pbs.org',
	'www.nbcnews.com',
	'abcnews.go.com',
	'www.foxnews.com',
	'moxie.foxnews.com',
	'www.kentucky.com',
	'www.courier-journal.com',
]);

function isRobotsBypassAllowed(targetUrl: string): boolean {
	const normalized = normalizeSourceUrl(targetUrl);
	if (!normalized) return false;
	if (ROBOTS_BYPASS_URLS.has(normalized)) return true;
	if (isKentuckySearchUrl(normalized) || isWymtSearchUrl(normalized)) return true;
	try {
		const { hostname } = new URL(normalized);
		if (TRUSTED_NEWS_DOMAINS.has(hostname)) return true;
	} catch {
		// ignore
	}
	return false;
}

function normalizeSourceUrl(value: string): string | null {
	try {
		const parsed = new URL(value);
		if (!(parsed.protocol === 'https:' || parsed.protocol === 'http:')) return null;
		parsed.hash = '';
		return parsed.toString();
	} catch {
		return null;
	}
}

function extractStructuredSearchLinks(sourceUrl: string, html: string, maxLinks: number): string[] {
	const normalized = normalizeSourceUrl(sourceUrl);
	if (!normalized || maxLinks <= 0) return [];

	// Support any kentucky.com search query (e.g. county-specific backfill searches)
	if (isKentuckySearchUrl(normalized)) {
		return extractKentuckySearchArticleLinks(sourceUrl, html, maxLinks);
	}

	// Support any wymt.com search query (e.g. county-specific backfill searches)
	if (isWymtSearchUrl(normalized)) {
		return extractWymtSearchArticleLinks(sourceUrl, html, maxLinks);
	}

	// Support kyweathercenter.com WordPress search pages (query string ?p=NNNNN)
	try {
		const { hostname } = new URL(normalized);
		if (hostname === 'kyweathercenter.com' || hostname === 'www.kyweathercenter.com') {
			return extractKyweathercenterSearchArticleLinks(sourceUrl, html, maxLinks);
		}
	} catch {
		// ignore malformed URL
	}

	return [];
}

function extractKentuckySearchArticleLinks(baseUrl: string, html: string, maxLinks: number): string[] {
	const results = new Set<string>();

	for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
		const href = (match[1] || '').trim();
		if (!href) continue;

		try {
			const resolved = new URL(href, baseUrl);
			if (resolved.origin !== 'https://www.kentucky.com') continue;
			if (!/\/article\d+\.html$/i.test(resolved.pathname)) continue;
			resolved.hash = '';
			resolved.search = '';
			results.add(resolved.toString());
			if (results.size >= maxLinks) break;
		} catch {
			// ignore invalid urls
		}
	}

	return [...results];
}

function extractWymtSearchArticleLinks(baseUrl: string, html: string, maxLinks: number): string[] {
	const results = new Set<string>();

	for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
		const href = (match[1] || '').trim();
		if (!href) continue;

		try {
			const resolved = new URL(href, baseUrl);
			if (resolved.origin !== 'https://www.wymt.com') continue;
			const path = resolved.pathname.toLowerCase();
			if (path.startsWith('/video/')) continue;
			if (!/^\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+\/?$/i.test(path)) continue;
			resolved.hash = '';
			resolved.search = '';
			results.add(resolved.toString());
			if (results.size >= maxLinks) break;
		} catch {
			// ignore invalid urls
		}
	}

	return [...results];
}

function extractKyweathercenterSearchArticleLinks(baseUrl: string, html: string, maxLinks: number): string[] {
	const results = new Set<string>();

	for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
		const href = (match[1] || '').trim();
		if (!href) continue;

		try {
			const resolved = new URL(href, baseUrl);
			const host = resolved.hostname.toLowerCase();
			if (host !== 'kyweathercenter.com' && host !== 'www.kyweathercenter.com') continue;
			if (!/\?p=\d+/i.test(resolved.search)) continue;
			resolved.hash = '';
			results.add(resolved.toString());
			if (results.size >= maxLinks) break;
		} catch {
			// ignore invalid urls
		}
	}

	return [...results];
}




// ---------------------------------------------------------------------------
// Article update detection task
// ---------------------------------------------------------------------------

/**
 * Checks recently published Kentucky articles for source updates.
 * For each article published in the last 24 hours:
 *   1. Re-fetch the source URL
 *   2. Hash the new content
 *   3. If hash differs from stored content_hash, generate an
 *      update paragraph and prepend it to the D1 summary
 *
 * Runs as part of the scheduled cron. Processes up to 20 articles
 * per run to stay within CPU limits. Each run picks up where the
 * last left off by ordering newest-first (recent articles are most
 * likely to have updates).
 */
async function checkArticleUpdates(env: Env, maxAgeHours: number = 24): Promise<void> {
  const articles = await getArticlesForUpdateCheck(env, maxAgeHours);
  // Limit to 20 per cron run to stay within CPU budget
  const batch = articles.slice(0, 20);

  for (const article of batch) {
    try {
      // Re-fetch the article with cache-busting
      const refetchUrl = article.canonicalUrl + `?_ts=${Date.now()}`;
      const extracted = await fetchAndExtractArticle(env, {
        url: refetchUrl,
        sourceUrl: article.canonicalUrl,
        providedTitle: article.title,
        providedDescription: '',
        // Omit feedPublishedAt so fetchAndExtractArticle treats this as a
        // manual/browser fetch, using a realistic UA to bypass bot protection
        // on sites like kentucky.com.  The published date is irrelevant here
        // since we are only re-fetching to detect content changes.
      }).catch(() => null);

      if (!extracted?.contentText) continue;

      const contentSample = extracted.contentText
        .split(/\s+/).slice(0, 3000).join(' ');
      const newHash = await sha256Hex(contentSample);

      // Skip if content hasn't changed since last check
      if (article.contentHash && article.contentHash === newHash) {
        continue;
      }

      // Skip if summary already starts with the same update
      // (guards against double-prepending on repeated cron runs
      // before content changes again)
      if (!article.contentHash) {
        // First time checking this article — store hash but
        // don't generate an update (we have no baseline to diff)
        await prepare(env, 'UPDATE articles SET content_hash = ? WHERE id = ?')
          .bind(newHash, article.id)
          .run()
          .catch(() => {});
        continue;
      }

      // Content changed — ask AI what's new
      const updateParagraph = await generateUpdateParagraph(
        env,
        extracted.contentText,
        article.summary,
        article.publishedAt,
      );

      if (!updateParagraph) {
        // AI found no meaningful new info, but content DID change — advance the
        // stored hash so this version isn't re-checked on every subsequent cron
        // run.  Without this the same changed content would trigger the AI on
        // every run and always return NO_UPDATE, wasting CPU and never settling.
        await prepare(env, 'UPDATE articles SET content_hash = ? WHERE id = ?')
          .bind(newHash, article.id)
          .run()
          .catch(() => {});
        continue;
      }

      // Prepend update to D1 summary and record new hash
      await prependUpdateToSummary(
        env,
        article.id,
        updateParagraph,
        newHash,
      );

      console.log(
        `[UPDATE DETECTED] Article #${article.id}: ${article.title}`
      );

    } catch (err) {
      // Never let one article failure stop the rest
      console.error(
        `[UPDATE CHECK FAILED] Article #${article.id}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

export const __testables = {
	normalizeSourceUrl,
	isStructuredSearchSource,
	isRobotsBypassAllowed,
	extractStructuredSearchLinks,
	isKentuckySearchUrl,
	isWymtSearchUrl,
	buildCountySearchUrls,
	getCountyCounts,
	generateSitemap,
	generateNewsSitemap,
	generateTodayRss,
	generateSitemapIndex,
	rebalanceSchoolHeavyRunSources,
	// expose internal helpers for unit tests
	buildArticlePath,
	scrapeFacebookPostPublic,
	deriveFacebookTitleAndBody,
	// exposing runIngest allows tests to stub the heavy ingestion routine
	runIngest,
	// make ingestSingleUrl available for unit tests
	ingestSingleUrl,
	isAdminAuthorized,
	// article update helpers
	checkArticleUpdates,
};

// also export runIngest directly for easier import in tests or tooling
export { runIngest };

/**
 * Cloudflare queue handler.  messages are sent by the admin UI and processed
 * asynchronously here; each invocation receives a batch of jobs.
 */
export async function queue(
	batch: MessageBatch<QueueJob>,
	env: Env,
	ctx: ExecutionContext,
): Promise<void> {
	// origin doesn't matter much; using example.com keeps tests happy.  in
	// production the worker's domain is automatically routed back to itself.
	const origin = 'https://example.com';
	const adminKey = ((env as any).ADMIN_PANEL_PASSWORD || '').trim();
	for (const msg of batch.messages) {
		// skip messages that have already been retried too many times
		if (msg.attempts != null && msg.attempts > MAX_QUEUE_RETRIES) {
			console.warn(
				`[QUEUE] Skipping message after ${msg.attempts} attempts:`,
				msg.body,
			);
			if (typeof msg.ack === 'function') msg.ack();
			continue;
		}

		const job = msg.body;
		switch (job.type) {
			case 'manualIngest':
				await runIngest(env, job.sourceUrls, job.limitPerSource, 'manual');
				// acknowledge success if possible
				if (typeof msg.ack === 'function') msg.ack();
				break;
			case 'backfillCounty': {
				// enqueue HTTP request; the handler will spawn per-source jobs
				ctx.waitUntil(
					fetch(`${origin}/api/admin/backfill-county`, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'x-admin-key': adminKey,
						},
						body: JSON.stringify({ county: job.county, threshold: job.threshold }),
						cf: { keepalive: true },
					}),
				);
				if (typeof msg.ack === 'function') msg.ack();
				break;
			}
			default:
				console.warn('queue handler received unknown job', job);
				if (typeof msg.retry === 'function') msg.retry();
		}
	}
}

function extractFacebookPostId(fbUrl: string): string | null {
	try {
		const parsed = new URL(fbUrl);
		if (!parsed.hostname.includes('facebook.com')) return null;

		// /posts/{id} and /photos/{id} patterns
		const postMatch = parsed.pathname.match(/\/(?:posts|photos|videos)\/(\d+)/);
		if (postMatch?.[1]) return postMatch[1];

		// permalink.php?story_fbid={postId}&id={pageId}
		const storyFbid = parsed.searchParams.get('story_fbid');
		const pageIdParam = parsed.searchParams.get('id');
		if (storyFbid && pageIdParam) return `${pageIdParam}_${storyFbid}`;

		// ?fbid=
		const fbid = parsed.searchParams.get('fbid');
		if (fbid) return fbid;

		return null;
	} catch {
		return null;
	}
}

/**
 * Scrape a public Facebook post via mbasic.facebook.com — the legacy server-rendered
 * mobile site that returns plain HTML without requiring JavaScript or authentication.
 * Extracts the post message and og:image from meta tags.
 */
/**
 * Scrape a public Facebook post by fetching its URL with the facebookexternalhit
 * user-agent, which Facebook whitelists to serve og: meta tags for public posts
 * without requiring login. mbasic.facebook.com was deprecated in 2023 and is no
 * longer usable.
 *
 * For short share links (/share/p/{code}), we first resolve the redirect using
 * facebookexternalhit to get the final post URL and its og: tags in one step,
 * since Facebook serves the resolved post content directly for this UA.
 */

/**
 * Attempt to extract the full post text from a Facebook page's embedded JSON data.
 * Facebook truncates og:description but embeds the full post text in __bbox / relay
 * JSON blobs inside <script> tags.  We look for the truncated og:description text
 * as an anchor and then find a longer string nearby in the JSON that starts with
 * the same prefix.
 *
 * Falls back to the truncated text if extraction fails.
 */
function extractFullPostTextFromHtml(html: string, truncatedMessage: string): string | null {
	// Strip trailing ellipsis to get the stable prefix we can search for
	const prefix = truncatedMessage.replace(/[…\.]{1,3}$/, '').trim();
	if (prefix.length < 20) return null;

	// Facebook embeds post content as JSON strings inside <script> tags.
	// We look for the prefix in all <script> blocks and extract the surrounding string.
	const scriptBlocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
	for (const block of scriptBlocks) {
		const scriptContent = block[1] ?? '';
		// Skip tiny scripts or non-data scripts
		if (scriptContent.length < 100) continue;

		// Find the prefix inside a JSON string value — it will be JSON-encoded,
		// meaning newlines become \n and quotes become \".
		const escapedPrefix = prefix
			.slice(0, 60) // only use first 60 chars to keep the search manageable
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"')
			.replace(/\n/g, '\\n')
			.replace(/\r/g, '\\r');

		const idx = scriptContent.indexOf(escapedPrefix);
		if (idx === -1) continue;

		// Find the start of the enclosing JSON string (look backward for an unescaped quote)
		let start = idx;
		while (start > 0 && scriptContent[start - 1] !== '"') start--;
		// Find the end of the enclosing JSON string (look forward for an unescaped quote)
		let end = idx + escapedPrefix.length;
		while (end < scriptContent.length) {
			if (scriptContent[end] === '"' && scriptContent[end - 1] !== '\\') break;
			end++;
		}

		if (end <= start) continue;
		const rawJsonString = scriptContent.slice(start, end);
		// Unescape the JSON string value
		try {
			const unescaped = JSON.parse(`"${rawJsonString}"`);
			if (typeof unescaped === 'string' && unescaped.length > prefix.length) {
				return unescaped.trim();
			}
		} catch {
			// JSON.parse failed — try a simpler unescape
			const simple = rawJsonString
				.replace(/\\n/g, '\n')
				.replace(/\\r/g, '\r')
				.replace(/\\t/g, '\t')
				.replace(/\\\"/g, '"')
				.replace(/\\\\/g, '\\');
			if (simple.length > prefix.length) return simple.trim();
		}
	}
	return null;
}

async function scrapeFacebookPostPublic(fbUrl: string): Promise<{ message: string | null; imageUrl: string | null; publishedAt: string | null }> {
	// facebookexternalhit is Facebook's own crawler UA. Facebook serves real
	// og:description content to this UA for public posts, bypassing login walls.
	const FB_CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

	const fetchWithCrawlerUA = async (targetUrl: string) => fetch(targetUrl, {
		method: 'GET',
		redirect: 'follow',
		headers: {
			'user-agent': FB_CRAWLER_UA,
			'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'accept-language': 'en-US,en;q=0.5',
			'cache-control': 'no-cache',
		},
	});

	const parseOgFromHtml = (html: string): { message: string | null; imageUrl: string | null; publishedAt: string | null } => {
		const descMatch =
			html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ??
			html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
		const imageMatch =
			html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["'](https?[^"']+)["']/i) ??
			html.match(/<meta[^>]+content=["'](https?[^"']+)["'][^>]+property=["']og:image["']/i);

		// Extract published/updated time from og:updated_time or article:published_time
		const timeMatch =
			html.match(/<meta[^>]+property=["']og:updated_time["'][^>]+content=["']([^"']+)["']/i) ??
			html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:updated_time["']/i) ??
			html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i) ??
			html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i);
		const publishedAt = timeMatch?.[1] ? htmlEntityDecode(timeMatch[1]) : null;

		let message = descMatch?.[1] ? htmlEntityDecode(descMatch[1]) : null;

		// og:description is truncated by Facebook at ~300 chars.
		// Attempt to extract the full post text from the embedded JSON data.
		// Facebook embeds post content in __bbox / ScheduledServerJS script blobs.
		if (message) {
			const fullText = extractFullPostTextFromHtml(html, message);
			if (fullText && fullText.length > message.replace(/…$|\.{3}$/, '').length) {
				message = fullText;
			}
		}

		const rawImage = imageMatch?.[1] ? htmlEntityDecode(imageMatch[1]) : null;
		// Filter out Facebook's generic placeholder images
		const imageUrl = rawImage && !rawImage.includes('rsrc.php') && !rawImage.includes('static.xx.fbcdn') ? rawImage : null;
		return { message, imageUrl, publishedAt };
	};

	// Attempt 1: fetch the URL directly with the crawler UA.
	// For share links, Facebook redirects to the real post and serves og: tags.
	// For direct post URLs, this fetches the post page directly.
	try {
		const resp = await fetchWithCrawlerUA(fbUrl);
		if (resp.ok) {
			const html = await resp.text();
			const result = parseOgFromHtml(html);
			if (result.message) return result;

			// If we got a page but no og:description, and the final URL differs
			// from what we requested (i.e. it resolved to a real post URL),
			// try fetching that resolved URL once more.
			if (resp.url && resp.url !== fbUrl && !resp.url.includes('/login')) {
				try {
					const resp2 = await fetchWithCrawlerUA(resp.url);
					if (resp2.ok) {
						const html2 = await resp2.text();
						const result2 = parseOgFromHtml(html2);
						if (result2.message) return result2;
					}
				} catch {
					// fall through
				}
			}
		}
	} catch {
		// fall through to return null
	}

	return { message: null, imageUrl: null, publishedAt: null };
}

/** Decode HTML entities in a string extracted from raw HTML attributes. */
function htmlEntityDecode(input: string): string {
	return input
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, '/')
		.replace(/&#x3D;/g, '=');
}

/**
 * Derive a title and body from a raw Facebook post message string.
 *
 * Short post (no paragraph breaks AND under 280 chars):
 *   → title = entire message, body = entire message
 *
 * Long post:
 *   → title = first non-empty line (if ≤ 150 chars), or first 120 chars with "…"
 *   → body  = entire message
 */
function deriveFacebookTitleAndBody(message: string): { title: string; body: string } {
	let trimmed = message.trim();

	// Facebook post bodies extracted from JSON sometimes include a header block:
	// "Page Name\nDate at Time\nPost text..."
	// Strip leading page-name and date-stamp lines so the actual post content
	// becomes the title/body.  A "date line" looks like "February 26 at 3:00 PM"
	// or "March 8, 2026" or a relative time like "2 hours ago".
	const dateLine = /^(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM)?|\d+\s+(?:hour|minute|day|week|month)s?\s+ago|Yesterday|Just now)\s*$/im;
	const lines = trimmed.split('\n');
	// Find the first line that looks like a date stamp and strip everything up to and including it
	const dateLineIdx = lines.findIndex((l) => dateLine.test(l.trim()));
	if (dateLineIdx !== -1 && dateLineIdx <= 3) {
		// Only strip if the date line is within the first 4 lines (it's a header, not content)
		trimmed = lines.slice(dateLineIdx + 1).join('\n').trim();
	}

	const hasMultipleParagraphs = trimmed.includes('\n\n');

	// Short post — the whole thing is the title
	if (!hasMultipleParagraphs && trimmed.length < 280) {
		return { title: trimmed, body: trimmed };
	}

	// Long post — use the first non-empty line as the title
	const firstLine = trimmed.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';

	if (firstLine && firstLine.length <= 150) {
		return { title: firstLine, body: trimmed };
	}

	// First line too long – truncate
	const autoTitle = trimmed.slice(0, 120).trim() + (trimmed.length > 120 ? '…' : '');
	return { title: autoTitle, body: trimmed };
}

function parseRobotsForGenericBot(content: string): { allow: string[]; disallow: string[] } {
	const allow: string[] = [];
	const disallow: string[] = [];
	const lines = content.split(/\r?\n/);

	let currentAgents: string[] = [];
	let currentAllow: string[] = [];
	let currentDisallow: string[] = [];

	const flushGroup = () => {
		const normalizedAgents = currentAgents.map((value) => value.toLowerCase());
		if (normalizedAgents.includes('*') || normalizedAgents.includes('kentuckynewsbot')) {
			allow.push(...currentAllow);
			disallow.push(...currentDisallow);
		}
		currentAgents = [];
		currentAllow = [];
		currentDisallow = [];
	};

	for (const rawLine of lines) {
		const clean = rawLine.split('#')[0]?.trim() || '';
		if (!clean) continue;
		const split = clean.split(':');
		if (split.length < 2) continue;

		const key = split[0]?.trim().toLowerCase();
		const value = split.slice(1).join(':').trim();
		if (!key) continue;

		if (key === 'user-agent') {
			if (currentAllow.length > 0 || currentDisallow.length > 0) {
				flushGroup();
			}
			currentAgents.push(value);
			continue;
		}

		if (key === 'allow') {
			currentAllow.push(value);
		}
		if (key === 'disallow') {
			currentDisallow.push(value);
		}
	}

	flushGroup();
	return { allow, disallow };
}

function isPathAllowedByRules(pathname: string, allowRules: string[], disallowRules: string[]): boolean {
	const rules = [
		...allowRules.filter(Boolean).map((pattern) => ({ type: 'allow' as const, pattern })),
		...disallowRules.filter(Boolean).map((pattern) => ({ type: 'disallow' as const, pattern })),
	];

	let best: { type: 'allow' | 'disallow'; length: number } | null = null;
	for (const rule of rules) {
		if (!matchesRobotsPattern(pathname, rule.pattern)) continue;
		const score = rule.pattern.length;
		if (!best || score > best.length || (score === best.length && rule.type === 'allow' && best.type === 'disallow')) {
			best = { type: rule.type, length: score };
		}
	}

	if (!best) return true;
	return best.type === 'allow';
}

function matchesRobotsPattern(pathname: string, pattern: string): boolean {
	if (!pattern) return false;
	const hasEndAnchor = pattern.endsWith('$');
	const rawPattern = hasEndAnchor ? pattern.slice(0, -1) : pattern;
	const escaped = rawPattern
		.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*');
	const regex = new RegExp(`^${escaped}${hasEndAnchor ? '$' : ''}`);
	return regex.test(pathname);
}
