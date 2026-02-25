import React, { useState } from "react";
import PropTypes from "prop-types";
import Typography from "@material-ui/core/Typography";
import Grid from "@material-ui/core/Grid";
import Card from "@material-ui/core/Card";
import CardActionArea from "@material-ui/core/CardActionArea";
import CardContent from "@material-ui/core/CardContent";
import CardMedia from "@material-ui/core/CardMedia";
import CardActions from "@material-ui/core/CardActions";
import IconButton from "@material-ui/core/IconButton";
import Chip from "@material-ui/core/Chip";
import ShareIcon from "@material-ui/icons/Share";
import FavoriteIcon from "@material-ui/icons/Favorite";
import { DateFromNow, ShareAPI, getPostTags, countyToSlug } from "../../utils/functions";
import { Link as RouterLink } from "react-router-dom";
import { KENTUCKY_COUNTIES } from "../../constants/counties";
import { Delete } from "@material-ui/icons";
import { GetValue, SaveValue } from "../../services/storageService";
import { Button, Dialog, DialogActions, DialogTitle } from "@material-ui/core";
import { SavePost } from "../../services/storageService";
import { makeStyles } from "@material-ui/core/styles";
import SnackbarNotify from "../snackbar-notify-component";
import { useDispatch } from "react-redux";
import { setPost } from "../../redux/actions/actions";

const useStyles = makeStyles({
  card: {
    borderRadius: 14,
    overflow: "hidden",
    height: "100%",
    transition: "transform .18s ease, box-shadow .18s ease",
    "&:hover": {
      transform: "translateY(-2px)",
      boxShadow: "0 14px 32px rgba(17, 24, 39, .14)",
    },
  },
  media: {
    height: 180,
    objectFit: "cover",
  },
  cardContent: {
    padding: "12px 12px 0 12px",
  },
  title: {
    fontSize: "1.05rem",
    lineHeight: 1.35,
    fontWeight: 700,
  },
});

export default function SinglePost(props) {
  const classes = useStyles();
  const { post, showDelete, handleDelete } = props;
  const postTags = getPostTags(post);
  const [openDialog, setOpenDialog] = useState(false);
  const [openSnackbarNotify, setOpenSnackbarNotify] = useState(false);
  const dispatch = useDispatch();
  const handlePost = (post) => dispatch(setPost(post));
  
  const handleDeletePost = () => {
    const posts = GetValue("savedPost");
    if (posts) {
      const otherPosts = posts.filter(
        (item) => item.originalLink !== post.originalLink
      );
      SaveValue("savedPost", otherPosts);
      handleDelete(post); //to refresh the post list in parent component
    }
  };

  const handleSavePost = () => {
    SavePost(post);
    setOpenSnackbarNotify(true);
  };

  const handleShare = () => {
    const title = post.title;
    const text = `I'm reading this on Kentucky News: ${post.title}`;
    // Prefer the local article URL so recipients land on our article page, not the external source.
    // Use the numeric article ID when available (mapped from the worker's id field).
    const url = post.id
      ? `https://localkynews.com/post?articleId=${post.id}`
      : `${window.location.origin}/post`;
    ShareAPI(title, text, url);
  };

  return (
    <>
      {openSnackbarNotify && (
        <SnackbarNotify message="Article saved successfully." />
      )}
      <Grid item xs={12} sm={6} md={4}>
        <Card className={classes.card}>
          <CardActionArea>
            {/* <CardActionArea component="a" href="#"> */}
            {/* <Card className={classes.card}>
          <div className={classes.cardDetails}>
            <CardContent>
              <Typography component="h2" variant="h5">
                {post.title}
              </Typography>
              <Typography variant="subtitle1" color="textSecondary">
                {post.date}
              </Typography>
              <Typography variant="subtitle1" paragraph>
                {post.description}
              </Typography>
              <Typography variant="subtitle1" color="primary">
                Continue reading...
              </Typography>
            </CardContent>
          </div>
          <Hidden xsDown>
            <CardMedia className={classes.cardMedia} image={post.image} title={post.imageTitle} />
          </Hidden>
        </Card> */}
            {/* Alt uses post.title since imageText may not always be set.
                loading="lazy" defers off-screen images to reduce initial payload. */}
            <CardMedia
              component="img"
              alt={post.title || post.imageText || "Article image"}
              className={classes.media}
              image={post.image || "/logo.png"}
              title={post.title}
              loading="lazy"
              onError={(e) => { e.target.onerror = null; e.target.src = "/logo.png"; }}
            />
            <CardContent
              onClick={() => handlePost(post)}
              className={classes.cardContent}
            >
              {postTags.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  {postTags.map((tag) => {
                    // Route: county name → county page, "National" → /national, others → /local
                    const isCounty = KENTUCKY_COUNTIES.includes(tag);
                    const tagRoute = isCounty
                      ? `/news/${countyToSlug(tag)}`
                      : tag === "National"
                      ? "/national"
                      : "/local";
                    return (
                      <RouterLink
                        key={tag}
                        to={tagRoute}
                        style={{ textDecoration: "none" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Chip
                          label={tag}
                          size="small"
                          variant="outlined"
                          color="primary"
                          clickable
                          style={{ marginRight: 4, marginBottom: 4 }}
                        />
                      </RouterLink>
                    );
                  })}
                </div>
              )}
              <Typography gutterBottom variant="h6" component="h3" className={classes.title}>
                {post.title}
              </Typography>
              <Typography
                variant="body2"
                color="textSecondary"
                component="p"
                dangerouslySetInnerHTML={{
                  __html:
                    post.shortDesc.split(" ").splice(0, 20).join(" ") + "...",
                }}
              ></Typography>
            </CardContent>
          </CardActionArea>
          <CardActions>
            <Grid container justify="space-between">
              <Grid item>
                <i style={{ marginRight: 20 }}>{DateFromNow(post.date)}</i>

                {/* <IconButton
                color="primary"
                aria-label="WhatsApp"
                component="span"
                size="small"
              >
                <WhatsAppIcon />
              </IconButton> */}

                {/* <Button
                size="small"
                color="primary"
                // onClick={() => history.push({ pathname: post.link, state: { post } })}
                onClick={() => handlePost(post)}
              >
                  Continue reading...
              </Button> */}
              </Grid>

              <Grid item>
                <IconButton
                  color="primary"
                  aria-label="Save"
                  component="span"
                  onClick={handleSavePost}
                  size="small"
                  style={{ marginRight: 10 }}
                >
                  <FavoriteIcon />
                </IconButton>
                <IconButton
                  color="primary"
                  aria-label="Share"
                  component="span"
                  size="small"
                  onClick={handleShare}
                >
                  <ShareIcon />
                </IconButton>

                {showDelete && (
                  <IconButton
                    color="secondary"
                    aria-label="Delete article"
                    component="span"
                    size="small"
                    onClick={() => setOpenDialog(true)}
                    style={{ marginLeft: 10 }}
                  >
                    <Delete />
                  </IconButton>
                )}
              </Grid>
            </Grid>
          </CardActions>
        </Card>
      </Grid>

      <Dialog
        open={openDialog}
        aria-labelledby="alert-dialog-title"
        aria-describedby="alert-dialog-description"
      >
        <DialogTitle id="alert-dialog-title">
          {"Are you sure you want to delete this saved article?"}
        </DialogTitle>
        <DialogActions>
          <Button color="primary" onClick={() => setOpenDialog(false)}>
            No
          </Button>
          <Button onClick={handleDeletePost} color="primary" autoFocus>
            Yes
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

SinglePost.propTypes = {
  post: PropTypes.object,
  showDelete: PropTypes.bool,
  handleDelete: PropTypes.func,
};
