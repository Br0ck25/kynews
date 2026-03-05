import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import Post from "../components/post/post-component";
import { Button, Typography, Card, CardContent } from "@material-ui/core";
import { useParams, useLocation, Link as RouterLink } from "react-router-dom";
import SiteService from "../services/siteService";
import { articleToUrl } from "../utils/functions";

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
// allow optional FB App ID to be provided via environment variables
const FB_APP_ID =
  (import.meta.env.REACT_APP_FB_APP_ID || import.meta.env.VITE_FB_APP_ID || "").trim();

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

    document.title = post.title ? `${post.title} — ${SITE_NAME}` : SITE_NAME;

    const desc = post.seoDescription || post.shortDesc || "";
    const cleanDesc = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);

    setMeta("name", "description", cleanDesc);
    setCanonical(pageUrl);

    setMeta("property", "og:type", "article");
    setMeta("property", "og:title", post.title || SITE_NAME);
    setMeta("property", "og:description", cleanDesc);
    setMeta("property", "og:url", pageUrl);
    setMeta("property", "og:site_name", SITE_NAME);
    // ensure OG image is always absolute; fall back to generic preview graphic
    const defaultImage = `${SITE_URL}/img/preview.PNG`;
    setMeta("property", "og:image", post.image || defaultImage);

    setMeta("name", "twitter:card", "summary_large_image");
    setMeta("name", "twitter:title", post.title || SITE_NAME);
    setMeta("name", "twitter:description", cleanDesc);
    setMeta("name", "twitter:image", post.image || defaultImage);
    if (FB_APP_ID) setMeta("property", "fb:app_id", FB_APP_ID);

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
      // restore default image tags as well so the generic shell metadata is
      // always present when leaving an article page.
      setMeta("property", "og:image", `${SITE_URL}/img/preview.PNG`);
      setMeta("name", "twitter:image", `${SITE_URL}/img/preview.PNG`);
      setMeta("property", "fb:app_id", FB_APP_ID || "0");
      document.getElementById("json-ld-article")?.remove();
      document.getElementById("json-ld-breadcrumb-post")?.remove();
    };
  }, [resolvedPost]);

  return (
    <div className={classes.root}>
      <Card data-testid="page-card" className={classes.card}>
        <CardContent>
          {resolvedPost ? (
            <Post post={resolvedPost} />
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
