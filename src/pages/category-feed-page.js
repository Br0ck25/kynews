import React, { useEffect, useState, useRef, useCallback } from "react";
import { unstable_batchedUpdates } from "react-dom";
import { makeStyles } from "@material-ui/core/styles";
import {
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Checkbox,
  ListItemText,
  Snackbar,
  IconButton,
  Typography,
  CircularProgress,
  Box,
} from "@material-ui/core";
import CloseIcon from "@material-ui/icons/Close";
import Skeletons from "../components/skeletons-component";
import FeaturedPost from "../components/featured-post-component";
import Posts from "../components/home/posts-component";
import SiteService from "../services/siteService";
import SnackbarNoInternet from "../components/snackbar-no-internet-component";
import { useDispatch, useSelector } from "react-redux";
import { setPosts, setTitle, setSelectedCounties } from "../redux/actions/actions";
import { KENTUCKY_COUNTIES } from "../constants/counties";
import { GetValue, SaveValue } from "../services/storageService";

const useStyles = makeStyles((theme) => ({
  root: {},
  countyFilterWrap: {
    marginBottom: theme.spacing(2),
  },
  close: {
    padding: theme.spacing(0.5),
  },
  loaderWrap: {
    display: "flex",
    justifyContent: "center",
    padding: theme.spacing(3),
  },
}));

const service = new SiteService();
const PAGE_LIMIT = 20;

function setPaginationLinks(prevCursor, nextCursor, baseUrl) {
  // Remove any existing pagination links
  document.querySelectorAll('link[rel="prev"], link[rel="next"]').forEach(el => el.remove());

  if (prevCursor) {
    const prev = document.createElement('link');
    prev.rel = 'prev';
    prev.href = `${baseUrl}?cursor=${encodeURIComponent(prevCursor)}`;
    document.head.appendChild(prev);
  }
  if (nextCursor) {
    const next = document.createElement('link');
    next.rel = 'next';
    next.href = `${baseUrl}?cursor=${encodeURIComponent(nextCursor)}`;
    document.head.appendChild(next);
  }
}

function getPageLimit(_category) {
  return PAGE_LIMIT;
}

export default function CategoryFeedPage({ category, title, countyFilterEnabled = false, filterPosts, hidePageMessages = false }) {
  const classes = useStyles();
  const selectedCounties = useSelector((state) => state.selectedCounties);
  const notifications = useSelector((state) => state.notifications || {});
  const dispatch = useDispatch();

  // Use local state for the full accumulated list (supports infinite pagination)
  const [allPosts, setAllPosts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [errors, setErrors] = useState("");

  // Sentinel element at the bottom of the list triggers next-page load
  const sentinelRef = useRef(null);
  // Ref-based loading guard: prevents double-fetches without forcing the
  // IntersectionObserver to disconnect/reconnect every time loading toggled.
  const isLoadingMoreRef = useRef(false);
  const isMountedRef = useRef(true);
  // Track current category+counties key to detect dependency changes
  const countyKey = (selectedCounties || []).join("|");
  const effectiveCounties = category === "national" ? [] : selectedCounties || [];
  const hasSelectedCounties = (selectedCounties || []).length > 0;

  useEffect(() => {
    dispatch(setTitle(title));

    const setOgTag = (prop, content) => {
      let el = document.querySelector(`meta[property="${prop}"]`);
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute("property", prop);
        document.head.appendChild(el);
      }
      el.setAttribute("content", content);
    };

    const setTwitterTag = (name, content) => {
      let el = document.querySelector(`meta[name="${name}"]`);
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute("name", name);
        document.head.appendChild(el);
      }
      el.setAttribute("content", content);
    };

    const setCanonical = (url) => {
      let el = document.querySelector('link[rel="canonical"]');
      if (!el) {
        el = document.createElement("link");
        el.setAttribute("rel", "canonical");
        document.head.appendChild(el);
      }
      el.setAttribute("href", url);
    };

    const canonicalUrl = `https://localkynews.com${window.location.pathname}`;
    const pageMetaDescription = `Latest ${title.toLowerCase()} updates from across Kentucky, aggregated from local news sources.`;

    setOgTag("og:url", canonicalUrl);
    setOgTag("og:title", title);
    setOgTag("og:description", pageMetaDescription);
    setOgTag("og:type", "website");
    setTwitterTag("twitter:title", title);
    setTwitterTag("twitter:description", pageMetaDescription);
    setCanonical(canonicalUrl);

    // Keep page description in sync with meta tag
    let descriptionMeta = document.querySelector('meta[name="description"]');
    if (!descriptionMeta) {
      descriptionMeta = document.createElement("meta");
      descriptionMeta.name = "description";
      document.head.appendChild(descriptionMeta);
    }
    descriptionMeta.setAttribute("content", pageMetaDescription);
  }, [title, dispatch]);

  // Reset and fetch first page whenever category or county selection changes
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    setAllPosts([]);
    setCursor(null);
    setHasMore(true);
    setIsLoading(true);
    setErrors("");
    isLoadingMoreRef.current = false; // reset ref on category/county change

    let active = true;

    service
      .fetchPage({ category, counties: effectiveCounties, cursor: null, limit: getPageLimit(category) })
      .then(({ posts, nextCursor }) => {
        if (!active || !isMountedRef.current) return;

        // notification logic: compare first post to last seen
        if (posts && posts.length > 0) {
          const firstPost = posts[0];
          const key = `lastSeen_${category}`;
          const lastSeen = GetValue(key);
          const firstId = firstPost.id || firstPost.originalLink || null;
          if (firstId) {
            if (notifications[category] && lastSeen && firstId !== lastSeen) {
              if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                try {
                  new Notification(`New ${title} article`, {
                    body: firstPost.title || "",
                    tag: category,
                    data: { url: firstPost.originalLink || "" },
                  });
                } catch (err) {
                  console.warn("Failed to show notification", err);
                }
              }
            }
            // always store most recent first for future comparisons
            SaveValue(key, firstId);
          }
        }

        // Batch all state updates into one React re-render.
        // React 17 does NOT batch async state updates; without batchedUpdates
        // cursor changes BEFORE isLoading=false so the sentinel effect fires
        // when sentinel is off the DOM, returns early, and is never re-triggered
        // when isLoading later becomes false — infinite scroll completely broken.
        unstable_batchedUpdates(() => {
          setAllPosts(posts);
          setCursor(nextCursor);
          setHasMore(nextCursor !== null);
          // Keep Redux posts in sync with the first page for post-detail navigation
          dispatch(setPosts(posts));
          setIsLoading(false);
        });
      })
      .catch((error) => {
        if (!active || !isMountedRef.current) return;
        unstable_batchedUpdates(() => {
          setErrors(error.errorMessage || "Failed to load posts.");
          setIsLoading(false);
        });
      });

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, countyKey]);

  // Poll for new articles every 5 minutes when notifications enabled for this
  // category and the component is mounted.
  useEffect(() => {
    if (!notifications[category]) return;
    let intervalId = null;
    const checkForNew = async () => {
      try {
        const { posts } = await service.fetchPage({
          category,
          counties: effectiveCounties,
          cursor: null,
          limit: 1,
        });
        if (posts && posts.length > 0) {
          const first = posts[0];
          const key = `lastSeen_${category}`;
          const lastSeen = GetValue(key);
          const firstId = first.id || first.originalLink || null;
          if (firstId) {
            if (lastSeen && firstId !== lastSeen) {
              if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                try {
                  new Notification(`New ${title} article`, {
                    body: first.title || "",
                    tag: category,
                    data: { url: first.originalLink || "" },
                  });
                } catch {}
              }
            }
            SaveValue(key, firstId);
          }
        }
      } catch (_) {
        // ignore errors on polling
      }
    };
    // run once immediately so toggling on has an instant check
    checkForNew();
    intervalId = setInterval(checkForNew, 5 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, [category, effectiveCounties, notifications]);

  // add robots meta tag for cursor parameters (paginated pages)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hasCursor = params.has('cursor');
    let robotsMeta = document.querySelector('meta[name="robots"]');
    if (!robotsMeta) {
      robotsMeta = document.createElement('meta');
      robotsMeta.name = 'robots';
      document.head.appendChild(robotsMeta);
    }
    robotsMeta.setAttribute('content', hasCursor ? 'noindex, follow' : 'index, follow');
    return () => {
      robotsMeta?.setAttribute('content', 'index, follow');
    };
  }, [window.location.search]);

  // Inject rel=prev / rel=next for paginated feeds
  useEffect(() => {
    const base = window.location.origin + window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const currentCursor = params.get('cursor');
    // prev = the cursor that produced the current page (stored when we navigated here)
    // For the first page there is no prev; cursor in the URL IS the next page token
    // The component already loaded page 1 without a cursor in the URL, so:
    // - if cursor is in the URL, this is a paginated page; prev = base URL (no cursor)
    // - next = cursor state variable (from the API response)
    const prevCursor = currentCursor ? '' : null; // empty string = base URL, null = omit
    setPaginationLinks(
      currentCursor ? '' : null,  // prev: link to base URL when on page 2+
      cursor,                      // next: next cursor from API
      base
    );
    return () => {
      document.querySelectorAll('link[rel="prev"], link[rel="next"]').forEach(el => el.remove());
    };
  }, [cursor]);

  // Load next page when the sentinel scrolls into view.
  // Uses a ref-based guard (isLoadingMoreRef) so this callback reference stays
  // stable while a fetch is in-flight.  Keeping the same callback reference
  // means the IntersectionObserver never has to disconnect and reconnect,
  // which was the root cause of missed triggers when the sentinel stayed in view.
  const loadMore = useCallback(() => {
    if (isLoadingMoreRef.current || !hasMore || !cursor) return;

    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    service
      .fetchPage({ category, counties: effectiveCounties, cursor, limit: getPageLimit(category) })
      .then(({ posts, nextCursor }) => {
        if (!isMountedRef.current) return;
        unstable_batchedUpdates(() => {
          setAllPosts((prev) => [...prev, ...posts]);
          setCursor(nextCursor);
          setHasMore(nextCursor !== null);
          isLoadingMoreRef.current = false;
          setIsLoadingMore(false);
        });
      })
      .catch(() => {
        if (!isMountedRef.current) return;
        unstable_batchedUpdates(() => {
          // silently fail on load-more; user can scroll up and back down to retry
          isLoadingMoreRef.current = false;
          setIsLoadingMore(false);
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, countyKey, cursor, hasMore]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;

    let observer;
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting) {
            loadMore();
          }
        },
        { rootMargin: "400px" } // fire 400px before sentinel reaches viewport
      );

      observer.observe(el);
    }

    // Fallback: also check on window scroll in case the IntersectionObserver
    // misses a trigger (e.g., very tall viewports or unusual scroll containers).
    const handleScroll = () => {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.top <= window.innerHeight + 400) {
        loadMore();
      }
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    // Initial check so infinite scroll works without any manual interaction.
    handleScroll();

    return () => {
      if (observer) observer.disconnect();
      window.removeEventListener("scroll", handleScroll);
    };
    // Re-run when isLoading changes so the observer is reattached the moment
    // the sentinel div appears in the DOM after the skeleton phase ends.
  }, [loadMore, isLoading]);

  // If viewport is taller than content, keep auto-loading until the sentinel
  // is below the preload threshold or there are no more pages.
  useEffect(() => {
    if (isLoading || isLoadingMoreRef.current || !hasMore || !cursor) return;
    const el = sentinelRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    if (rect.top <= window.innerHeight + 400) {
      loadMore();
    }
  }, [allPosts.length, hasMore, isLoading, loadMore]);

  const handleCountyChange = (event) => {
    dispatch(setSelectedCounties(event.target.value));
  };

  return (
    <div className={classes.root}>
      <SnackbarNoInternet />

      {/* Page section title: rendered as h1 so heading levels are sequential
          (h1 → h2 in FeaturedPost → h3 in article cards).  variant="h5"
          keeps the same visual size as before. */}
      <Typography variant="h5" component="h1" gutterBottom>
        {title}
      </Typography>

      {/* Manual county selector dropdown — only shown when explicitly enabled */}
      {countyFilterEnabled && category !== "national" && (
        <div className={classes.countyFilterWrap}>
          <FormControl fullWidth variant="outlined" size="small">
            <InputLabel id={`${category}-counties-label`}>Counties</InputLabel>
            <Select
              labelId={`${category}-counties-label`}
              multiple
              value={selectedCounties}
              onChange={handleCountyChange}
              label="Counties"
              renderValue={(selected) =>
                selected.length > 0 ? selected.join(", ") : "All counties"
              }
            >
              {KENTUCKY_COUNTIES.map((county) => (
                <MenuItem key={county} value={county}>
                  <Checkbox checked={selectedCounties.indexOf(county) > -1} />
                  <ListItemText primary={county} />
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </div>
      )}

      {isLoading ? (
        <Skeletons showFeaturedSkeleton />
      ) : allPosts.length === 0 ? (
        !hidePageMessages && (
          <Typography variant="body1">
            {category === "national"
              ? "No articles found for this section."
              : hasSelectedCounties
              ? "No articles found for the selected counties."
              : "No articles found for this section yet."}
          </Typography>
        )
      ) : (
        <>
          {/* Apply optional client-side filter (e.g. weather-page uses this to
              strip any misclassified non-weather articles from the feed). */}
          {(() => {
            const displayPosts = filterPosts ? allPosts.filter(filterPosts) : allPosts;
            if (displayPosts.length === 0) {
              return (
                !hidePageMessages && (
                  <Typography variant="body1">
                    No articles found for this section yet.
                  </Typography>
                )
              );
            }
            return (
              <>
                <FeaturedPost post={displayPosts[0]} />
                <Posts posts={displayPosts.slice(1)} />
              </>
            );
          })()}

          {/* Sentinel: IntersectionObserver watches this element to trigger more loads */}
          <div ref={sentinelRef} style={{ height: 1 }} />

          {isLoadingMore && (
            <Box className={classes.loaderWrap}>
              <CircularProgress size={32} />
            </Box>
          )}

          {!hasMore && allPosts.length > 0 && !hidePageMessages && (
            <Typography
              variant="body2"
              color="textSecondary"
              align="center"
              style={{ padding: 16 }}
            >
              All articles loaded.
            </Typography>
          )}
        </>
      )}

      <Snackbar
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
        open={!!errors}
        message={errors}
        key={`${category}-error`}
        action={
          <IconButton
            aria-label="close"
            color="inherit"
            className={classes.close}
            onClick={() => setErrors("")}
          >
            <CloseIcon />
          </IconButton>
        }
      />
    </div>
  );
}
