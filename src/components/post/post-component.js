import React from "react";
import PropTypes from "prop-types";
import { makeStyles } from "@material-ui/core/styles";
import Paper from "@material-ui/core/Paper";
import Typography from "@material-ui/core/Typography";
import Grid from "@material-ui/core/Grid";
import Divider from "@material-ui/core/Divider";
import Button from "@material-ui/core/Button";
import Box from "@material-ui/core/Box";
import "./post-component.css";

const useStyles = makeStyles((theme) => ({
  mainFeaturedPost: {
    position: "relative",
    backgroundColor: theme.palette.grey[800],
    color: theme.palette.common.white,
    marginBottom: theme.spacing(4),
    // backgroundImage: "url(https://source.unsplash.com/random)",
    backgroundSize: "cover",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center",
    minHeight: 320
  },
  overlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,.3)",
  },
  mainFeaturedPostContent: {
    margin: 40,
    position: "relative",
    padding: theme.spacing(3),
    [theme.breakpoints.up("md")]: {
      padding: theme.spacing(10),
      paddingRight: 0,
    },
  },
  actions: {
    display: "flex",
    gap: theme.spacing(1),
    padding: theme.spacing(2, 1),
    justifyContent: "flex-end",
  },
}));

export default function FeaturedPost(props) {
  const classes = useStyles();
  const { post } = props;
  const bodyText = String(post?.contentText || "").trim();
  const paragraphs = bodyText
    ? bodyText.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean)
    : [];

  const shareArticle = async () => {
    const shareUrl = post?.originalLink || window.location.href;
    const shareTitle = post?.title || "Local KY News";
    try {
      if (navigator.share) {
        await navigator.share({ title: shareTitle, url: shareUrl });
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      // eslint-disable-next-line no-alert
      alert("Link copied to clipboard");
    } catch {
      // ignore share cancellation/errors
    }
  };

  return (
    <main>
      <Paper
        className={classes.mainFeaturedPost}
        style={{ backgroundImage: `url(${post.image})` }}
      >
      </Paper>
      <Divider />
      <Grid item xs={12} md={9}>
        <Typography variant="h5" gutterBottom style={{ padding: 10 }}>
          {post.title}
        </Typography>
        <Divider />
        <div className={"description"}>
          {paragraphs.length > 0 ? (
            paragraphs.map((paragraph, index) => (
              <Typography key={`${post.title}-${index}`} variant="body1" paragraph>
                {paragraph}
              </Typography>
            ))
          ) : (
            <Typography variant="body1">No article body available.</Typography>
          )}
        </div>
        <Divider />
        <Box className={classes.actions}>
          <Button size="small" variant="outlined" color="primary" onClick={shareArticle}>
            Share link
          </Button>
          <Button
            size="small"
            variant="contained"
            color="primary"
            href={post?.originalLink || "#"}
            target="_blank"
            rel="noopener noreferrer"
            disabled={!post?.originalLink}
          >
            Original article
          </Button>
        </Box>
      </Grid>
    </main>
  );
}

FeaturedPost.propTypes = {
  post: PropTypes.object,
};
