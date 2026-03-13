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
const DEFAULT_OG_IMAGE = 'https://localkynews.com/img/preview.png';
const NOINDEX_WORD_THRESHOLD = 150;
let FB_APP_ID = '';
try {
  // eslint-disable-next-line no-eval
  const env = eval(String.fromCharCode(105,109,112,111,114,116) + '.meta.env');
  FB_APP_ID = (env.REACT_APP_FB_APP_ID || env.VITE_FB_APP_ID || '').trim();
} catch (e) {
  FB_APP_ID = '';
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

export default function PostPage() {
  const classes = useStyles();
  const location = useLocation();
  const reduxPost = useSelector((state) => state.post);
  const [resolvedPost, setResolvedPost] = React.useState(location?.state?.post || reduxPost || null);
  const [loading, setLoading] = React.useState(false);
  const service = React.useMemo(() => new SiteService(), []);

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

    const robotsContent = (post.rawWordCount ?? post.wordCount ?? 0) < NOINDEX_WORD_THRESHOLD
      ? "noindex,follow"
      : "index,follow";
    setMeta("name", "robots", robotsContent);

    // Open Graph
    setMeta("property", "og:type", "article");
    setMeta("property", "og:title", post.title || SITE_NAME);
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
    // fixed dimensions for schema use.  this mirrors the logic on the
    // client-side page so failures are consistent.
    let ogImage = post.image || defaultImage;
    if (ogImage && !/^https?:\/\//i.test(ogImage)) {
      try {
        ogImage = new URL(ogImage, SITE_URL).toString();
      } catch {
        // leave it alone
      }
    }
    setMeta("property", "og:image", ogImage);

    // Twitter card
    setMeta("name", "twitter:card", "summary_large_image");
    setMeta("name", "twitter:title", post.title || SITE_NAME);
    setMeta("name", "twitter:description", cleanDesc);
    setMeta("name", "twitter:image", ogImage);

    // dimensions for schema.org image object (see ArticleSlugPage)
    let schemaImageWidth = 1200;
    let schemaImageHeight = 630;
    if (ogImage === "https://localkynews.com/img/logo512.png") {
      schemaImageWidth = 512;
      schemaImageHeight = 512;
    }
    if (FB_APP_ID) setMeta("property", "fb:app_id", FB_APP_ID);

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
      ...(post.image
        ? {
            image: {
              "@type": "ImageObject",
              url: ogImage,
              width: schemaImageWidth,
              height: schemaImageHeight,
            },
          }
        : {}),
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
      setMeta("property", "og:image", `${SITE_URL}/img/preview.png`);
      setMeta("name", "twitter:image", `${SITE_URL}/img/preview.png`);
      setMeta("property", "fb:app_id", FB_APP_ID || "0");
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

