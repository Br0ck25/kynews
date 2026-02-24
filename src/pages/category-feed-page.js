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

  // Load next page when the sentinel scrolls into view
  const loadMore = useCallback(() => {
    if (isLoadingMore || !hasMore || !cursor) return;

    setIsLoadingMore(true);
    service
      .fetchPage({ category, counties: effectiveCounties, cursor, limit: getPageLimit(category) })
      .then(({ posts, nextCursor }) => {
        setAllPosts((prev) => [...prev, ...posts]);
        setCursor(nextCursor);
        setHasMore(nextCursor !== null);
        setIsLoadingMore(false);
      })
      .catch(() => {
        // silently fail on load-more; user can scroll up and back down to retry
        setIsLoadingMore(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, countyKey, cursor, hasMore, isLoadingMore]);

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
      { rootMargin: "200px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  const handleCountyChange = (event) => {
    dispatch(setSelectedCounties(event.target.value));
  };

  return (
    <div className={classes.root}>
      <SnackbarNoInternet />

      <Typography variant="h5" gutterBottom>
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
