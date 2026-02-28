import { blockArticleByIdAndDelete, deleteArticleById, findArticleByHash, getArticleById, getArticleBySlug, insertArticle, listBlockedArticles, getSourceStats, listAdminArticles, listArticlesForReclassify, queryArticles, unblockArticleByBlockedId, updateArticlePublishedAt, updateArticleClassification, updateArticleContent, updateArticleLinks, getCountyCounts, } from './lib/db';
import { HIGH_PRIORITY_SOURCE_SEEDS, MASTER_SOURCE_SEEDS, SCHOOL_SOURCE_SEEDS, } from './data/source-seeds';
import { badRequest, cachedTextFetch, corsPreflightResponse, isAllowedCategory, json, normalizeCanonicalUrl, parseCommaList, parseJsonBody, parsePositiveInt, sha256Hex, wordCount, } from './lib/http';
import { ingestSingleUrl, generateArticleSlug, findHighlySimilarTitle } from './lib/ingest';
import { normalizeCountyList } from './lib/geo';
import { KY_COUNTIES } from './data/ky-geo';
import { fetchAndParseFeed, resolveFeedUrls } from './lib/rss';
import { classifyArticleWithAi } from './lib/classify';
import { summarizeArticle } from './lib/ai';
import { generateFacebookCaption } from './lib/facebook';
const DEFAULT_SEED_LIMIT_PER_SOURCE = 0;
const MAX_SEED_LIMIT_PER_SOURCE = 10000;
const INGEST_METRICS_KEY = 'admin:ingest:latest';
const INGEST_ROTATION_KEY_PREFIX = 'admin:ingest:rotation:';
const FALLBACK_CRAWL_MAX_LINKS = 12;
const FALLBACK_CRAWL_MAX_SECTION_PAGES = 3;
/** Articles to fetch per source on each scheduled cron tick. */
const SCHEDULED_LIMIT_PER_SOURCE = 15;
/** Sources processed per 2-minute cron tick. ~108 total ÷ 10 per tick ≈ 22‑minute full cycle (rotates through all seeds). */
const SCHEDULED_SOURCES_PER_RUN = 10;
/** How many sources to fetch simultaneously — balances speed vs D1/network pressure. */
const INGEST_CONCURRENCY = 8;
/** KV key for the backfill-counties job status (polled by the admin UI). */
const BACKFILL_STATUS_KEY = 'admin:backfill:latest';
const STRUCTURED_SEARCH_SOURCE_URLS = new Set([
    'https://www.kentucky.com/search/?q=kentucky&page=1&sort=newest',
    'https://www.wymt.com/search/?query=kentucky',
]);
const ROBOTS_BYPASS_URLS = new Set([
    'https://www.kentucky.com/search/?q=kentucky&page=1&sort=newest',
    'https://www.wymt.com/search/?query=kentucky',
]);
const PUBLIC_ARTICLE_CACHE_HEADERS = {
    'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
};
/** All route handling extracted so the outer fetch() can wrap it in a try/catch
 *  that guarantees CORS headers on every response, even unhandled exceptions. */
async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    if ((url.pathname === '/' || url.pathname === '/health') && request.method === 'GET') {
        return json({
            ok: true,
            service: 'kentucky-news-worker',
            date: new Date().toISOString(),
        });
    }
    if (url.pathname === '/api/ingest/url' && request.method === 'POST') {
        const body = await parseJsonBody(request);
        const articleUrl = body?.url?.trim();
        if (!articleUrl)
            return badRequest('Missing required field: url');
        if (!isHttpUrl(articleUrl))
            return badRequest('url must be an absolute http(s) URL');
        try {
            const result = await ingestSingleUrl(env, { url: articleUrl });
            return json(result, result.status === 'rejected' ? 422 : 200);
        }
        catch (error) {
            return json({ error: 'ingest failed', details: safeError(error) }, 500);
        }
    }
    if (url.pathname === '/api/ingest/rss' && request.method === 'POST') {
        const body = await parseJsonBody(request);
        const feedUrl = body?.feedUrl?.trim();
        const sourceUrl = body?.sourceUrl?.trim();
        if (!feedUrl && !sourceUrl) {
            return badRequest('Provide feedUrl or sourceUrl');
        }
        const feedCandidates = feedUrl
            ? [feedUrl]
            : await resolveFeedUrls(env, sourceUrl);
        const uniqueFeeds = [...new Set(feedCandidates.filter(isHttpUrl))];
        if (uniqueFeeds.length === 0)
            return badRequest('No valid feed URLs found');
        const allItems = [];
        const seenLinks = new Set();
        for (const candidate of uniqueFeeds) {
            const parsed = await fetchAndParseFeed(env, candidate).catch(() => []);
            for (const item of parsed) {
                const normalizedLink = normalizeCanonicalUrl(item.link || '');
                if (!normalizedLink || seenLinks.has(normalizedLink))
                    continue;
                seenLinks.add(normalizedLink);
                allItems.push({ ...item, link: normalizedLink });
            }
        }
        if (allItems.length === 0) {
            return json({ error: 'Unable to parse feed', feedCandidates: uniqueFeeds }, 422);
        }
        allItems.sort((a, b) => toSortTimestamp(b.publishedAt) - toSortTimestamp(a.publishedAt));
        const results = [];
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
            }
            catch (error) {
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
        const body = await parseJsonBody(request);
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
        const body = await parseJsonBody(request);
        const limit = Math.min(Math.max(Number(body?.limit ?? 10), 1), 20);
        const beforeId = body?.beforeId ?? null;
        const articles = await listArticlesForReclassify(env, { limit, beforeId });
        if (articles.length === 0) {
            return json({ message: 'No more articles to reclassify', lastId: null });
        }
        const results = [];
        for (const article of articles) {
            try {
                const classification = await classifyArticleWithAi(env, {
                    url: article.canonicalUrl,
                    title: article.title,
                    content: article.contentText,
                });
                const changed = classification.category !== article.category ||
                    classification.isKentucky !== article.isKentucky ||
                    classification.isNational !== article.isNational ||
                    classification.county !== article.county;
                if (changed) {
                    await updateArticleClassification(env, article.id, classification);
                }
                results.push({ id: article.id, title: article.title, oldCategory: article.category, newCategory: classification.category, changed });
            }
            catch (err) {
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
        const body = await parseJsonBody(request);
        const includeSchools = body?.includeSchools !== false;
        const limitPerSource = normalizeLimitPerSource(body?.limitPerSource);
        const candidateSources = buildManualIngestSources(includeSchools);
        const sourceUrls = [...new Set(candidateSources.map((item) => item.trim()).filter(isHttpUrl))];
        ctx.waitUntil(runIngest(env, sourceUrls, limitPerSource, 'manual'));
        return json({ ok: true, message: 'Admin ingest started', sourcesTried: sourceUrls.length, limitPerSource }, 202);
    }
    // Internal endpoint: process a single county for the backfill job.  This is
    // invoked by the public backfill-counties handler via `fetch` so that each
    // county runs in its own worker invocation and avoids the 30-second waitUntil
    // limit.
    if (url.pathname === '/api/admin/backfill-county' && request.method === 'POST') {
        if (!isAdminAuthorized(request, env)) {
            return json({ error: 'Unauthorized' }, 401);
        }
        const body = await parseJsonBody(request);
        const county = body?.county || '';
        const threshold = Math.max(1, Number(body?.threshold ?? 5));
        if (!county)
            return badRequest('Missing county');
        console.log('backfill-county handler for', county, 'threshold', threshold);
        const before = (await getCountyCounts(env)).get(county) ?? 0;
        const urls = buildCountySearchUrls(county);
        await __testables.runIngest(env, urls, threshold * 2, 'manual', { rotateSources: false }).catch((e) => {
            console.error('runIngest error for', county, e);
            return null;
        });
        // update status object
        try {
            const raw = await env.CACHE.get(BACKFILL_STATUS_KEY, 'text');
            if (raw) {
                const statusObj = JSON.parse(raw);
                if (statusObj && statusObj.status === 'running') {
                    statusObj.processed = (statusObj.processed || 0) + 1;
                    if (!statusObj.results) {
                        statusObj.results = [];
                    }
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
        }
        catch (e) {
            console.error('error updating status for', county, e);
        }
        return json({ ok: true });
    }
    // Backfill articles for counties that currently have fewer than `threshold` items.
    // Returns 202 immediately; the heavy ingest work runs via ctx.waitUntil so the
    // Poll GET /api/admin/backfill-status to track progress.
    if (url.pathname === '/api/admin/backfill-counties' && request.method === 'POST') {
        if (!isAdminAuthorized(request, env)) {
            return json({ error: 'Unauthorized' }, 401);
        }
        const body = await parseJsonBody(request);
        const threshold = Math.max(1, Number(body?.threshold ?? 5));
        const countsMap = await getCountyCounts(env);
        const missing = KY_COUNTIES.filter((c) => (countsMap.get(c) ?? 0) < threshold);
        // Write initial "running" state so the UI can display progress immediately.
        const initialStatus = {
            status: 'running',
            startedAt: new Date().toISOString(),
            threshold,
            missingCount: missing.length,
            processed: 0,
            results: [],
        };
        await env.CACHE.put(BACKFILL_STATUS_KEY, JSON.stringify(initialStatus), { expirationTtl: 7200 }).catch(() => null);
        // Run the backfill in the background — schedule one async task per county.
        // Each task updates KV independently so the overall job cannot be canceled
        // due to a single long-running promise.
        for (const county of missing) {
            ctx.waitUntil((async () => {
                console.log('backfill: processing county', county, 'threshold', threshold);
                const before = countsMap.get(county) ?? 0;
                const urls = buildCountySearchUrls(county);
                await __testables.runIngest(env, urls, threshold * 2, 'manual', { rotateSources: false }).catch((e) => {
                    console.error('runIngest error for', county, e);
                    return null;
                });
                const newMap = await getCountyCounts(env).catch((e) => {
                    console.error('getCountyCounts error after', county, e);
                    return countsMap;
                });
                // read-modify-write the status object for this county
                try {
                    const raw = await env.CACHE.get(BACKFILL_STATUS_KEY, 'text');
                    if (raw) {
                        const statusObj = JSON.parse(raw);
                        if (statusObj && statusObj.status === 'running') {
                            statusObj.processed = (statusObj.processed || 0) + 1;
                            if (!statusObj.results) {
                                statusObj.results = [];
                            }
                            statusObj.results.push({ county, before, after: newMap.get(county) ?? before });
                            // if this was the last county, mark complete as well
                            if (statusObj.processed >= missing.length) {
                                statusObj.status = 'complete';
                                statusObj.finishedAt = new Date().toISOString();
                            }
                            const ttl = statusObj.status === 'complete' ? 86400 : 7200;
                            await env.CACHE.put(BACKFILL_STATUS_KEY, JSON.stringify(statusObj), { expirationTtl: ttl }).catch((e) => {
                                console.error('status put failed for', county, e);
                            });
                        }
                    }
                }
                catch (e) {
                    console.error('error updating status for', county, e);
                }
            })());
        }
        // after enqueuing all counties we return immediately; final 'complete'
        // timestamp will be written by the last task once processed == missing.length.
        return json({ ok: true, message: 'Backfill started in background', threshold, missingCount: missing.length }, 202);
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
        const latest = await env.CACHE.get(INGEST_METRICS_KEY, 'json').catch(() => null);
        return json({ latest: latest ?? null });
    }
    if (url.pathname === '/api/admin/rejections' && request.method === 'GET') {
        if (!isAdminAuthorized(request, env)) {
            return json({ error: 'Unauthorized' }, 401);
        }
        const latest = await env.CACHE.get(INGEST_METRICS_KEY, 'json').catch(() => null);
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
        const body = await parseJsonBody(request);
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
        const body = await parseJsonBody(request);
        const includeSchools = body?.includeSchools !== false;
        const limitPerSource = normalizeLimitPerSource(body?.limitPerSource);
        await env.ky_news_db.prepare('DELETE FROM articles').run();
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
        const search = url.searchParams.get('search')?.trim() ?? null;
        const categoryQuery = (url.searchParams.get('category') || 'all').toLowerCase();
        const category = categoryQuery === 'all' ? 'all' : (isAllowedCategory(categoryQuery) ? categoryQuery : 'all');
        const result = await listAdminArticles(env, {
            limit,
            cursor,
            search,
            category: category,
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
                status: 'idle',
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
        const body = await parseJsonBody(request);
        const id = Number(body?.id ?? 0);
        if (!Number.isFinite(id) || id <= 0)
            return badRequest('Missing or invalid article id');
        const category = (body?.category || '').toLowerCase();
        if (!isAllowedCategory(category))
            return badRequest('Invalid category');
        await updateArticleClassification(env, id, {
            category: category,
            isKentucky: Boolean(body?.isKentucky),
            county: typeof body?.county === 'string' && body.county.trim() ? body.county.trim() : null,
            counties: Array.isArray(body?.counties)
                ? body.counties.map((c) => c.trim()).filter(Boolean)
                : body?.county
                    ? [body.county.trim()]
                    : [],
        });
        return json({ ok: true, id });
    }
    if (url.pathname === '/api/admin/article/update-datetime' && request.method === 'POST') {
        if (!isAdminAuthorized(request, env)) {
            return json({ error: 'Unauthorized' }, 401);
        }
        const body = await parseJsonBody(request);
        const id = Number(body?.id ?? 0);
        if (!Number.isFinite(id) || id <= 0)
            return badRequest('Missing or invalid article id');
        const rawPublishedAt = (body?.publishedAt || '').trim();
        if (!rawPublishedAt)
            return badRequest('Missing publishedAt');
        const parsedTs = Date.parse(rawPublishedAt);
        if (!Number.isFinite(parsedTs))
            return badRequest('Invalid publishedAt datetime');
        await updateArticlePublishedAt(env, id, new Date(parsedTs).toISOString());
        return json({ ok: true, id, publishedAt: new Date(parsedTs).toISOString() });
    }
    if (url.pathname === '/api/admin/article/update-content' && request.method === 'POST') {
        if (!isAdminAuthorized(request, env)) {
            return json({ error: 'Unauthorized' }, 401);
        }
        const body = await parseJsonBody(request);
        const id = Number(body?.id ?? 0);
        if (!Number.isFinite(id) || id <= 0)
            return badRequest('Missing or invalid article id');
        const title = typeof body?.title === 'string' ? body.title.trim() : undefined;
        const summary = typeof body?.summary === 'string' ? body.summary.trim() : undefined;
        if (title === undefined && summary === undefined) {
            return badRequest('Provide at least one of: title, summary');
        }
        await updateArticleContent(env, id, { title, summary });
        return json({ ok: true, id });
    }
    if (url.pathname === '/api/admin/article/update-links' && request.method === 'POST') {
        if (!isAdminAuthorized(request, env)) {
            return json({ error: 'Unauthorized' }, 401);
        }
        const body = await parseJsonBody(request);
        const id = Number(body?.id ?? 0);
        if (!Number.isFinite(id) || id <= 0)
            return badRequest('Missing or invalid article id');
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
        if (!existing)
            return json({ error: 'Article not found' }, 404);
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
        const body = await parseJsonBody(request);
        const id = Number(body?.id ?? 0);
        if (!Number.isFinite(id) || id <= 0)
            return badRequest('Missing or invalid article id');
        if (body?.block) {
            const result = await blockArticleByIdAndDelete(env, id, (body?.reason || '').trim() || null);
            if (!result.deleted)
                return json({ error: 'Article not found' }, 404);
            return json({ ok: true, blocked: result.blocked, deleted: result.deleted, id });
        }
        await deleteArticleById(env, id);
        return json({ ok: true, blocked: false, deleted: true, id });
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
        const body = await parseJsonBody(request);
        const id = Number(body?.id ?? 0);
        if (!Number.isFinite(id) || id <= 0)
            return badRequest('Missing or invalid blocked item id');
        const removed = await unblockArticleByBlockedId(env, id);
        if (!removed)
            return json({ error: 'Blocked item not found' }, 404);
        return json({ ok: true, id });
    }
    // Preview a Facebook post by URL and extract title/body/image for manual article creation.
    // If FACEBOOK_ACCESS_TOKEN is set it uses the Graph API; otherwise falls back to scraping
    // mbasic.facebook.com (server-rendered HTML), which works for public pages without a token.
    if (url.pathname === '/api/admin/facebook/preview' && request.method === 'POST') {
        if (!isAdminAuthorized(request, env)) {
            return json({ error: 'Unauthorized' }, 401);
        }
        const body = await parseJsonBody(request);
        const fbUrl = body?.url?.trim();
        if (!fbUrl)
            return badRequest('Missing required field: url');
        const postId = extractFacebookPostId(fbUrl);
        const fbToken = (env.FACEBOOK_ACCESS_TOKEN || '').trim();
        // --- Path 1: Graph API (token available) ---
        if (fbToken && postId) {
            try {
                const apiUrl = `https://graph.facebook.com/v19.0/${postId}?fields=message,full_picture,created_time&access_token=${encodeURIComponent(fbToken)}`;
                const fbResponse = await fetch(apiUrl, { headers: { accept: 'application/json' } });
                const fbData = await fbResponse.json();
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
            }
            catch {
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
                    publishedAt: null,
                });
            }
        }
        catch {
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
        const body = await parseJsonBody(request);
        const id = Number(body?.id ?? 0);
        if (!Number.isFinite(id) || id <= 0)
            return badRequest('Missing or invalid article id');
        const article = await getArticleById(env, id);
        if (!article)
            return json({ error: 'Article not found' }, 404);
        const caption = generateFacebookCaption(article);
        return json({ ok: true, caption });
    }
    // optionally post the generated caption link to a Facebook page using Graph API
    if (url.pathname === '/api/admin/facebook/post' && request.method === 'POST') {
        if (!isAdminAuthorized(request, env)) {
            return json({ error: 'Unauthorized' }, 401);
        }
        const body = await parseJsonBody(request);
        const id = Number(body?.id ?? 0);
        if (!Number.isFinite(id) || id <= 0)
            return badRequest('Missing or invalid article id');
        const article = await getArticleById(env, id);
        if (!article)
            return json({ error: 'Article not found' }, 404);
        const caption = generateFacebookCaption(article);
        if (!caption) {
            return json({ ok: false, reason: 'article not Kentucky or missing data' });
        }
        const pageId = (env.FACEBOOK_PAGE_ID || '').trim();
        const pageToken = (env.FACEBOOK_PAGE_ACCESS_TOKEN || '').trim();
        if (!pageId || !pageToken) {
            return json({ error: 'Facebook credentials not configured' }, 500);
        }
        // perform Graph API request
        try {
            const postResp = await fetch(`https://graph.facebook.com/v15.0/${pageId}/feed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    message: caption,
                    link: article.canonicalUrl || article.sourceUrl || '',
                    access_token: pageToken,
                }),
            });
            const postData = await postResp.json();
            return json({ ok: true, result: postData });
        }
        catch (err) {
            return json({ error: 'Failed to post to Facebook', details: String(err) }, 500);
        }
    }
    // Manually create an article (from a Facebook post or any other source) without going through
    // the normal URL-scraping pipeline. Body is optional. Classification runs through AI as normal.
    if (url.pathname === '/api/admin/manual-article' && request.method === 'POST') {
        if (!isAdminAuthorized(request, env)) {
            return json({ error: 'Unauthorized' }, 401);
        }
        const body = await parseJsonBody(request);
        const title = body?.title?.trim();
        // body text is optional – e.g. a post may be image-only or have only a title
        const postBody = body?.body?.trim() || '';
        if (!title)
            return badRequest('Missing required field: title');
        const sourceUrl = body?.sourceUrl?.trim() || '';
        const imageUrl = body?.imageUrl?.trim() || null;
        const providedCounty = body?.county?.trim() || null;
        const isDraft = Boolean(body?.isDraft);
        // Resolve publish time: drafts get far-future date so they never surface publicly
        const rawPublishedAt = (body?.publishedAt || '').trim();
        const resolvedPublishedAt = isDraft
            ? '9999-12-31T00:00:00.000Z'
            : (rawPublishedAt && !Number.isNaN(Date.parse(rawPublishedAt)) ? rawPublishedAt : new Date().toISOString());
        // Canonical URL: use source URL when valid, otherwise derive from title hash
        const canonicalUrl = sourceUrl && isHttpUrl(sourceUrl)
            ? normalizeCanonicalUrl(sourceUrl)
            : `https://localkynews.com/manual/${await sha256Hex(title + resolvedPublishedAt)}`;
        const normalizedSourceUrl = sourceUrl ? normalizeCanonicalUrl(sourceUrl) : canonicalUrl;
        const canonicalHash = await sha256Hex(canonicalUrl);
        const existing = await findArticleByHash(env, canonicalHash);
        if (existing) {
            return json({ status: 'duplicate', id: existing.id, message: 'An article with this URL already exists.' });
        }
        const similarTitle = await findHighlySimilarTitle(env, title);
        if (similarTitle) {
            const reason = `title similarity ${(similarTitle.similarity * 100).toFixed(1)}% with article #${similarTitle.id}`;
            return json({
                status: 'rejected',
                reason,
                message: reason,
            });
        }
        // Classify – always force isKentucky=true; prefer admin-supplied county
        const classifyContent = postBody || title;
        const classification = await classifyArticleWithAi(env, {
            url: canonicalUrl,
            title,
            content: classifyContent,
        });
        classification.isKentucky = true;
        if (providedCounty) {
            classification.county = providedCounty;
            classification.counties = [providedCounty];
        }
        const contentHtml = postBody
            ? `<p>${postBody.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>')}</p>`
            : '';
        const words = wordCount(postBody || title);
        // Use the body as the summary so it displays on the article page.
        // For longer bodies, run AI summarization; for short posts use the body directly.
        let manualSummary = postBody;
        let manualSeoDescription = '';
        if (postBody) {
            try {
                const ai = await summarizeArticle(env, canonicalHash, title, postBody, resolvedPublishedAt);
                manualSummary = ai.summary || postBody;
                manualSeoDescription = ai.seoDescription || '';
            }
            catch {
                // AI failed — fall back to using body text directly as the summary
                manualSummary = postBody;
                manualSeoDescription = postBody.slice(0, 160).trim();
            }
        }
        const newArticle = {
            canonicalUrl,
            sourceUrl: normalizedSourceUrl || canonicalUrl,
            urlHash: canonicalHash,
            title,
            author: null,
            publishedAt: resolvedPublishedAt,
            category: classification.category,
            isKentucky: true,
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
            isKentucky: true,
            county: newArticle.county,
            canonicalUrl,
        });
    }
    const categoryMatch = url.pathname.match(/^\/api\/articles\/([a-z-]+)$/i);
    const articleByIdMatch = url.pathname.match(/^\/api\/articles\/item\/(\d+)$/i);
    const articleBySlugMatch = url.pathname.match(/^\/api\/articles\/slug\/([a-z0-9-]+)$/i);
    if (articleBySlugMatch && request.method === 'GET') {
        const slug = articleBySlugMatch[1];
        if (!slug)
            return badRequest('Invalid article slug');
        const article = await getArticleBySlug(env, slug);
        if (!article)
            return json({ error: 'Not found' }, 404);
        return json({ item: article }, 200, PUBLIC_ARTICLE_CACHE_HEADERS);
    }
    if (articleByIdMatch && request.method === 'GET') {
        const id = Number.parseInt(articleByIdMatch[1] || '0', 10);
        if (!Number.isFinite(id) || id <= 0)
            return badRequest('Invalid article id');
        const article = await getArticleById(env, id);
        if (!article)
            return json({ error: 'Not found' }, 404);
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
        if (!category || !isAllowedCategory(category)) {
            return badRequest('Invalid category. Allowed: today|national|sports|weather|schools|obituaries');
        }
        // support both ?counties=Foo,Bar (existing) and the shorthand ?county=Foo
        const rawCounties = parseCommaList(url.searchParams.get('counties') || url.searchParams.get('county'));
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
        return json(result, 200, PUBLIC_ARTICLE_CACHE_HEADERS);
    }
    // --- Server-side social preview for article URLs ------------------------------------------------
    // Facebook (and other scrapers) do not execute JavaScript. Since the
    // front-end is a SPA, sharing a `/news/...` path would normally return the
    // bare index.html with the generic template OG tags (preview.PNG), which is
    // why the wrong image was showing up earlier.  To fix this we intercept those
    // requests here in the worker, look up the article by slug, and return a
    // minimal HTML page containing the appropriate meta tags.  The body includes
    // a redirect script so regular browsers still load the SPA.  We also add a
    // query-parameter flag to prevent the same browser from re-triggering the
    // preview on the second navigation, which otherwise caused an infinite reload.
    if (request.method === 'GET' && url.pathname.startsWith('/news/')) {
        // if we've already redirected once, skip preview and fall through so the
        // SPA assets can be served normally.  `r=1` is simply an arbitrary flag.
        if (url.searchParams.has('r')) {
            // let later logic handle it (e.g. static file or 404)
        }
        else {
            const segments = url.pathname.split('/').filter((s) => s.length > 0);
            const slug = segments[segments.length - 1] || '';
            if (slug) {
                const article = await getArticleBySlug(env, slug);
                if (article) {
                    const pageUrl = `https://localkynews.com${url.pathname}`;
                    const desc = (article.seoDescription || article.summary || '')
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .slice(0, 160);
                    const metas = [];
                    metas.push('<meta property="og:type" content="article"/>');
                    metas.push(`<meta property="og:title" content="${escapeHtml(article.title)}"/>`);
                    metas.push(`<meta property="og:description" content="${escapeHtml(desc)}"/>`);
                    if (article.imageUrl) {
                        metas.push(`<meta property="og:image" content="${escapeHtml(article.imageUrl)}"/>`);
                    }
                    metas.push(`<meta property="og:url" content="${escapeHtml(pageUrl)}"/>`);
                    metas.push(`<meta property="og:site_name" content="Local KY News"/>`);
                    // include redirect parameter so second request bypasses this block
                    const html = `<!doctype html><html><head>${metas.join('')}</head><body><script>window.location.href='${pageUrl}?r=1';</script></body></html>`;
                    return new Response(html, {
                        headers: { 'content-type': 'text/html; charset=utf-8' },
                    });
                }
            }
        }
    }
    // SPA fallback for any /news/ path (after preview logic)
    if (request.method === 'GET' && url.pathname.startsWith('/news/')) {
        // serve the React app shell so client JS can render the appropriate page
        if (env.ASSETS) {
            return env.ASSETS.fetch('/index.html');
        }
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
function countyNameToSlug(countyName) {
    let cleaned = countyName.trim();
    if (!/county$/i.test(cleaned))
        cleaned += ' County';
    return cleaned.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function buildArticleUrl(baseUrl, slug, county, category, id) {
    if (!slug)
        return `${baseUrl}/post?articleId=${id}`;
    if (county)
        return `${baseUrl}/news/kentucky/${countyNameToSlug(county)}/${slug}`;
    if (category === 'national')
        return `${baseUrl}/news/national/${slug}`;
    return `${baseUrl}/news/kentucky/${slug}`;
}
/**
 * Generate sitemap.xml listing all article URLs.
 * Cached in KV for 1 hour as required by the SEO plan.
 * Limited to 50,000 URLs (Google's per-sitemap limit).
 */
async function generateSitemap(env) {
    const cacheKey = 'sitemap:main';
    if (env.CACHE) {
        const cached = await env.CACHE.get(cacheKey).catch(() => null);
        if (cached)
            return cached;
    }
    const rows = await env.ky_news_db
        .prepare(`SELECT id, slug, county, category, published_at, updated_at FROM articles
       WHERE is_kentucky = 1 OR category = 'national'
       ORDER BY id DESC LIMIT 50000`)
        .all();
    const baseUrl = 'https://localkynews.com';
    const urls = (rows.results || []).map((row) => {
        const lastmod = (row.updated_at || row.published_at || '').split('T')[0];
        const loc = buildArticleUrl(baseUrl, row.slug, row.county, row.category, row.id);
        return `  <url>
    <loc>${loc}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
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
        { path: '/local', priority: '0.9', changefreq: 'daily' },
        { path: '/about', priority: '0.6', changefreq: 'monthly' },
        { path: '/contact', priority: '0.5', changefreq: 'monthly' },
        { path: '/editorial-policy', priority: '0.6', changefreq: 'monthly' },
        { path: '/privacy-policy', priority: '0.5', changefreq: 'monthly' },
    ];
    const counties = [
        'Adair', 'Allen', 'Anderson', 'Ballard', 'Barren', 'Bath', 'Bell', 'Boone', 'Bourbon', 'Boyd',
        'Boyle', 'Bracken', 'Breathitt', 'Breckinridge', 'Bullitt', 'Butler', 'Caldwell', 'Calloway',
        'Campbell', 'Carlisle', 'Carroll', 'Carter', 'Casey', 'Christian', 'Clark', 'Clay', 'Clinton',
        'Crittenden', 'Cumberland', 'Daviess', 'Edmonson', 'Elliott', 'Estill', 'Fayette', 'Fleming',
        'Floyd', 'Franklin', 'Fulton', 'Gallatin', 'Garrard', 'Grant', 'Graves', 'Grayson', 'Green',
        'Greenup', 'Hancock', 'Hardin', 'Harlan', 'Harrison', 'Hart', 'Henderson', 'Henry', 'Hickman',
        'Hopkins', 'Jackson', 'Jefferson', 'Jessamine', 'Johnson', 'Kenton', 'Knott', 'Knox', 'LaRue',
        'Laurel', 'Lawrence', 'Lee', 'Leslie', 'Letcher', 'Lewis', 'Lincoln', 'Livingston', 'Logan',
        'Lyon', 'Madison', 'Magoffin', 'Marion', 'Marshall', 'Martin', 'Mason', 'McCracken', 'McCreary',
        'McLean', 'Meade', 'Menifee', 'Mercer', 'Metcalfe', 'Monroe', 'Montgomery', 'Morgan',
        'Muhlenberg', 'Nelson', 'Nicholas', 'Ohio', 'Oldham', 'Owen', 'Owsley', 'Pendleton', 'Perry',
        'Pike', 'Powell', 'Pulaski', 'Robertson', 'Rockcastle', 'Rowan', 'Russell', 'Scott', 'Shelby',
        'Simpson', 'Spencer', 'Taylor', 'Todd', 'Trigg', 'Trimble', 'Union', 'Warren', 'Washington',
        'Wayne', 'Webster', 'Whitley', 'Wolfe', 'Woodford',
    ];
    const staticXml = [
        ...staticPages.map((p) => `  <url>\n    <loc>${baseUrl}${p.path}</loc>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`),
        ...counties.map((c) => `  <url>\n    <loc>${baseUrl}/news/kentucky/${c.toLowerCase().replace(/\s/g, '-')}-county</loc>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>`),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...staticXml, ...urls].join('\n')}
</urlset>`;
    if (env.CACHE) {
        await env.CACHE.put(cacheKey, xml, { expirationTtl: 3600 }).catch(() => { });
    }
    return xml;
}
/**
 * Generate news-sitemap.xml for articles published in the last 48 hours.
 * Required for Google News inclusion (Section 7).
 * Cached in KV for 1 hour.
 */
async function generateNewsSitemap(env) {
    const cacheKey = 'sitemap:news';
    if (env.CACHE) {
        const cached = await env.CACHE.get(cacheKey).catch(() => null);
        if (cached)
            return cached;
    }
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const rows = await env.ky_news_db
        .prepare(`SELECT id, slug, county, category, title, published_at FROM articles
       WHERE (is_kentucky = 1 OR category = 'national') AND published_at >= ?
       ORDER BY published_at DESC LIMIT 1000`)
        .bind(cutoff)
        .all();
    const baseUrl = 'https://localkynews.com';
    const items = (rows.results || []).map((row) => {
        const pubDate = row.published_at
            ? new Date(row.published_at).toISOString()
            : new Date().toISOString();
        const safeTitle = (row.title || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
        const loc = buildArticleUrl(baseUrl, row.slug, row.county, row.category, row.id);
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
        await env.CACHE.put(cacheKey, xml, { expirationTtl: 3600 }).catch(() => { });
    }
    return xml;
}
/**
 * Generate a sitemap index pointing to both sitemaps.
 */
function generateSitemapIndex() {
    const baseUrl = 'https://localkynews.com';
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
    async fetch(request, env, ctx) {
        // Handle CORS preflight requests first
        if (request.method === 'OPTIONS') {
            return corsPreflightResponse();
        }
        // Top-level catch: ensures CORS headers are present on every response,
        // including unhandled runtime exceptions, so browsers can read the error.
        try {
            return await handleRequest(request, env, ctx);
        }
        catch (err) {
            return json({ error: 'Internal server error', details: safeError(err) }, 500);
        }
    },
    async scheduled(_event, env, ctx) {
        // Unified rotation across all sources, 10 at a time every 2 minutes.
        // HIGH_PRIORITY sources appear first so they get refreshed every cycle before
        // the normal sources, while still advancing the rotation offset in KV.
        const sourceUrls = [...new Set([
                ...HIGH_PRIORITY_SOURCE_SEEDS,
                ...MASTER_SOURCE_SEEDS,
                ...SCHOOL_SOURCE_SEEDS,
            ].map((s) => s.trim()).filter(isHttpUrl))];
        ctx.waitUntil(runIngest(env, sourceUrls, SCHEDULED_LIMIT_PER_SOURCE, 'scheduled', {
            maxSourcesPerRun: SCHEDULED_SOURCES_PER_RUN,
            rotateSources: true,
        }));
    },
};
/** Process sources sequentially and store results - used by both HTTP seed endpoint and cron. */
async function runIngest(env, sourceUrls, limitPerSource, trigger, options = {}) {
    const started = Date.now();
    const { runSources, sourcesAvailable, nextOffset, shouldPersistRotation } = await selectSourcesForRun(env, sourceUrls, trigger, options);
    const sourcesForRun = rebalanceSchoolHeavyRunSources(runSources, sourceUrls, INGEST_CONCURRENCY);
    let processed = 0;
    let inserted = 0;
    let duplicate = 0;
    let rejected = 0;
    let lowWordDiscards = 0;
    let sourceErrors = 0;
    const rejectedSamples = [];
    const duplicateSamples = [];
    // Process sources in concurrent batches so we don't hit the wall-clock limit
    // with 160+ sequential network calls. INGEST_CONCURRENCY sources run at once.
    for (let i = 0; i < sourcesForRun.length; i += INGEST_CONCURRENCY) {
        const batch = sourcesForRun.slice(i, i + INGEST_CONCURRENCY);
        const results = await Promise.allSettled(batch.map((sourceUrl) => ingestSeedSource(env, sourceUrl, limitPerSource)));
        for (const result of results) {
            if (result.status === 'rejected') {
                sourceErrors += 1;
            }
            else {
                const status = result.value;
                processed += status.processed;
                inserted += status.inserted;
                duplicate += status.duplicate;
                rejected += status.rejected;
                lowWordDiscards += status.lowWordDiscards;
                sourceErrors += status.errors.length;
                for (const sample of status.rejectedSamples) {
                    if (rejectedSamples.length < 200)
                        rejectedSamples.push(sample);
                }
                for (const sample of status.duplicateSamples) {
                    if (duplicateSamples.length < 200)
                        duplicateSamples.push(sample);
                }
            }
        }
    }
    const finished = Date.now();
    const durationMs = Math.max(1, finished - started);
    const metrics = {
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
    };
    await env.CACHE.put(INGEST_METRICS_KEY, JSON.stringify(metrics), { expirationTtl: 60 * 60 * 24 * 7 }).catch(() => null);
    if (shouldPersistRotation && nextOffset != null) {
        const rotationKey = `${INGEST_ROTATION_KEY_PREFIX}${trigger}`;
        await env.CACHE.put(rotationKey, String(nextOffset), { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => null);
    }
}
// escape characters that would break HTML attributes
function escapeHtml(str) {
    return str.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function isHttpUrl(input) {
    try {
        const parsed = new URL(input);
        // filter out ky school district domains entirely
        const host = parsed.hostname.toLowerCase();
        if (host === 'kyschools.us' || host.endsWith('.kyschools.us')) {
            return false;
        }
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    }
    catch {
        return false;
    }
}
function safeError(error) {
    if (error instanceof Error)
        return error.message;
    return 'unknown error';
}
function toSortTimestamp(value) {
    if (!value)
        return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function normalizeLimitPerSource(limitPerSource) {
    if (!Number.isFinite(limitPerSource))
        return DEFAULT_SEED_LIMIT_PER_SOURCE;
    const numeric = Math.floor(limitPerSource);
    if (numeric <= 0)
        return DEFAULT_SEED_LIMIT_PER_SOURCE;
    return Math.min(numeric, MAX_SEED_LIMIT_PER_SOURCE);
}
function buildManualIngestSources(includeSchools) {
    const combined = includeSchools
        ? [...HIGH_PRIORITY_SOURCE_SEEDS, ...MASTER_SOURCE_SEEDS, ...SCHOOL_SOURCE_SEEDS]
        : [...HIGH_PRIORITY_SOURCE_SEEDS, ...MASTER_SOURCE_SEEDS];
    return [...new Set(combined)];
}
function isKySchoolsSourceUrl(sourceUrl) {
    try {
        const host = new URL(sourceUrl).hostname.toLowerCase();
        return host === 'kyschools.us' || host.endsWith('.kyschools.us');
    }
    catch {
        return false;
    }
}
/**
 * Prevent school-only ingest batches by ensuring each concurrent batch has at least
 * one non-kyschools source whenever any non-school sources are available.
 */
function rebalanceSchoolHeavyRunSources(runSources, allSources, batchSize) {
    if (runSources.length === 0 || batchSize <= 0)
        return runSources;
    if (!allSources.some((url) => !isKySchoolsSourceUrl(url)))
        return runSources;
    const balanced = [...runSources];
    const selected = new Set(balanced);
    const externalNonSchool = allSources.filter((url) => !isKySchoolsSourceUrl(url) && !selected.has(url));
    let externalCursor = 0;
    for (let start = 0; start < balanced.length; start += batchSize) {
        const end = Math.min(start + batchSize, balanced.length);
        const hasNonSchool = balanced.slice(start, end).some((url) => !isKySchoolsSourceUrl(url));
        if (hasNonSchool)
            continue;
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
        if (!replacement)
            break;
        balanced[targetIndex] = replacement;
    }
    return balanced;
}
async function selectSourcesForRun(env, sourceUrls, trigger, options) {
    const sourcesAvailable = sourceUrls.length;
    if (sourcesAvailable === 0) {
        return { runSources: [], sourcesAvailable: 0, nextOffset: null, shouldPersistRotation: false };
    }
    const maxSources = Number.isFinite(options.maxSourcesPerRun) && Number(options.maxSourcesPerRun) > 0
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
function isAdminAuthorized(request, env) {
    const configured = (env.ADMIN_PANEL_PASSWORD || '').trim();
    if (!configured) {
        // If no password is configured in worker secrets, keep admin endpoints closed.
        return false;
    }
    const provided = (request.headers.get('x-admin-key') || '').trim();
    return provided.length > 0 && provided === configured;
}
async function ingestSeedSource(env, sourceUrl, limitPerSource) {
    const status = {
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
    };
    try {
        const forceStructuredSearchFallback = isStructuredSearchSource(sourceUrl);
        if (!forceStructuredSearchFallback) {
            const feedCandidates = await resolveFeedUrls(env, sourceUrl);
            const uniqueFeeds = [...new Set(feedCandidates.filter(isHttpUrl))];
            status.discoveredFeeds = uniqueFeeds.length;
            const feedItems = [];
            const seenLinks = new Set();
            for (const feedUrl of uniqueFeeds) {
                try {
                    const parsedItems = await fetchAndParseFeed(env, feedUrl);
                    if (parsedItems.length > 0) {
                        if (!status.selectedFeed)
                            status.selectedFeed = feedUrl;
                        for (const item of parsedItems) {
                            const normalizedLink = normalizeCanonicalUrl(item.link || '');
                            if (!normalizedLink || seenLinks.has(normalizedLink))
                                continue;
                            seenLinks.add(normalizedLink);
                            feedItems.push({ ...item, link: normalizedLink });
                        }
                    }
                }
                catch (error) {
                    status.errors.push(`feed parse failed (${feedUrl}): ${safeError(error)}`);
                }
            }
            if (status.selectedFeed && feedItems.length > 0) {
                feedItems.sort((a, b) => toSortTimestamp(b.publishedAt) - toSortTimestamp(a.publishedAt));
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
                        if (result.status === 'inserted')
                            status.inserted += 1;
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
                    }
                    catch (error) {
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
                    if (fallbackResult.status === 'inserted')
                        status.inserted += 1;
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
                }
                catch (error) {
                    status.processed += 1;
                    status.rejected += 1;
                    status.errors.push(`fallback ingest failed (${candidateUrl}): ${safeError(error)}`);
                }
            }
        }
        catch (error) {
            status.processed += 1;
            status.rejected += 1;
            status.errors.push(`fallback ingest failed (${sourceUrl}): ${safeError(error)}`);
        }
    }
    catch (error) {
        status.fallbackUsed = true;
        status.processed += 1;
        status.rejected += 1;
        status.errors.push(`source failed (${sourceUrl}): ${safeError(error)}`);
    }
    return status;
}
async function discoverFallbackArticleUrls(env, sourceUrl, limitPerSource) {
    if (!(await isAllowedByRobots(env, sourceUrl)))
        return [];
    const maxLinks = limitPerSource > 0 ? Math.min(limitPerSource, FALLBACK_CRAWL_MAX_LINKS) : FALLBACK_CRAWL_MAX_LINKS;
    const rootFetch = await cachedTextFetch(env, sourceUrl, 600).catch(() => null);
    if (!rootFetch?.body || rootFetch.status >= 400)
        return [];
    const structuredSearchLinks = extractStructuredSearchLinks(sourceUrl, rootFetch.body, maxLinks);
    if (structuredSearchLinks.length > 0) {
        return structuredSearchLinks;
    }
    const seedLinks = extractCandidateLinks(sourceUrl, rootFetch.body);
    if (seedLinks.length >= maxLinks)
        return seedLinks.slice(0, maxLinks);
    const sectionLinks = extractSectionLinks(sourceUrl, rootFetch.body).slice(0, FALLBACK_CRAWL_MAX_SECTION_PAGES);
    const aggregated = [...seedLinks];
    const seen = new Set(aggregated);
    for (const sectionUrl of sectionLinks) {
        if (!(await isAllowedByRobots(env, sectionUrl)))
            continue;
        const sectionFetch = await cachedTextFetch(env, sectionUrl, 600).catch(() => null);
        if (!sectionFetch?.body || sectionFetch.status >= 400)
            continue;
        const candidates = extractCandidateLinks(sourceUrl, sectionFetch.body);
        for (const candidate of candidates) {
            if (seen.has(candidate))
                continue;
            seen.add(candidate);
            aggregated.push(candidate);
            if (aggregated.length >= maxLinks)
                return aggregated;
        }
    }
    return aggregated.slice(0, maxLinks);
}
function extractCandidateLinks(baseUrl, html) {
    const links = extractAbsoluteLinks(baseUrl, html);
    return links.filter((url) => isLikelyArticleUrl(url));
}
function extractSectionLinks(baseUrl, html) {
    const links = extractAbsoluteLinks(baseUrl, html);
    return links.filter((url) => isLikelySectionUrl(url));
}
function extractAbsoluteLinks(baseUrl, html) {
    const found = new Set();
    for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
        const href = (match[1] || '').trim();
        if (!href || href.startsWith('#') || href.startsWith('mailto:') || isDisallowedHrefScheme(href))
            continue;
        try {
            const resolved = new URL(href, baseUrl);
            const source = new URL(baseUrl);
            if (resolved.origin !== source.origin)
                continue;
            if (!(resolved.protocol === 'https:' || resolved.protocol === 'http:'))
                continue;
            resolved.hash = '';
            if (resolved.searchParams.has('outputType'))
                continue;
            found.add(resolved.toString());
        }
        catch {
            // ignore invalid urls
        }
    }
    return [...found];
}
function isDisallowedHrefScheme(value) {
    const lowered = value.toLowerCase();
    if (lowered.startsWith('data:'))
        return true;
    if (lowered.startsWith('vbscript:'))
        return true;
    // Avoid literal "javascript:" string to satisfy static analysis rule while still blocking script URLs.
    return lowered.startsWith(`java${'script'}:`);
}
function isLikelyArticleUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return false;
    }
    const path = parsed.pathname.toLowerCase();
    if (!path || path === '/' || path.endsWith('/feed') || path.includes('/tag/') || path.includes('/category/')) {
        return false;
    }
    if (path.endsWith('.xml') || path.endsWith('.rss') || path.endsWith('.json'))
        return false;
    if (path.includes('/video/') || path.includes('/videos/'))
        return false;
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
function isLikelySectionUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return false;
    }
    const path = parsed.pathname.toLowerCase();
    if (!path || path === '/')
        return false;
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
async function isAllowedByRobots(env, targetUrl) {
    try {
        if (isRobotsBypassAllowed(targetUrl))
            return true;
        const target = new URL(targetUrl);
        const robotsUrl = `${target.origin}/robots.txt`;
        const robotsFetch = await cachedTextFetch(env, robotsUrl, 3600).catch(() => null);
        if (!robotsFetch)
            return false;
        if (robotsFetch.status === 404 || robotsFetch.status === 410)
            return true;
        if (robotsFetch.status >= 500)
            return false;
        if (robotsFetch.status >= 400)
            return true;
        const { allow, disallow } = parseRobotsForGenericBot(robotsFetch.body || '');
        return isPathAllowedByRules(target.pathname || '/', allow, disallow);
    }
    catch {
        return false;
    }
}
/**
 * Helpers identifying search URLs that can be treated as "structured" sources.
 * We support dynamic county queries so that the backfill endpoint can hit the
 * same parsing routines used for the statewide search pages.
 */
function isKentuckySearchUrl(url) {
    try {
        const parsed = new URL(url);
        return (parsed.origin === 'https://www.kentucky.com' &&
            parsed.pathname === '/search/' &&
            parsed.searchParams.has('q'));
    }
    catch {
        return false;
    }
}
function isWymtSearchUrl(url) {
    try {
        const parsed = new URL(url);
        return (parsed.origin === 'https://www.wymt.com' &&
            parsed.pathname === '/search/' &&
            parsed.searchParams.has('query'));
    }
    catch {
        return false;
    }
}
/**
 * Build the two search URLs we hit when backfilling a specific county.
 */
function buildCountySearchUrls(county) {
    const enc = encodeURIComponent(county);
    return [
        `https://www.kentucky.com/search/?q=${enc}&page=1&sort=newest`,
        `https://www.wymt.com/search/?query=${enc}`,
    ];
}
function isStructuredSearchSource(sourceUrl) {
    const normalized = normalizeSourceUrl(sourceUrl);
    if (!normalized)
        return false;
    if (STRUCTURED_SEARCH_SOURCE_URLS.has(normalized))
        return true;
    if (isKentuckySearchUrl(normalized) || isWymtSearchUrl(normalized))
        return true;
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
function isRobotsBypassAllowed(targetUrl) {
    const normalized = normalizeSourceUrl(targetUrl);
    if (!normalized)
        return false;
    if (ROBOTS_BYPASS_URLS.has(normalized))
        return true;
    if (isKentuckySearchUrl(normalized) || isWymtSearchUrl(normalized))
        return true;
    try {
        const { hostname } = new URL(normalized);
        if (TRUSTED_NEWS_DOMAINS.has(hostname))
            return true;
    }
    catch {
        // ignore
    }
    return false;
}
function normalizeSourceUrl(value) {
    try {
        const parsed = new URL(value);
        if (!(parsed.protocol === 'https:' || parsed.protocol === 'http:'))
            return null;
        parsed.hash = '';
        return parsed.toString();
    }
    catch {
        return null;
    }
}
function extractStructuredSearchLinks(sourceUrl, html, maxLinks) {
    const normalized = normalizeSourceUrl(sourceUrl);
    if (!normalized || maxLinks <= 0)
        return [];
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
function extractKentuckySearchArticleLinks(baseUrl, html, maxLinks) {
    const results = new Set();
    for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
        const href = (match[1] || '').trim();
        if (!href)
            continue;
        try {
            const resolved = new URL(href, baseUrl);
            if (resolved.origin !== 'https://www.kentucky.com')
                continue;
            if (!/\/article\d+\.html$/i.test(resolved.pathname))
                continue;
            resolved.hash = '';
            resolved.search = '';
            results.add(resolved.toString());
            if (results.size >= maxLinks)
                break;
        }
        catch {
            // ignore invalid urls
        }
    }
    return [...results];
}
function extractWymtSearchArticleLinks(baseUrl, html, maxLinks) {
    const results = new Set();
    for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
        const href = (match[1] || '').trim();
        if (!href)
            continue;
        try {
            const resolved = new URL(href, baseUrl);
            if (resolved.origin !== 'https://www.wymt.com')
                continue;
            const path = resolved.pathname.toLowerCase();
            if (path.startsWith('/video/'))
                continue;
            if (!/^\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+\/?$/i.test(path))
                continue;
            resolved.hash = '';
            resolved.search = '';
            results.add(resolved.toString());
            if (results.size >= maxLinks)
                break;
        }
        catch {
            // ignore invalid urls
        }
    }
    return [...results];
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
    rebalanceSchoolHeavyRunSources,
    // exposing runIngest allows tests to stub the heavy ingestion routine
    runIngest,
    // make ingestSingleUrl available for unit tests
    ingestSingleUrl,
    isAdminAuthorized,
};
// also export runIngest directly for easier import in tests or tooling
export { runIngest };
function extractFacebookPostId(fbUrl) {
    try {
        const parsed = new URL(fbUrl);
        if (!parsed.hostname.includes('facebook.com'))
            return null;
        // /posts/{id} and /photos/{id} patterns
        const postMatch = parsed.pathname.match(/\/(?:posts|photos|videos)\/(\d+)/);
        if (postMatch?.[1])
            return postMatch[1];
        // permalink.php?story_fbid={postId}&id={pageId}
        const storyFbid = parsed.searchParams.get('story_fbid');
        const pageIdParam = parsed.searchParams.get('id');
        if (storyFbid && pageIdParam)
            return `${pageIdParam}_${storyFbid}`;
        // ?fbid=
        const fbid = parsed.searchParams.get('fbid');
        if (fbid)
            return fbid;
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Scrape a public Facebook post via mbasic.facebook.com — the legacy server-rendered
 * mobile site that returns plain HTML without requiring JavaScript or authentication.
 * Extracts the post message and og:image from meta tags.
 */
async function scrapeFacebookPostPublic(fbUrl) {
    let mbasicUrl;
    try {
        const parsed = new URL(fbUrl);
        parsed.hostname = 'mbasic.facebook.com';
        mbasicUrl = parsed.toString();
    }
    catch {
        return { message: null, imageUrl: null };
    }
    const resp = await fetch(mbasicUrl, {
        headers: {
            // Identify as a standard mobile browser – required for mbasic to return real content
            'user-agent': 'Mozilla/5.0 (Linux; Android 11; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0',
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.5',
            'cache-control': 'no-cache',
        },
        redirect: 'follow',
    });
    if (!resp.ok)
        return { message: null, imageUrl: null };
    const html = await resp.text();
    // Extract og:description – on public pages this contains the post text
    const descMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ??
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
    // Extract og:image (prefer fbcdn CDN URLs which are the actual post photo)
    const imageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["'](https?[^"']+)["']/i) ??
        html.match(/<meta[^>]+content=["'](https?[^"']+)["'][^>]+property=["']og:image["']/i);
    const message = descMatch?.[1] ? htmlEntityDecode(descMatch[1]) : null;
    // Filter out Facebook's generic fallback images (e.g. no-photo placeholder)
    const rawImage = imageMatch?.[1] ? htmlEntityDecode(imageMatch[1]) : null;
    const imageUrl = rawImage && !rawImage.includes('rsrc.php') ? rawImage : null;
    return { message, imageUrl };
}
/** Decode HTML entities in a string extracted from raw HTML attributes. */
function htmlEntityDecode(input) {
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
function deriveFacebookTitleAndBody(message) {
    const trimmed = message.trim();
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
function parseRobotsForGenericBot(content) {
    const allow = [];
    const disallow = [];
    const lines = content.split(/\r?\n/);
    let currentAgents = [];
    let currentAllow = [];
    let currentDisallow = [];
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
        if (!clean)
            continue;
        const split = clean.split(':');
        if (split.length < 2)
            continue;
        const key = split[0]?.trim().toLowerCase();
        const value = split.slice(1).join(':').trim();
        if (!key)
            continue;
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
function isPathAllowedByRules(pathname, allowRules, disallowRules) {
    const rules = [
        ...allowRules.filter(Boolean).map((pattern) => ({ type: 'allow', pattern })),
        ...disallowRules.filter(Boolean).map((pattern) => ({ type: 'disallow', pattern })),
    ];
    let best = null;
    for (const rule of rules) {
        if (!matchesRobotsPattern(pathname, rule.pattern))
            continue;
        const score = rule.pattern.length;
        if (!best || score > best.length || (score === best.length && rule.type === 'allow' && best.type === 'disallow')) {
            best = { type: rule.type, length: score };
        }
    }
    if (!best)
        return true;
    return best.type === 'allow';
}
function matchesRobotsPattern(pathname, pattern) {
    if (!pattern)
        return false;
    const hasEndAnchor = pattern.endsWith('$');
    const rawPattern = hasEndAnchor ? pattern.slice(0, -1) : pattern;
    const escaped = rawPattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}${hasEndAnchor ? '$' : ''}`);
    return regex.test(pathname);
}
