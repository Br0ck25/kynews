import React, { useEffect, useState, useRef, useCallback } from "react";
import { makeStyles } from "@material-ui/core/styles";
import { TextField, Grid, Divider, Snackbar, IconButton, CircularProgress } from "@material-ui/core";
import CloseIcon from "@material-ui/icons/Close";
import Skeletons from "../components/skeletons-component";
import Posts from "../components/home/posts-component";
import SiteService from "../services/siteService";
import { useDispatch, useSelector } from "react-redux";
import { setSearchPosts } from "../redux/actions/actions";

const useStyles = makeStyles((theme) => ({
  root: {},
  gridContainer: {
    display: "flex",
    alignItems: "center",
  },
  loaderWrap: {
    display: "flex",
    justifyContent: "center",
    padding: theme.spacing(3),
  },
}));

const service = new SiteService();

export default function SearchPage() {
  const classes = useStyles();
  const searchPosts = useSelector(state => state.searchPosts);

  // ensure search result pages are not indexed by bots
  React.useEffect(() => {
    let robots = document.querySelector('meta[name="robots"]');
    if (!robots) {
      robots = document.createElement('meta');
      robots.name = 'robots';
      document.head.appendChild(robots);
    }
    robots.setAttribute('content', 'noindex');
    return () => {
      robots?.setAttribute('content', 'index, follow');
    };
  }, []);
  const dispatch = useDispatch();

  // local pagination state (Redux still used to persist the visible posts array)
  const [posts, setPosts] = useState(searchPosts.posts || []);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [errors, setErrors] = useState("");
  const [searchVal, setSearchVal] = useState(searchPosts.searchValue);

  const sentinelRef = useRef(null);
  const isMountedRef = useRef(true);
  const isLoadingMoreRef = useRef(false);

  // helper that actually calls the paged API; reset=true clears previous results
  const fetchResults = useCallback(
    async (reset = true) => {
      if (reset) {
        setPosts([]);
        setCursor(null);
        setHasMore(false);
      }

      const params = {
        search: searchVal,
        category: 'all',
        limit: 20,
        cursor: reset ? null : cursor,
      };

      try {
        const { posts: newPosts, nextCursor } = await service.fetchPage(params);
        if (!isMountedRef.current) return;

        const combined = reset ? newPosts : [...posts, ...newPosts];
        setPosts(combined);
        dispatch(setSearchPosts({ searchValue: searchVal, posts: combined }));
        setCursor(nextCursor);
        setHasMore(nextCursor !== null);
      } catch (err) {
        if (!isMountedRef.current) return;
        setErrors(err.errorMessage || 'Search failed. Please try again.');
      } finally {
        if (reset) setIsLoading(false);
        else setIsLoadingMore(false);
      }
    },
    [searchVal, cursor, posts, dispatch]
  );

  useEffect(() => {
    const delaySearch = setTimeout(() => {
      if (searchVal.length > 2) {
        setIsLoading(true);
        setErrors('');
        fetchResults(true);
      } else {
        dispatch(setSearchPosts({ searchValue: "", posts: [] }));
        setPosts([]);
        setCursor(null);
        setHasMore(false);
      }
    }, 1000);

    return () => clearTimeout(delaySearch);
  }, [searchVal, fetchResults, dispatch]);

  const handleChange = (ev) => {
    setSearchVal(ev.target.value);
  };

  // load more helper
  const loadMore = useCallback(() => {
    if (isLoadingMoreRef.current || !hasMore || isLoading) return;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    fetchResults(false).finally(() => {
      isLoadingMoreRef.current = false;
    });
  }, [hasMore, isLoading, fetchResults]);

  // intersection observer on sentinel
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
        { rootMargin: "200px" }
      );
      observer.observe(el);
    }

    const onScroll = () => {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.top <= window.innerHeight + 200) {
        loadMore();
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    return () => {
      if (observer) observer.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, [loadMore, isLoading]);

  return (
    <div className={classes.root}>
      <Grid container className={classes.gridContainer}>
        <Grid item xs={false} md={3}></Grid>
        <Grid item xs={12} md={6}>
          <TextField
            id="standard-full-width"
            label="Search articles"
            style={{ margin: 8 }}
            value={searchVal}
            helperText="Enter at least 3 characters"
            fullWidth
            margin="normal"
            InputLabelProps={{
              shrink: true,
            }}
            onChange={handleChange}
            autoComplete="off"
          />
        </Grid>
      </Grid>
      <Divider />
      <br />
      <Grid container>
        {isLoading && <Skeletons />}

        {/*
          When not loading we show one of three states:
            1. user has typed at least three characters and we have results
            2. user has typed at least three characters but there are no results
            3. user has typed something shorter than the minimum threshold
        */}
        {!isLoading && (
          (() => {
            const hasQuery = searchVal.length > 2;
            const postsToShow = posts || [];

            if (hasQuery) {
              if (postsToShow.length > 0) {
                return <Posts posts={postsToShow} />;
              }
              return (
                <Grid item xs={12} style={{ textAlign: 'center', padding: 16 }}>
                  <span style={{ color: '#666' }}>
                    No articles found{searchVal ? ` for "${searchVal}"` : ''}.
                  </span>
                </Grid>
              );
            }

            if (searchVal.length > 0) {
              return (
                <Grid item xs={12} style={{ textAlign: 'center', padding: 16 }}>
                  <span style={{ color: '#666' }}>
                    Enter at least 3 characters to search.
                  </span>
                </Grid>
              );
            }

            return null;
          })()
        )}

        {isLoadingMore && (
          <Grid item xs={12} className={classes.loaderWrap}>
            <CircularProgress />
          </Grid>
        )}

        {/* sentinel for infinite scroll */}
        <div ref={sentinelRef}></div>
      </Grid>

      <Snackbar
              anchorOrigin={{ vertical: "top", horizontal: "center" }}
              open={!!errors}
              message={errors}
              key={"topcenter"}
              action={
                  <IconButton
                    aria-label="close"
                    color="inherit"
                    className={classes.close}
                    onClick={() => setErrors('')}
                  >
                    <CloseIcon />
                  </IconButton>
              }
            />
    </div>
  );
}
