import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import Post from "../components/post/post-component";
import { Button, Typography } from "@material-ui/core";
import { useLocation, Link as RouterLink } from "react-router-dom";
import { useSelector } from "react-redux";
import SiteService from "../services/siteService";
import { articleToUrl } from "../utils/functions";

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

export default function PostPage() {
  const classes = useStyles();
  const location = useLocation();
  const reduxPost = useSelector((state) => state.post);
  const [resolvedPost, setResolvedPost] = React.useState(location?.state?.post || reduxPost || null);
  const [loading, setLoading] = React.useState(false);
  const service = React.useMemo(() => new SiteService(process.env.REACT_APP_API_BASE_URL), []);

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
    document.title = post.title
      ? `${post.title} — ${SITE_NAME}`
      : SITE_NAME;

    // Meta description
    const desc = post.seoDescription || post.shortDesc || "";
    const cleanDesc = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    setMeta("name", "description", cleanDesc);

    // Canonical (self-referencing — section 5.2)
    setCanonical(pageUrl);

    // Open Graph
    setMeta("property", "og:type", "article");
    setMeta("property", "og:title", post.title || SITE_NAME);
    setMeta("property", "og:description", cleanDesc);
    setMeta("property", "og:url", pageUrl);
    setMeta("property", "og:site_name", SITE_NAME);
    if (post.image) setMeta("property", "og:image", post.image);

    // Twitter card
    setMeta("name", "twitter:card", "summary_large_image");
    setMeta("name", "twitter:title", post.title || SITE_NAME);
    setMeta("name", "twitter:description", cleanDesc);
    if (post.image) setMeta("name", "twitter:image", post.image);

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
        name: publisherName,
        url: post.originalLink
          ? (() => { try { const u = new URL(post.originalLink); return u.origin; } catch { return ""; } })()
          : "",
      },
      ...(post.image ? { image: { "@type": "ImageObject", url: post.image } } : {}),
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
        <Post post={post} />
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

