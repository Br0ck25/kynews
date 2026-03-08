import React, { useEffect, useState } from "react";
import { makeStyles } from "@material-ui/core/styles";
import { TextField, Grid, Divider, Snackbar, IconButton } from "@material-ui/core";
import CloseIcon from "@material-ui/icons/Close";
import Skeletons from "../components/skeletons-component";
import Posts from "../components/home/posts-component";
import SiteService from "../services/siteService";
import { useDispatch, useSelector } from "react-redux";
import { setSearchPosts } from "../redux/actions/actions";

const useStyles = makeStyles({
  root: {},
  gridContainer: {
    display: "flex",
    alignItems: "center",
  },
});

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

  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState("");
  const [searchVal, setSearchVal] = useState(searchPosts.searchValue);

  useEffect(() => {
    const delaySearch = setTimeout(() => {
      //wait 1 sec until user stop typing
      if (searchVal.length > 2) {
        setIsLoading(true);
        // previously we restricted searches to the "today" feed which meant
        // national, sports, weather, etc. articles would never surface even if
        // the user pasted the exact headline.  Make the request against the
        // virtual "all" category so the backend returns matches from anywhere
        // on the site.
        service
          // do not send a hard limit when performing a search; the backend will
          // return as many matching posts as it deems reasonable (currently up
          // to its configured cap).  earlier versions always requested 15
          // items which triggered a 400 because the worker refused tiny limits
          // and also didn't recognise the pseudo-category `all`.
          .getPosts({ search: searchVal, category: 'all' })
          .then((data) => {
            dispatch(setSearchPosts({ searchValue: searchVal, posts: data }));
            setIsLoading(false);
          })
          .catch((error) => {
            setErrors(error.errorMessage);
          });
      } else {
            dispatch(setSearchPosts({ searchValue: "", posts: [] }));
      }
    }, 1000);

    return () => clearTimeout(delaySearch);
  }, [searchVal]);

  const handleChange = (ev) => {
    setSearchVal(ev.target.value);
  };

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
        {!isLoading && searchPosts.posts ? (
          <>
            <Posts posts={searchPosts.posts} />
          </>
        ) : (
          isLoading && <Skeletons />
        )}
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
