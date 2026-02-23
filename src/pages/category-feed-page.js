import React, { useEffect, useState } from "react";
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
} from "@material-ui/core";
import CloseIcon from "@material-ui/icons/Close";
import Skeletons from "../components/skeletons-component";
import FeaturedPost from "../components/featured-post-component";
import Posts from "../components/home/posts-component";
import SiteService from "../services/siteService";
import SnackbarNoInternet from "../components/snackbar-no-internet-component";
import { useDispatch, useSelector } from "react-redux";
import { setPosts, setSelectedCounties, setTitle } from "../redux/actions/actions";
import { KENTUCKY_COUNTIES } from "../constants/counties";

const useStyles = makeStyles((theme) => ({
  root: {},
  countyFilterWrap: {
    marginBottom: theme.spacing(2),
  },
  close: {
    padding: theme.spacing(0.5),
  },
}));

const service = new SiteService(process.env.REACT_APP_API_BASE_URL);

export default function CategoryFeedPage({ category, title, countyFilterEnabled = false }) {
  const classes = useStyles();
  const posts = useSelector((state) => state.posts);
  const selectedCounties = useSelector((state) => state.selectedCounties);
  const dispatch = useDispatch();

  const [isLoading, setIsLoading] = useState(true);
  const [errors, setErrors] = useState("");

  useEffect(() => {
    dispatch(setTitle(title));
  }, [title]);

  useEffect(() => {
    setIsLoading(true);
    // always respect preferences; dropdown is only for manual override if enabled
    const counties = selectedCounties || [];

    service
      .getPosts({
        category,
        limit: 24,
        counties,
      })
      .then((data) => {
        dispatch(setPosts(data));
        setIsLoading(false);
      })
      .catch((error) => {
        setErrors(error.errorMessage || "Failed to load posts.");
        setIsLoading(false);
      });
  }, [category, selectedCounties.join("|")]);

  const handleCountyChange = (event) => {
    dispatch(setSelectedCounties(event.target.value));
  };

  return (
    <div className={classes.root}>
      <SnackbarNoInternet />

      <Typography variant="h5" gutterBottom>
        {title}
      </Typography>

      {/* manual county selector dropdown is only shown when enabled, but filtering happens regardless */}
      {countyFilterEnabled && (
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

      {!isLoading && posts && posts.length > 0 ? (
        <>
          <FeaturedPost post={posts[0]} />
          <Posts posts={posts.filter((_, index) => index !== 0)} />
        </>
      ) : (
        <>
          {!isLoading && (!posts || posts.length === 0) ? (
            <Typography variant="body1">
              No articles found for this section yet. In local development, the app will try to auto-seed sources on first load.
            </Typography>
          ) : (
            <Skeletons showFeaturedSkeleton />
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
        </>
      )}
    </div>
  );
}
