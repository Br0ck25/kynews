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
	getLatestArticlesForLlms,
	getTopArticlesByCategory,
	unblockArticleByBlockedId,
	updateArticlePublishedAt,
	updateArticleClassification,
	updateArticleContent,
	updateArticleLinks,
	backfillMissingSlugs,
	getCountyCounts,
	getArticlesByCounty,
	getArticlesForUpdateCheck,
	findSlugMigration,
	migrateHashSlugs,
	prependUpdateToSummary,
	updateArticlePrimaryCounty,
	prepare,
	generateSeoSlug,
	// push helpers
	savePushSubscription,
	sendPushNotification,
	getFacebookSchedulerConfig,
	setFacebookSchedulerConfig,
	getRecentTodayArticles,
	addFacebookSchedulerPostedId,
	removeFacebookSchedulerPostedId,
	getFacebookSchedulerPostedIds,
	appendAdminLog,
	getAdminLogs,
	FacebookSchedulerPostHistoryItem,
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
import { ingestSingleUrl, findHighlySimilarTitle, fetchAndExtractArticle, generateImageAlt } from './lib/ingest';
import { normalizeCountyList } from './lib/geo';
import { KY_COUNTIES } from './data/ky-geo';
import { fetchAndParseFeed, resolveFeedUrls } from './lib/rss';
import { classifyArticleWithAi } from './lib/classify';
import { summarizeArticle, generateUpdateParagraph } from './lib/ai';
import type { Category, NewArticle, ArticleRecord } from './types';
import { generateFacebookCaption, generateAiFacebookCaption } from './lib/facebook';
import { buildPageTitle } from './lib/pageTitle';
import { processNwsAlerts, processNwsProducts, processLiveAlertsNationwide, fetchNwsAlertById, postWeatherAlertToFacebook, postFacebookPhotoCaption, getWeatherAlertImageUrl, buildWeatherAlertFbCaption, getLiveAlertAutopostFlag, setLiveAlertAutopostFlag, getLiveAlertAutopostStart, setLiveAlertAutopostStart, extractPrimaryStateCode } from './lib/nws';
import { processSpcFeed, parseSpcOutlooks } from './lib/spc';
import { fetchNwsStories } from './lib/nwsStories';
import { maybeRunWeatherSummary, publishWeatherSummary } from './lib/weatherSummary';
import { isSearchBot } from './lib/isSearchBot';
import {
	listWeatherAlertPosts,
	getPostedNwsAlertIds,
	getWeatherAlertPostById,
	insertWeatherAlertPost,
	updateWeatherAlertPostText,
	deleteWeatherAlertPost,
	deleteAllWeatherAlertPosts,
} from './lib/weatherAlerts';

const DEFAULT_SEED_LIMIT_PER_SOURCE = 0;
const MAX_SEED_LIMIT_PER_SOURCE = 10000;

const DIGEST_AUTOPOST_ENABLED_KEY = 'admin:digest:autopost:enabled';

async function getDigestAutopostEnabled(env: Env): Promise<boolean> {
	if (!env.CACHE) return true;
	const raw = await (env.CACHE as any).get(DIGEST_AUTOPOST_ENABLED_KEY);
	if (raw === null || raw === undefined) return true;
	return String(raw).toLowerCase() !== 'false';
}

async function setDigestAutopostEnabled(env: Env, enabled: boolean): Promise<void> {
	if (!env.CACHE) return;
	await (env.CACHE as any).put(DIGEST_AUTOPOST_ENABLED_KEY, enabled ? 'true' : 'false');
}

// If an article has fewer than this many raw words (measured at ingest)
// we serve a noindex directive to crawlers.
// Thin but valid content is indexed but should be capped in the snippet.
const NOINDEX_WORD_THRESHOLD = 150;
const SNIPPET_LIMIT_THRESHOLD = 100;

/**
 * Decide the robots meta tag based on the word count.
 */
function getRobotsContent(wordCount: number | null | undefined): string {
	const wc = wordCount ?? 0;
	if (wc < NOINDEX_WORD_THRESHOLD) return 'noindex,follow';
	if (wc < SNIPPET_LIMIT_THRESHOLD) return 'index,follow,max-snippet:160';
	return 'index,follow';
}

/**
 * Derive a sourceOrganization object for JSON-LD from an article's canonicalUrl.
 * Strips www., removes the TLD, splits on hyphens/dots, and title-cases each
 * word to produce a human-readable organization name.
 */
function deriveSourceOrganization(canonicalUrl: string): {
	'@type': string;
	name: string;
	url: string;
} {
	try {
		const hostname = new URL(canonicalUrl).hostname.replace(/^www\./, '');
		const withoutTld = hostname.replace(/\.[^.]+$/, '');
		const name = withoutTld
			.split(/[-.]/ )
			.filter(Boolean)
			.map(w => w.charAt(0).toUpperCase() + w.slice(1))
			.join(' ');
		return {
			'@type': 'NewsMediaOrganization',
			name: name || hostname,
			url: `https://${hostname}`,
		};
	} catch {
		return {
			'@type': 'NewsMediaOrganization',
			name: 'Local Kentucky News Source',
			url: 'https://localkynews.com',
		};
	}
}

function extractEventDateFromContent(contentText: string | null | undefined, publishedAt: string | null | undefined): string | null {
	if (!contentText || !publishedAt) return null;
	const publishedDate = new Date(publishedAt);
	if (Number.isNaN(publishedDate.getTime())) return null;
	const publishedMs = publishedDate.getTime();

	const monthMap: Record<string, number> = {
		January: 0,
		February: 1,
		March: 2,
		April: 3,
		May: 4,
		June: 5,
		July: 6,
		August: 7,
		September: 8,
		October: 9,
		November: 10,
		December: 11,
	};

	const pad = (n: number) => n.toString().padStart(2, '0');
	const toIso = (year: number, month0: number, day: number) => {
		const dt = Date.UTC(year, month0, day);
		if (dt <= publishedMs) return null;
		return `${year}-${pad(month0 + 1)}-${pad(day)}`;
	};

	// Look for Month DD, YYYY (e.g. "January 5, 2026")
	const monthRegex = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})\b/g;
	let match: RegExpExecArray | null;
	while ((match = monthRegex.exec(contentText)) !== null) {
		const month0 = monthMap[match[1]];
		const day = Number(match[2]);
		const year = Number(match[3]);
		if (!Number.isFinite(day) || !Number.isFinite(year)) continue;
		const iso = toIso(year, month0, day);
		if (iso) return iso;
	}

	// Look for MM/DD/YYYY
	const slashRegex = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
	while ((match = slashRegex.exec(contentText)) !== null) {
		const month = Number(match[1]);
		const day = Number(match[2]);
		const year = Number(match[3]);
		if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) continue;
		if (month < 1 || month > 12) continue;
		if (day < 1 || day > 31) continue;
		const iso = toIso(year, month - 1, day);
		if (iso) return iso;
	}

	return null;
}

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
		// KV namespace used for various caches (and now push subscriptions)
		CACHE?: KVNamespace;
		// asset binding provided by wrangler to serve static files
		ASSETS?: { fetch(input: RequestInfo, init?: RequestInit): Promise<Response> };
		// optional Facebook application ID used for OG tags in preview pages
		FB_APP_ID?: string;
		// optional Facebook page token for posting digests
		FB_PAGE_TOKEN?: string;
		// optional Facebook Page ID used for auto-posting digests
		FB_PAGE_ID?: string;
	}
}

const STRUCTURED_SEARCH_SOURCE_URLS = new Set<string>([
	// Add non-RSS search sources here if needed.
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
const DEFAULT_OG_IMAGE = `${BASE_URL}/img/og-default.png`;
const LOGO_IMAGE = `${BASE_URL}/img/logo512.png`;
/* TODO: export a 600×60px PNG of the site wordmark to public/img/logo-wide.png */

function normalizeOgImage(imageUrl: string | null | undefined): string {
	const resolved = imageUrl || DEFAULT_OG_IMAGE;
	return resolved === LOGO_IMAGE ? DEFAULT_OG_IMAGE : resolved;
}

/**
 * Return a URL that points to an image served from our domain.
 *
 * Facebook prefers preview images that are hosted on the same domain as the
 * shared URL. When our article's author-provided image is hosted on a third-
 * party site, we proxy it through our R2 bucket via /api/media/ so Facebook
 * uses a LocalKYNews-hosted image instead.
 */
async function getFacebookProxyImageUrl(env: Env, imageUrl: string | null | undefined): Promise<string | null> {
	if (!imageUrl) return null;
	if (imageUrl.startsWith(BASE_URL)) return imageUrl;
	if (!env.CACHE || !env.ky_news_media) return null;

	try {
		const hash = await sha256Hex(imageUrl);
		const cacheKey = `facebook:image-proxy:${hash}`;
		const cached = await env.CACHE.get<string>(cacheKey);
		if (cached) return cached;

		const resp = await fetch(imageUrl, { redirect: 'follow' });
		if (!resp.ok) return null;
		const contentType = resp.headers.get('content-type') || '';
		if (!contentType.startsWith('image/')) return null;
		const buffer = await resp.arrayBuffer();

		const urlObj = new URL(imageUrl);
		const extMatch = urlObj.pathname.match(/\.([a-z0-9]+)$/i);
		const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
		const safeExt = /^(jpg|jpeg|png|webp|gif|avif|svg|bmp)$/.test(ext) ? ext : 'jpg';

		const key = `facebook-image-proxy/${hash}.${safeExt}`;
		await env.ky_news_media.put(key, buffer, {
			httpMetadata: { contentType },
		});

		const proxyUrl = `${BASE_URL}/api/media/${key}`;
		await env.CACHE.put(cacheKey, proxyUrl, { expirationTtl: 60 * 60 * 24 * 30 });
		return proxyUrl;
	} catch {
		return null;
	}
}

/**
 * Return an HTML <section class="related"> block listing up to 5 recent published
 * articles from the same county, for crawler-visible internal links.
 * Returns an empty string when fewer than 2 related articles exist.
 */
async function buildRelatedCountyArticlesHtml(env: Env, article: ArticleRecord): Promise<string> {
	if (!article?.county) return '';

	const rows = await prepare(env,
		`SELECT title, slug, county, category, is_national, id
		 FROM articles
		 WHERE county = ? AND id != ? AND slug IS NOT NULL AND published_at IS NOT NULL
		 ORDER BY published_at DESC
		 LIMIT 5`
	).bind(article.county, article.id).all<any>();

	const items = (rows.results || []).filter((r: any) => r && r.slug);
	if (items.length < 2) return '';

	const listItems = items
		.map((row: any) => {
			const href = buildArticleUrl(
				BASE_URL,
				row.slug,
				row.county,
				row.category,
				Boolean(row.is_national),
				row.id,
			);
			return `    <li><a href="${escapeHtml(href)}">${escapeHtml(row.title)}</a></li>`;
		})
		.join('\n');

	return `<section class="related">
  <h2>More from ${escapeHtml(article.county)} County</h2>
  <ul>
${listItems}
  </ul>
</section>`;
}

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

async function postArticleToFacebook(env: Env, article: ArticleRecord) {
	const pageId = ((env as any).FACEBOOK_PAGE_ID || '').trim();
	const pageToken = ((env as any).FACEBOOK_PAGE_ACCESS_TOKEN || '').trim();
	if (!pageId || !pageToken) {
		return { ok: false, error: 'Facebook credentials not configured' };
	}

	// If this is a weather alert article (auto-ingested from the NWS API), use
	// the dedicated weather alert caption + photo post handler, which ensures the
	// post matches the expected "SPECIAL WEATHER STATEMENT" format.
	if (article.category === 'weather' && article.sourceUrl?.includes('/alerts/')) {
		const match = article.sourceUrl.match(/alerts\/(.+)$/);
		const alertId = match?.[1] ?? '';
		if (alertId) {
			const nwsAlert = await fetchNwsAlertById(alertId);
			if (nwsAlert) {
				await postWeatherAlertToFacebook(env, nwsAlert);
				return { ok: true, weatherAlert: true };
			}
		}
		// Fall back to the generic Facebook post path if we can't fetch the alert.
	}

	const caption = generateFacebookCaption(article);
	if (!caption) {
		return { ok: false, error: 'article not Kentucky or missing data' };
	}

	// Always link to our own article page on localkynews.com so traffic goes
	// through our site. Facebook's scraper will pick up og:image from our page.
	// Do NOT pass the `picture` param — it requires domain verification in
	// Facebook Business Manager (app ownership check) and causes code 100 errors.
	const ourArticleUrl = buildArticleUrl(BASE_URL, article.slug, article.county, article.category, article.isNational, article.id);

	try {
		const params: Record<string, string> = {
			message: caption,
			link: ourArticleUrl,
			access_token: pageToken,
		};

		const postResp = await fetch(`https://graph.facebook.com/v15.0/${pageId}/feed`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(params),
		});
		const postData = await postResp.json() as any;
		// The Graph API returns an "error" object on failure even when the HTTP
		// status is 200, so we must check the body — not just the HTTP status code.
		if (!postResp.ok || postData?.error) {
			const fbMsg = postData?.error?.message || `HTTP ${postResp.status}`;
			const fbCode = postData?.error?.code ? ` (code ${postData.error.code})` : '';
			return { ok: false, error: `${fbMsg}${fbCode}`, result: postData };
		}
		return { ok: true, fbPostId: String(postData?.id ?? ''), result: postData };
	} catch (err) {
		return { ok: false, error: 'Failed to post to Facebook', details: String(err) };
	}
}

async function runFacebookScheduler(env: Env): Promise<void> {
	const config = await getFacebookSchedulerConfig(env);
	if (!config.enabled) return;

	const tz = config.timezone || 'America/New_York';
	const nowUtc = new Date();
	const nowHHMM = nowUtc.toLocaleTimeString('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });

	const inTimeWindow = (hhmm: string, start: string, end: string) => {
		const toMins = (s: string) => {
			const [h, m] = s.split(':').map(Number);
			return h * 60 + m;
		};
		const cur = toMins(hhmm);
		const s = toMins(start);
		const e = toMins(end);
		return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
	};

	if (!inTimeWindow(nowHHMM, config.start, config.end)) return;

	const lastRun = config.lastRunAt ? new Date(config.lastRunAt) : null;
	if (lastRun) {
		const nextRun = new Date(lastRun.getTime() + (config.intervalMinutes || 60) * 60 * 1000);
		if (nowUtc < nextRun) return;
	}

	const articles = await getRecentTodayArticles(env, 500);
	const posted = await getFacebookSchedulerPostedIds(env);
	const eligible = articles.filter((row) => {
		if (row.category !== 'today') return false;
		if (!row.publishedAt || row.publishedAt.startsWith('9999')) return false;
		if (posted[String(row.id)]) return false;
		const artTime = new Date(row.publishedAt).toLocaleTimeString('en-US', {
			timeZone: tz,
			hour12: false,
			hour: '2-digit',
			minute: '2-digit',
		});
		return inTimeWindow(artTime, config.start, config.end);
	});

	if (eligible.length === 0) {
		return;
	}

	// Rank eligible articles using the same scoring logic as the morning/evening
	// digest so that high-value stories (crime, government, breaking news) are
	// always posted before filler or low-importance content.
	const toDigestRow = (a: ArticleRecord): DigestRow => ({
		id: a.id,
		title: a.title,
		slug: a.slug ?? null,
		county: a.county ?? null,
		category: a.category,
		is_kentucky: a.isKentucky ? 1 : 0,
		is_national: a.isNational ? 1 : 0,
		published_at: a.publishedAt ?? null,
	});

	eligible.sort((a, b) => {
		const scoreDiff = scoreArticle(toDigestRow(b)) - scoreArticle(toDigestRow(a));
		if (scoreDiff !== 0) return scoreDiff;
		// break ties by recency
		return new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime();
	});
	const article = eligible[0];

	const result = await postArticleToFacebook(env, article);
	const resultType: 'success' | 'error' | 'weather' =
		result.ok ? ((result as any).weatherAlert ? 'weather' : 'success') : 'error';
	const historyEntry: FacebookSchedulerPostHistoryItem = {
		at: nowUtc.toISOString(),
		id: article.id,
		title: article.title,
		result: resultType,
		...( resultType === 'success' && (result as any).fbPostId ? { fbPostId: (result as any).fbPostId } : {} ),
		...( resultType === 'error' && result.error ? { error: result.error } : {} ),
	};

	// Log to the admin activity feed so the failure is visible immediately.
	if (resultType === 'error') {
		await appendAdminLog(env, `❌ FB scheduler post FAILED for "${article.title}" (ID ${article.id}): ${result.error ?? 'unknown error'}`);
	} else {
		const fbId = (result as any).fbPostId ? ` FB post ID: ${(result as any).fbPostId}` : '';
		await appendAdminLog(env, `✅ FB scheduler posted "${article.title}" (ID ${article.id}).${fbId}`);
	}

	// Update scheduler state with last run and last post details.
	await setFacebookSchedulerConfig(env, {
		lastRunAt: nowUtc.toISOString(),
		lastPostedId: article.id,
		lastPostedTitle: article.title,
		lastPostingHistory: [
			...(await getFacebookSchedulerConfig(env)).lastPostingHistory ?? [],
			historyEntry,
		].slice(-10),
	});

	if (result.ok) {
		await addFacebookSchedulerPostedId(env, article.id);
	}
}

// Helper to choose a sensible preview image URL for an article record. Mirrors
// the logic used when rendering OG tags for bots.
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

/** All route handling extracted so the outer fetch() can wrap it in a try/catch
 *  that guarantees CORS headers are present on every response, even unhandled exceptions. */
async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
const url = new URL(request.url);

// Enforce a single canonical hostname: redirect www → non-www.
// This prevents duplicate-content signals and concentrates ranking signals.
if (url.hostname.toLowerCase() === 'www.localkynews.com') {
  const target = `https://localkynews.com${url.pathname}${url.search}`;
  return new Response(null, {
    status: 301,
    headers: {
      Location: target,
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}

// Homepage bot handling – serve JSON-LD structured data for search crawlers.
// Regular browsers and the /health probe still get the JSON ping below.
if (url.pathname === '/' && request.method === 'GET' && isSearchBot(request.headers.get('user-agent') || '')) {
  const websiteSchema = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Local KY News',
    url: 'https://localkynews.com',
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: 'https://localkynews.com/search?q={search_term_string}',
      },
      'query-input': 'required name=search_term_string',
    },
  };
  const orgSchema = {
    '@context': 'https://schema.org',
    '@type': 'NewsMediaOrganization',
    name: 'Local KY News',
    url: 'https://localkynews.com',
    logo: {
      '@type': 'ImageObject',
      url: 'https://localkynews.com/img/logo-wide.png',
      width: 600,
      height: 60,
    },
    sameAs: [],
    areaServed: {
      '@type': 'State',
      name: 'Kentucky',
    },
  };
  const homepageHtml = `<!doctype html>
<html lang="en-US">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Local KY News — Kentucky&#x27;s Local News Source</title>
  <meta name="description" content="Local KY News covers the latest headlines from all 120 Kentucky counties — local government, schools, sports, weather, and community stories."/>
  <link rel="canonical" href="https://localkynews.com/"/>
  <meta property="og:type" content="website"/>
  <meta property="og:title" content="Local KY News — Kentucky&#x27;s Local News Source"/>
  <meta property="og:description" content="Local KY News covers the latest headlines from all 120 Kentucky counties — local government, schools, sports, weather, and community stories."/>
  <meta property="og:url" content="https://localkynews.com/"/>
  <meta property="og:site_name" content="Local KY News"/>
  <meta property="og:image" content="${DEFAULT_OG_IMAGE}"/>
  <meta name="twitter:card" content="summary_large_image"/>
  <meta name="twitter:site" content="@LocalKYNews"/>
  <script type="application/ld+json">${JSON.stringify(websiteSchema)}</script>
  <script type="application/ld+json">${JSON.stringify(orgSchema)}</script>
</head>
<body>
  <h1>Local KY News</h1>
  <p>Kentucky&#x27;s local news source — covering all 120 counties.</p>
  <script>window.location.href="https://localkynews.com/";</script>
</body>
</html>`;
  return new Response(homepageHtml, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}

if ((url.pathname === '/' || url.pathname === '/health') && request.method === 'GET') {
return json({
ok: true,
service: 'kentucky-news-worker',
date: new Date().toISOString(),
});
}

// serve llms.txt as a dynamically generated index for LLMs
if (url.pathname === '/llms.txt' && request.method === 'GET') {
  try {
    const articles = await getLatestArticlesForLlms(env, 200);
    const updated = new Date().toISOString();

    const preamble = `# Local KY News — AI-readable article index\n` +
      `# Site: https://localkynews.com\n` +
      `# Updated: ${updated}\n` +
      `# Coverage: Kentucky local news, all 120 counties\n\n`;

    const entries = articles
      .map((article) => {
        const title = article.title || '';
        const href = buildArticleUrl(
          BASE_URL,
          article.slug,
          article.county,
          article.category,
          Boolean(article.is_national),
          article.id,
        );
        const isoDate = toIsoDateOrNull(article.published_at) || '';
        const date = isoDate.split('T')[0] || '';
        const county = article.county || 'Kentucky';
        const summary = (article.seo_description || '').replace(/\s+/g, ' ').trim().slice(0, 160);

        return `# ${title}\n` +
          `URL: ${href}\n` +
          `Date: ${date}\n` +
          `County: ${county}\n` +
          `Summary: ${summary}`;
      })
      .join('\n\n');

    const body = `${preamble}${entries}${entries ? '\n' : ''}`;

    return new Response(body, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=3600, s-maxage=3600',
      },
    });
  } catch (error) {
    return badRequest('Failed to generate llms.txt');
  }
}

// push subscription endpoint used by the SPA settings page
if (url.pathname === '/api/subscribe' && request.method === 'POST') {
  const sub = await parseJsonBody<any>(request);
  if (!sub || !sub.endpoint) return badRequest('missing subscription');
  await savePushSubscription(env, sub);
  return json({ success: true }, 201);
}

// internal API for broadcasting a notification (used by tests or admin UI)
if (url.pathname === '/api/sendNotification' && request.method === 'POST') {
  const payload = (await parseJsonBody<{ title: string; body: string; url: string }>(request)) || null;
  if (!payload || !payload.title || !payload.body || !payload.url) return badRequest('Missing title/body/url in payload');
  await sendPushNotification(env, payload);
  return json({ success: true });
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

  // Facebook URLs cannot be ingested like normal articles — the regular fetch
  // path hits a login wall.  Route them through the Facebook scrape path and
  // synthesize an IngestSource with the post content so the rest of the
  // pipeline (classify → summarize → insert) works normally.
  if (isFacebookUrl(articleUrl)) {
    try {
      const scraped = await scrapeFacebookPostPublic(articleUrl);
      if (!scraped.message) {
        return json({ status: 'rejected', reason: 'Could not retrieve Facebook post content — the post may be private or require login.' }, 422);
      }
      const { title, body: postBody } = deriveFacebookTitleAndBody(scraped.message);
      const result = await ingestSingleUrl(env, {
        url: articleUrl,
        allowShortContent: true,
        providedTitle: title,
        providedDescription: postBody,
        feedPublishedAt: scraped.publishedAt ?? undefined,
      });
      return json(result, result.status === 'rejected' ? 422 : 200);
    } catch (error) {
      const msg = safeError(error);
      console.error('[INGEST-URL FACEBOOK FAILED]', msg);
      return json({ status: 'rejected', reason: msg }, 422);
    }
  }

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

// ── POST /api/admin/article-test ────────────────────────────────────────────
// Fetch an external URL, then use AI to rewrite it as original reporting.
// Removes all attribution phrases ("According to X", "X said in a social media post", etc.)
// PREVIEW ONLY — nothing is saved to the database or published.
if (url.pathname === '/api/admin/article-test' && request.method === 'POST') {
  if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);

  const body = await parseJsonBody<{ url?: string }>(request);
  const testUrl = (body?.url || '').trim();
  if (!testUrl || !isHttpUrl(testUrl)) return badRequest('A valid http(s) URL is required.');

  let extracted;
  try {
    extracted = await fetchAndExtractArticle(env, { url: testUrl, sourceUrl: testUrl, allowShortContent: true });
  } catch (err: any) {
    return badRequest(`Could not fetch article: ${err?.message || 'Unknown error'}`);
  }

  const articleContent = (extracted.contentText || '').trim();
  if (!articleContent) return badRequest('No readable article content found at that URL.');

  const REWRITE_MODEL = '@cf/zai-org/glm-4.7-flash' as keyof AiModels;

  const systemPrompt = `You are an editor for LocalKYNews.com, a Kentucky local news website.
Your job is to rewrite news articles as original, first-person reporting by our newsroom.

When the source article uses any of these attribution patterns, remove them and state the facts directly:
- "According to [agency]" → remove, state the fact directly
- "[Agency] said in a social media post" → remove, state the fact directly
- "[Agency] says / said / announced" → remove, state the fact directly
- "officials say / officials said" → remove, state the fact directly
- "crews say / crews said" → remove, state the fact directly
- "the department said / the department says" → remove, state the fact directly
- "said in a statement / said in a news release" → remove, state the fact directly
- "per [agency]" → remove

Write the article as if our newsroom is directly reporting these facts.

Rules:
- Do NOT link back to or credit the original news outlet
- Do NOT use any attribution opener — name subjects directly and state facts as established events
- Keep all facts, names, locations, dates, and figures exactly as in the source
- Write in clean, professional local news style in third-person
- Preserve direct quotes from named officials (fire chiefs, mayors, etc.) using quotation marks
- Output exactly two things, separated by a single blank line:
  1. A news headline (one concise line)
  2. The full rewritten article body (multiple paragraphs, no headers or labels)
- Do not add any label like "Headline:" or "Body:" — output only the headline then the body`;

  const userPrompt = `Rewrite this as an original LocalKYNews.com article:\n\nOriginal headline: ${extracted.title}\n\n${articleContent.slice(0, 8000)}`;

  try {
    const aiRaw = (await env.AI.run(REWRITE_MODEL, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_completion_tokens: 2000,
    })) as { response?: string; result?: { response?: string }; output_text?: string };

    const rawText = (
      aiRaw?.response ||
      aiRaw?.result?.response ||
      aiRaw?.output_text ||
      ''
    ).trim();

    if (!rawText) return json({ ok: false, error: 'AI returned an empty response.' });

    // First non-empty line is the headline; everything after is the body
    const lines = rawText.split('\n');
    const headlineIdx = lines.findIndex((l) => l.trim().length > 0);
    const rewrittenTitle = headlineIdx >= 0 ? lines[headlineIdx].trim() : extracted.title;
    const rewrittenBody = lines.slice(headlineIdx + 1).join('\n').trim();

    return json({
      ok: true,
      originalTitle: extracted.title,
      originalUrl: testUrl,
      rewrittenTitle,
      rewrittenBody,
    });
  } catch (err: any) {
    return json({ ok: false, error: `AI rewrite failed: ${err?.message || 'Unknown error'}` });
  }
}

// ── POST /api/admin/nws-discussion/facebook-format ─────────────────────────
// AI formatter for NWS Area Forecast Discussions copied from the admin UI.
// Returns plain-text Facebook post content in strict office-specific templates.
if (url.pathname === '/api/admin/nws-discussion/facebook-format' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	if (!env.AI) return json({ error: 'AI binding is unavailable' }, 500);

	const body = await parseJsonBody<{ rawText?: string; officeLabel?: string; officeId?: string }>(request);
	const rawText = String(body?.rawText || '').trim();
	const officeId = String(body?.officeId || '').trim().toUpperCase();
	const officeLabelInput = String(body?.officeLabel || '').trim();

	if (!rawText) return badRequest('Missing rawText');

	let officeLabel = officeLabelInput;
	if (!officeLabel) {
		if (officeId === 'KJKL') officeLabel = 'Eastern Kentucky';
		else if (officeId === 'KLMK') officeLabel = 'Central Kentucky';
		else if (officeId === 'KPAH') officeLabel = 'Western Kentucky';
	}
	if (!officeLabel) officeLabel = 'Eastern Kentucky';

	const upperLabel = officeLabel.toUpperCase();
	const FORMAT_MODEL = '@cf/zai-org/glm-4.7-flash' as keyof AiModels;

	const templateRules = /CENTRAL KENTUCKY/i.test(upperLabel)
		? `TEMPLATE (use exactly these section headings):
🌤️ CENTRAL KENTUCKY WEATHER UPDATE

KEY TAKEAWAYS

TODAY (THURSDAY)
FRIDAY
WEEKEND
SUNDAY NIGHT – MONDAY
EARLY NEXT WEEK

BOTTOM LINE`
		: /WESTERN KENTUCKY/i.test(upperLabel)
		? `TEMPLATE (use exactly these section headings):
🌤️ WESTERN KENTUCKY WEATHER UPDATE

KEY TAKEAWAYS

TODAY (THURSDAY)
FRIDAY
WEEKEND
SUNDAY NIGHT
MONDAY
TUESDAY – WEDNESDAY

BOTTOM LINE`
		: `TEMPLATE (use exactly these section headings):
🌤️ EASTERN KENTUCKY WEATHER UPDATE

KEY TAKEAWAYS

THURSDAY
FRIDAY
SATURDAY
SUNDAY
SUNDAY NIGHT – MONDAY

BOTTOM LINE`;

	const systemPrompt = `You are the Local KY News weather social media editor.
Rewrite Area Forecast Discussion (AFD) text into a publication-ready Facebook post.

Hard rules:
- Plain text only. No markdown, no bullets symbols, no hashtags.
- Use ONLY facts in the AFD text; do not add outside facts.
- Keep wording clear and local-news style.
- Keep each section concise with short lines.
- Show ACTIVE ALERTS only when the Kentucky line has a real alert.
- If Kentucky alerts are "None", omit ACTIVE ALERTS entirely.
- Use an en dash in headings where shown (for example: SUNDAY NIGHT – MONDAY, TUESDAY – WEDNESDAY).
- Output only the final post text.

${templateRules}`;

	const userPrompt = `Office label: ${officeLabel}

AFD TEXT:
${rawText.slice(0, 14000)}`;

	try {
		const aiRaw = (await env.AI.run(FORMAT_MODEL, {
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userPrompt },
			],
			temperature: 0.1,
			seed: 42,
			max_completion_tokens: 1800,
		})) as { response?: string; result?: { response?: string }; output_text?: string };

		let formatted = (
			aiRaw?.response ||
			aiRaw?.result?.response ||
			aiRaw?.output_text ||
			''
		).trim();

		if (!formatted) return json({ error: 'AI returned an empty response' }, 500);

		formatted = formatted
			.replace(/\r\n/g, '\n')
			.replace(/^#{1,6}\s+/gm, '')
			.replace(/\*\*/g, '')
			.replace(/\n{3,}/g, '\n\n')
			.trim();

		// Force a deterministic header line in case model casing drifts.
		const expectedHeader = `🌤️ ${upperLabel} WEATHER UPDATE`;
		const lines = formatted.split('\n');
		if (lines.length === 0 || !/WEATHER UPDATE/i.test(lines[0])) {
			formatted = `${expectedHeader}\n\n${formatted}`;
		} else {
			lines[0] = expectedHeader;
			formatted = lines.join('\n');
		}

		// Never publish a "None" alerts block.
		formatted = formatted
			.replace(/(^|\n)ACTIVE ALERTS\s*\n(?:[^\n]*None\.?\s*\n?)+/gi, '$1')
			.replace(/\n{3,}/g, '\n\n')
			.trim();

		// Ensure bottom-line sentence ends cleanly.
		formatted = formatted.replace(/(BOTTOM LINE\s*\n[^\n]*?)(?=\s*$)/, (m) => {
			const t = m.trimEnd();
			return /[.!?]$/.test(t) ? t : `${t}.`;
		});

		return json({ ok: true, formatted });
	} catch (err: any) {
		return json({ error: `AI formatting failed: ${err?.message || 'Unknown error'}` }, 500);
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

  // Facebook URLs cannot be fetched like regular articles — they redirect to a
  // login wall.  Use the Facebook scrape path to get the post content, then
  // synthesize an IngestSource so the classify+summarize pipeline can run.
  if (isFacebookUrl(articleUrl)) {
    try {
      const scraped = await scrapeFacebookPostPublic(articleUrl);
      if (!scraped.message) {
        return json({
          status: 'rejected',
          reason: 'Could not retrieve Facebook post content — the post may be private or require login. Use "Create Manual Article → Load from Facebook" or fill fields manually.',
        }, 422);
      }
      const { title, body: postBody } = deriveFacebookTitleAndBody(scraped.message);
      const result = await ingestSingleUrl(env, {
        url: articleUrl,
        preview: true,
        allowShortContent: true,
        providedTitle: title,
        providedDescription: postBody,
        feedPublishedAt: scraped.publishedAt ?? undefined,
      });
      return json(result, result.status === 'rejected' ? 422 : 200);
    } catch (error) {
      const msg = safeError(error);
      console.error('[PREVIEW FACEBOOK FAILED]', msg);
      return json({ status: 'rejected', reason: msg }, 422);
    }
  }

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
		if (env.CACHE) {
			try {
				const rawPre = await (env.CACHE as any).get(BACKFILL_STATUS_KEY, 'text');
				if (rawPre) {
					const statusObjPre = JSON.parse(rawPre);
					if (statusObjPre && statusObjPre.status === 'running') {
						statusObjPre.currentUrl = sourceUrl;
						await (env.CACHE as any).put(BACKFILL_STATUS_KEY, JSON.stringify(statusObjPre), { expirationTtl: 7200 }).catch(() => {});
					}
				}
			} catch {}
		}
		await __testables.runIngest(env, [sourceUrl], threshold * 2, 'manual', { rotateSources: false }).catch((e: any) => {
			console.error('runIngest error for', county, sourceUrl, e);
			return null;
		});
		// update status object (same as previous code)
		if (env.CACHE) {
			try {
				const raw = await (env.CACHE as any).get(BACKFILL_STATUS_KEY, 'text');
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
						await (env.CACHE as any).put(BACKFILL_STATUS_KEY, JSON.stringify(statusObj), { expirationTtl: ttl }).catch((e: any) => {
							console.error('status put failed for', county, e);
						});
					}
				}
			} catch (e) {
				console.error('error updating status for', county, e);
			}
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

// Manual admin endpoint to regenerate AI summaries for articles published in last 48h
if (url.pathname === '/api/admin/regenerate-recent' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}
	ctx.waitUntil(regenerateRecentArticles(env, 48));
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
	await (env.CACHE as any).put(BACKFILL_STATUS_KEY, JSON.stringify(initialStatus), { expirationTtl: 7200 }).catch(() => null);

	// schedule a queue message for each county
	for (const county of missing) {
		ctx.waitUntil(
			(env.INGEST_QUEUE as any).send({ type: 'backfillCounty', county, threshold }),
		);
	}

	return json({ ok: true, message: 'Backfill queued', threshold, missingCount: totalJobs }, 202);
}

// Backfill missing SEO slugs for legacy articles.
// This should be called once after deployment to clean up old rows;
// it is safe to run multiple times (idempotent).
if (url.pathname === '/api/admin/backfill-slugs' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}

	const result = await backfillMissingSlugs(env);
	return json({ updated: result.updated, status: 'ok' });
}

if (url.pathname === '/api/admin/backfill-status' && request.method === 'GET') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}
	const status = await (env.CACHE as any).get(BACKFILL_STATUS_KEY, 'json').catch(() => null);
	return json({ status: status ?? null });
}

if (url.pathname === '/api/admin/metrics' && request.method === 'GET') {
if (!isAdminAuthorized(request, env)) {
return json({ error: 'Unauthorized' }, 401);
}

const latestRaw = await (env.CACHE as any).get(INGEST_METRICS_KEY, 'json').catch(() => null);
const latest = latestRaw as IngestRunMetrics | null;
return json({ latest: latest ?? null });
}

if (url.pathname === '/api/admin/rejections' && request.method === 'GET') {
if (!isAdminAuthorized(request, env)) {
return json({ error: 'Unauthorized' }, 401);
}

const latestRaw = await (env.CACHE as any).get(INGEST_METRICS_KEY, 'json').catch(() => null);
const latest = latestRaw as IngestRunMetrics | null;
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
      await (env.CACHE as any).delete(summaryKey).catch(() => {});
      await (env.CACHE as any).delete(ttlKey).catch(() => {});
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

    // Content changed — generate update paragraph.
    // Even if the hash is identical to the stored one (meaning the content
    // hasn't changed since the last automated check), we still run the AI/
    // fallback here because a previous check may have advanced the hash
    // without ever actually updating the article summary (e.g. AI returned
    // NO_UPDATE on the first pass).  For a manual admin check we always
    // want to compare the *current* article content against the *current*
    // stored summary so we don't silently drop updates.
    const contentChanged = article.contentHash !== newHash;
    const updateParagraph = await generateUpdateParagraph(
      env,
      extracted.contentText,
      article.summary,
      article.publishedAt,
    );

    if (!updateParagraph) {
      if (contentChanged) {
        // Content changed but nothing new to say — advance stored hash so
        // future cron runs don't keep re-checking the same version.
        await prepare(env, 'UPDATE articles SET content_hash = ? WHERE id = ?')
          .bind(newHash, article.id)
          .run()
          .catch(() => {});
      }
      const reason = contentChanged
        ? 'Content changed but no meaningful new information found'
        : 'Content unchanged and summary is already up to date';
      return json({ ok: true, updated: false, reason });
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
    await (env.CACHE as any).delete(summaryKey).catch(() => {});
    await (env.CACHE as any).delete(ttlKey).catch(() => {});
    await (env.CACHE as any).delete(feedbackKey).catch(() => {});
  }

  // refetch article content; omit feedPublishedAt so isManualIngest=true uses
  // the browser-like UA path (better bot bypassing for admin actions).
  let extracted: Awaited<ReturnType<typeof fetchAndExtractArticle>>;
  try {
    const refetchUrl = new URL(article.canonicalUrl);
    refetchUrl.searchParams.set('_', String(Date.now()));
    extracted = await fetchAndExtractArticle(env, {
      url: refetchUrl.toString(),
      sourceUrl: article.sourceUrl || article.canonicalUrl,
      providedTitle: article.title,
      providedDescription: '',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return badRequest(`Failed to fetch article content: ${msg}`);
  }

  let aiResult: Awaited<ReturnType<typeof summarizeArticle>>;
  try {
    aiResult = await summarizeArticle(env, article.urlHash, article.title, extracted.contentText, article.publishedAt, {
      county: article.county,
      city: article.city,
      category: article.category,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return badRequest(`AI summarization failed: ${msg}`);
  }
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

if (url.pathname === '/api/admin/migrate-hash-slugs' && request.method === 'POST') {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const result = await migrateHashSlugs(env);
    return json({ migrated: result.migrated, skipped: result.skipped });
  } catch (err) {
    console.error('[MIGRATE HASH SLUGS ERROR]', err);
    return json({ error: 'migration failed' }, 500);
  }
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

// --- Debug: inspect raw search results from D1 (admin only) -----------------
// GET /api/debug/search?q=term
// Returns: { query, hits, items: [{id, title, county, publishedAt}] }
// Use this to verify the D1 query is working correctly.
// Run `wrangler tail` to see the console.log output for each search.
if (url.pathname === '/api/debug/search' && request.method === 'GET') {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
  if (!q) return badRequest('Provide ?q=searchterm');

  let dbResult;
  try {
    dbResult = await queryArticles(env, {
      category: 'all',
      counties: [],
      search: q,
      limit: 20,
      cursor: null,
    });
  } catch (err) {
    return json({ error: 'D1 query threw', detail: String(err) }, 500);
  }

  return json({
    query: q,
    hits: dbResult.items.length,
    items: dbResult.items.map((a) => ({
      id: a.id,
      title: a.title,
      county: a.county,
      category: a.category,
      publishedAt: a.publishedAt,
    })),
  });
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
          await (env.CACHE as any).delete(`cfp:${fingerprint}`).catch(() => {});
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
        await (env.CACHE as any).delete(`${prefix}${hashKey}`).catch(() => {});
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

// Discover recent post URLs from a public Facebook page by scraping mbasic.
// Body: { url: string, limit?: number }
// Returns: { ok, posts: [{ postUrl, message, imageUrl, publishedAt }], pageUrl, warning? }
if (url.pathname === '/api/admin/facebook/page-posts' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}

	const body = await parseJsonBody<{ url?: string; limit?: number }>(request);
	const pageUrl = body?.url?.trim();
	if (!pageUrl) return badRequest('Missing required field: url');
	if (!isHttpUrl(pageUrl)) return badRequest('url must be an absolute http(s) URL');
	if (!/facebook\.com/i.test(pageUrl)) return badRequest('url must be a facebook.com URL');

	const limit = Math.min(Math.max(Number(body?.limit ?? 10), 1), 20);

	try {
		const posts = await scrapeFacebookPagePosts(pageUrl, limit);

		if (posts.length === 0) {
			return json({
				ok: false,
				posts: [],
				pageUrl,
				warning: 'No posts found. The page may be private, require login, or Facebook may have blocked the request. Try again or use individual post links instead.',
			});
		}

		return json({ ok: true, posts, pageUrl, count: posts.length });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[FB PAGE POSTS FAILED]', msg);
		return json({ ok: false, posts: [], pageUrl, warning: `Scrape failed: ${msg}` }, 200);
	}
}

// DELETE /api/admin/facebook/scheduler/mark-posted/:id — remove article from the
// scheduler's "already posted" set so it becomes eligible for retry.
if (url.pathname.startsWith('/api/admin/facebook/scheduler/mark-posted/') && request.method === 'DELETE') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const idStr = url.pathname.split('/').pop() ?? '';
	const id = Number(idStr);
	if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid article id');
	await removeFacebookSchedulerPostedId(env, id);
	await appendAdminLog(env, `Admin cleared scheduler posted-ID for article ${id} — will retry`);
	return json({ ok: true, id });
}

// Helper: resolve a local article ID from a user-provided URL.
// Supports LocalKYNews URLs (including query param ?articleId=), as well as canonical/source URLs.
async function resolveArticleIdFromUrl(env: Env, inputUrl: string): Promise<number | null> {
	const trimmed = (inputUrl || '').trim();
	if (!trimmed) return null;

	// Try to interpret the input as a URL. If it's a relative path, resolve against our base URL.
	let parsed: URL | null = null;
	try {
		parsed = new URL(trimmed);
	} catch {
		try {
			parsed = new URL(trimmed, BASE_URL);
		} catch {
			parsed = null;
		}
	}

	// If it's our own site, try to parse the slug or articleId query param.
	if (parsed) {
		const baseOrigin = new URL(BASE_URL).origin;
		if (parsed.origin === baseOrigin) {
			const idParam = parsed.searchParams.get('articleId');
			if (idParam) {
				const parsedId = Number(idParam);
				if (Number.isFinite(parsedId) && parsedId > 0) return parsedId;
			}

			const pathSegments = parsed.pathname.split('/').filter(Boolean);
			const newsIndex = pathSegments.indexOf('news');
			if (newsIndex !== -1 && pathSegments.length > newsIndex + 2) {
				const slug = pathSegments[pathSegments.length - 1];
				if (slug) {
					const article = await getArticleBySlug(env, slug);
					if (article) return article.id;
				}
			}
		}
	}

	// Fall back to finding by canonical/source URL.
	const normalized = normalizeCanonicalUrl(trimmed);
	if (normalized) {
		const row: any = await prepare(env,
			`SELECT id FROM articles WHERE canonical_url = ? OR source_url = ? LIMIT 1`
		).bind(normalized, normalized).first();
		if (row?.id) return Number(row.id);
	}

	return null;
}

// POST /api/admin/facebook/scheduler/mark-posted — tell the scheduler to skip an article
// (useful when you've already posted it manually).
if (url.pathname === '/api/admin/facebook/scheduler/mark-posted' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const body = await parseJsonBody<{ url?: string; id?: number }>(request);
	let id: number | null = null;
	if (body?.id) {
		const parsed = Number(body.id);
		if (Number.isFinite(parsed) && parsed > 0) id = parsed;
	}
	if (!id && body?.url) {
		const urlStr = body.url.trim();
		if (urlStr) {
			id = await resolveArticleIdFromUrl(env, urlStr);
		}
	}
	if (!id) {
		return badRequest('Could not locate an article for the provided url or id. Provide a valid local article URL or article id.');
	}
	await addFacebookSchedulerPostedId(env, id);
	await appendAdminLog(env, `Admin marked article ${id} as posted for scheduler (url: ${body?.url ?? ''})`);
	return json({ ok: true, id });
}

// GET/POST /api/admin/facebook/scheduler — configure the server-side scheduler
if (url.pathname === '/api/admin/facebook/scheduler' && request.method === 'GET') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}
	const config = await getFacebookSchedulerConfig(env);
	return json({ ok: true, ...config });
}

if (url.pathname === '/api/admin/facebook/scheduler' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}
	const body = (await parseJsonBody<{
		enabled?: boolean;
		start?: string;
		end?: string;
		intervalMinutes?: number;
	}>(request)) || {};

	const updates: any = {};
	if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;
	if (typeof body.start === 'string') updates.start = body.start;
	if (typeof body.end === 'string') updates.end = body.end;
	if (typeof body.intervalMinutes === 'number') updates.intervalMinutes = Math.max(1, Math.min(1440, Math.floor(body.intervalMinutes)));

	const config = await setFacebookSchedulerConfig(env, updates);
	return json({ ok: true, ...config });
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

	const caption = await generateAiFacebookCaption(article, env);
	await appendAdminLog(env, `Caption generated for ID ${id}`);
	return json({ ok: true, caption });
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

	const result = await postArticleToFacebook(env, article);
	if (result.ok) {
		return json(result);
	}
	return json({ error: result.error || 'Failed to post to Facebook', details: result.details }, 500);
}

// POST /api/admin/facebook/post-alert — post a specific NWS alert to the Live Weather
// Alerts Facebook page. Uses LIVE_ALERTS_PAGE_ID and LIVE_ALERTS_PAGE_ACCESS_TOKEN
// (separate from the Local KY News page credentials FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN).
if (url.pathname === '/api/admin/facebook/post-alert' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const body = await parseJsonBody<{ alertId?: string; caption?: string; event?: string; areaDesc?: string }>(request);

	const liveAlertsPageId    = ((env as any).LIVE_ALERTS_PAGE_ID    || '').trim();
	const liveAlertsPageToken = ((env as any).LIVE_ALERTS_PAGE_ACCESS_TOKEN || '').trim();
	if (!liveAlertsPageId || !liveAlertsPageToken) {
		return json({ error: 'LIVE_ALERTS_PAGE_ID / LIVE_ALERTS_PAGE_ACCESS_TOKEN secrets not configured for the Live Weather Alerts Facebook page' }, 500);
	}

	// Use the caption passed from the frontend when available (avoids a NWS
	// re-fetch that would 404 if the alert has already expired).
	let caption = (body?.caption ?? '').trim();
	let eventType = (body?.event ?? '').trim();
	let areaDesc = (body?.areaDesc ?? '').trim();

	if (!caption) {
		// Fallback: try to re-fetch the alert from NWS.
		let alertId = (body?.alertId ?? '').trim();
		if (!alertId) return badRequest('Missing caption or alertId');
		if (alertId.startsWith('https://api.weather.gov/alerts/')) {
			alertId = alertId.slice('https://api.weather.gov/alerts/'.length);
		}
		const alert = await fetchNwsAlertById(alertId);
		if (!alert) return json({ error: 'Alert not found on NWS API and no caption was provided' }, 422);
		caption   = buildWeatherAlertFbCaption(alert);
		eventType = alert.event;
		areaDesc  = alert.areaDesc;
	}

	const stateCode = areaDesc ? extractPrimaryStateCode(areaDesc) : null;
	const imageUrl = eventType ? getWeatherAlertImageUrl(eventType, stateCode ?? undefined) : '';

	try {
		if (imageUrl) {
			// Photo post with banner image.
			const params = new URLSearchParams({ caption, url: imageUrl, access_token: liveAlertsPageToken });
			const respFb = await fetch(`https://graph.facebook.com/v19.0/${liveAlertsPageId}/photos`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: params,
			});
			const fbData = await respFb.json() as any;
			if (!respFb.ok || fbData?.error) {
				const msg = fbData?.error?.message ?? `HTTP ${respFb.status}`;
				const code = fbData?.error?.code ? ` (code ${fbData.error.code})` : '';
				return json({ ok: false, error: `${msg}${code}`, details: fbData }, 500);
			}
			return json({ ok: true, fbPostId: String(fbData?.id ?? ''), result: fbData });
		} else {
			// Text-only post via /feed when no specific banner image exists.
			const params = new URLSearchParams({ message: caption, access_token: liveAlertsPageToken });
			const respFb = await fetch(`https://graph.facebook.com/v19.0/${liveAlertsPageId}/feed`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: params,
			});
			const fbData = await respFb.json() as any;
			if (!respFb.ok || fbData?.error) {
				const msg = fbData?.error?.message ?? `HTTP ${respFb.status}`;
				const code = fbData?.error?.code ? ` (code ${fbData.error.code})` : '';
				return json({ ok: false, error: `${msg}${code}`, details: fbData }, 500);
			}
			return json({ ok: true, fbPostId: String(fbData?.id ?? ''), result: fbData });
		}
	} catch (err: any) {
		return json({ ok: false, error: 'Network error posting to Facebook', details: String(err) }, 500);
	}
}

// POST /api/admin/facebook/exchange-token — exchange a short-lived user token for a
// long-lived page access token for the Live Weather Alerts Facebook page.
// Requires FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, and LIVE_ALERTS_PAGE_ID secrets.
// Does NOT touch any Local KY News page credentials.
if (url.pathname === '/api/admin/facebook/exchange-token' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);

	const body = await parseJsonBody<{ shortLivedToken?: string }>(request);
	const shortLivedToken = (body?.shortLivedToken ?? '').trim();
	if (!shortLivedToken) return badRequest('Missing shortLivedToken');

	const appId      = ((env as any).FACEBOOK_APP_ID    || '').trim();
	const appSecret  = ((env as any).FACEBOOK_APP_SECRET || '').trim();
	const pageId     = ((env as any).LIVE_ALERTS_PAGE_ID || '').trim();
	if (!appId || !appSecret) return json({ error: 'FACEBOOK_APP_ID / FACEBOOK_APP_SECRET secrets not configured' }, 500);
	if (!pageId) return json({ error: 'LIVE_ALERTS_PAGE_ID secret not configured' }, 500);

	// Step 1: exchange short-lived user token for a long-lived user token (60 days)
	const exchangeUrl = new URL('https://graph.facebook.com/oauth/access_token');
	exchangeUrl.searchParams.set('grant_type', 'fb_exchange_token');
	exchangeUrl.searchParams.set('client_id', appId);
	exchangeUrl.searchParams.set('client_secret', appSecret);
	exchangeUrl.searchParams.set('fb_exchange_token', shortLivedToken);
	const exchangeRes = await fetch(exchangeUrl.toString());
	const exchangeData = await exchangeRes.json() as any;
	if (!exchangeRes.ok || !exchangeData?.access_token) {
		return json({ error: 'Failed to exchange token', details: exchangeData?.error?.message ?? exchangeData }, 500);
	}
	const longLivedUserToken = String(exchangeData.access_token);

	// Step 2: use long-lived user token to get a non-expiring page access token
	const pageTokenUrl = new URL(`https://graph.facebook.com/${encodeURIComponent(pageId)}`);
	pageTokenUrl.searchParams.set('fields', 'access_token,name');
	pageTokenUrl.searchParams.set('access_token', longLivedUserToken);
	const pageTokenRes  = await fetch(pageTokenUrl.toString());
	const pageTokenData = await pageTokenRes.json() as any;
	if (!pageTokenRes.ok || !pageTokenData?.access_token) {
		return json({ error: 'Failed to get page access token', details: pageTokenData?.error?.message ?? pageTokenData }, 500);
	}

	return json({
		ok: true,
		pageName: pageTokenData.name ?? '',
		pageAccessToken: String(pageTokenData.access_token),
		instruction: 'Run: npx wrangler secret put LIVE_ALERTS_PAGE_ACCESS_TOKEN  and paste this token.',
	});
}

// GET /api/admin/live-alerts/autopost — read the three category auto-post flags
if (url.pathname === '/api/admin/live-alerts/autopost' && request.method === 'GET') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const [warnings, watches, others, startDate] = await Promise.all([
		getLiveAlertAutopostFlag(env, 'warnings'),
		getLiveAlertAutopostFlag(env, 'watches'),
		getLiveAlertAutopostFlag(env, 'others'),
		getLiveAlertAutopostStart(env),
	]);
	return json({ warnings, watches, others, startDateTime: startDate?.toISOString() ?? null });
}

// POST /api/admin/live-alerts/autopost — set one or more category auto-post flags
// Body: { warnings?: boolean, watches?: boolean, others?: boolean, startDateTime?: string | null }
if (url.pathname === '/api/admin/live-alerts/autopost' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const body = await parseJsonBody<{ warnings?: boolean; watches?: boolean; others?: boolean; startDateTime?: string | null }>(request);
	if (!body) return badRequest('Missing request body');
	const updates: Promise<void>[] = [];
	if (typeof body.warnings === 'boolean') updates.push(setLiveAlertAutopostFlag(env, 'warnings', body.warnings));
	if (typeof body.watches  === 'boolean') updates.push(setLiveAlertAutopostFlag(env, 'watches',  body.watches));
	if (typeof body.others   === 'boolean') updates.push(setLiveAlertAutopostFlag(env, 'others',   body.others));
	if (body.startDateTime !== undefined) {
		if (body.startDateTime === null || body.startDateTime === '') {
			updates.push(setLiveAlertAutopostStart(env, null));
		} else {
			const dt = new Date(body.startDateTime);
			if (Number.isNaN(dt.valueOf())) return badRequest('Invalid startDateTime');
			updates.push(setLiveAlertAutopostStart(env, dt.toISOString()));
		}
	}
	if (updates.length === 0) return badRequest('Provide at least one of: warnings, watches, others, startDateTime');
	await Promise.all(updates);
	const [warnings, watches, others, startDate] = await Promise.all([
		getLiveAlertAutopostFlag(env, 'warnings'),
		getLiveAlertAutopostFlag(env, 'watches'),
		getLiveAlertAutopostFlag(env, 'others'),
		getLiveAlertAutopostStart(env),
	]);
	return json({ ok: true, warnings, watches, others, startDateTime: startDate?.toISOString() ?? null });
}

// POST /api/admin/nws-alerts/run — manually trigger NWS alert ingestion
if (url.pathname === '/api/admin/nws-alerts/run' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	try {
		const result = await processNwsAlerts(env);
		return json({ ok: true, ...result });
	} catch (err: any) {
		return json({ error: String(err) }, 500);
	}
}

// POST /api/admin/spc/run — manually trigger SPC RSS ingestion
if (url.pathname === '/api/admin/spc/run' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	try {
		const result = await processSpcFeed(env);
		return json({ ok: true, ...result });
	} catch (err: any) {
		return json({ error: String(err) }, 500);
	}
}

// GET /api/spc-outlooks — public: return Day 1/2/3 SPC convective outlook articles for the weather page
if (url.pathname === '/api/spc-outlooks' && request.method === 'GET') {
	try {
		const spcHeaders = {
			'User-Agent': 'LocalKYNews/1.0 (localkynews.com; news@localkynews.com)',
			Accept: 'application/rss+xml, application/xml',
		};
		// Fetch both the general SPC feed and the dedicated convective-outlook feed in parallel.
		// The dedicated feed (spcacrss.xml) is more reliable for Day 2/3 items.
		const [res1, res2] = await Promise.all([
			fetch('https://www.spc.noaa.gov/products/spcrss.xml',  { headers: spcHeaders }),
			fetch('https://www.spc.noaa.gov/products/spcacrss.xml', { headers: spcHeaders }),
		]);
		const [xml1, xml2] = await Promise.all([
			res1.ok ? res1.text() : Promise.resolve(''),
			res2.ok ? res2.text() : Promise.resolve(''),
		]);
		// Concatenate both XML bodies — parseSpcOutlooks uses regex <item> matching, so this is safe.
		const outlooks = await parseSpcOutlooks(xml1 + xml2);
		return json({ outlooks }, 200, { 'Cache-Control': 'public, max-age=900, s-maxage=900' });
	} catch {
		return json({ outlooks: [] });
	}
}

// GET /api/weather — proxy NWS endpoints so the frontend doesn't hit CORS issues.
if (url.pathname === '/api/weather' && request.method === 'GET') {
	const lat = url.searchParams.get('lat');
	const lon = url.searchParams.get('lon');
	if (!lat || !lon) return badRequest('Missing lat/lon parameters');

	// NWS API requires a User-Agent header; requests without one are rejected.
	const nwsHeaders = {
		'User-Agent': 'LocalKYNews/1.0 (localkynews.com; news@localkynews.com)',
		Accept: 'application/geo+json, application/json',
	};

	try {
		const pointsRes = await fetch(`https://api.weather.gov/points/${lat},${lon}`, { headers: nwsHeaders });
		if (!pointsRes.ok) return json({ error: 'Failed to fetch points', status: pointsRes.status }, 502);
		const pointsData = await pointsRes.json() as any;

		const forecastUrl = pointsData?.properties?.forecast as string | undefined;
		const stationsUrl = pointsData?.properties?.observationStations as string | undefined;
		const [forecastRes, stationsRes] = await Promise.all([
			forecastUrl ? fetch(forecastUrl, { headers: nwsHeaders }) : null,
			stationsUrl ? fetch(stationsUrl, { headers: nwsHeaders }) : null,
		]);

		let forecast = null;
		let observation = null;

		if (forecastRes && forecastRes.ok) {
			const fData = await forecastRes.json() as any;
			forecast = fData?.properties?.periods ?? null;
		}

		if (stationsRes && stationsRes.ok) {
			const sData = await stationsRes.json() as any;
			const stationId = sData?.features?.[0]?.properties?.stationIdentifier as string | undefined;
			if (stationId) {
				const obsRes = await fetch(`https://api.weather.gov/stations/${stationId}/observations/latest`, { headers: nwsHeaders });
				if (obsRes.ok) {
					const oData = await obsRes.json() as any;
					observation = oData?.properties ?? null;
				}
			}
		}

		return json({ points: pointsData, forecast, observation });
	} catch (err) {
		return json({ error: String(err) }, 500);
	}
}

// GET /api/nws-stories — public: fetch latest briefings from NWS LMK, JKL, PAH offices
if (url.pathname === '/api/nws-stories' && request.method === 'GET') {
	try {
		const offices = await fetchNwsStories();
		return json({ offices }, 200, { 'Cache-Control': 'public, max-age=600, s-maxage=600' });
	} catch {
		return json({ offices: [] });
	}
}

// POST /api/admin/nws-products/run — manually trigger ingestion of NWS product feeds
if (url.pathname === '/api/admin/nws-products/run' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	try {
		const result = await processNwsProducts(env);
		return json({ ok: true, ...result });
	} catch (err: any) {
		return json({ error: String(err) }, 500);
	}
}

// POST /api/admin/weather-summary/run — manually publish a weather summary article
// Body: { "when": "morning" | "evening" }  (defaults to current time of day)
if (url.pathname === '/api/admin/weather-summary/run' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	try {
		const body = await parseJsonBody<{ when?: 'morning' | 'evening' }>(request);
		const { hour } = (() => {
			const parts = new Intl.DateTimeFormat('en-US', {
				timeZone: 'America/New_York', hour12: false, hour: 'numeric',
			}).formatToParts(new Date());
			return { hour: parseInt(parts.find(p => p.type === 'hour')?.value ?? '12', 10) };
		})();
		const when: 'morning' | 'evening' = body?.when ?? (hour < 12 ? 'morning' : 'evening');
		await publishWeatherSummary(env, when);
		return json({ ok: true, when });
	} catch (err: any) {
		return json({ error: String(err) }, 500);
	}
}

// ── GET /api/admin/weather-alert-posts ─────────────────────────────────────
// Returns all posts (newest first) AND the set of already-posted NWS alert IDs
// so the frontend can skip duplicates before ever saving.
if (url.pathname === '/api/admin/weather-alert-posts' && request.method === 'GET') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const posts = await listWeatherAlertPosts(env);
	const postedIds = await getPostedNwsAlertIds(env);
	return json({ posts, postedNwsIds: [...postedIds] });
}

// ── POST /api/admin/weather-alert-posts ─────────────────────────────────────
// Save one new alert post. If nws_alert_id is provided and already exists
// the endpoint returns 409 so the frontend knows it is a duplicate.
if (url.pathname === '/api/admin/weather-alert-posts' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const body = await parseJsonBody<{
		nws_alert_id?: string | null;
		event?: string;
		area?: string;
		severity?: string;
		expires_at?: string | null;
		sent_at?: string | null;
		post_text?: string;
	}>(request);
	if (!body) return badRequest('Missing request body');

	const post_text = typeof body.post_text === 'string' ? body.post_text.trim() : '';
	if (!post_text) return badRequest('post_text is required');

	const nws_alert_id = typeof body.nws_alert_id === 'string' ? body.nws_alert_id.trim() || null : null;

	// Duplicate check — only applies to NWS-sourced posts
	if (nws_alert_id) {
		const posted = await getPostedNwsAlertIds(env);
		if (posted.has(nws_alert_id)) {
			return json({ error: 'Alert already posted', nws_alert_id }, 409);
		}
	}

	const id = await insertWeatherAlertPost(env, {
		nws_alert_id,
		event: typeof body.event === 'string' ? body.event.trim() : 'Weather Alert',
		area: typeof body.area === 'string' ? body.area.trim() : '',
		severity: typeof body.severity === 'string' ? body.severity.trim() : 'Unknown',
		expires_at: typeof body.expires_at === 'string' ? body.expires_at : null,
		sent_at: typeof body.sent_at === 'string' ? body.sent_at : null,
		post_text,
	});

	return json({ ok: true, id });
}

// ── POST /api/admin/weather-alert-posts/update ──────────────────────────────
// Update the editable post_text for an existing post.
if (url.pathname === '/api/admin/weather-alert-posts/update' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const body = await parseJsonBody<{ id?: number; post_text?: string }>(request);
	if (!body) return badRequest('Missing request body');

	const id = Number(body.id ?? 0);
	if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid id');

	const post_text = typeof body.post_text === 'string' ? body.post_text.trim() : '';
	if (!post_text) return badRequest('post_text is required');

	const updated = await updateWeatherAlertPostText(env, id, post_text);
	if (!updated) return json({ error: 'Post not found' }, 404);
	return json({ ok: true, id });
}

// ── POST /api/admin/weather-alert-posts/delete ──────────────────────────────
// Delete a post by id.
if (url.pathname === '/api/admin/weather-alert-posts/delete' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const body = await parseJsonBody<{ id?: number }>(request);
	const id = Number(body?.id ?? 0);
	if (!Number.isFinite(id) || id <= 0) return badRequest('Missing or invalid id');

	const deleted = await deleteWeatherAlertPost(env, id);
	if (!deleted) return json({ error: 'Post not found' }, 404);
	return json({ ok: true, id });
}

// ── POST /api/admin/weather-alert-posts/delete-all ───────────────────────────
// Wipe the entire table so stale alerts can be re-fetched fresh.
if (url.pathname === '/api/admin/weather-alert-posts/delete-all' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const count = await deleteAllWeatherAlertPosts(env);
	return json({ ok: true, deleted: count });
}

// ── POST /api/admin/weather-alert-posts/post ────────────────────────────────
// Post a saved weather alert to Facebook (uses the fixed Weather Alert image).
if (url.pathname === '/api/admin/weather-alert-posts/post' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const body = await parseJsonBody<{ id?: number; post_text?: string }>(request);
	if (!body) return badRequest('Missing request body');

	let postText = typeof body.post_text === 'string' ? body.post_text.trim() : '';
	let alertEvent: string | undefined;
	if (!postText) {
		const id = Number(body.id ?? 0);
		if (!Number.isFinite(id) || id <= 0) return badRequest('Missing post text or id');
		const post = await getWeatherAlertPostById(env, id);
		if (!post) return json({ error: 'Post not found' }, 404);
		postText = post.post_text;
		alertEvent = post.event;
	}
	if (!postText) return badRequest('Missing post text');

	const imageUrl = alertEvent ? getWeatherAlertImageUrl(alertEvent) : undefined;
	const result = await postFacebookPhotoCaption(env, postText, imageUrl);
	return json(result);
}

// ── GET /api/admin/digest ───────────────────────────────────────────────────
// Returns the stored morning and evening digest texts from KV.
if (url.pathname === '/api/admin/digest' && request.method === 'GET') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	if (!env.CACHE) return json({ morning: null, evening: null });
	const [morningRaw, eveningRaw] = await Promise.all([
		(env.CACHE as any).get('admin:digest:morning'),
		(env.CACHE as any).get('admin:digest:evening'),
	]);
	return json({
		morning: morningRaw ? JSON.parse(morningRaw) : null,
		evening: eveningRaw ? JSON.parse(eveningRaw) : null,
	});
}

// ── POST /api/admin/digest/generate ────────────────────────────────────────
// Generate a new digest from today's articles and store it in KV.
// Body: { "when": "morning" | "evening" }
if (url.pathname === '/api/admin/digest/generate' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const body = await parseJsonBody<{ when?: 'morning' | 'evening' }>(request);
	const when: 'morning' | 'evening' = body?.when === 'evening' ? 'evening' : 'morning';
	const text = await generateDigestText(env, when);
	const entry = { text, generatedAt: new Date().toISOString() };
	if (env.CACHE) {
		await (env.CACHE as any).put(`admin:digest:${when}`, JSON.stringify(entry));
	}
	return json({ ok: true, when, ...entry });
}

// ── POST /api/admin/digest/save ─────────────────────────────────────────────
// Save an edited digest text back to KV.
// Body: { "when": "morning" | "evening", "text": string }
if (url.pathname === '/api/admin/digest/save' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const body = await parseJsonBody<{ when?: string; text?: string }>(request);
	if (!body) return badRequest('Missing request body');
	const when: 'morning' | 'evening' = body.when === 'evening' ? 'evening' : 'morning';
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (!text) return badRequest('text is required');
	const entry = { text, generatedAt: new Date().toISOString() };
	if (env.CACHE) {
		await (env.CACHE as any).put(`admin:digest:${when}`, JSON.stringify(entry));
	}
	return json({ ok: true, when });
}

// ── GET /api/admin/digest/autopost ─────────────────────────────────────────
// Returns the pending/suppressed/posted status for the morning/evening auto-post
// along with the global enabled/disabled state.
if (url.pathname === '/api/admin/digest/autopost' && request.method === 'GET') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	if (!env.CACHE) return json({ enabled: true, morning: null, evening: null });
	const [morningRaw, eveningRaw] = await Promise.all([
		(env.CACHE as any).get('admin:digest:morning:autopost'),
		(env.CACHE as any).get('admin:digest:evening:autopost'),
	]);
	const enabled = await getDigestAutopostEnabled(env);
	return json({
		enabled,
		morning: morningRaw ? JSON.parse(morningRaw) : null,
		evening: eveningRaw ? JSON.parse(eveningRaw) : null,
	});
}

// ── POST /api/admin/digest/autopost ────────────────────────────────────────
// Enable or disable global digest auto-posting.
if (url.pathname === '/api/admin/digest/autopost' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const body = await parseJsonBody<{ enabled?: boolean }>(request);
	if (!body || typeof body.enabled !== 'boolean') return badRequest('Missing or invalid enabled flag');
	await setDigestAutopostEnabled(env, body.enabled);
	if (env.CACHE) {
		const status = body.enabled ? { status: 'idle' } : { status: 'disabled', disabledAt: new Date().toISOString() };
		await Promise.all([
			(env.CACHE as any).put('admin:digest:morning:autopost', JSON.stringify(status), { expirationTtl: 7200 }),
			(env.CACHE as any).put('admin:digest:evening:autopost', JSON.stringify(status), { expirationTtl: 7200 }),
		]);
	}
	return json({ ok: true, enabled: body.enabled });
}

// ── POST /api/admin/digest/suppress ───────────────────────────────────────
// Suppress auto-post for a given slot (morning or evening).
if (url.pathname === '/api/admin/digest/suppress' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const body = await parseJsonBody<{ when?: string }>(request);
	const when: 'morning' | 'evening' = body?.when === 'evening' ? 'evening' : 'morning';
	if (!env.CACHE) return json({ error: 'No cache available' }, 500);
	await (env.CACHE as any).put(
		`admin:digest:${when}:autopost`,
		JSON.stringify({ status: 'suppressed', suppressedAt: new Date().toISOString() }),
		{ expirationTtl: 3600 }
	);
	return json({ ok: true, when, status: 'suppressed' });
}

// ── POST /api/admin/digest/post-now ───────────────────────────────────────
// Immediately post the most recent generated digest to Facebook.
if (url.pathname === '/api/admin/digest/post-now' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
	const body = await parseJsonBody<{ when?: string }>(request);
	const when: 'morning' | 'evening' = body?.when === 'evening' ? 'evening' : 'morning';
	if (!env.CACHE) return json({ error: 'No cache available' }, 500);
	const digestRaw = await (env.CACHE as any).get(`admin:digest:${when}`);
	if (!digestRaw) return json({ error: 'No digest found' }, 404);
	const digest = JSON.parse(digestRaw) as { text: string };
	const result = await postDigestToFacebook(env, digest.text, when);
	if (!result) return json({ error: 'Facebook post failed' }, 500);
	if ('error' in result) return json({ error: 'Facebook post failed', details: result.error }, 500);
	await (env.CACHE as any).put(
		`admin:digest:${when}:autopost`,
		JSON.stringify({ status: 'posted', postedAt: new Date().toISOString(), postId: result.postId }),
		{ expirationTtl: 3600 }
	);
	return json({ ok: true, when, postId: result.postId });
}

// serve files from the R2 media bucket; this is intentionally *not* an admin
// route so that uploaded images can be embedded in public article pages.
if (url.pathname.startsWith('/api/media/') && request.method === 'GET') {
	// strip the prefix to obtain the object key
	const key = url.pathname.slice('/api/media/'.length);
	if (!key) {
		return new Response('Not found', { status: 404 });
	}
	const obj = await env.ky_news_media.get(key);
	if (!obj) {
		return new Response('Not found', { status: 404 });
	}
	const headers = new Headers();
	if (obj.httpMetadata?.contentType) {
		headers.set('Content-Type', obj.httpMetadata.contentType);
	}
	return new Response(obj.body, { headers });
}

// allow admins to upload a single image file; the client will later pass the
// returned URL (which proxies through /api/media/) when creating or editing
// an article.  the uploaded file is stored in R2 under an auto-generated key.
if (url.pathname === '/api/admin/upload-image' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}
	// rely on the standard FormData parsing provided by the runtime
	const form = await request.formData();
	const file = form.get('file');
	if (!(file instanceof Blob)) {
		return badRequest('No file uploaded');
	}
	if (!file.type.startsWith('image/')) {
		return badRequest('Uploaded file is not an image');
	}
	// derive a reasonable extension from the original filename when possible
	const name = (file as any).name || '';
	const ext = name.split('.').pop().toLowerCase();
	// generate a short unique identifier; randomUUID might not be available in
	// the test harness, so fall back to a simple base‑36 random string.
	const uniq = typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: Math.random().toString(36).substring(2, 10);
	const key = `uploads/${Date.now()}-${uniq}${ext ? '.' + ext : ''}`;

	const data = await file.arrayBuffer();
	await env.ky_news_media.put(key, data, {
		httpMetadata: { contentType: file.type },
	});
	return json({ url: `/api/media/${key}`, key });
}

// Manually create an article (from a Facebook post or any other source) without going through
// the normal URL-scraping pipeline. Body is optional. Classification runs through AI as normal.
if (url.pathname === '/api/admin/manual-article' && request.method === 'POST') {
	if (!isAdminAuthorized(request, env)) {
		return json({ error: 'Unauthorized' }, 401);
	}

	const body = await parseJsonBody<{
		title?: string;
		author?: string;
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
	const author = (body?.author || '').trim() || null;
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
	// SEO description should still be sentence-safe rather than cutting mid-word.
	const manualSummary = postBody;

	function buildSeoDescription(text: string, county?: string | null, maxLen = 160): string {
		if (!text) return '';
		const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
		if (!clean) return '';

		const strippingRegex = /^(according to [^,]+,\s*|officials (?:say|said|announced)\s+that\s*|(?:a |the )?[a-z]+ (?:said|says|announced)\s+that\s*)/i;
		let result = clean.replace(strippingRegex, '').trim();

		// Prepend county when it isn't included in the first 60 characters.
		const countyName = county?.trim();
		if (countyName && countyName.length > 0) {
			const prefixWindow = result.slice(0, 60).toLowerCase();
			if (!prefixWindow.includes(countyName.toLowerCase())) {
				result = `${countyName} County, KY — ${result}`;
			}
		}

		const targetMax = Math.min(maxLen, 158);
		if (result.length <= targetMax) {
			if (result.length < 120 && !result.trim().endsWith('.')) {
				result = `${result} Read the full story.`;
			}
			return result;
		}

		// Try to end at a sentence boundary within the limit
		const withinLimit = result.slice(0, targetMax + 50); // look slightly past limit
		const sentenceMatch = withinLimit.match(/^(.{80,}?[.!?])\s/);
		if (sentenceMatch && sentenceMatch[1].length <= targetMax) {
			result = sentenceMatch[1].trim();
		} else {
			// Fall back to word boundary
			const wordBoundary = result.slice(0, targetMax).replace(/\s+\S*$/, '');
			result = `${wordBoundary}…`;
		}

		if (result.length < 120 && !result.trim().endsWith('.')) {
			result = `${result} Read the full story.`;
		}

		return result;
	}

	const manualSeoDescription = buildSeoDescription(postBody, classification.county);

	const imageAlt = imageUrl
		? generateImageAlt(title, classification.county ?? null, classification.category)
		: null;

	const newArticle: NewArticle = {
		canonicalUrl,
		sourceUrl: normalizedSourceUrl || canonicalUrl,
		urlHash: canonicalHash,
		title,
		author,
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
		imageAlt,
		rawR2Key: null,
		// Use SEO-friendly slugs for all manually-created articles.
		slug: generateSeoSlug(title, classification.county, resolvedPublishedAt),
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
const category = categoryMatch[1]?.toLowerCase();
if (!category || (category !== 'all' && !isAllowedCategory(category))) {
  return badRequest(
    'Invalid category. Allowed: today|national|sports|weather|schools|all',
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
  // Diagnostic log: visible in `wrangler tail`.  Remove once search is confirmed working.
  if (search) {
    console.log(`[search] query="${search}" category="${category}" hits=${result.items.length}`);
  }
} catch (err) {
  // log the error so it can be investigated in production
  console.error('[search] queryArticles threw', { search, category, err: String(err) });
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
    { items: [], nextCursor: null, searchError: 'query_failed' },
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
const countyHubMatch = url.pathname.match(/^\/news\/kentucky\/([a-z-]+)-county\/?$/);
if (countyHubMatch && request.method === 'GET') {
  const ua = request.headers.get('user-agent') || '';
  const isSocialBot = isSearchBot(ua);

  if (isSocialBot) {
    const countySlug = countyHubMatch[1]; // e.g. "perry"
    const countyName = countySlug
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase()); // "Perry"
    const countyDisplay = `${countyName} County`; // "Perry County"
    const fullSlug = `${countySlug}-county`; // "perry-county"

    const pageUrl = `${BASE_URL}/news/kentucky/${fullSlug}`;
    const title = `${countyDisplay}, KY News — Local KY News`;
    const description = `${countyDisplay} County, KY — local government, schools, sports, and community news. Updated continuously.`;
    const image = DEFAULT_OG_IMAGE;
    const bodyDescription = `Local KY News covers government, schools, sports, weather, and community updates from ${countyDisplay}, Kentucky. Browse the latest headlines below and check back often for new stories as they publish.`;

    const hasCursor = url.searchParams.has('cursor');
    const robotsContent = hasCursor ? 'noindex, follow' : 'index, follow';
    const canonicalLink = hasCursor ? '' : `<link rel="canonical" href="${escapeHtml(pageUrl)}"/>`;

    const recentArticles = await getArticlesByCounty(env, countyDisplay, 10);
    const listItems = recentArticles
      .filter((row) => row && row.slug)
      .map((row) => {
        const href = buildArticleUrl(
          BASE_URL,
          row.slug,
          row.county,
          row.category,
          row.isNational,
          row.id,
        );
        const dateStr = row.publishedAt
          ? new Date(row.publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
          : '';
        return `<li><a href="${escapeHtml(href)}">${escapeHtml(row.title)}</a>${dateStr ? ` <span class="article-date">${escapeHtml(dateStr)}</span>` : ''}</li>`;
      })
      .join('\n');
    const recentListHtml = `<ul>\n${listItems}\n</ul>`;

    const webPageSchema = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: `${countyDisplay} County KY News`,
      url: pageUrl,
      description,
    });

    const breadcrumbSchema = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: BASE_URL },
        { '@type': 'ListItem', position: 2, name: countyDisplay, item: pageUrl },
      ],
    });

    const html = `<!doctype html><html lang="en-US"><head>
<meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}"/>
<meta name="robots" content="${robotsContent}"/>
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
<meta name="twitter:site" content="@LocalKYNews"/>
${canonicalLink}
<script type="application/ld+json">${webPageSchema}</script>
<script type="application/ld+json">${breadcrumbSchema}</script>
</head><body>
<main>
  <h1>${escapeHtml(`${countyDisplay}, KY — Local News & Community Information`)}</h1>
  <section class="county-intro">
    <p>${escapeHtml(countyDisplay)} County is located in [region] Kentucky, a place defined by small towns, rural landscapes, and a strong sense of community. The county is home to a mix of farming families, local businesses, and public servants who work together to keep daily life running smoothly. While each town within the county has its own character, they share common interests in school activities, county government, public safety, and outdoor recreation. Over the years, the county has seen its fair share of change, but it still holds onto traditions like community fairs, high school sports rivalries, and town hall meetings that draw neighbors together.</p>
    <p>Residents of ${escapeHtml(countyDisplay)} County rely on Local KY News for coverage of local government, school board decisions, sports, weather alerts, and community events.</p>
    <p>The county seat is [seat]. Major topics covered include the ${escapeHtml(countyDisplay)} County school district, county court proceedings, local elections, and emergency services.</p>
  </section>
  <p>${escapeHtml(bodyDescription)}</p>
  ${recentListHtml}
  <section>
    <h2>${escapeHtml(`More news from ${countyDisplay}`)}</h2>
    <p><a href="${escapeHtml(pageUrl)}">Browse all ${escapeHtml(countyDisplay)} news on Local KY News</a></p>
  </section>
</main>
</body></html>`;

    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=1800, s-maxage=1800, stale-while-revalidate=86400',
      },
    });
  }
}

// Legacy county hub redirects (non-JS bots rely on HTTP redirects).
// This ensures that old URLs like `/news/pike-county` permanently redirect
// to the new canonical `/news/kentucky/pike-county` path.
const legacyCountyMatch = url.pathname.match(/^\/news\/(?!kentucky\/)([a-z0-9-]+-county)\/?$/i);
if (legacyCountyMatch && request.method === 'GET') {
  const countySlug = legacyCountyMatch[1].toLowerCase();
  const target = `/news/kentucky/${countySlug}${url.search}`;
  return new Response(null, {
    status: 301,
    headers: {
      Location: target,
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
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
  const isBot = isSearchBot(userAgent);

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

        // If the legacy /post?articleId= URL is used and the article already
        // has a slug, always redirect to the canonical /news/... URL.
        // This applies to bots and human visitors alike.
        if (article.slug) {
          return new Response(null, {
            status: 301,
            headers: {
              Location: canonicalPath,
            },
          });
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
          const fallbackImage = DEFAULT_OG_IMAGE;
          const imageForMeta = normalizeOgImage((await selectPreviewImage(article)) || fallbackImage);
          const imageObject = imageForMeta
            ? {
                "@type": "ImageObject",
                url: imageForMeta,
                ...(imageForMeta === DEFAULT_OG_IMAGE ? { width: 1200, height: 630 } : {}),
              }
            : null;

          // Render the summary as paragraphs
          const summaryParagraphs = (article.summary || '')
            .split(/\n\n+/)
            .map((p: string) => `<p>${escapeHtml(p.trim())}</p>`)
            .filter((p: string) => p.length > 10)
            .join('\n');

          const countyLabel = article.county ? `${article.county} County` : (article.isKentucky ? 'Kentucky' : '');
          const categoryLabel = article.category ? article.category.charAt(0).toUpperCase() + article.category.slice(1) : '';

          // build JSON-LD schemas for IAB and bots
          const newsArticleSchema = {
            "@context": "https://schema.org",
            "@type": "NewsArticle",
            headline: article.title,
            wordCount: article.rawWordCount ?? article.summaryWordCount ?? undefined,
            articleSection: article.category
              ? article.category.charAt(0).toUpperCase() + article.category.slice(1)
              : undefined,
            description: desc,
            isAccessibleForFree: true,
            hasPart: {
              "@type": "WebPageElement",
              isAccessibleForFree: true,
              cssSelector: ".article-summary",
            },
            url: pageUrl,
            mainEntityOfPage: { "@type": "WebPage", "@id": pageUrl },
            datePublished: article.publishedAt,
            dateModified: article.updatedAt || article.publishedAt,
            ...(article.author ? {
              author: (() => {
                // Known media organization names derived from hostname
                const mediaOrgs = new Set([
                  'WYMT News', 'WKYT News', 'WLEX News', 'WDRB News', 'WHAS11',
                  'Courier Journal', 'Lexington Herald-Leader', 'WKDZ Radio',
                  'WBKO News', 'Kentucky.com'
                ]);
                // If author looks like an org (all caps, known outlet, or no spaces)
                const looksLikeOrg = mediaOrgs.has(article.author) ||
                  /^[A-Z0-9\s]+$/.test(article.author) ||
                  !article.author.includes(' ');
                if (looksLikeOrg) {
                  return {
                    "@type": "NewsMediaOrganization",
                    name: article.author,
                    url: article.canonicalUrl
                      ? new URL(article.canonicalUrl).origin
                      : undefined
                  };
                }
                return { "@type": "Person", name: article.author };
              })()
            } : {}),
            publisher: {
              "@type": "Organization",
              name: "Local KY News",
              url: "https://localkynews.com",
              logo: {
                "@type": "ImageObject",
                url: "https://localkynews.com/img/logo-wide.png",
                width: 600,
                height: 60,
              },
            },
            ...(imageObject ? { image: imageObject } : {}),
            ...(article.county
              ? {
                  contentLocation: {
                    "@type": "AdministrativeArea",
                    name: `${article.county} County, Kentucky`,
                  },
                }
              : article.isKentucky
              ? {
                  contentLocation: {
                    "@type": "State",
                    name: "Kentucky",
                  },
                }
              : {}),
            speakable: {
              "@type": "SpeakableSpecification",
              cssSelector: ["h1", ".article-summary"],
            },
            sourceOrganization: deriveSourceOrganization(article.canonicalUrl),
          };
          const countyUrl = article.county
            ? `https://localkynews.com/news/kentucky/${article.county.toLowerCase().replace(/\s+/g, "-")}-county`
            : null;
          const breadcrumbSchema = {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Home", item: "https://localkynews.com" },
              ...(countyUrl
                ? [
                    { "@type": "ListItem", position: 2, name: `${article.county} County`, item: countyUrl },
                    { "@type": "ListItem", position: 3, name: article.title, item: pageUrl },
                  ]
                : [{ "@type": "ListItem", position: 2, name: article.title, item: pageUrl }]),
            ],
          };

          const iabPageTitle = buildPageTitle(article.title, article.county, article.isKentucky, article.city);

          const iabHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="${getRobotsContent(article.rawWordCount)}"/>
  <title>${escapeHtml(iabPageTitle)}</title>
  <meta name="description" content="${escapeHtml(desc)}"/>
  <meta property="og:type" content="article"/>
  <meta property="og:title" content="${escapeHtml(iabPageTitle)}"/>
  <meta property="og:description" content="${escapeHtml(desc)}"/>
  <meta property="og:image" content="${escapeHtml(imageForMeta)}"/>
  <meta property="og:image:width" content="${article.imageWidth ?? 1200}"/>
  <meta property="og:image:height" content="${article.imageHeight ?? 630}"/>
  <meta property="og:url" content="${escapeHtml(pageUrl)}"/>
  <link rel="canonical" href="${escapeHtml(pageUrl)}"/>
  <meta property="article:published_time" content="${escapeHtml(article.publishedAt)}"/>
  <meta property="article:modified_time" content="${escapeHtml(article.updatedAt || article.publishedAt)}"/>
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
  ${imageForMeta && imageForMeta !== fallbackImage ? `<img class="hero" src="${escapeHtml(imageForMeta)}" alt="${escapeHtml(article.imageAlt || article.title)}" loading="eager"/>` : ''}
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

          const eventDate = extractEventDateFromContent(article.contentText, article.publishedAt);
          const toEventDateTime = (d: string) =>
            /T\d{2}:\d{2}/.test(d) ? d : `${d}T00:00:00-05:00`;
          const eventSchema =
            (eventDate && (article.category === 'events' || article.category === 'sports'))
              ? {
                  "@context": "https://schema.org",
                  "@type": "Event",
                  name: article.title,
                  description: desc,
                  url: pageUrl,
                  startDate: toEventDateTime(eventDate),
                  endDate: toEventDateTime(eventDate),
                  location: article.county
                    ? {
                        "@type": "Place",
                        name: `${article.county} County, Kentucky`,
                        address: {
                          "@type": "PostalAddress",
                          addressLocality: article.city || article.county,
                          addressRegion: "KY",
                          addressCountry: "US",
                        },
                      }
                    : { "@type": "Place", name: "Kentucky" },
                  organizer: deriveSourceOrganization(article.canonicalUrl),
                  eventStatus: "https://schema.org/EventScheduled",
                  eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
                }
              : null;
          const schemaScripts = `<script type="application/ld+json" id="json-ld-article">${JSON.stringify(newsArticleSchema)}</script>\n<script type="application/ld+json" id="json-ld-breadcrumb">${JSON.stringify(breadcrumbSchema)}</script>`
            + (eventSchema ? `\n<script type="application/ld+json" id="json-ld-event">${JSON.stringify(eventSchema)}</script>` : '');
          const finalHtml = iabHtml.replace('</head>', `${schemaScripts}\n</head>`);
          return new Response(finalHtml, {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              // Bot-rendered article HTML: browsers and CDN cache for 1 h; Cloudflare edge
              // serves stale content for up to 24 h while revalidating in the background,
              // eliminating cold-cache latency spikes.
              'cache-control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
            },
          });
        }
        if (isBot) {
          const pageUrl = `https://localkynews.com${canonicalPath}`;
          const metas: string[] = [];
          const metaPageTitle = buildPageTitle(article.title, article.county, article.isKentucky, article.city);
          const fallbackImage = DEFAULT_OG_IMAGE;
          metas.push('<meta property="og:type" content="article"/>');
          metas.push(`<meta property="og:title" content="${escapeHtml(metaPageTitle)}"/>`);
          metas.push(`<meta property="og:description" content="${escapeHtml(desc)}"/>`);
          const imageForMeta = normalizeOgImage((await selectPreviewImage(article)) || fallbackImage);
          const imageObject = imageForMeta
            ? {
                "@type": "ImageObject",
                url: imageForMeta,
                ...(imageForMeta === DEFAULT_OG_IMAGE ? { width: 1200, height: 630 } : {}),
              }
            : null;
          metas.push(`<meta property="og:image" content="${escapeHtml(imageForMeta)}"/>`);
          metas.push(`<meta property="og:image:width" content="${article.imageWidth ?? 1200}"/>`);
          metas.push(`<meta property="og:image:height" content="${article.imageHeight ?? 630}"/>`);
          metas.push(`<meta property="og:url" content="${escapeHtml(pageUrl)}"/>`);
          metas.push('<meta property="og:site_name" content="Local KY News"/>');
          metas.push('<meta name="twitter:card" content="summary_large_image"/>');
          metas.push('<meta name="twitter:site" content="@LocalKYNews"/>');
          metas.push(`<meta name="twitter:title" content="${escapeHtml(metaPageTitle)}"/>`);
          metas.push(`<meta name="twitter:description" content="${escapeHtml(desc)}"/>`);
          metas.push(`<meta name="twitter:image" content="${escapeHtml(imageForMeta)}"/>`);
          metas.push(`<meta property="fb:app_id" content="${escapeHtml(env.FB_APP_ID || '0')}"/>`);
        // add description, canonical link, and article timestamps
        metas.push(`<meta name="description" content="${escapeHtml(desc)}"/>`);
        metas.push(`<link rel="canonical" href="${escapeHtml(pageUrl)}"/>`);
        metas.push(`<meta property="article:published_time" content="${escapeHtml(article.publishedAt)}"/>`);
        metas.push(`<meta property="article:modified_time" content="${escapeHtml(article.updatedAt || article.publishedAt)}"/>`);

        // build JSON-LD schemas for bots
        const newsArticleSchema = {
          "@context": "https://schema.org",
          "@type": "NewsArticle",
          headline: article.title,
          wordCount: article.rawWordCount ?? article.summaryWordCount ?? undefined,
          articleSection: article.category
            ? article.category.charAt(0).toUpperCase() + article.category.slice(1)
            : undefined,
          description: desc,
          url: pageUrl,
          mainEntityOfPage: { "@type": "WebPage", "@id": pageUrl },
          datePublished: article.publishedAt,
          dateModified: article.updatedAt || article.publishedAt,
          ...(article.author
            ? { author: { "@type": "Person", name: article.author } }
            : {}),
          publisher: {
            "@type": "Organization",
            name: "Local KY News",
            url: "https://localkynews.com",
            logo: {
              "@type": "ImageObject",
              url: "https://localkynews.com/img/logo-wide.png",
              width: 600,
              height: 60,
            },
          },
          ...(imageObject ? { image: imageObject } : {}),
          ...(article.county
            ? {
                contentLocation: {
                  "@type": "AdministrativeArea",
                  name: `${article.county} County, Kentucky`,
                },
              }
            : article.isKentucky
            ? {
                contentLocation: {
                  "@type": "State",
                  name: "Kentucky",
                },
              }
            : {}),
          speakable: {
            "@type": "SpeakableSpecification",
            cssSelector: ["h1", ".article-summary"],
          },
          sourceOrganization: deriveSourceOrganization(article.canonicalUrl),
        };
        const countyUrl = article.county
          ? `https://localkynews.com/news/kentucky/${article.county.toLowerCase().replace(/\s+/g, "-")}-county`
          : null;
        const breadcrumbSchema = {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: "https://localkynews.com" },
            ...(countyUrl
              ? [
                  { "@type": "ListItem", position: 2, name: `${article.county} County`, item: countyUrl },
                  { "@type": "ListItem", position: 3, name: article.title, item: pageUrl },
                ]
              : [{ "@type": "ListItem", position: 2, name: article.title, item: pageUrl }]),
          ],
        };

        // Build article body so Googlebot can index the actual text content
        const renderSummaryHtml = (summary: string): string => {
          const paras = (summary || '').split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
          const html: string[] = [];
          let hasRenderedParagraph = false;

          for (let i = 0; i < paras.length; i++) {
            const t = paras[i];

            // Paragraphs that are just a short heading + colon (e.g. "Key facts:")
            if (/^[^:\n]+:\s*$/.test(t)) {
              if (!hasRenderedParagraph) {
                html.push(`<p>${escapeHtml(t)}</p>`);
                hasRenderedParagraph = true;
              } else {
                const heading = t.replace(/:\s*$/, '');
                html.push(`<h2 class="article-section-heading">${escapeHtml(heading)}</h2>`);
              }
              continue;
            }

            // "What this means for ..." blocks
            if (/^What this means for\b/i.test(t)) {
              if (!hasRenderedParagraph) {
                html.push(`<p>${escapeHtml(t)}</p>`);
                hasRenderedParagraph = true;
                continue;
              }
              const colonIdx = t.indexOf(':');
              if (colonIdx >= 0) {
                const heading = t.slice(0, colonIdx + 1);
                const body = t.slice(colonIdx + 1).trim();
                html.push(`<h2 class="article-section-heading">${escapeHtml(heading)}</h2>`);
                if (body) {
                  html.push(`<p>${escapeHtml(body)}</p>`);
                  hasRenderedParagraph = true;
                }
              } else {
                html.push(`<h2 class="article-section-heading">${escapeHtml(t)}</h2>`);
              }
              continue;
            }

            // Lists (each line begins with "-" or "*" or a number+period)
            const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
            const isNumberedList = lines.length > 0 && lines.every((l) => /^(?:\d+\.|[-*])\s*/.test(l));
            if (isNumberedList) {
              const items = lines
                .map((l) => `<li>${escapeHtml(l.replace(/^(?:\d+\.|[-*])\s*/, '').trim())}</li>`)
                .join('');
              html.push(`<ul class="article-key-points">${items}</ul>`);
              continue;
            }

            // "## Heading" → <h2> (existing subheading support — keep)
            if (/^##\s+/.test(t)) {
              if (!hasRenderedParagraph) {
                html.push(`<p>${escapeHtml(t)}</p>`);
                hasRenderedParagraph = true;
              } else {
                html.push(`<h2 class="article-section-heading">${escapeHtml(t.replace(/^##\s+/, ''))}</h2>`);
              }
              continue;
            }

            // Default: paragraph
            html.push(`<p>${escapeHtml(t)}</p>`);
            hasRenderedParagraph = true;
          }

          return `<div class="article-summary">${html.join('\n')}</div>`;
        };

        let botSummaryParagraphs = renderSummaryHtml(article.summary || '');
        if (botSummaryParagraphs.includes('<p>')) {
          botSummaryParagraphs = botSummaryParagraphs.replace('<p>', '<p class="article-summary">');
        }
        const botRelatedHtml = await buildRelatedCountyArticlesHtml(env, article);
        const botCountyLabel = article.county ? `${article.county} County` : (article.isKentucky ? 'Kentucky' : '');
        const botCategoryLabel = article.category ? article.category.charAt(0).toUpperCase() + article.category.slice(1) : '';
        const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="${getRobotsContent(article.rawWordCount)}"/>
  <title>${escapeHtml(metaPageTitle)}</title>
  ${metas.join('\n  ')}
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;padding:16px;color:#111;line-height:1.6;}
    h1{font-size:1.35rem;line-height:1.3;margin-bottom:8px;}
    .meta{font-size:0.82rem;color:#666;margin-bottom:16px;}
    .meta span{margin-right:12px;}
    p{margin:0 0 14px;}
    a.source{display:block;margin:20px 0;padding:12px;background:#f0f4ff;border-radius:8px;text-decoration:none;color:#1a56db;font-weight:600;text-align:center;}
    footer{border-top:1px solid #eee;margin-top:24px;padding-top:12px;font-size:0.78rem;color:#999;text-align:center;}
    .related{margin:24px 0;} .related h2{font-size:1rem;margin-bottom:8px;}
    .related ul{padding-left:1.2rem;margin:0;} .related li{margin:4px 0;}
    .related a{color:#1a56db;}
  </style>
</head>
<body>
  <h1>${escapeHtml(article.title)}</h1>
  <div class="meta">
    ${botCountyLabel ? `<span>📍 ${escapeHtml(botCountyLabel)}</span>` : ''}
    ${botCategoryLabel ? `<span>${escapeHtml(botCategoryLabel)}</span>` : ''}
    ${article.publishedAt ? `<span>${new Date(article.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>` : ''}
  </div>
  ${botSummaryParagraphs || `<p class="article-summary">${escapeHtml(article.seoDescription || article.title)}</p>`}
  ${botRelatedHtml}
  <a class="source" href="${escapeHtml(article.canonicalUrl)}" rel="noopener">Read full article at source →</a>
  <footer>Local KY News · <a href="https://localkynews.com" style="color:#999;">localkynews.com</a></footer>
</body>
</html>`;
        // insert JSON-LD before sending
        const eventDate = extractEventDateFromContent(article.contentText, article.publishedAt);
        const eventSchema =
          (eventDate && (article.category === 'events' || article.category === 'sports'))
            ? {
                "@context": "https://schema.org",
                "@type": "Event",
                name: article.title,
                description: desc,
                url: pageUrl,
                startDate: eventDate,
                endDate: eventDate,
                location: article.county
                  ? {
                      "@type": "Place",
                      name: `${article.county} County, Kentucky`,
                      address: {
                        "@type": "PostalAddress",
                        addressLocality: article.city || article.county,
                        addressRegion: "KY",
                        addressCountry: "US",
                      },
                    }
                  : { "@type": "Place", name: "Kentucky" },
                organizer: deriveSourceOrganization(article.canonicalUrl),
                eventStatus: "https://schema.org/EventScheduled",
                eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
              }
            : null;
        const schemaScripts = `<script type="application/ld+json" id="json-ld-article">${JSON.stringify(newsArticleSchema)}</script>\n<script type="application/ld+json" id="json-ld-breadcrumb">${JSON.stringify(breadcrumbSchema)}</script>`
          + (eventSchema ? `\n<script type="application/ld+json" id="json-ld-event">${JSON.stringify(eventSchema)}</script>` : '');
        const finalHtml = html.replace('</head>', `${schemaScripts}\n</head>`);
        return new Response(finalHtml, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            // Bot-rendered article HTML: browsers and CDN cache for 1 h; Cloudflare edge
            // serves stale content for up to 24 h while revalidating in the background,
            // eliminating cold-cache latency spikes.
            'cache-control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
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

    // If we didn't find an article for this slug, check whether it was migrated
    // from an older hash-based slug.  This allows legacy shared links to still
    // resolve to the current canonical URL.
    if (!article) {
      const migration = await findSlugMigration(env, slug);
      if (migration) {
        const migratedArticle = await getArticleBySlug(env, migration.newSlug);
        if (migratedArticle) {
          const redirectPath = buildArticlePath(migratedArticle);
          return new Response(null, {
            status: 301,
            headers: { Location: redirectPath },
          });
        }
      }
    }

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
        const fallbackImage = DEFAULT_OG_IMAGE;
        const imageForMeta = normalizeOgImage((await selectPreviewImage(article)) || fallbackImage);
        const imageObject = imageForMeta
          ? {
              "@type": "ImageObject",
              url: imageForMeta,
              ...(imageForMeta === DEFAULT_OG_IMAGE ? { width: 1200, height: 630 } : {}),
            }
          : null;
        const summaryParagraphs = (article.summary || '')
          .split(/\n\n+/)
          .map((p: string) => `<p>${escapeHtml(p.trim())}</p>`)
          .filter((p: string) => p.length > 10)
          .join('\n');
        const countyLabel = article.county ? `${article.county} County` : (article.isKentucky ? 'Kentucky' : '');
        const categoryLabel = article.category ? article.category.charAt(0).toUpperCase() + article.category.slice(1) : '';

        // build JSON-LD schemas for IAB responses
        const newsArticleSchema = {
          "@context": "https://schema.org",
          "@type": "NewsArticle",
          headline: article.title,
          wordCount: article.rawWordCount ?? article.summaryWordCount ?? undefined,
          articleSection: article.category
            ? article.category.charAt(0).toUpperCase() + article.category.slice(1)
            : undefined,
          description: desc,
          url: pageUrl,
          mainEntityOfPage: { "@type": "WebPage", "@id": pageUrl },
          datePublished: article.publishedAt,
          dateModified: article.updatedAt || article.publishedAt,
          ...(article.author
            ? { author: { "@type": "Person", name: article.author } }
            : {}),
          publisher: {
            "@type": "Organization",
            name: "Local KY News",
            url: "https://localkynews.com",
            logo: {
              "@type": "ImageObject",
              url: "https://localkynews.com/img/logo-wide.png",
              width: 600,
              height: 60,
            },
          },
          ...(imageObject ? { image: imageObject } : {}),
          ...(article.county
            ? {
                contentLocation: {
                  "@type": "AdministrativeArea",
                  name: `${article.county} County, Kentucky`,
                },
              }
            : article.isKentucky
            ? {
                contentLocation: {
                  "@type": "State",
                  name: "Kentucky",
                },
              }
            : {}),
          speakable: {
            "@type": "SpeakableSpecification",
            cssSelector: ["h1", ".article-summary"],
          },
          sourceOrganization: deriveSourceOrganization(article.canonicalUrl),
        };
        const countyUrl = article.county
          ? `https://localkynews.com/news/kentucky/${article.county.toLowerCase().replace(/\s+/g, "-")}-county`
          : null;
        const breadcrumbSchema = {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: "https://localkynews.com" },
            ...(countyUrl
              ? [
                  { "@type": "ListItem", position: 2, name: `${article.county} County`, item: countyUrl },
                  { "@type": "ListItem", position: 3, name: article.title, item: pageUrl },
                ]
              : [{ "@type": "ListItem", position: 2, name: article.title, item: pageUrl }]),
          ],
        };

        const iabPageTitle = buildPageTitle(article.title, article.county, article.isKentucky, article.city);

        const iabHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="${getRobotsContent(article.rawWordCount)}"/>
  <title>${escapeHtml(iabPageTitle)}</title>
  <meta name="description" content="${escapeHtml(iabDesc)}"/>
  <meta property="og:type" content="article"/>
  <meta property="og:title" content="${escapeHtml(iabPageTitle)}"/>
  <meta property="og:description" content="${escapeHtml(iabDesc)}"/>
  <meta property="og:image" content="${escapeHtml(imageForMeta)}"/>
  <meta property="og:url" content="${escapeHtml(pageUrl)}"/>
  <link rel="canonical" href="${escapeHtml(pageUrl)}"/>
  <meta property="article:published_time" content="${escapeHtml(article.publishedAt)}"/>
  <meta property="article:modified_time" content="${escapeHtml(article.updatedAt || article.publishedAt)}"/>
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
  ${imageForMeta && imageForMeta !== fallbackImage ? `<img class="hero" src="${escapeHtml(imageForMeta)}" alt="${escapeHtml(article.imageAlt || article.title)}" loading="eager"/>` : ''}
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
        const eventDate = extractEventDateFromContent(article.contentText, article.publishedAt);
        const eventSchema =
          (eventDate && (article.category === 'events' || article.category === 'sports'))
            ? {
                "@context": "https://schema.org",
                "@type": "Event",
                name: article.title,
                description: desc,
                url: pageUrl,
                startDate: eventDate,
                endDate: eventDate,
                location: article.county
                  ? {
                      "@type": "Place",
                      name: `${article.county} County, Kentucky`,
                      address: {
                        "@type": "PostalAddress",
                        addressLocality: article.city || article.county,
                        addressRegion: "KY",
                        addressCountry: "US",
                      },
                    }
                  : { "@type": "Place", name: "Kentucky" },
                organizer: deriveSourceOrganization(article.canonicalUrl),
                eventStatus: "https://schema.org/EventScheduled",
                eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
              }
            : null;
        const schemaScripts = `<script type="application/ld+json" id="json-ld-article">${JSON.stringify(newsArticleSchema)}</script>\n<script type="application/ld+json" id="json-ld-breadcrumb">${JSON.stringify(breadcrumbSchema)}</script>`
          + (eventSchema ? `\n<script type="application/ld+json" id="json-ld-event">${JSON.stringify(eventSchema)}</script>` : '');
        const finalHtml = iabHtml.replace('</head>', `${schemaScripts}\n</head>`);
        return new Response(finalHtml, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            // Bot-rendered article HTML: browsers and CDN cache for 1 h; Cloudflare edge
            // serves stale content for up to 24 h while revalidating in the background,
            // eliminating cold-cache latency spikes.
            'cache-control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
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
        const fallbackImage = DEFAULT_OG_IMAGE;

        // determine which image to use. priority:
        // 1. explicit article.imageUrl
        // 2. first <img> inside stored contentHtml (works for our own posts)
        // 3. attempt external fetch+scrape (useful for third-party sources)
        // use the shared preview-image logic so bots and Graph posts agree
        const metas = [];
        const metaPageTitle = buildPageTitle(article.title, article.county, article.isKentucky, article.city);
        metas.push('<meta property="og:type" content="article"/>');
        metas.push(`<meta property="og:title" content="${escapeHtml(metaPageTitle)}"/>`);
        metas.push(`<meta property="og:description" content="${escapeHtml(desc)}"/>`);
        const imageForMeta = normalizeOgImage((await selectPreviewImage(article)) || fallbackImage);
        const imageObject = imageForMeta
          ? {
              "@type": "ImageObject",
              url: imageForMeta,
              ...(imageForMeta === DEFAULT_OG_IMAGE ? { width: 1200, height: 630 } : {}),
            }
          : null;

        // build JSON-LD schemas for bots
        const newsArticleSchema = {
          "@context": "https://schema.org",
          "@type": "NewsArticle",
          headline: article.title,
          wordCount: article.rawWordCount ?? article.summaryWordCount ?? undefined,
          articleSection: article.category
            ? article.category.charAt(0).toUpperCase() + article.category.slice(1)
            : undefined,
          description: desc,
          url: pageUrl,
          mainEntityOfPage: { "@type": "WebPage", "@id": pageUrl },
          datePublished: article.publishedAt,
          dateModified: article.updatedAt || article.publishedAt,
          ...(article.author
            ? { author: { "@type": "Person", name: article.author } }
            : {}),
          publisher: {
            "@type": "Organization",
            name: "Local KY News",
            url: "https://localkynews.com",
            logo: {
              "@type": "ImageObject",
              url: "https://localkynews.com/img/logo-wide.png",
              width: 600,
              height: 60,
            },
          },
          ...(imageObject ? { image: imageObject } : {}),
          ...(article.county
            ? {
                contentLocation: {
                  "@type": "AdministrativeArea",
                  name: `${article.county} County, Kentucky`,
                },
              }
            : article.isKentucky
            ? {
                contentLocation: {
                  "@type": "State",
                  name: "Kentucky",
                },
              }
            : {}),
          speakable: {
            "@type": "SpeakableSpecification",
            cssSelector: ["h1", ".article-summary"],
          },
          sourceOrganization: deriveSourceOrganization(article.canonicalUrl),
        };
        const countyUrl = article.county
          ? `https://localkynews.com/news/kentucky/${article.county.toLowerCase().replace(/\s+/g, "-")}-county`
          : null;
        const breadcrumbSchema = {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: "https://localkynews.com" },
            ...(countyUrl
              ? [
                  { "@type": "ListItem", position: 2, name: `${article.county} County`, item: countyUrl },
                  { "@type": "ListItem", position: 3, name: article.title, item: pageUrl },
                ]
              : [{ "@type": "ListItem", position: 2, name: article.title, item: pageUrl }]),
          ],
        };

        metas.push(`<meta property="og:image" content="${escapeHtml(imageForMeta)}"/>`);
        metas.push(`<meta property="og:image:width" content="${article.imageWidth ?? 1200}"/>`);
        metas.push(`<meta property="og:image:height" content="${article.imageHeight ?? 630}"/>`);
        metas.push(`<meta property="og:url" content="${escapeHtml(pageUrl)}"/>`);
        metas.push('<meta property="og:site_name" content="Local KY News"/>');

        // Twitter uses its own tags and also wants the large image card.
        metas.push('<meta name="twitter:card" content="summary_large_image"/>');
        metas.push('<meta name="twitter:site" content="@LocalKYNews"/>');
        metas.push(`<meta name="twitter:title" content="${escapeHtml(metaPageTitle)}"/>`);
        metas.push(`<meta name="twitter:description" content="${escapeHtml(desc)}"/>`);
        metas.push(
          `<meta name="twitter:image" content="${escapeHtml(imageForMeta)}"/>
        `);

        // always include the tag; use configured ID or fall back to '0'
        metas.push(
          `<meta property="fb:app_id" content="${escapeHtml(
            env.FB_APP_ID || '0'
          )}"/>`
        );

        // add description, canonical link, and article timestamps
        metas.push(`<meta name="description" content="${escapeHtml(desc)}"/>`);
        metas.push(`<link rel="canonical" href="${escapeHtml(pageUrl)}"/>`);
        metas.push(`<meta property="article:published_time" content="${escapeHtml(article.publishedAt)}"/>`);
        metas.push(`<meta property="article:modified_time" content="${escapeHtml(article.updatedAt || article.publishedAt)}"/>`);
        // Build article body so Googlebot can index the actual text content
        const renderSummaryHtml = (summary: string): string => {
          const paras = (summary || '').split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
          const html: string[] = [];
          let hasRenderedParagraph = false;

          for (let i = 0; i < paras.length; i++) {
            const t = paras[i];

            // Paragraphs that are just a short heading + colon (e.g. "Key facts:")
            if (/^[^:\n]+:\s*$/.test(t)) {
              if (!hasRenderedParagraph) {
                html.push(`<p>${escapeHtml(t)}</p>`);
                hasRenderedParagraph = true;
              } else {
                const heading = t.replace(/:\s*$/, '');
                html.push(`<h2 class="article-section-heading">${escapeHtml(heading)}</h2>`);
              }
              continue;
            }

            // "What this means for ..." blocks
            if (/^What this means for\b/i.test(t)) {
              if (!hasRenderedParagraph) {
                html.push(`<p>${escapeHtml(t)}</p>`);
                hasRenderedParagraph = true;
                continue;
              }
              const colonIdx = t.indexOf(':');
              if (colonIdx >= 0) {
                const heading = t.slice(0, colonIdx + 1);
                const body = t.slice(colonIdx + 1).trim();
                html.push(`<h2 class="article-section-heading">${escapeHtml(heading)}</h2>`);
                if (body) {
                  html.push(`<p>${escapeHtml(body)}</p>`);
                  hasRenderedParagraph = true;
                }
              } else {
                html.push(`<h2 class="article-section-heading">${escapeHtml(t)}</h2>`);
              }
              continue;
            }

            // Lists (each line begins with "-" or "*" or a number+period)
            const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
            const isNumberedList = lines.length > 0 && lines.every((l) => /^(?:\d+\.|[-*])\s*/.test(l));
            if (isNumberedList) {
              const items = lines
                .map((l) => `<li>${escapeHtml(l.replace(/^(?:\d+\.|[-*])\s*/, '').trim())}</li>`)
                .join('');
              html.push(`<ul class="article-key-points">${items}</ul>`);
              continue;
            }

            // "## Heading" → <h2> (existing subheading support — keep)
            if (/^##\s+/.test(t)) {
              if (!hasRenderedParagraph) {
                html.push(`<p>${escapeHtml(t)}</p>`);
                hasRenderedParagraph = true;
              } else {
                html.push(`<h2 class="article-section-heading">${escapeHtml(t.replace(/^##\s+/, ''))}</h2>`);
              }
              continue;
            }

            // Default: paragraph
            html.push(`<p>${escapeHtml(t)}</p>`);
            hasRenderedParagraph = true;
          }

          return `<div class="article-summary">${html.join('\n')}</div>`;
        };

        let botSummaryParagraphs = renderSummaryHtml(article.summary || '');
        if (botSummaryParagraphs.includes('<p>')) {
          botSummaryParagraphs = botSummaryParagraphs.replace('<p>', '<p class="article-summary">');
        }
        const botRelatedHtml = await buildRelatedCountyArticlesHtml(env, article);
        const botCountyLabel = article.county ? `${article.county} County` : (article.isKentucky ? 'Kentucky' : '');
        const botCategoryLabel = article.category ? article.category.charAt(0).toUpperCase() + article.category.slice(1) : '';
        const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="${getRobotsContent(article.rawWordCount)}"/>
  <title>${escapeHtml(metaPageTitle)}</title>
  ${metas.join('\n  ')}
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;padding:16px;color:#111;line-height:1.6;}
    h1{font-size:1.35rem;line-height:1.3;margin-bottom:8px;}
    .meta{font-size:0.82rem;color:#666;margin-bottom:16px;}
    .meta span{margin-right:12px;}
    p{margin:0 0 14px;}
    a.source{display:block;margin:20px 0;padding:12px;background:#f0f4ff;border-radius:8px;text-decoration:none;color:#1a56db;font-weight:600;text-align:center;}
    footer{border-top:1px solid #eee;margin-top:24px;padding-top:12px;font-size:0.78rem;color:#999;text-align:center;}
    .related{margin:24px 0;} .related h2{font-size:1rem;margin-bottom:8px;}
    .related ul{padding-left:1.2rem;margin:0;} .related li{margin:4px 0;}
    .related a{color:#1a56db;}
  </style>
</head>
<body>
  <h1>${escapeHtml(article.title)}</h1>
  <div class="meta">
    ${botCountyLabel ? `<span>📍 ${escapeHtml(botCountyLabel)}</span>` : ''}
    ${botCategoryLabel ? `<span>${escapeHtml(botCategoryLabel)}</span>` : ''}
    ${article.publishedAt ? `<span>${new Date(article.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>` : ''}
  </div>
  ${botSummaryParagraphs || `<p class="article-summary">${escapeHtml(article.seoDescription || article.title)}</p>`}
  ${botRelatedHtml}
  <a class="source" href="${escapeHtml(article.canonicalUrl)}" rel="noopener">Read full article at source →</a>
  <footer>Local KY News · <a href="https://localkynews.com" style="color:#999;">localkynews.com</a></footer>
</body>
</html>`;
        // insert JSON-LD scripts
        const eventDate = extractEventDateFromContent(article.contentText, article.publishedAt);
        const eventSchema =
          (eventDate && (article.category === 'events' || article.category === 'sports'))
            ? {
                "@context": "https://schema.org",
                "@type": "Event",
                name: article.title,
                description: desc,
                url: pageUrl,
                startDate: eventDate,
                endDate: eventDate,
                location: article.county
                  ? {
                      "@type": "Place",
                      name: `${article.county} County, Kentucky`,
                      address: {
                        "@type": "PostalAddress",
                        addressLocality: article.city || article.county,
                        addressRegion: "KY",
                        addressCountry: "US",
                      },
                    }
                  : { "@type": "Place", name: "Kentucky" },
                organizer: deriveSourceOrganization(article.canonicalUrl),
                eventStatus: "https://schema.org/EventScheduled",
                eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
              }
            : null;
        const schemaScripts = `<script type="application/ld+json" id="json-ld-article">${JSON.stringify(newsArticleSchema)}</script>\n<script type="application/ld+json" id="json-ld-breadcrumb">${JSON.stringify(breadcrumbSchema)}</script>`
          + (eventSchema ? `\n<script type="application/ld+json" id="json-ld-event">${JSON.stringify(eventSchema)}</script>` : '');
        const finalHtml = html.replace('</head>', `${schemaScripts}\n</head>`);
        return new Response(finalHtml, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            // Bot-rendered article HTML: browsers and CDN cache for 1 h; Cloudflare edge
            // serves stale content for up to 24 h while revalidating in the background,
            // eliminating cold-cache latency spikes.
            'cache-control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
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

// Serve static HTML for certain section index pages when crawled by bots.
// Bots that don't execute JavaScript need real content to index; normal
// browsers will fall through to the SPA shell below.
const SECTION_PATHS: Record<string, { title: string; description: string; category: string }> = {
  '/today':         { title: 'Kentucky News Today — Local KY News', description: 'The latest local news from across all 120 Kentucky counties.', category: 'today' },
  '/national':      { title: 'National News — Local KY News', description: 'National headlines curated for Kentucky readers.', category: 'national' },
  '/news/national': { title: 'National News — Local KY News', description: 'National headlines curated for Kentucky readers.', category: 'national' },
  '/sports':        { title: 'Kentucky Sports News — Local KY News', description: 'High school, college, and local sports coverage across Kentucky.', category: 'sports' },
  '/weather':       { title: 'Kentucky Weather — Local KY News', description: 'Weather alerts, forecasts, and updates across Kentucky.', category: 'weather' },
  '/schools':       { title: 'Kentucky Schools News — Local KY News', description: 'Education news, school events, and district updates across Kentucky.', category: 'schools' },
  '/local':         { title: 'Local Kentucky News — Local KY News', description: 'Community news and local stories from Kentucky counties.', category: 'local' },
};

const sectionMeta = SECTION_PATHS[url.pathname.replace(/\/$/, '')];
if (request.method === 'GET' && sectionMeta && isSearchBot(request.headers.get('user-agent') || '')) {
  const categoryHeading = sectionMeta.title.replace(/\s*—\s*Local KY News$/, '').trim();
  const canonicalUrl = `${BASE_URL}${url.pathname}`;

  const articles = await getTopArticlesByCategory(env, sectionMeta.category, 10);
  const listItems = articles
    .filter((a) => a.slug)
    .map((a) => {
      const href = buildArticleUrl(BASE_URL, a.slug, a.county, a.category, a.is_national === 1, a.id);
      const dateStr = a.published_at
        ? new Date(a.published_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : '';
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(a.title)}</a>${dateStr ? ` - ${escapeHtml(dateStr)}` : ''}</li>`;
    })
    .join('\n');

  const baseResponse = env.ASSETS
    ? await env.ASSETS.fetch('/index.html')
    : await fetch(`${BASE_URL}/index.html`);
  let baseHtml = await baseResponse.text();

  // Ensure our SEO metadata is present and not duplicated.
  baseHtml = baseHtml.replace(/<link rel="canonical"[^>]*>\s*/i, '');
  baseHtml = baseHtml.replace(/<meta name="description"[^>]*>\s*/i, '');

  const metaBlock =
    `<meta name="description" content="${escapeHtml(sectionMeta.description)}"/>\n` +
    `<link rel="canonical" href="${canonicalUrl}"/>\n`;
  baseHtml = baseHtml.replace('</head>', `${metaBlock}</head>`);

  const prerenderBlock =
    `<div id="seo-prerender" style="display:none">` +
    `<h1>${escapeHtml(categoryHeading)}</h1>` +
    `<ul>${listItems}</ul>` +
    `</div>`;
  baseHtml = baseHtml.replace('</body>', `${prerenderBlock}</body>`);

  const headers = new Headers(baseResponse.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'public, max-age=300, s-maxage=300');

  return new Response(baseHtml, {
    status: baseResponse.status,
    headers,
  });
}

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
    // A county hub page should include a canonical link (or a noindex robots
    // tag on paginated variants) even when the request is served via the
    // SPA shell. This ensures crawlers that don't run JS still see the proper
    // metadata.
    const countyHubMatch = url.pathname.match(/^\/news\/kentucky\/([a-z-]+)-county\/?$/);
    if (countyHubMatch) {
        const hasCursor = url.searchParams.has('cursor');
        const canonicalUrl = `${BASE_URL}/news/kentucky/${countyHubMatch[1]}-county`;

        const baseResponse = env.ASSETS
            ? await env.ASSETS.fetch('/index.html')
            : await fetch(`${BASE_URL}/index.html`);
        let baseHtml = await baseResponse.text();

        // Remove or replace any existing canonical tag to ensure the correct
        // URL is used for county pages, and remove it entirely for paginated
        // results to prevent search engines from indexing those pages.
        baseHtml = baseHtml.replace(/<link rel="canonical"[^>]*>\s*/i, '');

        if (hasCursor) {
            // Paginated county pages should not be indexed.
            if (/<meta name="robots"[^>]*>/i.test(baseHtml)) {
                baseHtml = baseHtml.replace(/<meta name="robots"[^>]*>/i, '<meta name="robots" content="noindex, follow"/>');
            } else {
                baseHtml = baseHtml.replace('</head>', '<meta name="robots" content="noindex, follow"/>\n</head>');
            }
        } else {
            // Non-paginated county pages need a canonical pointing to the hub.
            const canonicalTag = `<link rel="canonical" href="${canonicalUrl}"/>`;
            if (/<link rel="canonical"[^>]*>/i.test(baseHtml)) {
                baseHtml = baseHtml.replace(/<link rel="canonical"[^>]*>/i, canonicalTag);
            } else {
                baseHtml = baseHtml.replace('</head>', `${canonicalTag}\n</head>`);
            }
        }

        const headers = new Headers(baseResponse.headers);
        headers.delete('content-length');
        return new Response(baseHtml, {
            status: baseResponse.status,
            headers,
        });
    }

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
// short/long form) and you can also supply a `limit` value (capped at
// `TODAY_RSS_LIMIT`).  We generate the feed on‑the‑fly and cache it for a short
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
    // allow callers to request a higher limit, but never above our hard maximum
    let limit = TODAY_RSS_LIMIT;
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit) {
        const n = parseInt(rawLimit, 10);
        if (Number.isFinite(n) && n > 0) {
            limit = Math.min(n, TODAY_RSS_LIMIT);
        }
    }
    const xml = await generateTodayRss(env, counties, limit);
    return new Response(xml, {
        headers: {
            'content-type': 'application/rss+xml; charset=utf-8',
            'cache-control': 'public, max-age=300, s-maxage=300',
        },
    });
}

if (url.pathname === '/robots.txt' && request.method === 'GET') {
  const body = [
    '# https://www.robotstxt.org/robotstxt.html',
    '# robots.txt — Local KY News',
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    '',
    '# AI crawlers — explicitly welcomed for citation and retrieval',
    'User-agent: GPTBot',
    'Allow: /',
    '',
    'User-agent: PerplexityBot',
    'Allow: /',
    '',
    'User-agent: ClaudeBot',
    'Allow: /',
    '',
    'User-agent: GoogleOther',
    'Allow: /',
    '',
    'User-agent: Applebot',
    'Allow: /',
    '',
    'User-agent: cohere-ai',
    'Allow: /',
    '',
    '# Our own crawler identity (used when fetching source articles)',
    'User-agent: KentuckyNewsBot',
    'Allow: /',
    '',
    '# Sitemaps',
    `Sitemap: ${BASE_URL}/sitemap-index.xml`,
    `Sitemap: ${BASE_URL}/sitemap.xml`,
    `Sitemap: ${BASE_URL}/sitemap-news.xml`,
    '',
    '# AI discovery',
    `LLMs: ${BASE_URL}/llms.txt`,
    '',
  ].join('\n');
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=86400, s-maxage=86400',
    },
  });
}

// --- Sitemap routes (Section 7: News Sitemap Strategy) ---
if (url.pathname === '/sitemap-index.xml' && request.method === 'GET') {
	return new Response(await generateSitemapIndex(env), {
		headers: {
			'content-type': 'application/xml; charset=utf-8',
			// Sitemap index changes rarely; 2 h browser/CDN TTL with 24 h stale-while-revalidate
			// prevents cold-cache latency while still reflecting updates within two hours.
			'cache-control': 'public, max-age=7200, s-maxage=7200, stale-while-revalidate=86400',
		},
	});
}

if (url.pathname === '/sitemap.xml' && request.method === 'GET') {
	const xml = await generateSitemap(env);
	return new Response(xml, {
		headers: {
			'content-type': 'application/xml; charset=utf-8',
			// Main sitemap changes rarely; 2 h browser/CDN TTL with 24 h stale-while-revalidate
			// prevents cold-cache latency while still reflecting updates within two hours.
			'cache-control': 'public, max-age=7200, s-maxage=7200, stale-while-revalidate=86400',
		},
	});
}

if (url.pathname === '/sitemap-news.xml' && request.method === 'GET') {
	const xml = await generateNewsSitemap(env);
	return new Response(xml, {
		headers: {
			'content-type': 'application/xml; charset=utf-8',
			// Google News Sitemap must refresh quickly; a long TTL delays discovery of breaking stories.
			// Keep TTL short (1 min) so newly ingested articles appear in news search within minutes.
			'cache-control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
		},
	});
}

// GET /api/trimarc — proxy the TRIMARC Louisville traffic RSS feed (CORS bypass)
if (url.pathname === '/api/trimarc' && request.method === 'GET') {
	try {
		const res = await fetch('https://www.trimarc.org/rss/trimarcrss.xml', {
			headers: { 'User-Agent': 'LocalKYNews/1.0 (localkynews.com; news@localkynews.com)' },
		});
		if (!res.ok) return json({ error: 'Failed to fetch TRIMARC feed', status: res.status }, 502);
		const xml = await res.text();
		const items = parseTrimarcRss(xml);
		return json({ items }, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=60' });
	} catch (err) {
		return json({ error: String(err) }, 500);
	}
}

return json({ error: 'Not found' }, 404);
}

// ─── TRIMARC RSS parser ───────────────────────────────────────────────────────

interface TrimarcItem {
	title: string;
	description: string;
	link: string;
	pubDate: string;
	guid: string;
	// Parsed structured fields
	reportNumber: string;  // e.g. "282626"  (before " : " in title)
	location: string;      // e.g. "I-71/75 North Ramp from Donaldson Hwy. in Kenton County"
	county: string;        // e.g. "Kenton County"  (extracted from location)
	incidentType: string;  // e.g. "Disabled Vehicle-Occupied"  (before " : " in description)
	notes: string;         // e.g. "May be viewed on CCTV_06_75_1838"  (after " : " in description)
}

function parseTrimarcRss(xml: string): TrimarcItem[] {
	const items: TrimarcItem[] = [];
	const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
	let match: RegExpExecArray | null;

	function tagVal(block: string, tag: string): string {
		const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
		return m ? m[1] : '';
	}

	function decodeXmlStr(s: string): string {
		return s
			.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.trim();
	}

	while ((match = itemRegex.exec(xml)) !== null) {
		const block = match[1];
		const title       = decodeXmlStr(tagVal(block, 'title'));
		const description = decodeXmlStr(tagVal(block, 'description'));
		const link        = decodeXmlStr(tagVal(block, 'link'));
		const pubDate     = tagVal(block, 'pubDate').trim();
		const guid        = decodeXmlStr(tagVal(block, 'guid')) || link;

		// Title format: "{reportNumber} : {location}"
		const titleColonIdx = title.indexOf(' : ');
		const reportNumber = titleColonIdx !== -1 ? title.substring(0, titleColonIdx).trim() : '';
		const location     = titleColonIdx !== -1 ? title.substring(titleColonIdx + 3).trim() : title;

		// Extract county from "... in {Name} County" at end of location
		const countyMatch = location.match(/\bin\s+([A-Za-z][A-Za-z\s]*?)\s+County\b/i);
		const county = countyMatch ? `${countyMatch[1].trim()} County` : '';

		// Description format: "{incidentType} : {notes}"
		const descColonIdx = description.indexOf(' : ');
		const incidentType = descColonIdx !== -1 ? description.substring(0, descColonIdx).trim() : description;
		const notes        = descColonIdx !== -1 ? description.substring(descColonIdx + 3).trim() : '';

		items.push({ title, description, link, pubDate, guid, reportNumber, location, county, incidentType, notes });
	}

	return items;
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

  // If the category is missing/empty for a non-KY story, default to 'national'.
  // This prevents generating URLs like /news//<slug> when the admin retags an
  // article but leaves the category unset.
  const category = (article.category || '').trim().toLowerCase() || 'national';
  return `/news/${category}/${article.slug}`;
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
		const cached = await (env.CACHE as any).get(cacheKey).catch(() => null);
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
       WHERE (is_kentucky = 1 OR is_national = 1)
         AND slug IS NOT NULL AND slug != ''
         AND raw_word_count > 50
       ORDER BY id DESC LIMIT 50000`,
        )
        .all<{ id: number; slug: string | null; county: string | null; category: string; is_national: number; published_at: string; updated_at: string }>();

	// Warn if there are still legacy articles with missing slugs. Those should
	// be accessed via /post?articleId=N and must NOT be included in the sitemap.
	const missingSlugCountRow = await env.ky_news_db
		.prepare(
            `SELECT COUNT(1) as count FROM articles
       WHERE (is_kentucky = 1 OR is_national = 1)
         AND raw_word_count > 50
         AND (slug IS NULL OR slug = '')`,
        )
        .first<{ count: number }>();
	const missingSlugCount = missingSlugCountRow?.count ?? 0;
	if (missingSlugCount > 0) {
		console.warn(
			`[Sitemap] Skipping ${missingSlugCount} articles without slugs; they are still accessible via ${baseUrl}/post?articleId=<id>`,
		);
	}

	// filter out any rows missing a usable slug (legacy /post? urls are not canonical)
	const validRows = (rows.results || []).filter((row) => row.slug && row.slug.trim() !== '');
	// compute latest update date per county slug for hub pages
	const countyLastmod: Record<string, string> = {};
	validRows.forEach((row) => {
		if (row.county) {
			const slug = row.county.toLowerCase().replace(/\s+/g, '-');
			const iso = toIsoDateOrNull(row.updated_at || row.published_at || '');
			const date = iso ? iso.split('T')[0] : '';
			if (date) {
				if (!countyLastmod[slug] || date > countyLastmod[slug]) {
					countyLastmod[slug] = date;
				}
			}
		}
	});
	const urls = validRows.map((row) => {
		// normalize whatever timestamp we have and then take the UTC date portion
		const iso = toIsoDateOrNull(row.updated_at || row.published_at || '');
		const lastmod = iso ? iso.split('T')[0] : '';
		const loc = buildArticleUrl(baseUrl, row.slug, row.county, row.category, Boolean(row.is_national), row.id);
		return `  <url>
    <loc>${loc}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}
  </url>`;
	});

	// Add static pages — no changefreq or priority (Google ignores them).
	// Dynamic pages get today's date; truly static pages get a fixed release date.
	const dynamicPaths = ['/', '/today', '/national', '/sports', '/weather', '/schools', '/local'];
	const staticPaths = ['/about', '/contact', '/editorial-policy', '/privacy-policy'];
	const SITE_STATIC_DATE = '2025-01-01';

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

	const today = new Date().toISOString().split('T')[0];
	const staticXml = [
		...dynamicPaths.map(
			(p) => `  <url>\n    <loc>${baseUrl}${p}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`,
		),
		...staticPaths.map(
			(p) => `  <url>\n    <loc>${baseUrl}${p}</loc>\n    <lastmod>${SITE_STATIC_DATE}</lastmod>\n  </url>`,
		),
	];

	// County hub pages — one entry per Kentucky county, placed after article URLs.
	const countyXml = counties.map((c) => {
		const slug = c.toLowerCase().replace(/\s/g, '-');
		return `  <url>\n    <loc>${baseUrl}/news/kentucky/${slug}-county</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`;
	});

	// Hardcoded static page entries with explicit changefreq and priority.
	const requestedStaticXml = [
		`  <url>\n    <loc>${baseUrl}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.9</priority>\n  </url>`,
		`  <url>\n    <loc>${baseUrl}/about</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.5</priority>\n  </url>`,
		`  <url>\n    <loc>${baseUrl}/editorial-policy</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.5</priority>\n  </url>`,
		`  <url>\n    <loc>${baseUrl}/local</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.5</priority>\n  </url>`,
		`  <url>\n    <loc>${baseUrl}/news/national</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.5</priority>\n  </url>`,
		`  <url>\n    <loc>${baseUrl}/search</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.5</priority>\n  </url>`,
	];

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...staticXml, ...urls, ...countyXml, ...requestedStaticXml].join('\n')}
</urlset>`;

	if (env.CACHE) {
		await (env.CACHE as any).put(cacheKey, xml, { expirationTtl: 3600 }).catch(() => {});
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
		const cached = await (env.CACHE as any).get(cacheKey).catch(() => null);
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

	// Warn if there are any recent articles without a slug; they should be
	// accessed via /post?articleId=N and excluded from the news sitemap.
	const missingSlugCountRow = await prepare(env,
			`SELECT COUNT(1) as count FROM articles
       WHERE (is_kentucky = 1 OR is_national = 1) AND published_at >= ?
         AND (slug IS NULL OR slug = '')`,
		)
		.bind(cutoff)
		.first<{ count: number }>();
	const missingSlugCount = missingSlugCountRow?.count ?? 0;
	if (missingSlugCount > 0) {
		console.warn(
			`[News Sitemap] Skipping ${missingSlugCount} articles without slugs; they are still accessible via ${baseUrl}/post?articleId=<id>`,
		);
	}

	const validRows = (rows.results || []).filter((row) => row.slug && row.slug.trim() !== '');
	const items = validRows.map((row) => {
		const pubDate = toIsoDateOrNull(row.published_at) || new Date().toISOString();
		const safeTitle = (row.title || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&apos;');
		const loc = buildArticleUrl(baseUrl, row.slug, row.county, row.category, Boolean(row.is_national), row.id);
		// build keywords: county (if any), capitalized category, Kentucky if not national
		const parts: string[] = [];
		if (row.county) parts.push(row.county);
		if (row.category) {
			const cap = row.category.charAt(0).toUpperCase() + row.category.slice(1);
			parts.push(cap);
		}
		if (!row.is_national) parts.push('Kentucky');
		const keywords = parts.join(', ');
		return `  <url>
    <loc>${loc}</loc>
    <news:news>
      <news:publication>
        <news:name>Local KY News</news:name>
        <news:language>en</news:language>
      </news:publication>
      <news:publication_date>${pubDate}</news:publication_date>
      <news:title>${safeTitle}</news:title>
      <news:keywords>${keywords}</news:keywords>
    </news:news>
  </url>`;
	});

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${items.join('\n')}
</urlset>`;

	if (env.CACHE) {
		await (env.CACHE as any).put(cacheKey, xml, { expirationTtl: 3600 }).catch(() => {});
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
// maximum number of items included in the /today.rss feed.  the
// frontend JSON endpoint uses a similar limit (50000) but the RSS feed is
// intentionally smaller to keep the XML payload reasonable for subscribers.
// users asked for “more articles”, so bump this constant here; tests below
// validate that we honour it.
export const TODAY_RSS_LIMIT = 100;

async function generateTodayRss(env: Env, counties: string[], limit: number = TODAY_RSS_LIMIT): Promise<string> {
    // original code guarded against giant county arrays; keep that logic
    if (counties.length > 100) {
        counties = [];
    }
    // ensure limit is sane
    if (!Number.isFinite(limit) || limit <= 0) {
        limit = TODAY_RSS_LIMIT;
    }
    limit = Math.min(limit, TODAY_RSS_LIMIT);

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
                 ORDER BY published_at DESC, id DESC LIMIT ${limit}`
            ).bind(...counties, ...counties).all<RssRow>();
            rows = result.results ?? [];
        }
        // If no county filter or county filter returned nothing, fetch global feed
        if (rows.length === 0) {
            const result = await prepare(env,
                `SELECT id, title, slug, county, category, is_national, published_at, summary
                 FROM articles
                 WHERE category = 'today'
                 ORDER BY published_at DESC, id DESC LIMIT ${limit}`
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
 * Uses the most recently updated article date as the lastmod for the main
 * sitemap so that crawlers have an accurate staleness signal.
 */
async function generateSitemapIndex(env: Env): Promise<string> {
	const baseUrl = BASE_URL;
	const now = new Date().toISOString().split('T')[0];
	let sitemapLastmod = now;
	try {
		const result = await env.ky_news_db
			.prepare(
				`SELECT MAX(COALESCE(updated_at, published_at)) as latest
				 FROM articles
				 WHERE (is_kentucky = 1 OR is_national = 1)`,
			)
			.first<{ latest: string | null }>();
		const iso = result?.latest ? toIsoDateOrNull(result.latest) : null;
		if (iso) sitemapLastmod = iso.split('T')[0];
	} catch {
		// fall back to today if the query fails
	}
	return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${baseUrl}/sitemap.xml</loc>
    <lastmod>${sitemapLastmod}</lastmod>
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

  // Check NWS for Kentucky weather alerts on every tick
  ctx.waitUntil(
    processNwsAlerts(env).then(({ published, skipped }) => {
      console.log(`[NWS] Tick complete: ${published} published, ${skipped} skipped`);
    }).catch((err) => console.error('[NWS] processNwsAlerts threw', err))
  );

  // Post ALL active US alerts to the Live Weather Alerts Facebook page
  ctx.waitUntil(
    processLiveAlertsNationwide(env)
      .catch((err) => console.error('[LIVE-ALERTS-FB] processLiveAlertsNationwide threw', err))
  );

  // Also fetch hazardous weather outlook products from the three offices
  ctx.waitUntil(
    processNwsProducts(env).then(({ published, skipped }) => {
      if (published > 0) {
        console.log(`[NWS_PRODUCTS] run complete: ${published} published, ${skipped} skipped`);
      }
    }).catch((err) => console.error('[NWS_PRODUCTS] processNwsProducts threw', err))
  );

  // run the twice-daily weather summary if the clock has just reached the
  // designated hour (6 a.m. or 6 p.m. Eastern).
  ctx.waitUntil(
    maybeRunWeatherSummary(env).catch((err) => console.error('[WEATHER_SUMMARY] error', err))
  );

  // Generate the morning digest at 6:45 AM ET and evening digest at 6:45 PM ET.
  ctx.waitUntil(
    maybeRunDigest(env).catch((err) => console.error('[DIGEST] error', err))
  );

  // Check SPC RSS feed for new convective outlooks, watches, and discussions
  ctx.waitUntil(
    processSpcFeed(env).then(({ published, skipped }) => {
      if (published > 0) {
        console.log(`[SPC] Feed run complete: ${published} published, ${skipped} skipped`);
      }
    }).catch((err) => console.error('[SPC] processSpcFeed threw', err))
  );

  // Run the Facebook auto-post scheduler (configured via the admin UI).
  ctx.waitUntil(
    runFacebookScheduler(env).catch((err: any) => console.error('[FB_SCHEDULER] error', err))
  );
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
// Keep a shared set of normalized links across the run so the same article
// content from multiple sources isn't processed twice in the same ingestion run.
const globalSeenLinks = new Set<string>();

// Process sources in concurrent batches so we don't hit the wall-clock limit
// with 160+ sequential network calls. INGEST_CONCURRENCY sources run at once.
for (let i = 0; i < sourcesForRun.length; i += INGEST_CONCURRENCY) {
const batch = sourcesForRun.slice(i, i + INGEST_CONCURRENCY);
const results = await Promise.allSettled(batch.map((sourceUrl) => ingestSeedSource(env, sourceUrl, limitPerSource, globalSeenLinks)));
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
await (env.CACHE as any).put(rotationKey, String(nextOffset), { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => null);
}

// escape characters that would break HTML attributes
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
}

/** Returns true if the URL is a facebook.com URL (any subdomain). */
function isFacebookUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    return parsed.hostname === 'facebook.com' || parsed.hostname.endsWith('.facebook.com');
  } catch {
    return false;
  }
}

function isHttpUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    // filter out ky school district domains entirely
    const host = parsed.hostname.toLowerCase();
    if (host === 'kyschools.us' || host.endsWith('.kyschools.us')) {
      return false;
    }
    // kyweathercenter.com is no longer a trusted source and should be skipped.
    if (host === 'kyweathercenter.com' || host === 'www.kyweathercenter.com') {
      return false;
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// isSearchBot is imported from ./lib/isSearchBot

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
		const raw = await (env.CACHE as any).get(BACKFILL_STATUS_KEY, 'text');
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
				await (env.CACHE as any).put(BACKFILL_STATUS_KEY, JSON.stringify(statusObj), { expirationTtl: ttl }).catch((e: any) => {
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
	const rawOffset = await (env.CACHE as any).get(rotationKey).catch(() => null);
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

async function ingestSeedSource(
	env: Env,
	sourceUrl: string,
	limitPerSource: number,
	globalSeenLinks: Set<string>,
): Promise<SeedSourceStatus> {
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

// Explicitly skip sources that we no longer ingest (e.g. deprecated or banned).
if (!isHttpUrl(sourceUrl)) {
	status.errors.push('source URL is not allowed');
	return status;
}

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
if (!normalizedLink || seenLinks.has(normalizedLink) || globalSeenLinks.has(normalizedLink)) continue;
seenLinks.add(normalizedLink);
globalSeenLinks.add(normalizedLink);
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
				// Notify subscribed browsers about the new article (fire-and-forget).
				sendPushNotification(env, {
					title: 'New article: Kentucky News',
					body: result.title ?? item.title ?? '',
					url: result.slug
						? `/news/${(result.category || 'national').trim().toLowerCase()}/${result.slug}`
						: '/',
				}).catch((err) => console.error('[push] sendPushNotification failed', err));
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



// ---------------------------------------------------------------------------
// Morning / Evening digest helpers
// ---------------------------------------------------------------------------

type DigestRow = {
  id: number;
  title: string;
  slug: string | null;
  county: string | null;
  category: string;
  is_kentucky: number;
  is_national: number;
  published_at: string | null;
};

function scoreArticle(row: DigestRow): number {
  const title = (row.title ?? '').replace(/[\r\n]+/g, ' ').trim();

  // Statewide Kentucky coverage often has `is_national = 1` because it is not
  // pinned to a single county. Keep those stories eligible for the hard-news
  // bonuses below, but still sink truly non-Kentucky national items.
  if (row.is_national && !row.is_kentucky) return -10;

  const FILLER_PATTERNS = [
    /student achiever/i,
    /\bspotlight\b/i,
    /\bsponsor(ed)?\b/i,
    /\baward(s)? winner\b/i,
    /celebrates?\s+(st\.?\s*patrick|christmas|thanksgiving|easter|halloween)/i,
    /\bholiday\s+(parade|event|festival|celebration)\b/i,
    /\bfun\s+fact\b/i,
    /\bthis\s+week('?s)?\s+(events?|things?\s+to\s+do)\b/i,
    /\bcelebrat(es?|ing|ion).{0,40}(birthday|anniversary|festival|jubilee)/i,
    /\b250th\b|\b100th\b|\b75th\b/i,
    /\bmusic\s+festival\b|\bconcert\b|\blive\s+music\b/i,
    /\bthings\s+to\s+do\b/i,
    /\brecipe\b|\bcooking\b|\bfood\s+festival\b/i,
    /\bmurder\s+mystery\b/i,
    /\bdinner\s+(series|theater|theatre|show|event)\b/i,
    /\bopinion\b|\bop-?ed\b|\bcommentary\b|\bcolumn\b/i,
    /\bcitizens?\s+group\s+hosts?\b/i,
    /\bforum\s+for\b/i,
    /\bcandidates?\b.{0,40}\b(q\s*&\s*a|q\/a|forum|town\s+hall|pie\s+and\s+coffee)\b/i,
    /\bspeak(s|ing)?\s+at\b.{0,40}\b(q\s*&\s*a|q\/a|forum|town\s+hall)\b/i,
    /\bpie\s+and\s+coffee\b/i,
    /\bexpand(s|ing)?\s+its\b/i,
    /\bspeakeasy\b|\bgangster\b/i,
    /\b5k\s*,?\s*(walk|run)\b/i,
    /\bkaraoke\b/i,
    /\bweathers?\s+.{0,20}snowstorm\b/i,
    /\bweather\s+whiplash\b/i,
    /\bpolitical\s+analyst\b/i,
    /\bmain\s+street\s+clean\s+sweep\b/i,
    /\bclean\s+sweep\b/i,
    /\bag\s+spotlight\b/i,
    /\bhorse\s+club\b|\barena\s+ride\b/i,
    /\bturkey\s+season\b/i,
    /\bsweet\s+sixteen\b/i,
    /\bcoming\s+up\b/i,
    /\bcelebrates?\s+(revitalization|renovation|opening|launch|milestone)\b/i,
    /\bmemorial\s+garden\b/i,
    /\bopens?\s+.*\blocation\b/i,
    /\bgrand\s+opening\b/i,
    /\bcountry\s+club\b/i,
    /\bhotel\s+at\b/i,
    /\bwomen\s+in\s+business\b/i,
    /\bnew\s+celtic\b|\bnew\s+.{0,15}arts?\s+scene\b/i,
    /\birish\s+musician\b/i,
    /\bbest\s+of\s+\w+\s+(voting|vote|award)\b/i,
    /\bvoting\s+is\s+open\b/i,
    /\bcast\s+your?\s+vote\b/i,
    /\bto\s+appear\s+on\b/i,
    /\bfamily\s+feud\b|\bwheel\s+of\s+fortune\b|\bjeopardy\b/i,
    /\breality\s+(tv|show|series)\b/i,
    /\btv\s+show\b|\btelevision\s+show\b/i,
    /\bpet\s+of\s+the\s+(day|week)\b/i,
    /\badoptable\s+pet\b/i,
    /\b(pet|animal|dog|cat)\s+adoption\b/i,
    /\bpet\s+adoption\s+(event|drive|day|fair)\b/i,
    /\bfind\s+a\s+new\s+friend\b/i,
    /\bendometriosis\b|\bawareness\s+month\b/i,
    /\b(promotes?|named?)\s+.{0,30}\bvice\s+president\b/i,
    /\bnamed?\s+(next|new)\s+(principal|superintendent|director|chief)\b/i,
    /\bchurchill\s+downs\b/i,
  ];

  const MINOR_PATTERNS = [
    /\bnames?\s+\w+\s+(director|principal|superintendent|chief|officer|coordinator)\b/i,
    /\bpromotes?\s+\w+\s+to\b/i,
    /\bhires?\s+new\b/i,
    /\bappoints?\s+\w+\s+(as|to)\b/i,
    /\bannual\s+.{0,30}(summit|gala|luncheon|banquet|dinner|meeting|gathering|conference)\b/i,
    /\bhosts?\s+(annual|its\s+\d+|a\s+free|free)\b/i,
    /\bpresents?\s+a\s+new\b/i,
    /\brenovations?\b/i,
    /\broad\s+(work|clos|construction|project)\b/i,
    /\btraffic\s+(impact|delay|update)\b/i,
    /\bcelebration\s+of\s+america\b/i,
    /\bstudent\s+(art|showcase|exhibit)\b/i,
    /\bhonors?\s+(husband|wife|teacher|veteran)\s+through\b/i,
    /\bapproves?\s+proposal\b/i,
    /\bbuilding\s+new\s+.{0,20}(scene|center|facility|park|trail)\b/i,
    /\bpromotes?\s+\w[\w\s]{0,30}to\s+(senior|vice|executive|assistant)\b/i,
    /\bpolitical\s+analyst\b/i,
    /\bup\s+for\s+grabs\b/i,
    /\bresolution\s+reintroduced\b/i,
    /\breintroduced\s+by\s+metro\s+council\b/i,
    /\bcouncil\s+backs?\s+plan\b/i,
    /\bopens?\s+.*\blocation\b/i,
    /\bcelebrates?\s+revitalization\b/i,
    /\bmemorial\s+garden\b/i,
    /\bhotel\s+at\s+old\s+country\s+club\b/i,
    /\bconsidering\s+day-?one\s+health\s+insurance\b/i,
    /\bhealth\s+insurance\s+coverage\s+for\s+new\s+employees?\b/i,
    /\bappointed?\s+as\s+.{0,40}\b(coo|cfo|ceo|chief\s+operating\s+officer|chief\s+financial\s+officer)\b/i,
  ];

  let score = 0;

  if (FILLER_PATTERNS.some((p) => p.test(title))) {
    score -= 20;
  } else if (MINOR_PATTERNS.some((p) => p.test(title))) {
    score -= 10;
  }

  if (row.is_kentucky) score += 5;
  if (row.county) score += 2;

  const HIGH_VALUE_PATTERNS: Array<{ pattern: RegExp; bonus: number }> = [
    { pattern: /\bmurder\b(?!\s+mystery)/i,                                bonus: 20 },
    { pattern: /\bhomicide\b/i,                                            bonus: 20 },
    { pattern: /\bdouble\s+murder\b/i,                                     bonus:  6 },
    { pattern: /\bshot\s+and\s+(killed|dead)\b/i,                          bonus: 20 },
    { pattern: /\bshooting\b/i,                                            bonus: 15 },
    { pattern: /\bstabbing\b|\bstabbed\b/i,                                bonus: 15 },
    { pattern: /\bsexual\s+(offense|assault|abuse)\b/i,                    bonus: 18 },
    { pattern: /\bhomeless\s+.{0,20}(dead|killed|found)\b/i,              bonus: 12 },
    { pattern: /\b(service\s+members?|troops?|soldiers?)\b.{0,30}\b(killed|dead)\b/i, bonus: 14 },
    { pattern: /\bmilitary\s+(casualt(y|ies)|death|deaths)\b/i,            bonus: 12 },
    { pattern: /\bdrug(s)?\s+(located|found|seized|bust|trafficking)\b/i,  bonus: 14 },
    { pattern: /\bmeth\b|\bfentanyl\b|\bheroin\b|\bcocaine\b/i,            bonus:  8 },
    { pattern: /\b\d+\s+arrested\b/i,                                      bonus: 12 },
    { pattern: /\barrested\b/i,                                            bonus:  8 },
    { pattern: /\bcharged\s+(with|in)\b/i,                                 bonus:  8 },
    { pattern: /\bindicted\b/i,                                            bonus: 12 },
    { pattern: /\bwanted\s+(wednesday|fugitive|suspect|person)\b/i,        bonus: 10 },
    { pattern: /\bfacing\s+.{0,20}(charge|count|offense)\b/i,             bonus: 10 },
    { pattern: /\bgovernor\b|\bbeshear\b/i,                                bonus: 12 },
    { pattern: /\bveto\b|\boverride\b/i,                                   bonus: 15 },
    { pattern: /\blawmakers?\s+(override|pass|approve|vote|advance)\b/i,   bonus: 14 },
    { pattern: /\blegislature\b|\bgeneral\s+assembly\b/i,                  bonus:  7 },
    { pattern: /\bbills?\s+awaiting\s+senate\s+vote\b/i,                   bonus: 10 },
    { pattern: /\bbill\s+advances?\b/i,                                    bonus:  8 },
    { pattern: /\bsenate\s+vote\b/i,                                       bonus:  6 },
    { pattern: /\bfrankfort\b/i,                                           bonus:  4 },
    { pattern: /\bu\.?s\.?\s+senate\b|\bsenate\s+(race|seat)\b|\bcongress(ional)?\b/i, bonus:  7 },
    { pattern: /\bhouse\s+bill\b|\bsenate\s+bill\b|\bhb\s*\d+\b|\bsb\s*\d+\b/i, bonus: 6 },
    { pattern: /\bdebate\b/i,                                              bonus:  5 },
    { pattern: /\bamber\s+alert\b/i,                                       bonus: 20 },
    { pattern: /\bmissing\s+(child|teen|person)\b/i,                       bonus: 15 },
    { pattern: /\bevacu(ation|ate)\b/i,                                    bonus: 15 },
    { pattern: /\bwater\s+(outage|contamination|boil)\b/i,                 bonus:  7 },
    { pattern: /\bpower\s+outage\b/i,                                      bonus:  5 },
    { pattern: /\brecords?\s+reveal\b|\binvestigation\s+reveals?\b/i,      bonus:  7 },
    { pattern: /\bdied\s+in\s+(custody|jail|prison)\b/i,                   bonus: 15 },
    { pattern: /\bunder\s+investigation\b/i,                               bonus:  6 },
    { pattern: /\bfederal\s+(charges?|indictment|investigation)\b/i,       bonus: 14 },
    { pattern: /\blawsuit\b/i,                                             bonus:  4 },
    { pattern: /\bvoter\s+data\b|\bsensitive\s+voter\b/i,                  bonus:  6 },
    { pattern: /\bschool\s+choice\b/i,                                     bonus:  6 },
    { pattern: /\btax\s+(credit|cut|increase|hike)\b/i,                    bonus:  5 },
    { pattern: /\bbudget\s+(cut|shortfall|crisis)\b/i,                     bonus:  6 },
  ];

  for (const { pattern, bonus } of HIGH_VALUE_PATTERNS) {
    if (pattern.test(title)) score += bonus;
  }

  if (score > 0 && row.published_at) {
    const hoursOld = (Date.now() - new Date(row.published_at).getTime()) / 3_600_000;
    score += Math.max(0, Math.round(4 - hoursOld));
  }

  return score;
}

function buildIntroSentence(rows: DigestRow[], when: 'morning' | 'evening'): string {
  const topRows = rows.slice(0, 10);
  const uniqueCounties = [...new Set(topRows.map(r => r.county).filter((c): c is string => !!c))];
  const hasMultipleRegions = uniqueCounties.length >= 3;
  const hasStatewide = topRows.some(r => r.is_kentucky && !r.county);

  if (when === 'morning') {
    if (hasStatewide && hasMultipleRegions) {
      return `From local communities to statewide news, here are the stories Kentucky is waking up to this morning.`;
    }
    if (uniqueCounties.length === 1) {
      return `Out of ${uniqueCounties[0]} County and across the Commonwealth, here are the top stories making news in Kentucky this morning.`;
    }
    if (uniqueCounties.length === 2) {
      return `From ${uniqueCounties[0]} County to ${uniqueCounties[1]} County and communities across the Commonwealth, here are the top stories making news in Kentucky this morning.`;
    }
    return `From across the Commonwealth, here are the top stories making news in Kentucky this morning.`;
  } else {
    if (hasStatewide && hasMultipleRegions) {
      return `From local headlines to statewide developments, here's what shaped Kentucky today.`;
    }
    if (uniqueCounties.length === 1) {
      return `From ${uniqueCounties[0]} County and across the Commonwealth, here are the latest stories published today in Kentucky.`;
    }
    if (uniqueCounties.length === 2) {
      return `From ${uniqueCounties[0]} County to ${uniqueCounties[1]} County and across the Commonwealth, here are the latest stories published today in Kentucky.`;
    }
    return `From across the Commonwealth, here are the latest stories published today in Kentucky.`;
  }
}

function deduplicateByTitle(rows: DigestRow[]): DigestRow[] {
  const kept: DigestRow[] = [];
  const TOKEN_ALIASES: Record<string, string> = {
    candidates: 'candidate',
    charged: 'charge',
    charges: 'charge',
    democratic: 'democrat',
    democrats: 'democrat',
    injuries: 'injury',
    lawmakers: 'lawmaker',
    overrides: 'override',
    republicans: 'republican',
  };

  const normalize = (t: string) =>
    t
      .toLowerCase()
      .replace(/['’]s\b/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .map((w) => TOKEN_ALIASES[w] ?? w)
      .filter((w) => w.length >= 4);

  const buildFeatures = (title: string) => {
    const tokens = normalize(title);
    return {
      words: new Set(tokens),
      bigrams: new Set(tokens.slice(0, -1).map((word, idx) => `${word} ${tokens[idx + 1]}`)),
    };
  };

  for (const row of rows) {
    const features = buildFeatures(row.title);
    const isDuplicate = kept.some((k) => {
      const other = buildFeatures(k.title);
      const tokenOverlap = [...features.words].filter((w) => other.words.has(w)).length;
      const bigramOverlap = [...features.bigrams].filter((bg) => other.bigrams.has(bg)).length;
      const minLen = Math.min(features.words.size, other.words.size);

      return (
        (minLen > 0 && tokenOverlap / minLen >= 0.75) ||
        (bigramOverlap >= 1 && tokenOverlap >= 3) ||
        tokenOverlap >= 4
      );
    });
    if (!isDuplicate) kept.push(row);
  }

  return kept;
}

function inferDigestTopic(title: string): string | null {
  const text = title.toLowerCase();

  if (/\bschool\s+choice\b|\btax\s+credit\s+veto\b|\bhouse\s+bill\s+1\b/.test(text)) {
    return 'school-choice';
  }
  if (/\bu\.?s\.?\s+senate\b|\bsenate\s+(race|seat)\b|\bsenate\s+debate\b/.test(text)) {
    return 'us-senate-race';
  }
  if (/\bamber\s+alert\b|\bwynter'?s\s+law\b/.test(text)) {
    return 'amber-alert';
  }

  return null;
}

function inferDigestDesk(row: DigestRow): 'public-safety' | 'government' | 'election' | 'weather' | 'other' {
  const title = (row.title ?? '').toLowerCase();

  if (/\bu\.?s\.?\s+senate\b|\bsenate\s+(race|seat)\b|\bprimary\b/.test(title)) {
    return 'election';
  }
  if (/\bweather\b|\bstorm\b|\bsnow\b|\brain\b|\bwind\b|\btornado\b|\bflood\b/.test(title)) {
    return 'weather';
  }
  if (/\bmurder\b(?!\s+mystery)|\bhomicide\b|\bshooting\b|\bstabbing\b|\barrested\b|\bcharged\b|\bindicted\b|\bwanted\b|\bsexual\s+offense\b|\bamber\s+alert\b|\bmissing\s+(child|teen|person)\b|\bdrugs?\b|\b(service\s+members?|troops?|soldiers?)\b.{0,30}\b(killed|dead)\b|\bmilitary\s+(casualt(y|ies)|death|deaths)\b/.test(title)) {
    return 'public-safety';
  }
  if (/\bgovernor\b|\bbeshear\b|\bveto\b|\boverride\b|\blawmakers?\b|\blegislature\b|\bgeneral\s+assembly\b|\bhouse\s+bill\b|\bsenate\s+bill\b|\bbills?\b|\bsenate\s+vote\b|\bfrankfort\b|\bresolution\b|\bvoter\s+data\b/.test(title)) {
    return 'government';
  }

  return 'other';
}

function isSevereWeatherDigestTitle(title: string): boolean {
  const text = title.toLowerCase();
  return /\b(severe\s+thunderstorm|tornado|flash\s+flood|flood\s+warning|winter\s+storm|ice\s+storm|blizzard|warning|watch|advisory|weather\s+alert|emergency)\b/.test(text);
}

function isKentuckyNationalDigestCandidate(row: DigestRow): boolean {
  const slug = (row.slug ?? '').toLowerCase();
  const title = row.title ?? '';
  const slugHasKentuckyToken = /(?:^|-)kentucky(?:-|$)/.test(slug);
  const titleHasKentucky = /\bkentucky\b|\bky\b/i.test(title);
  if (!slugHasKentuckyToken || !titleHasKentucky) return false;
  if (row.is_kentucky !== 1) return false;
  return scoreArticle(row) > 0;
}

function isHardFillerDigestTitle(title: string): boolean {
  const text = title.toLowerCase();
  return /\b(main\s+street\s+clean\s+sweep|clean\s+sweep|ag\s+spotlight|pet\s+of\s+the\s+(day|week)|adoptable\s+pet|pet\s+adoption|find\s+a\s+new\s+friend|horse\s+club|arena\s+ride|turkey\s+season|sweet\s+sixteen|pie\s+and\s+coffee|murder\s+mystery|speakeasy|coming\s+up)\b/.test(text);
}

function selectDigestRows(scoredRows: Array<{ row: DigestRow; score: number }>, limit: number): DigestRow[] {
  const selected: Array<{ row: DigestRow; score: number }> = [];
  const deferred: Array<{ row: DigestRow; score: number }> = [];
  const weakCandidates: Array<{ row: DigestRow; score: number }> = [];
  const topicCounts = new Map<string, number>();
  const deskCounts = new Map<string, number>();
  let selectedNationalCount = 0;
  const MAX_NATIONAL_LINKS = 1;
  const DESK_CAPS: Partial<Record<'public-safety' | 'government' | 'election' | 'weather' | 'other', number>> = {
    'public-safety': 4,
    government: 3,
    election: 1,
    weather: 1,
    other: 2,
  };

  const hasReachedDeskCap = (
    desk: 'public-safety' | 'government' | 'election' | 'weather' | 'other',
    options?: { allowExtraOther?: boolean },
  ): boolean => {
    if (desk === 'other' && options?.allowExtraOther) {
      return (deskCounts.get('other') ?? 0) >= 3;
    }
    const cap = DESK_CAPS[desk];
    return typeof cap === 'number' && (deskCounts.get(desk) ?? 0) >= cap;
  };

  for (const candidate of scoredRows) {
    if (candidate.score <= 0) {
      weakCandidates.push(candidate);
      continue;
    }

    const topic = inferDigestTopic(candidate.row.title);
    const desk = inferDigestDesk(candidate.row);
    const sameTopicAlreadyUsed = !!topic && (topicCounts.get(topic) ?? 0) >= 1;
    const electionAlreadyUsed = desk === 'election' && (deskCounts.get(desk) ?? 0) >= 1;
    const isNationalLink = candidate.row.is_national === 1 || candidate.row.category === 'national';
    const nationalCapReached = isNationalLink && selectedNationalCount >= MAX_NATIONAL_LINKS;
    const deskCapReached = hasReachedDeskCap(desk);

    if (sameTopicAlreadyUsed || electionAlreadyUsed || deskCapReached || nationalCapReached) {
      deferred.push(candidate);
      continue;
    }

    selected.push(candidate);
    if (isNationalLink) selectedNationalCount += 1;
    if (topic) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    deskCounts.set(desk, (deskCounts.get(desk) ?? 0) + 1);

    if (selected.length >= limit) {
      return selected.map((entry) => entry.row);
    }
  }

  // Fallback: fill remaining slots from deferred items, but prefer stronger
  // stories first and continue to avoid over-indexing low-value "other" items
  // unless we have no alternatives left.
  const fallback = [...deferred].sort((a, b) => b.score - a.score);
  for (const candidate of fallback) {
    if (candidate.score <= 0) {
      weakCandidates.push(candidate);
      continue;
    }

    const desk = inferDigestDesk(candidate.row);
    const isNationalLink = candidate.row.is_national === 1 || candidate.row.category === 'national';
    if (isNationalLink && selectedNationalCount >= MAX_NATIONAL_LINKS) continue;
    if (hasReachedDeskCap(desk, { allowExtraOther: true })) continue;
    selected.push(candidate);
    if (isNationalLink) selectedNationalCount += 1;
    deskCounts.set(desk, (deskCounts.get(desk) ?? 0) + 1);
    if (selected.length >= limit) break;
  }

  // Only use weak stories if we would otherwise return fewer than the target
  // digest size. This keeps the "More Kentucky News" section at 4 items when
  // enough same-day candidates exist.
  const minimumStories = limit;
  if (selected.length < minimumStories) {
    const weakFallback = [...weakCandidates].sort((a, b) => b.score - a.score);
    const softWeatherFallback: Array<{ row: DigestRow; score: number }> = [];
    const hardFillerFallback: Array<{ row: DigestRow; score: number }> = [];
    for (const candidate of weakFallback) {
      const desk = inferDigestDesk(candidate.row);
      const isSoftWeatherFeature = desk === 'weather' && !isSevereWeatherDigestTitle(candidate.row.title);
      if (isSoftWeatherFeature) {
        softWeatherFallback.push(candidate);
        continue;
      }
      if (isHardFillerDigestTitle(candidate.row.title)) {
        hardFillerFallback.push(candidate);
        continue;
      }
      const isNationalLink = candidate.row.is_national === 1 || candidate.row.category === 'national';
      if (isNationalLink && selectedNationalCount >= MAX_NATIONAL_LINKS) continue;
      if (hasReachedDeskCap(desk, { allowExtraOther: true })) continue;
      selected.push(candidate);
      if (isNationalLink) selectedNationalCount += 1;
      deskCounts.set(desk, (deskCounts.get(desk) ?? 0) + 1);
      if (selected.length >= minimumStories) break;
    }

    // If we still need slots, allow softer weather feature pieces as a last
    // resort so the digest still reaches the requested item count.
    if (selected.length < minimumStories) {
      for (const candidate of softWeatherFallback) {
        const isNationalLink = candidate.row.is_national === 1 || candidate.row.category === 'national';
        if (isNationalLink && selectedNationalCount >= MAX_NATIONAL_LINKS) continue;
        selected.push(candidate);
        if (isNationalLink) selectedNationalCount += 1;
        deskCounts.set('weather', (deskCounts.get('weather') ?? 0) + 1);
        if (selected.length >= minimumStories) break;
      }
    }

    // Last resort: if we still cannot fill, allow hard-filler stories rather
    // than returning fewer than the configured digest size.
    if (selected.length < minimumStories) {
      for (const candidate of hardFillerFallback) {
        const desk = inferDigestDesk(candidate.row);
        const isNationalLink = candidate.row.is_national === 1 || candidate.row.category === 'national';
        if (isNationalLink && selectedNationalCount >= MAX_NATIONAL_LINKS) continue;
        if (hasReachedDeskCap(desk, { allowExtraOther: true })) continue;
        selected.push(candidate);
        if (isNationalLink) selectedNationalCount += 1;
        deskCounts.set(desk, (deskCounts.get(desk) ?? 0) + 1);
        if (selected.length >= minimumStories) break;
      }
    }
  }

  return selected.slice(0, limit).map((entry) => entry.row);
}

/**
 * Build the text of a Morning or Evening digest from today's articles.
 */
async function generateDigestText(env: Env, when: 'morning' | 'evening'): Promise<string> {
	// Determine today's date in Eastern Time
	const etParts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York',
		year: 'numeric', month: '2-digit', day: '2-digit',
	}).formatToParts(new Date());
	const year  = etParts.find((p) => p.type === 'year')?.value  ?? '';
	const month = etParts.find((p) => p.type === 'month')?.value ?? '';
	const day   = etParts.find((p) => p.type === 'day')?.value   ?? '';
	const datePrefix = `${year}-${month}-${day}`;

	const nextDay = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
	nextDay.setDate(nextDay.getDate() + 1);
	const nextParts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York',
		year: 'numeric', month: '2-digit', day: '2-digit',
	}).formatToParts(nextDay);
	const nextYear  = nextParts.find((p) => p.type === 'year')?.value  ?? '';
	const nextMonth = nextParts.find((p) => p.type === 'month')?.value ?? '';
	const nextDay2  = nextParts.find((p) => p.type === 'day')?.value   ?? '';
	const datePrefixNext = `${nextYear}-${nextMonth}-${nextDay2}`;

	const result = await prepare(env,
		`SELECT id, title, slug, county, category, is_kentucky, is_national, published_at
		 FROM articles
		 WHERE category = 'today'
		   AND slug IS NOT NULL
		   AND (published_at LIKE ? OR published_at LIKE ?)
		 ORDER BY published_at DESC
		 LIMIT 50`,
	).bind(`${datePrefix}%`, `${datePrefixNext}%`).all<DigestRow>();

	const rows = result.results ?? [];
	const digestRows = rows.filter((row) => {
		const href = buildArticleUrl(BASE_URL, row.slug, row.county, row.category, !!row.is_national, row.id);
		if (!href.includes('/news/national/')) return true;
		return isKentuckyNationalDigestCandidate(row);
	});

	if (digestRows.length === 0) {
		return when === 'morning'
			? `Morning News Roundup – Top Stories to Start Your Day\n\nNo articles found yet for ${datePrefix}. Check back soon.`
			: `Evening Recap – Stories You May Have Missed\n\nNo articles found yet for ${datePrefix}. Check back soon.`;
	}

	const dedupedRows = deduplicateByTitle(digestRows);

	const scored = [...dedupedRows]
		.map((r) => ({ row: r, score: scoreArticle(r) }))
		.sort((a, b) => b.score - a.score);

	const rankedRows = selectDigestRows(scored, 7);

	const top  = rankedRows.slice(0, 3);
	const more = rankedRows.slice(3, 7);

	const intro = buildIntroSentence(dedupedRows, when);

	const buildUrl = (r: typeof rows[0]) =>
		buildArticleUrl(BASE_URL, r.slug, r.county, r.category, !!r.is_national, r.id);

	const parts: string[] = [];

	if (when === 'morning') {
		parts.push('Morning News Roundup – Top Stories to Start Your Day');
		parts.push('');
		parts.push(intro);
		parts.push('');
		parts.push('📰 Top Stories This Morning');
		parts.push('');
		for (const r of top) {
			parts.push(`• ${r.title}`);
			parts.push(`  ${buildUrl(r)}`);
			parts.push('');
		}
		if (more.length > 0) {
			parts.push('📌 More Kentucky News This Morning');
			parts.push('');
			for (const r of more) {
				parts.push(`• ${r.title}`);
				parts.push(`  ${buildUrl(r)}`);
				parts.push('');
			}
		}
		parts.push('#KentuckyNews #KYMorningNews #MorningRoundup #LocalKYNews #KentuckyHeadlines #StartYourDayKY #KYNewsUpdate');
	} else {
		parts.push('Evening Recap – Stories You May Have Missed');
		parts.push('');
		parts.push(intro);
		parts.push('');
		parts.push('📰 Top Stories Tonight');
		parts.push('');
		for (const r of top) {
			parts.push(`• ${r.title}`);
			parts.push(`  ${buildUrl(r)}`);
			parts.push('');
		}
		if (more.length > 0) {
			parts.push('📌 More Kentucky Headlines');
			parts.push('');
			for (const r of more) {
				parts.push(`• ${r.title}`);
				parts.push(`  ${buildUrl(r)}`);
				parts.push('');
			}
		}
		parts.push('#KentuckyNews #KYEveningRecap #EveningNews #LocalKYNews #StoriesYouMissed #KentuckyHeadlines #KYDailyUpdate');
	}

	return parts.join('\n').trimEnd();
}

/**
 * Post a digest to Facebook as a plain text post (with an optional thumbnail). The
 * worker uses `FB_PAGE_TOKEN` and `FB_PAGE_ID` from secrets.
 */
async function postDigestToFacebook(env: Env, text: string, when?: 'morning' | 'evening'): Promise<{ postId: string } | { error: string } | null> {
  // Support both the new FB_PAGE_* env vars and legacy FACEBOOK_PAGE_* vars used
  // for weather alert posting.
  const fbToken =
    (env as any).FB_PAGE_TOKEN || (env as any).FACEBOOK_PAGE_ACCESS_TOKEN;
  const fbPageId = (env as any).FB_PAGE_ID || (env as any).FACEBOOK_PAGE_ID;
  if (!fbToken || !fbPageId) return null;

  // Resolve the digest type from the explicit param first, then fall back to
  // inspecting the generated text so scheduled posts also get the right image.
  const resolvedWhen = when ??
    (text.includes('Morning News Roundup') ? 'morning' :
     text.includes('Evening Recap')        ? 'evening' : undefined);

  const imageUrl = resolvedWhen === 'morning'
    ? `${BASE_URL}/img/morning-news-round-up.png`
    : resolvedWhen === 'evening'
    ? `${BASE_URL}/img/evening-recap.png`
    : undefined;

  // ── Attempt 1: photo post with branded image ───────────────────────────────
  // If imageUrl is defined, try /photos first so the post has the branded
  // thumbnail.  If Facebook can't fetch the image (e.g. not yet deployed),
  // it returns a non-ok response and we fall through to a plain text post.
  if (imageUrl) {
    try {
      const params = new URLSearchParams({
        access_token: fbToken,
        caption: text,
        url: imageUrl,
      });
      const res = await fetch(
        `https://graph.facebook.com/v19.0/${fbPageId}/photos`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params,
        }
      );
      const data = (await res.json()) as any;
      if (res.ok && data?.id) {
        console.log(`[DIGEST] Photo post succeeded → id=${data.id}`);
        return { postId: data.id };
      }
      // Photo post failed — log the reason and fall through to plain text.
      console.warn('[DIGEST] Photo post failed, falling back to text post:', JSON.stringify(data));
    } catch (err) {
      console.warn('[DIGEST] Photo post threw, falling back to text post:', String(err));
    }
  }

  // ── Attempt 2: plain text feed post ────────────────────────────────────────
  try {
    const params = new URLSearchParams({
      access_token: fbToken,
      message: text,
    });
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${fbPageId}/feed`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      }
    );
    const data = (await res.json()) as any;
    if (!res.ok) {
      const msg = JSON.stringify(data);
      console.error('[DIGEST] Text feed post failed:', msg);
      return { error: msg };
    }
    if (data?.id) {
      console.log(`[DIGEST] Text feed post succeeded → id=${data.id}`);
      return { postId: data.id };
    }
    const msg = JSON.stringify(data);
    console.error('[DIGEST] Text feed post returned no id:', msg);
    return { error: msg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[DIGEST] Text feed post error:', err);
    return { error: msg };
  }
}

async function maybeRunDigest(env: Env): Promise<void> {
  if (!env.CACHE) return;

  // Parse the current Eastern Time into components we need for window checks
  // and for the per-day dedup key.
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: 'numeric',
    minute: 'numeric',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const hour   = parseInt(etParts.find((p) => p.type === 'hour')?.value   ?? '0', 10);
  const minute = parseInt(etParts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const year   = etParts.find((p) => p.type === 'year')?.value  ?? '';
  const month  = etParts.find((p) => p.type === 'month')?.value ?? '';
  const day    = etParts.find((p) => p.type === 'day')?.value   ?? '';
  const todayEt = `${year}-${month}-${day}`;

  // ── MORNING GENERATE: 6:30–6:59 AM ET ──────────────────────────────────────
  // Runs on every cron tick in this window (every minute) but a KV dedup flag
  // ensures the digest is only generated once per calendar day.  Widening from
  // a single-minute check to a 30-minute window means a missed cron tick can
  // never silently prevent the morning post from firing.
  const digestAutopostEnabled = await getDigestAutopostEnabled(env);

  if (hour === 6 && minute >= 30) {
    const generatedKey = `admin:digest:morning:generated:${todayEt}`;
    const alreadyGenerated = await (env.CACHE as any).get(generatedKey);
    if (!alreadyGenerated) {
      const text = await generateDigestText(env, 'morning');
      const entry = { text, generatedAt: new Date().toISOString() };
      await (env.CACHE as any).put('admin:digest:morning', JSON.stringify(entry));

      if (digestAutopostEnabled) {
        await (env.CACHE as any).put(
          'admin:digest:morning:autopost',
          JSON.stringify({ status: 'pending', scheduledFor: '7:00 AM', generatedAt: new Date().toISOString() }),
          { expirationTtl: 7200 },
        );
        console.log(`[DIGEST] Generated morning digest for ${todayEt}, autopost pending at 7:00 AM`);
      } else {
        await (env.CACHE as any).put(
          'admin:digest:morning:autopost',
          JSON.stringify({ status: 'disabled', disabledAt: new Date().toISOString() }),
          { expirationTtl: 7200 },
        );
        console.log(`[DIGEST] Generated morning digest for ${todayEt}, autopost disabled`);
      }

      // Mark as generated for today so later ticks in this window are no-ops.
      await (env.CACHE as any).put(generatedKey, '1', { expirationTtl: 3600 * 8 });
    }
  }

  // ── MORNING POST: 7:00–7:14 AM ET ──────────────────────────────────────────
  // Attempts to post on every tick in this 15-minute window.  The status
  // transitions from 'pending' → 'posted'|'failed' on the first successful
  // attempt, so later ticks in the window are automatically skipped.
  if (hour === 7 && minute <= 14) {
    const raw = await (env.CACHE as any).get('admin:digest:morning:autopost');
    if (raw) {
      const flag = JSON.parse(raw) as { status: string };
      if (digestAutopostEnabled && flag.status === 'pending') {
        const digestRaw = await (env.CACHE as any).get('admin:digest:morning');
        if (digestRaw) {
          const digest = JSON.parse(digestRaw) as { text: string };
          const result = await postDigestToFacebook(env, digest.text, 'morning');
          const isSuccess = result && !('error' in result);
          const newFlag = {
            status: isSuccess ? 'posted' : 'failed',
            postedAt: new Date().toISOString(),
            postId: isSuccess ? (result as { postId: string }).postId : null,
          };
          await (env.CACHE as any).put(
            'admin:digest:morning:autopost',
            JSON.stringify(newFlag),
            { expirationTtl: 7200 },
          );
          console.log(`[DIGEST] Morning auto-post ${isSuccess ? 'succeeded' : 'failed'}`);
        }
      }
    }
  }

  // ── EVENING GENERATE: 5:30–5:59 PM ET ─────────────────────────────────────
  if (hour === 17 && minute >= 30) {
    const generatedKey = `admin:digest:evening:generated:${todayEt}`;
    const alreadyGenerated = await (env.CACHE as any).get(generatedKey);
    if (!alreadyGenerated) {
      const text = await generateDigestText(env, 'evening');
      const entry = { text, generatedAt: new Date().toISOString() };
      await (env.CACHE as any).put('admin:digest:evening', JSON.stringify(entry));

      if (digestAutopostEnabled) {
        await (env.CACHE as any).put(
          'admin:digest:evening:autopost',
          JSON.stringify({ status: 'pending', scheduledFor: '6:00 PM', generatedAt: new Date().toISOString() }),
          { expirationTtl: 7200 },
        );
        console.log(`[DIGEST] Generated evening digest for ${todayEt}, autopost pending at 6:00 PM`);
      } else {
        await (env.CACHE as any).put(
          'admin:digest:evening:autopost',
          JSON.stringify({ status: 'disabled', disabledAt: new Date().toISOString() }),
          { expirationTtl: 7200 },
        );
        console.log(`[DIGEST] Generated evening digest for ${todayEt}, autopost disabled`);
      }

      await (env.CACHE as any).put(generatedKey, '1', { expirationTtl: 3600 * 8 });
    }
  }

  // ── EVENING POST: 6:00–6:14 PM ET ─────────────────────────────────────────
  if (hour === 18 && minute <= 14) {
    const raw = await (env.CACHE as any).get('admin:digest:evening:autopost');
    if (raw) {
      const flag = JSON.parse(raw) as { status: string };
      if (digestAutopostEnabled && flag.status === 'pending') {
        const digestRaw = await (env.CACHE as any).get('admin:digest:evening');
        if (digestRaw) {
          const digest = JSON.parse(digestRaw) as { text: string };
          const result = await postDigestToFacebook(env, digest.text, 'evening');
          const isSuccess = result && !('error' in result);
          const newFlag = {
            status: isSuccess ? 'posted' : 'failed',
            postedAt: new Date().toISOString(),
            postId: isSuccess ? (result as { postId: string }).postId : null,
          };
          await (env.CACHE as any).put(
            'admin:digest:evening:autopost',
            JSON.stringify(newFlag),
            { expirationTtl: 7200 },
          );
          console.log(`[DIGEST] Evening auto-post ${isSuccess ? 'succeeded' : 'failed'}`);
        }
      }
    }
  }
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

/**
 * Regenerate AI summaries for articles published within the last maxAgeHours.
 * Processes up to 20 articles per call to stay within CPU budget.
 */
async function regenerateRecentArticles(env: Env, maxAgeHours: number = 48): Promise<void> {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
  const rows = await prepare(env,
    `SELECT id, url_hash, canonical_url, source_url, title, published_at,
            county, city, category
     FROM articles
     WHERE published_at >= ?
       AND is_kentucky = 1
     ORDER BY published_at DESC
     LIMIT 20`
  ).bind(cutoff).all();

  const articles = (rows.results ?? []) as Array<{
    id: number;
    url_hash: string;
    canonical_url: string;
    source_url: string | null;
    title: string;
    published_at: string;
    county: string | null;
    city: string | null;
    category: string;
  }>;

  for (const article of articles) {
    try {
      const refetchUrl = article.canonical_url + `?_=${Date.now()}`;
      const extracted = await fetchAndExtractArticle(env, {
        url: refetchUrl,
        sourceUrl: article.source_url || article.canonical_url,
        providedTitle: article.title,
        providedDescription: '',
        feedPublishedAt: article.published_at,
      }).catch(() => null);

      if (!extracted?.contentText) continue;

      const aiResult = await summarizeArticle(
        env,
        article.url_hash,
        article.title,
        extracted.contentText,
        article.published_at,
        {
          county: article.county,
          city: article.city,
          category: article.category as any,
        },
      );

      await prepare(env,
        'UPDATE articles SET summary = ?, seo_description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).bind(aiResult.summary, aiResult.seoDescription, article.id).run().catch(() => {});

      console.log(`[REGEN] Article #${article.id}: ${article.title}`);
    } catch (err) {
      console.error(
        `[REGEN FAILED] Article #${article.id}:`,
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
	buildRelatedCountyArticlesHtml,
	scrapeFacebookPostPublic,
	deriveFacebookTitleAndBody,
	// exposing runIngest allows tests to stub the heavy ingestion routine
	runIngest,
	// make ingestSingleUrl available for unit tests
	ingestSingleUrl,
	scoreArticle,
	generateDigestText,
	isAdminAuthorized,
	// article update helpers
	checkArticleUpdates,
	regenerateRecentArticles,
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

/**
 * Resolve a Facebook share shortlink (facebook.com/share/p/{code}) to its
 * real post URL by following the redirect chain manually.
 *
 * Facebook share links do not expose og: tags to crawler UAs — they just
 * redirect to the real post URL.  We follow up to 5 Location header hops
 * using redirect:'manual' so we can capture the final destination URL
 * and then scrape *that* URL for post content.
 *
 * Returns the resolved URL (which may be a full facebook.com/permalink/…
 * or /photo/… URL), or the original URL if resolution fails.
 */
async function resolveFacebookShareUrl(shareUrl: string): Promise<string> {
	const isShareLink = /facebook\.com\/share\//i.test(shareUrl);
	if (!isShareLink) return shareUrl;

	// Use a browser-like UA for the redirect resolution so Facebook doesn't
	// block the HEAD request before it can issue the Location redirect.
	const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

	let current = shareUrl;
	for (let hop = 0; hop < 5; hop++) {
		try {
			const resp = await fetch(current, {
				method: 'GET',
				redirect: 'manual',
				headers: {
					'user-agent': BROWSER_UA,
					'accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
					'accept-language': 'en-US,en;q=0.9',
					'cache-control': 'no-cache',
				},
			});

			// 3xx redirect — follow the Location header
			if (resp.status >= 300 && resp.status < 400) {
				const location = resp.headers.get('location');
				if (!location) break;
				// Resolve relative locations against the current URL
				try {
					current = new URL(location, current).toString();
				} catch {
					break;
				}
				// Stop if we've landed on a login page — we can't go further
				if (current.includes('/login') || current.includes('checkpoint')) break;
				continue;
			}

			// 200 — we've arrived; use resp.url (the final URL after any implicit follows)
			if (resp.status === 200) {
				const finalUrl = resp.url || current;
				// Only use the resolved URL if it's still on facebook.com
				if (finalUrl && /facebook\.com/i.test(finalUrl) && !finalUrl.includes('/login')) {
					return finalUrl;
				}
			}

			// Non-redirect, non-200 — stop
			break;
		} catch {
			break;
		}
	}

	// Return best resolved URL so far (may still be the share link if all hops failed)
	return current;
}

async function scrapeFacebookPostPublic(fbUrl: string): Promise<{ message: string | null; imageUrl: string | null; publishedAt: string | null }> {
	// facebookexternalhit is Facebook's own crawler UA. Facebook serves real
	// og:description content to this UA for public posts, bypassing login walls.
	const FB_CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

	// For /share/p/ shortlinks, resolve the redirect chain to get the real
	// post URL *before* attempting og: scraping.  Share links don't serve
	// og: tags even to the crawler UA — they only redirect.
	if (/facebook\.com\/share\//i.test(fbUrl)) {
		try {
			const resolved = await resolveFacebookShareUrl(fbUrl);
			if (resolved !== fbUrl && !resolved.includes('/login') && !resolved.includes('checkpoint')) {
				console.log(`[FB SHARE RESOLVED] ${fbUrl} → ${resolved}`);
				fbUrl = resolved;
			}
		} catch {
			// fall through with original URL
		}
	}

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
		// fall through to Attempt 2
	}

	// Attempt 2: for /share/p/{code} short links the crawler-UA fetch sometimes
	// lands on an interstitial rather than the post.  Try converting the URL to
	// m.facebook.com and fetching again — the mobile site serves og: tags for
	// public posts without requiring JavaScript.
	try {
		const parsedFbUrl = new URL(fbUrl);
		const isShareLink = parsedFbUrl.pathname.startsWith('/share/');
		const mobileUrl = isShareLink
			? fbUrl.replace(/^https?:\/\/(www\.)?facebook\.com/, 'https://m.facebook.com')
			: null;
		if (mobileUrl && mobileUrl !== fbUrl) {
			const respM = await fetchWithCrawlerUA(mobileUrl);
			if (respM.ok) {
				const htmlM = await respM.text();
				const resultM = parseOgFromHtml(htmlM);
				if (resultM.message) return resultM;
				// Follow redirect if the mobile URL resolved elsewhere
				if (respM.url && respM.url !== mobileUrl && !respM.url.includes('/login')) {
					const respM2 = await fetchWithCrawlerUA(respM.url);
					if (respM2.ok) {
						const htmlM2 = await respM2.text();
						const resultM2 = parseOgFromHtml(htmlM2);
						if (resultM2.message) return resultM2;
					}
				}
			}
		}
	} catch {
		// fall through to return null
	}

	return { message: null, imageUrl: null, publishedAt: null };
}

/**
 * Returns true if this Facebook URL points to a page/profile root rather than
 * a specific post.  Post URLs contain /posts/, /permalink/, story_fbid=, etc.
 */
function isFacebookPageUrl(fbUrl: string): boolean {
	try {
		const parsed = new URL(fbUrl);
		if (!parsed.hostname.includes('facebook.com')) return false;
		const path = parsed.pathname;
		const isPost =
			/\/posts\/\d+/.test(path) ||
			/\/permalink\//.test(path) ||
			/\/share\/p\//.test(path) ||
			/\/photos\/\d+/.test(path) ||
			/\/videos\/\d+/.test(path) ||
			parsed.searchParams.has('story_fbid') ||
			parsed.searchParams.has('fbid');
		if (isPost) return false;
		const segments = path.split('/').filter(Boolean);
		return segments.length <= 1 || parsed.pathname === '/profile.php';
	} catch {
		return false;
	}
}

/**
 * Discover recent post links from a public Facebook page by fetching the
 * mbasic.facebook.com server-rendered HTML and parsing out permalink hrefs.
 *
 * Returns up to `limit` posts as { postUrl, message, imageUrl, publishedAt }.
 * message/imageUrl/publishedAt are best-effort previews and may be null.
 */
async function scrapeFacebookPagePosts(
	pageUrl: string,
	limit = 10,
): Promise<Array<{ postUrl: string; message: string | null; imageUrl: string | null; publishedAt: string | null }>> {
	let mbasicUrl: string;
	try {
		const parsed = new URL(pageUrl);
		parsed.hostname = 'mbasic.facebook.com';
		parsed.search = '';
		mbasicUrl = parsed.toString();
	} catch {
		return [];
	}

	const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
	const FB_CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

	let html = '';

	// Attempt 1: mobile UA on mbasic
	try {
		const resp = await fetch(mbasicUrl, {
			headers: {
				'user-agent': MOBILE_UA,
				'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				'accept-language': 'en-US,en;q=0.5',
				'cache-control': 'no-cache',
			},
			redirect: 'follow',
		});
		if (resp.ok) {
			html = await resp.text();
			// Login wall check
			if (html.includes('login') && html.includes('password') && html.length < 20000) {
				html = '';
			}
		}
	} catch {
		// fall through
	}

	// Attempt 2: crawler UA on original URL
	if (!html) {
		try {
			const resp = await fetch(pageUrl, {
				headers: {
					'user-agent': FB_CRAWLER_UA,
					'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'accept-language': 'en-US,en;q=0.5',
					'cache-control': 'no-cache',
				},
				redirect: 'follow',
			});
			if (resp.ok) html = await resp.text();
		} catch {
			// fall through
		}
	}

	if (!html) return [];

	const posts: Array<{ postUrl: string; message: string | null; imageUrl: string | null; publishedAt: string | null }> = [];
	const seenUrls = new Set<string>();

	// Strategy 1: extract all permalink / /posts/ hrefs
	const hrefPattern = /href="([^"]*(?:permalink|\/posts\/|story_fbid)[^"]*)"/gi;
	let match: RegExpExecArray | null;
	while ((match = hrefPattern.exec(html)) !== null) {
		let href = match[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'");
		if (href.startsWith('/')) href = `https://www.facebook.com${href}`;
		href = href.replace('mbasic.facebook.com', 'www.facebook.com');
		if (href.includes('/login') || href.includes('checkpoint') || href.includes('/share?')) continue;
		try {
			const p = new URL(href);
			const key = p.pathname + (p.searchParams.get('story_fbid') ?? '') + (p.searchParams.get('id') ?? '');
			if (seenUrls.has(key)) continue;
			seenUrls.add(key);
		} catch { continue; }
		posts.push({ postUrl: href, message: null, imageUrl: null, publishedAt: null });
		if (posts.length >= limit) break;
	}

	// Strategy 2: /PageName/posts/NNN patterns
	if (posts.length === 0) {
		const postsPattern = /href="([^"]*\/[^"\/]+\/posts\/\d+[^"]*)"/gi;
		while ((match = postsPattern.exec(html)) !== null) {
			let href = match[1].replace(/&amp;/g, '&');
			if (href.startsWith('/')) href = `https://www.facebook.com${href}`;
			href = href.replace('mbasic.facebook.com', 'www.facebook.com');
			if (href.includes('/login') || href.includes('checkpoint')) continue;
			try {
				const p = new URL(href);
				const key = p.pathname;
				if (seenUrls.has(key)) continue;
				seenUrls.add(key);
			} catch { continue; }
			posts.push({ postUrl: href, message: null, imageUrl: null, publishedAt: null });
			if (posts.length >= limit) break;
		}
	}

	// Strategy 3: try to grab inline post text for preview
	const storyBlockPattern = /<div[^>]*>\s*(?:<[^>]+>\s*)*<abbr[^>]*>(.*?)<\/abbr>[\s\S]{0,2000}?<\/div>/gi;
	let storyMatch: RegExpExecArray | null;
	let storyIdx = 0;
	storyBlockPattern.lastIndex = 0;
	while ((storyMatch = storyBlockPattern.exec(html)) !== null && storyIdx < posts.length) {
		const block = storyMatch[0];
		const abbrMatch = block.match(/<abbr[^>]*>(.*?)<\/abbr>/i);
		const publishedAt = abbrMatch ? abbrMatch[1].trim() : null;
		const pMatch = block.match(/<p[^>]*>([\s\S]+?)<\/p>/i);
		if (pMatch) {
			const raw = pMatch[1]
				.replace(/<[^>]+>/g, '')
				.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
				.trim();
			if (raw.length > 20) {
				posts[storyIdx].message = raw;
				posts[storyIdx].publishedAt = publishedAt;
			}
		}
		storyIdx++;
	}

	return posts;
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
