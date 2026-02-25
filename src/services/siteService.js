import { SaveValue, GetValue } from "./storageService";
import { KENTUCKY_COUNTIES } from "../constants/counties";

const DEFAULT_IMAGE = "https://source.unsplash.com/random/1200x800?kentucky-news";
const WORKER_FALLBACK_BASE_URL = "https://worker.jamesbrock25.workers.dev";

const ADMIN_SESSION_KEY = "ky_admin_panel_key";

const ALLOWED_CATEGORIES = [
  "today",
  "national",
  "sports",
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
  return {
    id: article?.id ?? null,
    slug: article?.slug ?? null,
    title: article?.title ?? "Untitled",
    date: article?.publishedAt ?? new Date().toISOString(),
    shortDesc: article?.summary ?? article?.seoDescription ?? "",
    description: article?.contentHtml ?? article?.summary ?? "",
    contentText: bodyText,
    image: article?.imageUrl ?? null,
    imageText: article?.title ?? "Kentucky News",
    link: "/post",
    originalLink: article?.canonicalUrl ?? article?.sourceUrl ?? "",
    sourceUrl: article?.sourceUrl ?? "",
    categories: article?.category ? [article.category] : [],
    county: article?.county ?? null,
    author: article?.author ?? null,
    tags: [],
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
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };

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
    const shouldFallback =
      path.startsWith("/api/") &&
      !isAdminPath &&
      this.baseUrl !== WORKER_FALLBACK_BASE_URL &&
      (parsed == null || isHtmlLike || !response.ok);

    if (shouldFallback) {
      try {
        response = await fetch(`${WORKER_FALLBACK_BASE_URL}${path}`, requestOptions);
        ({ parsed, rawText, isHtmlLike } = await parseResponse(response));
      } catch {
        // Keep original response interpretation below.
      }
    }

    const data = parsed;

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
    const options =
      typeof searchOrOptions === "string"
        ? {
            category: "today",
            search: searchOrOptions,
            limit: perPage,
            counties: [],
          }
        : {
            category: "today",
            search: "",
            limit: perPage,
            counties: [],
            ...searchOrOptions,
          };

    const category = ALLOWED_CATEGORIES.includes(options.category)
      ? options.category
      : "today";

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
  async fetchPage({ category = "today", counties = [], cursor = null, limit = 20 } = {}) {
    const validCategory = ALLOWED_CATEGORIES.includes(category) ? category : "today";
    const params = new URLSearchParams();
    params.set("limit", String(limit));
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

  async retagArticle({ id, category, isKentucky, county }) {
    return this.request("/api/admin/retag", {
      method: "POST",
      body: JSON.stringify({ id, category, isKentucky, county }),
    });
  }

  async updateAdminArticleDateTime({ id, publishedAt }) {
    return this.request("/api/admin/article/update-datetime", {
      method: "POST",
      body: JSON.stringify({ id, publishedAt }),
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
   * Manually create an article from supplied fields (e.g. a Facebook post pasted by an admin).
   * Returns { status: 'inserted'|'duplicate', id, isDraft, category, county, canonicalUrl }
   */
  async createManualArticle({ title, body, imageUrl, sourceUrl, county, isDraft, publishedAt }) {
    return this.request("/api/admin/manual-article", {
      method: "POST",
      body: JSON.stringify({ title, body, imageUrl, sourceUrl, county, isDraft, publishedAt }),
    });
  }

  /**
   * Update the title and/or summary of an existing article.
   * Returns { ok: true, id }
   */
  async updateAdminArticleContent({ id, title, summary }) {
    return this.request("/api/admin/article/update-content", {
      method: "POST",
      body: JSON.stringify({ id, title, summary }),
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
}
