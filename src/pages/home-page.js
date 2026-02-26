import React, { useState, useEffect } from "react";
import { makeStyles } from "@material-ui/core/styles";
import FeaturedPost from "../components/featured-post-component";
import Posts from "../components/home/posts-component";
import SiteService from "../services/siteService";
import { IconButton } from "@material-ui/core";
import Skeletons from "../components/skeletons-component";
import { usePrevious } from "../customHooks/custom-hooks";
import Snackbar from "@material-ui/core/Snackbar";
import CloseIcon from "@material-ui/icons/Close";
import SnackbarNoInternet from "../components/snackbar-no-internet-component";
import { useDispatch, useSelector } from "react-redux";
import { setPosts } from "../redux/actions/actions";

const useStyles = makeStyles((theme) => ({
  root: {},
  close: {
    padding: theme.spacing(0.5),
  },
}));

const service = new SiteService(process.env.REACT_APP_API_BASE_URL);

export default function HomePage() {
  const classes = useStyles();
  const posts = useSelector((state) => state.posts);
  const tabSelected = useSelector((state) => state.tabSelected);
  const selectedCounties = useSelector((state) => state.selectedCounties);
  const dispatch = useDispatch();

  const [isLoading, setIsLoading] = useState(true);
  const [errors, setErrors] = useState("");

  const tabSelectedPrev = usePrevious(tabSelected);
  useEffect(() => {
    // if (!categories)
    //   service.getCategories().then((data) => handleCategories(data));
    // if (!tags) service.getTags().then((data) => handleTags(data));
    if (!posts || (tabSelectedPrev && tabSelectedPrev !== tabSelected)) {
      setIsLoading(true);
      let searchVal = tabSelected.index > 0 ? tabSelected.value : "";
      service
        .getPosts({
          category: "today",
          search: searchVal,
          limit: 10,
          counties: selectedCounties,
        })
        .then((data) => {
          dispatch(setPosts(data));
          setIsLoading(false);
        })
        .catch((error) => {
          setErrors(error.errorMessage);
        });
    } else setIsLoading(false);
  }, [tabSelected.index, selectedCounties.join("|")]);


  return (
    <div className={classes.root}>
      {/* <h4>Home page</h4> */}      <main>
        <SnackbarNoInternet />
        {!isLoading && posts.length > 0 ? (
          <>
            <FeaturedPost post={posts[0]} />
            <Posts posts={posts.filter((item, index) => index !== 0)} />{" "}
            {/* get all but not first item (because is used in FeaturedPost) */}
          </>
        ) : (
          <>
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
                  onClick={() => setErrors("")}
                >
                  <CloseIcon />
                </IconButton>
              }
            />
            <Skeletons showFeaturedSkeleton />
          </>
        )}
        {/* <FullScreenPostDialog /> */}
      </main>
    </div>
  );
}
