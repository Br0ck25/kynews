import React from "react";
import PropTypes from "prop-types";
import { makeStyles } from "@material-ui/core/styles";
import Paper from "@material-ui/core/Paper";
import Typography from "@material-ui/core/Typography";
import Grid from "@material-ui/core/Grid";
import Divider from "@material-ui/core/Divider";
import Box from "@material-ui/core/Box";
import Button from "@material-ui/core/Button";
import IconButton from "@material-ui/core/IconButton";
import ShareIcon from "@material-ui/icons/Share";
import FavoriteIcon from "@material-ui/icons/Favorite";
import "./post-component.css";
import { ShareAPI, ToDateTime } from "../../utils/functions";
import { SavePost } from "../../services/storageService";
import SnackbarNotify from "../snackbar-notify-component";

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
}));

export default function FeaturedPost(props) {
  const classes = useStyles();
  const { post } = props;
  const [showSaved, setShowSaved] = React.useState(false);
  const bodyText = String(post?.contentText || "").trim();
  const paragraphs = bodyText
    ? bodyText.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean)
    : [];

  const handleSave = () => {
    SavePost(post);
    setShowSaved(true);
  };

  const handleShare = () => {
    const title = post.title;
    const text = `I'm reading this on Kentucky News: ${post.title}`;
    const url = post.originalLink;
    ShareAPI(title, text, url);
  };

  return (
    <main>
      {showSaved && <SnackbarNotify message="Article saved successfully." />}
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
        <Typography variant="body2" color="textSecondary" style={{ padding: "0 10px 10px" }}>
          {ToDateTime(post.date)}
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
        <Box style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "0 10px 12px" }}>
          <IconButton color="primary" aria-label="Save" onClick={handleSave} size="small">
            <FavoriteIcon />
          </IconButton>
          <IconButton color="primary" aria-label="Share" onClick={handleShare} size="small">
            <ShareIcon />
          </IconButton>
          <Button
            size="small"
            color="primary"
            variant="outlined"
            href={post.originalLink || "#"}
            target="_blank"
            rel="noopener noreferrer"
            disabled={!post.originalLink}
          >
            Original Article
          </Button>
        </Box>
      </Grid>
    </main>
  );
}

FeaturedPost.propTypes = {
  post: PropTypes.object,
};
