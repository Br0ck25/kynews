import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import Post from "../components/post/post-component";
import AlertPolygonMap from "../components/weather/alert-polygon-map";
import { Button, Typography, Card, CardContent } from "@material-ui/core";
import { useParams, useLocation, Link as RouterLink } from "react-router-dom";
import SiteService from "../services/siteService";
import { articleToUrl, buildPageTitle, countyToSlug } from "../utils/functions";
import Constants from "../constants/constants";

const useStyles = makeStyles((theme) => ({
  root: { marginTop: 15 },
  card: {
    marginBottom: 16,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: theme.palette.background.paper,
    boxShadow: theme.shadows[1],
    transition: "transform .18s ease, box-shadow .18s ease",
    "&:hover": {
      transform: "translateY(-1px)",
      boxShadow: theme.shadows[3],
    },
  },
  emptyState: { textAlign: "center", padding: "24px 16px" },
  emptyAction: { marginTop: 16 },
}));

const SITE_URL = "https://localkynews.com";
const SITE_NAME = "Local KY News";
const DEFAULT_OG_IMAGE = 'https://localkynews.com/img/og-default.png';
const LOGO_IMAGE = 'https://localkynews.com/img/logo512.png';
const { NOINDEX_WORD_THRESHOLD, SNIPPET_LIMIT_THRESHOLD } = Constants;
// Allow optional FB App ID to be provided via environment variables.
// This reads from import.meta.env in Vite or falls back to process.env for tests.
function getFbAppId() {
  try {
    // `import.meta` is not parsable by Jest's Babel, so access via eval at runtime.
    // eslint-disable-next-line no-eval
    const env = eval(String.fromCharCode(105,109,112,111,114,116) + '.meta.env');
    return (env.REACT_APP_FB_APP_ID || env.VITE_FB_APP_ID || '').trim();
  } catch {
    return (process?.env?.REACT_APP_FB_APP_ID || process?.env?.VITE_FB_APP_ID || '').trim();
  }
}

function setMeta(attr, value, content) {
  let el = document.querySelector(`meta[${attr}="${value}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, value);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setCanonical(href) {
  let el = document.querySelector('link[rel="canonical"]');
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", "canonical");
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

function setJsonLd(id, data) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("script");
    el.type = "application/ld+json";
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(data);
}

function getRobotsContent(wordCount) {
  const wc = wordCount ?? 0;
  if (wc < NOINDEX_WORD_THRESHOLD) return "noindex,follow";
  if (wc < SNIPPET_LIMIT_THRESHOLD) return "index,follow,max-snippet:160";
  return "index,follow";
}

const DESCRIPTION_MIN_LENGTH = 50;
const DESCRIPTION_MAX_LENGTH = 155;

function decodeHtmlEntities(input) {
  if (!input) return "";
  const withNamedEntities = input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x3D;/g, "=");

  return withNamedEntities
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&#([0-9]+);/g, (_, num) => {
      const code = parseInt(num, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });
}

function stripHtmlTags(input) {
  return (input || "").replace(/<[^>]*>/g, " ");
}

function trimLeadingSentenceFragment(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return trimmed;

  const firstLetterMatch = trimmed.match(/[A-Za-z]/);
  if (!firstLetterMatch) return trimmed;
  const idx = firstLetterMatch.index ?? 0;
  const firstLetter = trimmed[idx];
  if (firstLetter && firstLetter === firstLetter.toUpperCase()) return trimmed;

  const boundaryRegex = /[.!?](?:["')\]]+)?\s+/g;
  let match;
  while ((match = boundaryRegex.exec(trimmed))) {
    if (match.index >= idx) {
      return trimmed.slice(match.index + match[0].length).trim();
    }
  }
  return trimmed;
}

function truncateAtWordBoundary(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  const sliced = text.slice(0, maxLength);
  const lastSpace = sliced.lastIndexOf(" ");
  const truncated = lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced;
  return `${truncated.trim()}...`;
}

function formatCountyLabel(county) {
  if (!county) return "Kentucky";
  const trimmed = county.trim();
  return /county$/i.test(trimmed) ? trimmed : `${trimmed} County`;
}

function buildShortDescription(shortDesc) {
  let text = decodeHtmlEntities(stripHtmlTags(shortDesc || ""));
  text = text.replace(/\s+/g, " ").trim();
  text = trimLeadingSentenceFragment(text);
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return truncateAtWordBoundary(text, DESCRIPTION_MAX_LENGTH);
}

function buildMetaDescription(post) {
  const seoDescription = (post?.seoDescription || "").trim();
  if (seoDescription) return seoDescription;

  const shortDesc = buildShortDescription(post?.shortDesc || "");
  if (shortDesc && shortDesc.length >= DESCRIPTION_MIN_LENGTH) return shortDesc;

  const countyLabel = formatCountyLabel(post?.county);
  const title = (post?.title || "Local KY News").trim() || "Local KY News";
  return `${countyLabel}, KY — ${title} | Local KY News`;
}

/**
 * Renders an article loaded by slug from the URL params.
 * Works for all three slug-based route patterns:
 *   /news/kentucky/:countySlug/:articleSlug
 *   /news/national/:articleSlug
 *   /news/kentucky/:countySlug  (when countySlug is NOT a county — dispatched from KentuckyNewsPage)
 */
export default function ArticleSlugPage() {
  const classes = useStyles();
  const params = useParams();
  const location = useLocation();

  // articleSlug was previously pulled from params or countySlug depending on which
  // route was active.  That approach broke when the URL contains an extra county
  // segment (e.g. `/news/kentucky/adair-county/my-story-123`) because the
  // dispatcher route treated the article slug as `infoType` and params only
  // held the county slug.  Instead we compute the slug robustly as the **last
  // non-empty segment in the path**, which works for all variants:
  //   /news/national/:slug
  //   /news/kentucky/:county/:slug
  //   /news/kentucky/:slug          (statewide article)
  // and also handles the dispatcher case where the path is forwarded without a
  // dedicated route parameter.
  const slug = React.useMemo(() => {
    const parts = location.pathname.split("/").filter(Boolean);
    return parts.pop() || "";
  }, [location.pathname]);

  const [resolvedPost, setResolvedPost] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const service = React.useMemo(
    // baseUrl is resolved internally, so just use the default constructor
    () => new SiteService(),
    []
  );

  const [relatedPosts, setRelatedPosts] = React.useState([]);
  const [relatedLoading, setRelatedLoading] = React.useState(false);

  React.useEffect(() => {
    const county = resolvedPost?.county;
    if (!county) {
      setRelatedPosts([]);
      return;
    }

    setRelatedLoading(true);
    service
      .fetchPage({ category: 'today', counties: [county], limit: 10 })
      .then((result) => {
        const posts = (result.posts || []).filter((p) => p.id !== resolvedPost?.id);
        setRelatedPosts(posts.slice(0, 4));
      })
      .catch(() => {})
      .finally(() => setRelatedLoading(false));
  }, [resolvedPost, service]);

  React.useEffect(() => {
    if (!slug) {
      setLoading(false);
      return;
    }
    setLoading(true);
    service
      .getPostBySlug(slug)
      .then((post) => setResolvedPost(post))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug, service]);

  // Inject SEO meta, canonical, JSON-LD when post is resolved
  React.useEffect(() => {
    const post = resolvedPost;
    if (!post) return;

    const pageUrl = `${SITE_URL}${articleToUrl(post)}`;

    const pageTitle = buildPageTitle(post.title, post.county, post.isKentucky);
    document.title = pageTitle;

    const cleanDesc = buildMetaDescription(post);

    setMeta("name", "description", cleanDesc);
    setCanonical(pageUrl);

    const robotsContent = getRobotsContent(post.rawWordCount ?? post.wordCount);
    setMeta("name", "robots", robotsContent);

    setMeta("property", "og:type", "article");
    setMeta("property", "og:title", pageTitle);
    setMeta("property", "og:description", cleanDesc);
    setMeta("property", "og:url", pageUrl);
    setMeta("property", "og:site_name", SITE_NAME);
    // add article published/modified times if present (ISO8601 strings from DB)
    const publishedTime = post.publishedAt || post.date || "";
    if (publishedTime) {
      setMeta("property", "article:published_time", publishedTime);
    }
    const modifiedTime = post.updatedAt || post.publishedAt || post.date || "";
    if (modifiedTime) {
      setMeta("property", "article:modified_time", modifiedTime);
    }
    // ensure OG image is always absolute; fall back to the default 1200x630
    // preview image when the article itself doesn't provide an image.
    const defaultImage = DEFAULT_OG_IMAGE;
    // post.image may be a relative path so coerce to a full URL like the
    // server-side preview logic does.  this only affects clients, but it
    // prevents the DOM-based tags from ending up with "/foo.jpg" which
    // crawlers could potentially misinterpret.
    let ogImage = post.image || defaultImage;
    if (ogImage && !/^https?:\/\//i.test(ogImage)) {
      try {
        ogImage = new URL(ogImage, SITE_URL).toString();
      } catch {
        // ignore and keep whatever value we already had
      }
    }
    if (ogImage === LOGO_IMAGE) {
      ogImage = DEFAULT_OG_IMAGE;
    }
    setMeta("property", "og:image", ogImage);
    setMeta("property", "og:image:width", "1200");
    setMeta("property", "og:image:height", "630");

    // For schema.org, declare fixed dimensions only for the default image.
    const imageObject = {
      "@type": "ImageObject",
      url: ogImage,
      ...(ogImage === DEFAULT_OG_IMAGE ? { width: 1200, height: 630 } : {}),
    };

    setMeta("name", "twitter:card", "summary_large_image");
    setMeta("name", "twitter:title", pageTitle);
    setMeta("name", "twitter:description", cleanDesc);
    setMeta("name", "twitter:image", ogImage);
    setMeta('name', 'twitter:site', '@LocalKYNews');
    const fbAppId = getFbAppId();
    if (fbAppId) setMeta("property", "fb:app_id", fbAppId);

    // alternate plain-text version for AI crawlers
    const textUrl = `${pageUrl}?format=text`;
    let altLink = document.querySelector('link[rel="alternate"][type="text/plain"]');
    if (!altLink) {
      altLink = document.createElement('link');
      altLink.setAttribute('rel', 'alternate');
      altLink.setAttribute('type', 'text/plain');
      document.head.appendChild(altLink);
    }
    altLink.setAttribute('href', textUrl);

    const publisherName =
      post.sourceName ||
      (() => {
        try {
          return new URL(post.originalLink || "").hostname.replace(/^www\./, "");
        } catch {
          return SITE_NAME;
        }
      })();

    const publisherUrl = (() => {
      try {
        const hostname = new URL(post.canonicalUrl || post.originalLink || "").hostname.replace(/^www\./, "");
        return hostname ? `https://${hostname}` : "https://localkynews.com";
      } catch {
        return "https://localkynews.com";
      }
    })();

    const newsArticleSchema = {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      headline: post.title,
      description: cleanDesc,
      url: pageUrl,
      mainEntityOfPage: { "@type": "WebPage", "@id": pageUrl },
      datePublished: post.date || post.publishedAt,
      dateModified: post.updatedAt || post.date || post.publishedAt,
      author: post.author
        ? { "@type": "Person", name: post.author }
        : { "@type": "Organization", name: publisherName },
      publisher: {
        "@type": "Organization",
        name: "Local KY News",
        url: "https://localkynews.com",
        logo: {
          "@type": "ImageObject",
          url: "https://localkynews.com/img/logo512.png",
          width: 512,
          height: 512,
        },
      },
      sourceOrganization: {
        "@type": "NewsMediaOrganization",
        name: publisherName,
        url: publisherUrl,
      },
      image: imageObject,
      ...(post.county
        ? {
            contentLocation: {
              "@type": "AdministrativeArea",
              name: `${post.county} County, Kentucky`,
            },
          }
        : post.isKentucky
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
    };

    const countyUrl = post.county
      ? `${SITE_URL}/news/kentucky/${post.county.toLowerCase().replace(/\s+/g, "-")}-county`
      : null;

    const breadcrumbSchema = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        ...(countyUrl
          ? [
              { "@type": "ListItem", position: 2, name: `${post.county} County`, item: countyUrl },
              { "@type": "ListItem", position: 3, name: post.title, item: pageUrl },
            ]
          : [{ "@type": "ListItem", position: 2, name: post.title, item: pageUrl }]),
      ],
    };

    setJsonLd("json-ld-article", newsArticleSchema);
    setJsonLd("json-ld-breadcrumb-post", breadcrumbSchema);

    return () => {
      document.title = SITE_NAME;
      const genericDesc =
        "Kentucky News - local, state, and national updates for all 120 Kentucky counties.";
      setMeta("name", "description", genericDesc);
      setCanonical(SITE_URL);
      setMeta("name", "robots", "index,follow");
      // restore default image tags as well.
      setMeta("property", "og:image", DEFAULT_OG_IMAGE);
      setMeta("property", "og:image:width", "1200");
      setMeta("property", "og:image:height", "630");
      setMeta("name", "twitter:image", DEFAULT_OG_IMAGE);
      setMeta("property", "fb:app_id", getFbAppId() || "0");
      document.getElementById("json-ld-article")?.remove();
      document.getElementById("json-ld-breadcrumb-post")?.remove();
    };
  }, [resolvedPost]);

  return (
    <div className={classes.root}>
      <Card data-testid="page-card" className={classes.card}>
        <CardContent>
          {resolvedPost ? (
            <>
              <Post post={resolvedPost} />
              {resolvedPost.alertGeojson && (
                <AlertPolygonMap geojson={resolvedPost.alertGeojson} />
              )}
              {relatedPosts.length > 0 && (
                <div style={{ marginTop: 24 }}>
                  <Typography variant="h6" gutterBottom>
                    More from {resolvedPost.county} County
                  </Typography>
                  <ul style={{ paddingLeft: 16, marginTop: 8 }}>
                    {relatedPosts.map((post) => (
                      <li key={post.id}>
                        <RouterLink to={articleToUrl(post)}>{post.title}</RouterLink>
                      </li>
                    ))}
                  </ul>
                  <Button
                    component={RouterLink}
                    to={`/news/kentucky/${countyToSlug(resolvedPost.county)}`}
                    color="primary"
                    size="small"
                  >
                    View all {resolvedPost.county} County news →
                  </Button>
                </div>
              )}
            </>
          ) : loading ? (
            <div className={classes.emptyState}>
          <Typography variant="h6" gutterBottom>
            Loading article...
          </Typography>
        </div>
      ) : (
        <div className={classes.emptyState}>
          <Typography variant="h6" gutterBottom>
            We couldn&apos;t find that article.
          </Typography>
          <Typography variant="body2" color="textSecondary">
            It may have expired or the link may be outdated.
          </Typography>
          <Button
            className={classes.emptyAction}
            component={RouterLink}
            to="/today"
            color="primary"
            variant="contained"
          >
            Back to Local KY News
          </Button>
        </div>
      )}
      </CardContent>
      </Card>
    </div>
  );
}
