import React from "react";
import PropTypes from "prop-types";
import { makeStyles } from "@material-ui/core/styles";
import Paper from "@material-ui/core/Paper";
import Typography from "@material-ui/core/Typography";
import Grid from "@material-ui/core/Grid";
import Button from "@material-ui/core/Button";
import Chip from "@material-ui/core/Chip";
import { useDispatch } from "react-redux";
import { setPost } from "../redux/actions/actions";
import { DateFromNow, getPostTags } from "../utils/functions";

const useStyles = makeStyles((theme) => ({
  mainFeaturedPost: {
    position: "relative",
    backgroundColor: theme.palette.grey[800],
    color: theme.palette.common.white,
    marginBottom: theme.spacing(4),
    borderRadius: 18,
    overflow: "hidden",
    backgroundImage: "url(https://source.unsplash.com/random)",
    backgroundSize: "cover",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center",
    boxShadow: "0 16px 40px rgba(15, 23, 42, .22)",
  },
  overlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    left: 0,
    background: "linear-gradient(180deg, rgba(2,6,23,.22) 0%, rgba(2,6,23,.64) 100%)",
  },
  mainFeaturedPostContent: {
    position: "relative",
    padding: theme.spacing(4),
    [theme.breakpoints.up("md")]: {
      padding: theme.spacing(6),
      paddingRight: 0,
    },
  },
}));

export default function FeaturedPost(props) {
  const dispatch = useDispatch();

  const handlePost = (post) => dispatch(setPost(post));

  const classes = useStyles();
  const { post } = props;
  const postTags = getPostTags(post);

  return (
    <Paper
      className={classes.mainFeaturedPost}
      style={{ backgroundImage: `url(${post.image})` }}
    >
      {/* Hidden preload image for the LCP background-image.
          fetchpriority="high" and loading="eager" instruct the browser to
          discover and download this resource as early as possible, reducing
          the "Resource load delay" in LCP breakdown. */}
      {
        <img
          style={{ display: "none" }}
          src={post.image}
          alt={post.imageText}
          fetchpriority="high"
          loading="eager"
        />
      }
      <div className={classes.overlay} />
      <Grid container>
        <Grid item md={6}>
          <div className={classes.mainFeaturedPostContent}>
            {postTags.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                {postTags.map((tag) => (
                  <Chip
                    key={tag}
                    label={tag}
                    size="small"
                    style={{ marginRight: 4, marginBottom: 4, color: '#fff', borderColor: 'rgba(255,255,255,0.5)' }}
                    variant="outlined"
                  />
                ))}
              </div>
            )}
            <Typography
              component="h2"
              variant="h3"
              color="inherit"
              gutterBottom
              style={{ fontWeight: 900, lineHeight: 1.2 }}
            >
              {post.title}
            </Typography>
            <Typography
              variant="body1"
              color="inherit"
              paragraph
              dangerouslySetInnerHTML={{
                __html:
                  post.description.split(" ").splice(0, 15).join(" ") + "...",
              }}
            >
              {/* {post.description.split(' ').splice(0, 10).join(' ')}... */}
            </Typography>
            <Typography variant="body2" color="inherit" style={{ opacity: 0.9 }}>
              {DateFromNow(post.date)}
            </Typography>
            <Button
              size="small"
              color="primary"
              // onClick={() => history.push(location)}
              onClick={() => handlePost(post)}
            >
              Continue reading...
            </Button>
          </div>
        </Grid>
      </Grid>
    </Paper>
  );
}

FeaturedPost.propTypes = {
  post: PropTypes.object,
};
