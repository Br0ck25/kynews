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

function getPageLimit(_category) {
  return PAGE_LIMIT;
}

export default function CategoryFeedPage({ category, title, countyFilterEnabled = false, filterPosts }) {
  const classes = useStyles();
  const selectedCounties = useSelector((state) => state.selectedCounties);
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
        <Typography variant="body1">
          {category === "national"
            ? "No articles found for this section."
            : hasSelectedCounties
            ? "No articles found for the selected counties."
            : "No articles found for this section yet."}
        </Typography>
      ) : (
        <>
          {/* Apply optional client-side filter (e.g. weather-page uses this to
              strip any misclassified non-weather articles from the feed). */}
          {(() => {
            const displayPosts = filterPosts ? allPosts.filter(filterPosts) : allPosts;
            if (displayPosts.length === 0) {
              return (
                <Typography variant="body1">
                  No articles found for this section yet.
                </Typography>
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

          {!hasMore && allPosts.length > 0 && (
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
