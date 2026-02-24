import React, { useEffect, useState, useRef, useCallback } from "react";
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
  Button,
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

const service = new SiteService(process.env.REACT_APP_API_BASE_URL);
const PAGE_LIMIT = 20;

function getPageLimit(_category) {
  return PAGE_LIMIT;
}

export default function CategoryFeedPage({ category, title, countyFilterEnabled = false }) {
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
  // Track current category+counties key to detect dependency changes
  const countyKey = (selectedCounties || []).join("|");
  const effectiveCounties = category === "national" ? [] : selectedCounties || [];
  const hasSelectedCounties = (selectedCounties || []).length > 0;

  useEffect(() => {
    dispatch(setTitle(title));
  }, [title, dispatch]);

  // Reset and fetch first page whenever category or county selection changes
  useEffect(() => {
    setAllPosts([]);
    setCursor(null);
    setHasMore(true);
    setIsLoading(true);
    setErrors("");
    isLoadingMoreRef.current = false; // reset ref on category/county change

    service
      .fetchPage({ category, counties: effectiveCounties, cursor: null, limit: getPageLimit(category) })
      .then(({ posts, nextCursor }) => {
        setAllPosts(posts);
        setCursor(nextCursor);
        setHasMore(nextCursor !== null);
        // Keep Redux posts in sync with the first page for post-detail navigation
        dispatch(setPosts(posts));
        setIsLoading(false);
      })
      .catch((error) => {
        setErrors(error.errorMessage || "Failed to load posts.");
        setIsLoading(false);
      });
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
        setAllPosts((prev) => [...prev, ...posts]);
        setCursor(nextCursor);
        setHasMore(nextCursor !== null);
        isLoadingMoreRef.current = false;
        setIsLoadingMore(false);
      })
      .catch(() => {
        // silently fail on load-more; user can scroll up and back down to retry
        isLoadingMoreRef.current = false;
        setIsLoadingMore(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, countyKey, cursor, hasMore]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: "400px" } // fire 400px before sentinel reaches viewport
    );

    observer.observe(el);

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

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", handleScroll);
    };
  }, [loadMore]);

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
          <FeaturedPost post={allPosts[0]} />
          <Posts posts={allPosts.filter((_, index) => index !== 0)} />

          {/* Sentinel: IntersectionObserver watches this element to trigger more loads */}
          <div ref={sentinelRef} style={{ height: 1 }} />

          {isLoadingMore && (
            <Box className={classes.loaderWrap}>
              <CircularProgress size={32} />
            </Box>
          )}

          {/* Manual fallback button: shown when there are more articles but
              the IntersectionObserver has not fired (e.g. browser quirks or
              very fast scrolling past the sentinel). */}
          {hasMore && !isLoadingMore && (
            <Box style={{ textAlign: "center", padding: "16px 0" }}>
              <Button
                variant="outlined"
                color="primary"
                onClick={loadMore}
                aria-label="Load more articles"
              >
                Load More
              </Button>
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
