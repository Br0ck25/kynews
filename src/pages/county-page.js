import React, { useEffect, useState } from "react";
import { makeStyles } from "@material-ui/core/styles";
import {
  Typography,
  Divider,
  IconButton,
  Button,
} from "@material-ui/core";
import ShareIcon from "@material-ui/icons/Share";
import FavoriteIcon from "@material-ui/icons/Favorite";
import SiteService from "../services/siteService";
import FeaturedPost from "../components/featured-post-component";
import Posts from "../components/home/posts-component";
import Skeletons from "../components/skeletons-component";
import SnackbarNotify from "../components/snackbar-notify-component";
import { slugToCounty } from "../utils/functions";
import { useParams, useHistory } from "react-router-dom";
import { useDispatch } from "react-redux";
import { setSelectedCounties } from "../redux/actions/actions";

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

export default function CountyPage() {
  const classes = useStyles();
  const { countySlug } = useParams();
  const history = useHistory();
  const dispatch = useDispatch();

  const countyName = slugToCounty(countySlug);

  const [posts, setPosts] = useState([]);
  const [statePosts, setStatePosts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errors, setErrors] = useState("");
  const [saved, setSaved] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState("");

  // update page metadata when county changes
  useEffect(() => {
    if (!countyName) return;

    document.title = `${countyName} County, KY News — Local KY News`;
    const description = `The latest news from ${countyName} County, Kentucky.`;
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", description);
  }, [countyName]);

  const updateSelectionState = React.useCallback((tags) => {
    const selected = (tags || []).filter((t) => t.active).map((t) => t.value);
    dispatch(setSelectedCounties(selected));
  }, [dispatch]);

  // determine if the county is currently "saved" (selected tag)
  useEffect(() => {
    if (!countyName) return;
    service.getTags().then((tags) => {
      const present = tags.find((t) => t.value === countyName && t.active);
      setSaved(!!present);
      updateSelectionState(tags);
    });
  }, [countyName, updateSelectionState]);

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
    const url = window.location.href;
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
    service.saveTags(countyName).then((tags) => {
      const present = tags.find((t) => t.value === countyName && t.active);
      setSaved(!!present);
      updateSelectionState(tags);
      setSnackbarMessage(present ? "County saved" : "County removed");
    });
  };

  const handleBack = () => {
    history.push("/local");
  };

  if (!countyName) {
    return (
      <div>
        <Button size="small" onClick={handleBack} className={classes.backLink}>
          &larr; All Counties
        </Button>
        <Typography variant="h5">County not found</Typography>
        <Typography variant="body2">
          The URL you provided does not match a valid Kentucky county.
        </Typography>
      </div>
    );
  }

  return (
    <div className={classes.root}>
      <Button size="small" onClick={handleBack} className={classes.backLink}>
        &larr; All Counties
      </Button>

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
