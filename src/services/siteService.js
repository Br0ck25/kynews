import { SaveValue, GetValue } from "./storageService";
import { KENTUCKY_COUNTIES } from "../constants/counties";

const DEFAULT_IMAGE = "https://source.unsplash.com/random/1200x800?kentucky-news";

// exported for unit testing only
export { mapWorkerArticleToPost };
const WORKER_FALLBACK_BASE_URL = "https://worker.jamesbrock25.workers.dev";

const ADMIN_SESSION_KEY = "ky_admin_panel_key";

const ALLOWED_CATEGORIES = [
  "today",
  "national",
  "sports",
  "events",
  "weather",
  "schools",
  "obituaries",
];

const COUNTY_ALIASES = {
  "mc cracken": "McCracken",
  "mccraken": "McCracken",
  "mc creary": "McCreary",
  "mccreary county": "McCreary",
  "larue county": "LaRue",
  "kenton county": "Kenton",
};

function normalizeCountyValue(value) {
  const cleaned = (value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+county$/u, "");

  if (!cleaned) return null;

  const aliasMatch = COUNTY_ALIASES[cleaned];
  if (aliasMatch) return aliasMatch;

  return (
    KENTUCKY_COUNTIES.find(
      (county) => county.toLowerCase() === cleaned || county.toLowerCase() === `${cleaned} county`
    ) ?? null
  );
}

function createDefaultCountyTags() {
  return KENTUCKY_COUNTIES.map((county) => ({ value: county, active: false }));
}

function migrateToCountyTags(existingTags) {
  const base = createDefaultCountyTags();
  const activeCounties = new Set(
    (existingTags || [])
      .filter((tag) => tag && tag.active)
      .map((tag) => normalizeCountyValue(tag.value))
      .filter(Boolean)
  );

  return base.map((tag) => ({
    ...tag,
    active: activeCounties.has(tag.value),
  }));
}

function mapWorkerArticleToPost(article) {
  const bodyText = article?.contentText ?? "";

  // derive a categories array that reflects both the stored category and the
  // explicit national flag.  previously we simply pushed `article.category`,
  // which meant a national article with an empty category resulted in `[]`.  The
  // UI used the first element of this array to render the page header and
  // route the category chip, so blank arrays caused the label to fall back to
  // "Local News".
  const categories = [];
  if (article?.category) {
    categories.push(article.category);
  }
  // worker responses may use either `is_national` (numeric) or
  // `isNational` (boolean) depending on which mapper ran; handle both.
  if (
    ((article?.is_national === 1) || article?.isNational === true) &&
    !categories.includes('national')
  ) {
    categories.push('national');
  }

  return {
    id: article?.id ?? null,
    slug: article?.slug ?? null,
    title: article?.title ?? "Untitled",
    date: article?.publishedAt ?? new Date().toISOString(),
    shortDesc: article?.summary ?? article?.seoDescription ?? "",
    description: article?.contentHtml ?? article?.summary ?? "",
    contentText: bodyText,
    image: article?.imageUrl ?? null,
    imageAlt: article?.imageAlt ?? null,
    imageText: article?.imageAlt || article?.title || "Kentucky News",
    link: "/post",
    // prefer canonical URL for the "Read full story" button except when
    // the canonical link is one of our manually generated slugs.  Those slugs
    // point back to ourselves and should not be used as outbound links; instead
    // fall back to sourceUrl (which for truly original pieces will be the
    // homepage, and for manually sourced articles may be an external URL).
    originalLink: article?.canonicalUrl && !article.canonicalUrl.startsWith("https://localkynews.com/manual/")
      ? article.canonicalUrl
      : (article?.sourceUrl || ""),
    sourceUrl: article?.sourceUrl ?? "",
    categories,
    county: article?.county ?? null,
    author: article?.author ?? null,
    isKentucky: Boolean(article?.isKentucky),
    // support both numeric and boolean representations of the national flag
    isNational: article?.is_national === 1 || article?.isNational === true,
    // if extra counties were stored, expose them as tags so UI components can work with them
    tags: Array.isArray(article?.counties) ? article.counties : [],
    alertGeojson: article?.alert_geojson ?? article?.alertGeojson ?? null,
  };
}

function sortPostsNewestFirst(posts) {
  return [...posts].sort((a, b) => {
    const aDate = new Date(a.date).getTime();
    const bDate = new Date(b.date).getTime();
    if (!Number.isFinite(aDate) && !Number.isFinite(bDate)) return 0;
    if (!Number.isFinite(aDate)) return 1;
    if (!Number.isFinite(bDate)) return -1;
    return bDate - aDate;
  });
}

function toError(error, fallbackMessage) {
  const message =
    error?.error ||
    error?.message ||
    error?.errorMessage ||
    fallbackMessage ||
    "Something went wrong while loading news.";

  return { errorMessage: message };
}

function resolveViteApiBaseUrl() {
  try {
    // Keep import.meta inside a runtime string to avoid CommonJS/Jest parse errors.
    // eslint-disable-next-line no-new-func
    return Function(
      'try { return (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_API_BASE_URL) || undefined; } catch (_) { return undefined; }'
    )();
  } catch {
    return undefined;
  }
}

function looksLikeHtmlDocument(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}

export default class SiteService {
  constructor(baseUrl) {
    // baseUrl may be provided directly (useful in tests) or pulled from an
    // environment variable that can be set by the build system (Cloudflare
    // Pages offers *Build environment variables* which are injected into
    // `process.env` and made available at runtime as `REACT_APP_*`).
    //
    // During local development nothing is set so we default to an empty
    // string, causing all requests to go to `/<path>`; in production the
    // variable should point at a deployed Worker endpoint (or left blank if
    // the Worker is routed to the same domain via `wrangler` routes).
    const viteBaseUrl = resolveViteApiBaseUrl();
    this.baseUrl =
      baseUrl ||
      viteBaseUrl ||
      process.env.REACT_APP_API_BASE_URL ||
      "";

    // Admin requests use the same base URL as public API so everything stays
    // same-origin and CORS preflight is never triggered.
    // Vite only injects VITE_* env vars — REACT_APP_* are always undefined at
    // runtime, so we cannot rely on them for admin URL configuration.
    this.adminBaseUrl = this.baseUrl;

    this.devSeedAttempted = false;
  }

  async request(path, options = {}) {
    // avoid sending a Content-Type header with GET requests; that
    // turns them into "non-simple" cross-origin requests and forces a
    // CORS preflight which can fail when falling back to a different
    // origin (e.g. a raw workers.dev host).  Only include the header when
    // there is a body to describe.
    const headers = {
      ...(options.headers || {}),
    };
    if ((options.method || "GET").toUpperCase() !== "GET") {
      headers["Content-Type"] = "application/json";
    }

    if (path.startsWith("/api/admin/")) {
      const adminKey = this.getAdminPanelKey();
      if (adminKey) {
        headers["x-admin-key"] = adminKey;
      }
    }

    const requestOptions = {
      headers,
      ...options,
    };

    const isAdminPath = path.startsWith("/api/admin/");
    const targetBaseUrl = isAdminPath ? this.adminBaseUrl : this.baseUrl;
    const targetUrl = `${targetBaseUrl}${path}`;
    let response = await fetch(targetUrl, requestOptions);

    // Admin paths must NOT fall back to WORKER_FALLBACK_BASE_URL — doing so
    // crosses origins and triggers CORS.  The shouldFallback logic below only
    // applies to public /api/ paths.
    const parseResponse = async (resp) => {
      const contentType = resp.headers.get("content-type") || "";
      const rawText = await resp.text();

      let parsed = null;
      if (rawText) {
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = null;
        }
      }

      return {
        parsed,
        rawText,
        isHtmlLike: contentType.includes("text/html") || looksLikeHtmlDocument(rawText),
      };
    };

    let { parsed, rawText, isHtmlLike } = await parseResponse(response);

    // If same-origin /api is routed to SPA HTML (or returns an error page),
    // retry against the worker host.  We used to only do this when the first
    // response was `ok`, but POST/ADMIN requests currently return a 405 from
    // the frontend app which prevents the retry.  Treat any non-JSON/HTML
    // response as a sign that we've hit the SPA instead of the API.
    // Never reroute admin paths to the worker.dev fallback — that crosses
    // origins and causes CORS failures. Admin requests must stay same-origin.
    // Fallback is only necessary when we clearly hit the SPA instead of the
    // API (HTML or non-JSON response) or when the original request produced a
    // client-side error such as 404/405.  We intentionally *do not* retry on
    // 5xx server errors, since those indicate a real API problem that would
    // just be duplicated by hitting the fallback host and only generate
    // confusing CORS errors in the browser.
    // Only retry against the worker fallback when we clearly hit the SPA (HTML
    // page) or got a non-JSON response.  A valid API error (e.g. 404 with a JSON
    // body) should not trigger the fallback because that is a real response from
    // the API.
    const shouldFallback =
      path.startsWith("/api/") &&
      !isAdminPath &&
      this.baseUrl !== WORKER_FALLBACK_BASE_URL &&
      (parsed == null || isHtmlLike);

    if (shouldFallback) {
      console.warn('[siteService] primary request returned non-JSON/HTML, falling back to worker.dev:', path);
      try {
        response = await fetch(`${WORKER_FALLBACK_BASE_URL}${path}`, requestOptions);
        ({ parsed, rawText, isHtmlLike } = await parseResponse(response));
      } catch {
        // Keep original response interpretation below.
      }
    }

    const data = parsed;

    // Treat 422 responses specially.  The admin ingest endpoints use 422 to
    // indicate that the pipeline processed the request but decided to reject
    // the URL (e.g. duplicate, short content, etc).  Those responses contain a
    // JSON body with `status`/`reason` fields that the caller needs to inspect
    // rather than being forced into the catch block.  Previously every
    // non-OK status caused `request()` to throw, which meant the admin UI
    // could not distinguish a rejection from a network error.  We now return
    // the parsed body for 422 if available.
    if (response.status === 422 && parsed != null) {
      return parsed;
    }

    if (!response.ok) {
      throw toError(data, `Request failed with status ${response.status}`);
    }

    if (data == null || isHtmlLike) {
      throw toError(
        null,
        "API endpoint returned non-JSON content. Check frontend API routing or base URL configuration."
      );
    }

    return data;
  }

  async getPosts(searchOrOptions = "", perPage = 10) {
    let options;
    if (typeof searchOrOptions === "string") {
      // when callers supply a bare string it historically implied a
      // "today" query, but search pages expect to hit every category.  using
      // `all` here makes that behaviour consistent without requiring callers
      // to always remember to pass an object.  In this case we still honor the
      // caller-supplied `perPage` argument because callers typically use the
      // string overload for paginated feeds rather than freeform searches.
      options = {
        category: "all",
        search: searchOrOptions,
        limit: perPage,
        counties: [],
      };
    } else {
      // when an object is provided we no longer unconditionally default the
      // limit to `perPage`.  callers who omit `limit` now send no `limit`
      // query parameter at all, allowing the backend to decide (and avoid
      // accidentally imposing a 10‑item cap on searches).
      options = {
        category: "today",
        search: "",
        limit: undefined,
        counties: [],
        ...searchOrOptions,
      };
      // if the caller provided a search term but neglected to specify a
      // category, broaden the query to every article.  they can still
      // explicitly pass `category: 'today'` if they want to constrain it.
      if (options.search && !searchOrOptions.category) {
        options.category = 'all';
      }
    }

    // Ensure any counties passed by callers are canonicalized.  The
    // consumer (e.g. county page) usually passes a clean name, but other
    // parts of the app (settings filters, saved counties) may persist raw
    // values, so normalizing here avoids unnecessary empty queries.
    if (options.counties && options.counties.length > 0) {
      options.counties = options.counties
        .map((c) => normalizeCountyValue(c))
        .filter(Boolean);
    }

    // allow the special "all" pseudo‑category through; otherwise fall back
    // to a sane default.
    const category = options.category === 'all' ? 'all' :
      (ALLOWED_CATEGORIES.includes(options.category) ? options.category : "today");

    const params = new URLSearchParams();
    if (options.search) params.set("search", options.search);
    if (options.limit) params.set("limit", String(options.limit));
    if (category !== "national" && options.counties && options.counties.length > 0) {
      params.set("counties", options.counties.join(","));
    }

    const cacheKey = `posts_${category}_${options.search || ""}_${
      (options.counties || []).join("|")
    }_${options.limit || perPage}`;

    if (!navigator.onLine) {
      return new Promise((resolve, reject) => {
        const cachedPosts = GetValue(cacheKey) || GetValue("posts");
        if (cachedPosts) resolve(cachedPosts);
        else {
          reject(
            toError(
              null,
              "No internet connection and no cached Kentucky News posts are available yet."
            )
          );
        }
      });
    }

    try {
      const queryString = params.toString();
      const route = `/api/articles/${category}${queryString ? `?${queryString}` : ""}`;
      let payload = await this.request(route);

      if (payload?.searchError) {
        console.warn('[Search] Backend reported query error:', payload.searchError);
        // treat as empty result but surface a gentle error in the UI
        throw { errorMessage: 'Search is temporarily unavailable. Please try again.' };
      }

      if (
        (!payload?.items || payload.items.length === 0) &&
        this.isLocalDev() &&
        !this.devSeedAttempted &&
        !options.search
      ) {
        this.devSeedAttempted = true;
        await this.seedLocalDev();
        payload = await this.request(route);
      }

      const posts = sortPostsNewestFirst((payload?.items || []).map(mapWorkerArticleToPost));
      // only cache unfiltered "today" queries (no counties specified) because
      // storing every county result quickly eats localStorage quota.
      if (!options.counties || options.counties.length === 0) {
        try {
          SaveValue(cacheKey, posts);
          if (category === "today" && !options.search) {
            SaveValue("posts", posts);
          }
        } catch (e) {
          console.warn('cache write failed', e);
        }
      }
      return posts;
    } catch (error) {
      throw toError(error, "Unable to load posts.");
    }
  }

  getCategories() {
    return Promise.resolve([
      { id: "today", name: "Today" },
      { id: "national", name: "National" },
      { id: "sports", name: "Sports" },
      { id: "weather", name: "Weather" },
      { id: "schools", name: "Schools" },
      { id: "obituaries", name: "Obituaries" },
    ]);
  }

  getTags() {
    if (!navigator.onLine)
      return new Promise((resolve, reject) => resolve(GetValue("tags")));
    else {
      // return fetch(this.baseUrl + "/tags")
      //   .then((resp) => resp.json())
      //   .then((data) => {
      //     SaveValue("tags", data);
      //     return data;
      //   })
      //   .catch((err) => err);
      return new Promise((resolve, reject) => {
        const localStorageTags = GetValue('tags');
        const migratedTags = migrateToCountyTags(localStorageTags);
        SaveValue('tags', migratedTags);

        return resolve(GetValue('tags'));
      });
    }
  }

  saveTags(value) { //to save all
    return new Promise((resolve, reject) => {
      const tags = GetValue('tags');
      const newTags = tags.map((item) => {
        return item.value !== value ? item : { value, active: !item.active };
      });
      SaveValue('tags', newTags);
      resolve(GetValue('tags'));
    });
  }

  isLocalDev() {
    const host = window?.location?.hostname || "";
    return host === "localhost" || host === "127.0.0.1";
  }

  async seedLocalDev() {
    try {
      await this.request("/api/ingest/seed?maxSources=12&limitPerSource=3", {
        method: "POST",
      });
    } catch {
      // best effort; leave normal empty-state handling in place
    }
  }

  /**
   * Fetch a single page of articles for infinite scroll.
   * Returns { posts: [], nextCursor: string|null }.
   * Pass cursor=null for the first page, then pass the returned nextCursor for subsequent pages.
   */
  async fetchPage({ category = "today", search = '', counties = [], cursor = null, limit = 20 } = {}) {
    const validCategory = (ALLOWED_CATEGORIES.includes(category) || category === 'all') ? category : "today";
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (search) {
      params.set("search", search);
    }
    if (validCategory !== "national" && counties && counties.length > 0) {
      params.set("counties", counties.join(","));
    }
    if (cursor) {
      params.set("cursor", cursor);
    }

    const route = `/api/articles/${validCategory}?${params.toString()}`;
    const payload = await this.request(route);

    return {
      posts: sortPostsNewestFirst((payload?.items || []).map(mapWorkerArticleToPost)),
      nextCursor: payload?.nextCursor ?? null,
    };
  }

  async getPostById(id) {
    const numericId = Number(id);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      throw toError(null, "Invalid article id.");
    }

    const payload = await this.request(`/api/articles/item/${numericId}`);
    if (!payload?.item) {
      throw toError(null, "Article not found.");
    }

    return mapWorkerArticleToPost(payload.item);
  }

  async getPostBySlug(slug) {
    if (!slug) throw toError(null, "Invalid article slug.");
    const payload = await this.request(`/api/articles/slug/${encodeURIComponent(slug)}`);
    if (!payload?.item) throw toError(null, "Article not found.");
    return mapWorkerArticleToPost(payload.item);
  }

  async ingestUrl(url) {
    if (!url) {
      throw toError(null, "Missing url to ingest.");
    }

    return this.request("/api/ingest/url", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  }

  async ingestRss({ feedUrl, sourceUrl }) {
    if (!feedUrl && !sourceUrl) {
      throw toError(null, "Provide either feedUrl or sourceUrl for RSS ingest.");
    }

    return this.request("/api/ingest/rss", {
      method: "POST",
      body: JSON.stringify({ feedUrl, sourceUrl }),
    });
  }

  async getAdminSources() {
    return this.request("/api/admin/sources");
  }

  async getAdminMetrics() {
    return this.request("/api/admin/metrics");
  }

  async getAdminRejections() {
    return this.request("/api/admin/rejections");
  }

  async publishAdminRejection(payload) {
    return this.request("/api/admin/publish", {
      method: "POST",
      body: JSON.stringify(payload || {}),
    });
  }

  async adminIngest({ includeSchools = true, limitPerSource = 0 } = {}) {
    return this.request("/api/admin/ingest", {
      method: "POST",
      body: JSON.stringify({ includeSchools, limitPerSource }),
    });
  }

  async adminPurgeAndReingest({ includeSchools = true, limitPerSource = 0 } = {}) {
    return this.request("/api/admin/purge-and-reingest", {
      method: "POST",
      body: JSON.stringify({ includeSchools, limitPerSource }),
    });
  }

  async adminBackfillCounties({ threshold = 5 } = {}) {
    return this.request("/api/admin/backfill-counties", {
      method: "POST",
      body: JSON.stringify({ threshold }),
    });
  }

  async adminReclassify({ limit = 20, beforeId = null } = {}) {
    return this.request("/api/admin/reclassify", {
      method: "POST",
      body: JSON.stringify({ limit, beforeId }),
    });
  }

  async getBackfillStatus() {
    return this.request("/api/admin/backfill-status");
  }

  async getAdminArticles({ category = "all", search = "", cursor = null, limit = 25 } = {}) {
    const params = new URLSearchParams();
    params.set("category", category);
    params.set("limit", String(limit));
    if (search) params.set("search", search);
    if (cursor) params.set("cursor", cursor);

    return this.request(`/api/admin/articles?${params.toString()}`);
  }

  async retagArticle({ id, category, isKentucky, county, counties }) {
    // `counties` is an optional array of county tags used for multi-county
    // assignments.  The UI now builds this list and passes it through so the
    // backend can correctly clear or update the junction table instead of
    // relying on the fallback logic that previously repopulated the primary
    // county from the existing row.
    return this.request("/api/admin/retag", {
      method: "POST",
      body: JSON.stringify({ id, category, isKentucky, county, counties }),
    });
  }

  async updateAdminArticleDateTime({ id, publishedAt }) {
    return this.request("/api/admin/article/update-datetime", {
      method: "POST",
      body: JSON.stringify({ id, publishedAt }),
    });
  }

  async updateAdminArticleLinks({ id, canonicalUrl, sourceUrl }) {
    return this.request("/api/admin/article/update-links", {
      method: "POST",
      body: JSON.stringify({ id, canonicalUrl, sourceUrl }),
    });
  }

  // manually trigger update-check logic on a single article
  async checkArticleUpdate({ id }) {
    return this.request(`/api/admin/articles/${id}/check-update`, {
      method: "POST",
    });
  }

  async adminCheckUpdates() {
    return this.request("/api/admin/check-updates", {
      method: "POST",
    });
  }

  async deleteAdminArticle({ id, block = false, reason = "" }) {
    return this.request("/api/admin/article/delete", {
      method: "POST",
      body: JSON.stringify({ id, block, reason }),
    });
  }

  async getBlockedArticles() {
    return this.request("/api/admin/blocked");
  }

  async unblockArticle({ id }) {
    return this.request("/api/admin/blocked/unblock", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
  }

  /**
   * Preview a Facebook post by URL.
   * Returns { ok, title, body, imageUrl, publishedAt, message? }
   * When ok=false the message explains why (no token, bad URL, etc.) and title/body/imageUrl are null.
   */
  async previewFacebookPost(fbUrl) {
    return this.request("/api/admin/facebook/preview", {
      method: "POST",
      body: JSON.stringify({ url: fbUrl }),
    });
  }

  /**
   * Generate a Facebook caption for an existing article.  The worker will
   * return an empty string for non-Kentucky items.
   */
  async facebookCaption(id) {
    return this.request("/api/admin/facebook/caption", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
  }

  /**
   * Post the caption/link to the configured Facebook page.  Requires that
   * FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN are set on the worker.
   * The returned object mirrors the Graph API response or contains an
   * error message if something went wrong.
   */
  async facebookPost(id) {
    return this.request("/api/admin/facebook/post", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
  }

  /**
   * Manually create an article from supplied fields (e.g. a Facebook post pasted by an admin).
   * Returns { status: 'inserted'|'duplicate', id, isDraft, category, county, canonicalUrl }
   */
  async createManualArticle({ title, author, body, imageUrl, sourceUrl, county, isDraft, publishedAt, category, isKentucky, ignoreSimilarity }) {
    const payload = { title, author, body, imageUrl, sourceUrl, county, isDraft, publishedAt };
    if (category !== undefined) payload.category = category;
    if (isKentucky !== undefined) payload.isKentucky = isKentucky;
    if (ignoreSimilarity) payload.ignoreSimilarity = true;
    return this.request("/api/admin/manual-article", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  /**
   * Upload a single image file for use in an article.  The returned object
   * contains a proxy URL (under /api/media/) that is safe to pass as the
   * `imageUrl` property on article creation or editing.  This method bypasses
   * the normal `request` helper because it must send `FormData` instead of
   * JSON and the helper always sets a JSON content type header.
   */
  async uploadAdminImage(file) {
    const form = new FormData();
    form.append('file', file);
    const headers = {};
    const panelKey = this.getAdminPanelKey();
    if (panelKey) headers['x-admin-key'] = panelKey;
    const resp = await fetch(`${this.adminBaseUrl}/api/admin/upload-image`, {
      method: 'POST',
      body: form,
      headers,
    });
    return resp.json();
  }

  /**
   * Request a preview of what would happen if the given URL were ingested.
   * The result mirrors the normal ingest response but includes extra fields
   * (title, summary, category, etc) and no database row is created.
   */
  async previewIngestUrl(url) {
    return this.request("/api/admin/ingest-url-preview", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  }

  /**
   * Actually perform an admin ingest of the given URL.  This is the same
   * operation that the preview endpoint simulates, but it creates the
   * database row and returns the normal ingest response object.
   */
  async adminIngestUrl(url) {
    return this.request("/api/admin/ingest-url", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  }

  /**
   * Update the title and/or summary of an existing article.
   * Returns { ok: true, id }
   */
  async updateAdminArticleContent({ id, title, summary, imageUrl }) {
    const payload = { id, title, summary };
    if (imageUrl !== undefined) {
      payload.imageUrl = imageUrl;
    }
    return this.request("/api/admin/article/update-content", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  setAdminPanelKey(value) {
    const key = String(value || "").trim();
    if (!key) {
      sessionStorage.removeItem(ADMIN_SESSION_KEY);
      return;
    }
    sessionStorage.setItem(ADMIN_SESSION_KEY, key);
  }

  getAdminPanelKey() {
    try {
      return sessionStorage.getItem(ADMIN_SESSION_KEY) || "";
    } catch {
      return "";
    }
  }

  async getWeatherByZip(zip) {
    const normalizedZip = String(zip || "").trim();
    if (!/^\d{5}$/.test(normalizedZip)) {
      throw toError(null, "Please enter a valid 5-digit ZIP code.");
    }

    const geoRes = await fetch(`https://api.zippopotam.us/us/${normalizedZip}`);
    if (!geoRes.ok) {
      throw toError(null, "ZIP code not found.");
    }
    const geo = await geoRes.json();
    const place = geo?.places?.[0];
    const lat = Number(place?.latitude);
    const lon = Number(place?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw toError(null, "Unable to resolve coordinates for this ZIP code.");
    }

    const forecastRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=America%2FNew_York&temperature_unit=fahrenheit&wind_speed_unit=mph&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max`
    );
    const forecast = forecastRes.ok ? await forecastRes.json() : null;

    const alertsRes = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lon}`);
    const alertsJson = alertsRes.ok ? await alertsRes.json() : { features: [] };

    return {
      zip: normalizedZip,
      city: place?.["place name"] || "",
      state: place?.state || "",
      latitude: lat,
      longitude: lon,
      current: forecast?.current ?? null,
      daily: forecast?.daily ?? null,
      alerts: Array.isArray(alertsJson?.features)
        ? alertsJson.features.slice(0, 5).map((f) => ({
            title: f?.properties?.headline || f?.properties?.event || "Weather Alert",
            event: f?.properties?.event || "",
            severity: f?.properties?.severity || "",
            urgency: f?.properties?.urgency || "",
            certainty: f?.properties?.certainty || "",
            areaDesc: f?.properties?.areaDesc || "",
            senderName: f?.properties?.senderName || "",
            sent: f?.properties?.sent || "",
            effective: f?.properties?.effective || "",
            expires: f?.properties?.expires || "",
            description: f?.properties?.description || "",
            instruction: f?.properties?.instruction || "",
            response: f?.properties?.response || "",
            web: f?.properties?.web || "",
          }))
        : [],
    };
  }

  getPostByHref(href) {
    return fetch(href)
      .then((resp) => resp.json())
      .then((data) => {
        if (data?.title?.rendered) {
          return {
            title: data.title.rendered,
            date: data.date,
            shortDesc: data.excerpt?.rendered || "",
            description: data.content?.rendered || "",
            image:
              data?._embedded?.["wp:featuredmedia"]?.["0"]?.source_url ||
              DEFAULT_IMAGE,
            imageText: data.title.rendered,
            link: "/post",
            originalLink: data.link || href,
            categories: [],
            county: null,
            tags: [],
          };
        }

        if (data?.items?.length > 0) {
          return mapWorkerArticleToPost(data.items[0]);
        }

        return null;
      })
      .catch((err) => err);
  }

  /**
   * Fetch Day 1/2/3 SPC convective outlook articles for the weather page.
   * Returns { outlooks: SpcOutlook[] } where each outlook has:
   *   day, title, description, body, link, imageUrl, publishedAt
   */
  async getSpcOutlooks() {
    try {
      const data = await this.request("/api/spc-outlooks");
      return Array.isArray(data?.outlooks) ? data.outlooks : [];
    } catch {
      return [];
    }
  }

  /**
   * Fetch weather briefings from NWS Louisville (LMK), Jackson (JKL), and Paducah (PAH).
   * Returns an array of office objects, each with officeName, officeArea, stories, and images.
   */
  async getNwsStories() {
    try {
      const data = await this.request("/api/nws-stories");
      return Array.isArray(data?.offices) ? data.offices : [];
    } catch {
      return [];
    }
  }
}
