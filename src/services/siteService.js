import { SaveValue, GetValue } from "./storageService";
import { KENTUCKY_COUNTIES } from "../constants/counties";

const DEFAULT_IMAGE = "https://source.unsplash.com/random/1200x800?kentucky-news";
const WORKER_FALLBACK_BASE_URL = "https://worker.jamesbrock25.workers.dev";

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
    title: article?.title ?? "Untitled",
    date: article?.publishedAt ?? new Date().toISOString(),
    shortDesc: article?.summary ?? article?.seoDescription ?? "",
    description: article?.contentHtml ?? article?.summary ?? "",
    contentText: bodyText,
    image: article?.imageUrl ?? DEFAULT_IMAGE,
    imageText: article?.title ?? "Kentucky News",
    link: "/post",
    originalLink: article?.canonicalUrl ?? article?.sourceUrl ?? "",
    categories: article?.category ? [article.category] : [],
    county: article?.county ?? null,
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
    this.devSeedAttempted = false;
  }

  async request(path, options = {}) {
    const requestOptions = {
      headers: {
        "Content-Type": "application/json",
      },
      ...options,
    };

    const targetUrl = `${this.baseUrl}${path}`;
    let response = await fetch(targetUrl, requestOptions);

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

    // If same-origin /api is routed to SPA HTML, retry against worker host.
    if (
      response.ok &&
      (parsed == null || isHtmlLike) &&
      path.startsWith("/api/") &&
      this.baseUrl !== WORKER_FALLBACK_BASE_URL
    ) {
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
