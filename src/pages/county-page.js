import React, { useEffect, useState } from "react";
import { makeStyles } from "@material-ui/core/styles";
import {
  Typography,
  Divider,
  IconButton,
  Button,
  Box,
} from "@material-ui/core";
import ShareIcon from "@material-ui/icons/Share";
import FavoriteIcon from "@material-ui/icons/Favorite";
import SiteService from "../services/siteService";
import FeaturedPost from "../components/featured-post-component";
import Posts from "../components/home/posts-component";
import Skeletons from "../components/skeletons-component";
import SnackbarNotify from "../components/snackbar-notify-component";
import { slugToCounty, getCountyIntro, countyToSlug } from "../utils/functions";
import { useParams, useHistory } from "react-router-dom";
import { __RouterContext } from "react-router";
import { ToggleSavedCounty, GetSavedCounties } from "../services/storageService";

const useStyles = makeStyles((theme) => ({
  root: {},
  headerActions: {
    display: "inline-flex",
    verticalAlign: "middle",
    marginLeft: theme.spacing(1),
  },
  backLink: {
    marginBottom: theme.spacing(2),
  },
  divider: {
    margin: theme.spacing(2, 0),
  },
}));

const service = new SiteService();

const SITE_URL = "https://localkynews.com";

/** Inject JSON-LD structured data for a county page */
function setCountyJsonLd(countyName) {
  const pageUrl = `${SITE_URL}/news/kentucky/${countyName.toLowerCase().replace(/\s+/g, "-")}-county`;
  const schema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${countyName} County, KY News`,
    description: `Latest news from ${countyName} County, Kentucky — including local government, schools, sports, weather, and community updates.`,
    url: pageUrl,
    publisher: { "@type": "Organization", name: "Local KY News", url: SITE_URL },
    breadcrumb: {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Kentucky Counties", item: `${SITE_URL}/local` },
        { "@type": "ListItem", position: 3, name: `${countyName} County`, item: pageUrl },
      ],
    },
  };
  let el = document.getElementById("json-ld-county");
  if (!el) {
    el = document.createElement("script");
    el.type = "application/ld+json";
    el.id = "json-ld-county";
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(schema);
}

/**
 * Returns a 300–500 word introductory text about a given KY county.
 * Used to satisfy Section 5.4 of the SEO implementation plan.
 */

export default function CountyPage({ countySlugProp = null, onClose = null }) {
  const classes = useStyles();
  // Determine if we're within a router context (dialogs may break the context due
  // to portals).  We'll always call the hooks but only use them when a router
  // exists so we don't violate the Rules of Hooks by changing call order.
  const router = React.useContext(__RouterContext);
  const hasRouter = !!router;
  const params = useParams();
  const history = useHistory();

  const countySlug = countySlugProp || (hasRouter ? params.countySlug : "") || "";

  const countyName = slugToCounty(countySlug);

  const [posts, setPosts] = useState([]);
  const [statePosts, setStatePosts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errors, setErrors] = useState("");
  const [saved, setSaved] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState("");
  // County intro: first paragraph always visible, rest collapsed by default
  const [introExpanded, setIntroExpanded] = useState(false);

  // update page metadata when county changes
  useEffect(() => {
    if (!countyName) return;

    document.title = `${countyName} County, KY News — Local KY News`;
    const description = `The latest news from ${countyName} County, Kentucky — local government, schools, sports, weather, and community stories.`;
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", description);

    // Self-referencing canonical (Section 5.2)
    const pageUrl = `${SITE_URL}/news/kentucky/${countyName.toLowerCase().replace(/\s+/g, "-")}-county`;
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.setAttribute("rel", "canonical");
      document.head.appendChild(canonical);
    }
    canonical.setAttribute("href", pageUrl);

    // JSON-LD schema (Section 5.5)
    setCountyJsonLd(countyName);
  }, [countyName]);

  // Determine whether this county is in the dedicated saved-counties list.
  useEffect(() => {
    if (!countyName) return;
    const savedCounties = GetSavedCounties();
    setSaved(savedCounties.includes(countyName));
  }, [countyName]);

  // fetch county-specific posts (and fallback state posts if needed)
  useEffect(() => {
    if (!countyName) return;
    setIsLoading(true);
    setErrors("");

    service
      .getPosts({ category: "today", counties: [countyName], limit: 50 })
      .then((countyData) => {
        setPosts(countyData);

        if (countyData.length < 5) {
          // grab some extra statewide kentucky posts to pad the page
          return service
            .getPosts({ category: "today", limit: 10 })
            .then((stateData) => {
              const extras = stateData
                .filter((p) => p.county !== countyName)
                .slice(0, 5 - countyData.length);
              setStatePosts(extras);
            });
        }
      })
      .catch((err) => {
        setErrors(err.errorMessage || "Failed to load posts.");
      })
      .finally(() => setIsLoading(false));
  }, [countyName]);

  const handleShare = async () => {
    const title = `${countyName} County, KY News`;
    // build canonical URL rather than relying on window.location (which will be
    // "/local" when this page is shown via dialog).
    const slug = countyToSlug(countyName);
    const url = `${SITE_URL}/news/kentucky/${slug}`;
    const text = `Latest from ${countyName} County on Kentucky News`;

    try {
      if (navigator.share) {
        await navigator.share({ title, text, url });
      } else {
        await navigator.clipboard.writeText(url);
        setSnackbarMessage("Link copied to clipboard");
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleSave = () => {
    if (!countyName) return;
    const nowSaved = ToggleSavedCounty(countyName);
    setSaved(nowSaved);

    if (nowSaved) {
      // Saving a county only bookmarks it; feed filters are managed in Settings.
      setSnackbarMessage(
        `${countyName} County saved. To filter your home feed by county, go to Settings → County Filters.`
      );
    } else {
      setSnackbarMessage(`${countyName} County removed from saved list.`);
    }
  };

  const handleBack = () => {
    // unused since we no longer show a back button; navigation is handled
    // by the UI that opened this page/dialog.
    if (countySlugProp && props?.onClose) {
      props.onClose();
    } else if (history) {
      history.push("/local");
    }
  };

  if (!countyName) {
    return (
      <div>
        <Typography variant="h5">County not found</Typography>
        <Typography variant="body2">
          The URL you provided does not match a valid Kentucky county.
        </Typography>
      </div>
    );
  }

  return (
    <div className={classes.root}>
      <Typography variant="h5" gutterBottom>
        {countyName} County
        <span className={classes.headerActions}>
          <IconButton
            color="primary"
            size="small"
            aria-label="Share county"
            onClick={handleShare}
          >
            <ShareIcon fontSize="small" />
          </IconButton>
          <IconButton
            color={saved ? "secondary" : "primary"}
            size="small"
            aria-label="Save county"
            onClick={handleSave}
          >
            <FavoriteIcon fontSize="small" />
          </IconButton>
        </span>
      </Typography>

      {/* County introductory content — 300–500 words (Section 5.4)
           First paragraph always visible; remaining paragraphs collapsible. */}
      <Box
        style={{
          background: "#f5f8ff",
          border: "1px solid #d0d9f0",
          borderRadius: 6,
          padding: "14px 16px",
          marginBottom: 20,
        }}
      >
        {getCountyIntro(countyName)
          .split("\n\n")
          .map((para, i) => {
            if (i === 0) {
              return (
                <Typography key={i} variant="body2" color="textSecondary" paragraph style={{ marginBottom: 8 }} dangerouslySetInnerHTML={{ __html: para }} />
              );
            }
            if (!introExpanded) return null;
            return (
              <Typography key={i} variant="body2" color="textSecondary" paragraph style={{ marginBottom: i < 2 ? 8 : 0 }} dangerouslySetInnerHTML={{ __html: para }} />
            );
          })}
        <Button
          size="small"
          color="primary"
          onClick={() => setIntroExpanded((v) => !v)}
          style={{ padding: "0 0 4px", minWidth: 0, textTransform: "none", fontSize: "0.78rem" }}
        >
          {introExpanded ? "Show less" : "Show more"}
        </Button>
      </Box>
      <Divider style={{ marginBottom: 16 }} />

      {isLoading ? (
        <Skeletons showFeaturedSkeleton />
      ) : (
        <>
          {errors && (
            <Typography color="error" variant="body2">
              {errors}
            </Typography>
          )}

          {posts && posts.length > 0 ? (
            <>
              <FeaturedPost post={posts[0]} />
              <Posts posts={posts.slice(1)} />
            </>
          ) : (
            <Typography variant="body1">
              No articles found for {countyName} County.
            </Typography>
          )}

          {posts.length < 5 && statePosts.length > 0 && (
            <>
              <Divider className={classes.divider} />
              <Typography variant="subtitle1" gutterBottom>
                More from Kentucky
              </Typography>
              <Posts posts={statePosts} />
            </>
          )}
        </>
      )}

      {snackbarMessage && <SnackbarNotify message={snackbarMessage} />}
    </div>
  );
}
