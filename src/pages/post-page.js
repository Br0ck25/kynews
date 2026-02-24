import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import Post from "../components/post/post-component";
import { Button, Typography } from "@material-ui/core";
import { useLocation, Link as RouterLink } from "react-router-dom";
import { useSelector } from "react-redux";
import SiteService from "../services/siteService";

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
  const [resolvedPost, setResolvedPost] = React.useState(location?.state?.post || reduxPost || null);
  const [loading, setLoading] = React.useState(false);
  const service = React.useMemo(() => new SiteService(process.env.REACT_APP_API_BASE_URL), []);

  React.useEffect(() => {
    if (resolvedPost) return;
    const params = new URLSearchParams(location.search || "");
    const articleId = params.get("articleId");
    if (!articleId) return;

    setLoading(true);
    service
      .getPostById(articleId)
      .then((post) => setResolvedPost(post))
      .catch(() => setResolvedPost(null))
      .finally(() => setLoading(false));
  }, [location.search, resolvedPost, service]);

  const post = resolvedPost;

  return (
    <div className={classes.root}>
      {post ? (
        <Post post={post} />
      ) : loading ? (
        <div className={classes.emptyState}>
          <Typography variant="h6" gutterBottom>
            Loading article...
          </Typography>
        </div>
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
            Back to Local KY News
          </Button>
        </div>
      )}
    </div>
  );
}
