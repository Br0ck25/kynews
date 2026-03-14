import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import Post from "../components/post/post-component";
import { Button, Typography } from "@material-ui/core";
import { useLocation, Link as RouterLink } from "react-router-dom";
import { useSelector } from "react-redux";
import SiteService from "../services/siteService";
import { articleToUrl, buildPageTitle, countyToSlug } from "../utils/functions";
import Constants from "../constants/constants";

const useStyles = makeStyles({
  root: {
    marginTop: 15,
  },
  emptyState: {
    textAlign: "center",
    padding: "24px 16px",
  },
  emptyAction: {
    marginTop: 16,
  },
});

const SITE_URL = "https://localkynews.com";
const SITE_NAME = "Local KY News";
const DEFAULT_OG_IMAGE = 'https://localkynews.com/img/og-default.png';
const LOGO_IMAGE = 'https://localkynews.com/img/logo512.png';
const { NOINDEX_WORD_THRESHOLD, SNIPPET_LIMIT_THRESHOLD } = Constants;
function getFbAppId() {
  try {
    // eslint-disable-next-line no-eval
    const env = eval(String.fromCharCode(105,109,112,111,114,116) + '.meta.env');
    return (env.REACT_APP_FB_APP_ID || env.VITE_FB_APP_ID || '').trim();
  } catch (e) {
    // import.meta not available or eval blocked (e.g., Jest tests).
    // Fall back to process.env values when available.
    return (process?.env?.REACT_APP_FB_APP_ID || process?.env?.VITE_FB_APP_ID || '').trim();
  }
}

/**
 * Injects/updates a <meta> tag in <head> by name or property.
 * Creates the element if it doesn't exist.
 */
function setMeta(attr, value, content) {
  let el = document.querySelector(`meta[${attr}="${value}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, value);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

/**
 * Injects/updates the canonical <link> tag.
 */
function setCanonical(href) {
  let el = document.querySelector('link[rel="canonical"]');
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", "canonical");
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

/**
 * Injects/updates a JSON-LD <script> block with the given id.
 */
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

export default function PostPage() {
  const classes = useStyles();
  const location = useLocation();
  const reduxPost = useSelector((state) => state.post);
  const [resolvedPost, setResolvedPost] = React.useState(location?.state?.post || reduxPost || null);
  const [loading, setLoading] = React.useState(false);
  const service = React.useMemo(() => new SiteService(), []);

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

  // Resolve from ?articleId= query param if not already in state/redux
  React.useEffect(() => {
    if (resolvedPost) return;
    const params = new URLSearchParams(location.search || "");
    const articleId = params.get("articleId");
    if (!articleId) return;

    setLoading(true);
    service
      .getPostById(articleId)
      .then((post) => setResolvedPost(post))
      .catch(() => setResolvedPost(null))
      .finally(() => setLoading(false));
  }, [location.search, resolvedPost, service]);

  // Inject SEO meta, canonical, and JSON-LD when post is resolved
  React.useEffect(() => {
    const post = resolvedPost;
    if (!post) return;

    const params = new URLSearchParams(location.search || "");
    const articleId = params.get("articleId") || post.id;
    // Prefer a clean SEO URL when the post has a slug; fall back to legacy ?articleId= URL
    const cleanPath = articleToUrl(post);
    const pageUrl = cleanPath.startsWith('/post?')
      ? (articleId ? `${SITE_URL}/post?articleId=${articleId}` : `${SITE_URL}/post`)
      : `${SITE_URL}${cleanPath}`;

    // Page title
    const pageTitle = buildPageTitle(post.title, post.county, post.isKentucky);
    document.title = pageTitle;

    // Meta description
    const desc = post.seoDescription || post.shortDesc || "";
    const cleanDesc = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    setMeta("name", "description", cleanDesc);

    // Canonical (self-referencing — section 5.2)
    setCanonical(pageUrl);

    const robotsContent = getRobotsContent(post.rawWordCount ?? post.wordCount);
    setMeta("name", "robots", robotsContent);

    // Open Graph
    setMeta("property", "og:type", "article");
    setMeta("property", "og:title", pageTitle);
    setMeta("property", "og:description", cleanDesc);
    setMeta("property", "og:url", pageUrl);
    setMeta("property", "og:site_name", SITE_NAME);
    // article published/modified timestamps
    const publishedTime = post.publishedAt || post.date || "";
    if (publishedTime) {
      setMeta("property", "article:published_time", publishedTime);
    }
    const modifiedTime = post.updatedAt || post.publishedAt || post.date || "";
    if (modifiedTime) {
      setMeta("property", "article:modified_time", modifiedTime);
    }
    const defaultImage = DEFAULT_OG_IMAGE;
    // similar to ArticleSlugPage we normalize an absolute URL and declare
    // fixed dimensions for schema use. this mirrors the logic on the
    // client-side page so failures are consistent.
    let ogImage = post.image || defaultImage;
    if (ogImage && !/^https?:\/\//i.test(ogImage)) {
      try {
        ogImage = new URL(ogImage, SITE_URL).toString();
      } catch {
        // leave it alone
      }
    }
    if (ogImage === LOGO_IMAGE) {
      ogImage = DEFAULT_OG_IMAGE;
    }
    setMeta("property", "og:image", ogImage);
    setMeta("property", "og:image:width", "1200");
    setMeta("property", "og:image:height", "630");

    // Twitter card
    setMeta("name", "twitter:card", "summary_large_image");
    setMeta("name", "twitter:title", pageTitle);
    setMeta("name", "twitter:description", cleanDesc);
    setMeta("name", "twitter:image", ogImage);

    // dimensions for schema.org image object (see ArticleSlugPage)
    const imageObject = {
      "@type": "ImageObject",
      url: ogImage,
      ...(ogImage === DEFAULT_OG_IMAGE ? { width: 1200, height: 630 } : {}),
    };
    const fbAppId = getFbAppId();
    if (fbAppId) setMeta("property", "fb:app_id", fbAppId);

    // alternate plain-text article endpoint
    const textUrl = `${pageUrl}?format=text`;
    let altLink = document.querySelector('link[rel="alternate"][type="text/plain"]');
    if (!altLink) {
      altLink = document.createElement('link');
      altLink.setAttribute('rel', 'alternate');
      altLink.setAttribute('type', 'text/plain');
      document.head.appendChild(altLink);
    }
    altLink.setAttribute('href', textUrl);

    // JSON-LD: NewsArticle schema (section 5.5)
    const publisherName =
      post.sourceName ||
      (() => {
        try {
          return new URL(post.originalLink || "").hostname.replace(/^www\./, "");
        } catch {
          return SITE_NAME;
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
        "@type": "Organization",
        name: publisherName,
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

    // JSON-LD: BreadcrumbList schema
    const breadcrumbSchema = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: SITE_URL,
        },
        ...(post.county
          ? [
              {
                "@type": "ListItem",
                position: 2,
                name: `${post.county} County`,
                item: `${SITE_URL}/news/kentucky/${post.county.toLowerCase().replace(/\s+/g, "-")}-county`,
              },
              { "@type": "ListItem", position: 3, name: post.title, item: pageUrl },
            ]
          : [{ "@type": "ListItem", position: 2, name: post.title, item: pageUrl }]),
      ],
    };

    setJsonLd("json-ld-article", newsArticleSchema);
    setJsonLd("json-ld-breadcrumb-post", breadcrumbSchema);

    // Cleanup on unmount to restore generic site meta
    return () => {
      document.title = SITE_NAME;
      const genericDesc = "Kentucky News - local, state, and national updates for all 120 Kentucky counties.";
      setMeta("name", "description", genericDesc);
      setCanonical(SITE_URL);
      setMeta("name", "robots", "index,follow");
      setMeta("property", "og:image", DEFAULT_OG_IMAGE);
      setMeta("property", "og:image:width", "1200");
      setMeta("property", "og:image:height", "630");
      setMeta("name", "twitter:image", DEFAULT_OG_IMAGE);
      setMeta("property", "fb:app_id", getFbAppId() || "0");
      const ldScript = document.getElementById("json-ld-article");
      if (ldScript) ldScript.remove();
      const bcScript = document.getElementById("json-ld-breadcrumb-post");
      if (bcScript) bcScript.remove();
    };
  }, [resolvedPost, location.search]);

  const post = resolvedPost;

  return (
    <div className={classes.root}>
      {post ? (
        <>
          <Post post={post} />
          {relatedPosts.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <Typography variant="h6" gutterBottom>
                More from {post.county} County
              </Typography>
              <ul style={{ paddingLeft: 16, marginTop: 8 }}>
                {relatedPosts.map((related) => (
                  <li key={related.id}>
                    <RouterLink to={articleToUrl(related)}>
                      {related.title}
                    </RouterLink>
                  </li>
                ))}
              </ul>
              <Button
                component={RouterLink}
                to={`/news/kentucky/${countyToSlug(post.county)}`}
                color="primary"
                size="small"
              >
                View all {post.county} County news →
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
            It may have expired or been opened without a selected post.
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
    </div>
  );
}
