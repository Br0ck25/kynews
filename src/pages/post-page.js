import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import Post from "../components/post/post-component";
import { Button, Typography } from "@material-ui/core";
import { useLocation, Link as RouterLink } from "react-router-dom";
import { useSelector } from "react-redux";

const useStyles = makeStyles({
  root: {
    marginTop: 15,
  },
  emptyState: {
    textAlign: "center",
    padding: "24px 16px",
  },
  emptyAction: {
    marginTop: 16,
  },
});

export default function PostPage() {
  const classes = useStyles();
  const location = useLocation();
  const reduxPost = useSelector((state) => state.post);
  const post = location?.state?.post || reduxPost;

  return (
    <div className={classes.root}>
      {post ? (
        <Post post={post} />
      ) : (
        <div className={classes.emptyState}>
          <Typography variant="h6" gutterBottom>
            We couldn&apos;t find that article.
          </Typography>
          <Typography variant="body2" color="textSecondary">
            It may have expired or been opened without a selected post.
          </Typography>
          <Button
            className={classes.emptyAction}
            component={RouterLink}
            to="/today"
            color="primary"
            variant="contained"
          >
            Back to Kentucky Today
          </Button>
        </div>
      )}
    </div>
  );
}
