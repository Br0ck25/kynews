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
import Chip from "@material-ui/core/Chip";
import ShareIcon from "@material-ui/icons/Share";
import { Link as RouterLink } from "react-router-dom";
import { __RouterContext } from "react-router";
import { useDispatch } from "react-redux";
import { setPost } from "../../redux/actions/actions";
import "./post-component.css";
import { ShareAPI, ToDateTime, countyToSlug } from "../../utils/functions";
import SiteService from "../../services/siteService";

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
  const dispatch = useDispatch();
  // determine whether we're rendered inside a Router; __RouterContext is
  // the internal context used by react-router.  When the post is shown via
  // the fullscreen dialog (ThemeProvider) the component is outside the
  // router tree and the context will be undefined, so we avoid using any
  // Link/history functionality in that case.
  const router = React.useContext(__RouterContext);
  const hasRouter = !!router;
  const history = router?.history ?? null;
  const [relatedPosts, setRelatedPosts] = React.useState([]);
  const service = React.useMemo(() => new SiteService(process.env.REACT_APP_API_BASE_URL), []);

  const summaryParagraphs = String(post?.shortDesc || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim()
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const sourceName = extractSourceName(post.originalLink || post.sourceUrl || "");
  const countySlug = post.county ? countyToSlug(post.county) : null;
  const categoryLabel = categoryDisplayName(post.categories?.[0]);

  const video = React.useMemo(() => findPlayableVideo(post), [post]);

  React.useEffect(() => {
    if (!post.county) return;
    service
      .getPosts({ category: "today", counties: [post.county], limit: 7 })
      .then((posts) => {
        setRelatedPosts(
          posts.filter((p) => p.originalLink !== post.originalLink).slice(0, 5)
        );
      })
      .catch(() => {});
  }, [post.county, post.originalLink, service]);

  const handleRelatedClick = (relatedPost) => {
    dispatch(setPost(relatedPost));
    if (hasRouter && history) {
      history.push({ pathname: "/post", state: { post: relatedPost } });
    }
  };

  const handleShare = () => {
    const title = post.title;
    const text = `I'm reading this on Kentucky News: ${post.title}`;
    const url = post.originalLink;
    ShareAPI(title, text, url);
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
        <Typography variant="body2" color="textSecondary" style={{ padding: "0 10px 4px" }}>
          {ToDateTime(post.date)}
        </Typography>

        {/* County + Category chips */}
        <Box style={{ padding: "4px 10px 10px", display: "flex", flexWrap: "wrap", gap: 6 }}>
          {post.county && countySlug && (
            hasRouter ? (
              <RouterLink to={`/news/${countySlug}`} style={{ textDecoration: "none" }}>
                <Chip
                  label={`${post.county} County`}
                  size="small"
                  color="primary"
                  clickable
                />
              </RouterLink>
            ) : (
              <Chip
                label={`${post.county} County`}
                size="small"
                color="primary"
              />
            )
          )}
          {categoryLabel && (
            <Chip
              label={categoryLabel}
              size="small"
              variant="outlined"
            />
          )}
        </Box>

        <Divider />

        {/* Source attribution box */}
        <Box style={{ margin: "12px 10px", padding: "10px 14px", backgroundColor: "#f5f5f5", borderRadius: 4, borderLeft: "3px solid #1976d2" }}>
          <Typography variant="caption" display="block" style={{ color: "#555" }}>
            Summary — Original reporting by{" "}
            <a href={post.originalLink} target="_blank" rel="noopener noreferrer" style={{ color: "#1976d2", textDecoration: "none" }}>
              {sourceName}
            </a>
          </Typography>
          {post.author && (
            <Typography variant="caption" display="block" style={{ color: "#555" }}>
              Author: {post.author}
            </Typography>
          )}
          <Typography variant="caption" display="block" style={{ marginTop: 4 }}>
            <a href={post.originalLink} target="_blank" rel="noopener noreferrer" style={{ color: "#1976d2", textDecoration: "none" }}>
              Read full story at {sourceName}
            </a>
          </Typography>
        </Box>

        {video && (
          <Box style={{ padding: "10px 10px 0" }}>
            {video.type === "youtube" || video.type === "vimeo" ? (
              <div style={{ position: "relative", paddingTop: "56.25%", borderRadius: 8, overflow: "hidden" }}>
                <iframe
                  title={`${post.title} video`}
                  src={video.src}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: 0 }}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            ) : (
              <video
                controls
                preload="metadata"
                style={{ width: "100%", borderRadius: 8, backgroundColor: "#000" }}
              >
                <source src={video.src} type={video.type === "hls" ? "application/vnd.apple.mpegurl" : "video/mp4"} />
                Your browser does not support embedded video playback.
              </video>
            )}
          </Box>
        )}

        {summaryParagraphs.length > 0 && (
          <div className={"description"} style={{ padding: "0 10px 10px" }}>
            <Typography variant="subtitle2" color="textSecondary" gutterBottom>
              Summary
            </Typography>
            {summaryParagraphs.map((para, index) => (
              <Typography key={`${post.title}-summary-${index}`} variant="body1" paragraph>
                {para}
              </Typography>
            ))}
          </div>
        )}

        <Box style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, padding: "0 10px 12px" }}>
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
            style={{ fontWeight: 600 }}
          >
            Read Full Story at {sourceName}
          </Button>
          {post.county && countySlug && (
            hasRouter ? (
              <RouterLink
                to={`/news/${countySlug}`}
                style={{ color: "#1976d2", textDecoration: "none", whiteSpace: "nowrap" }}
              >
                <Typography variant="body2" style={{ color: "#1976d2", whiteSpace: "nowrap" }}>
                  — More {post.county} County News
                </Typography>
              </RouterLink>
            ) : (
              <Typography variant="body2" style={{ color: "#1976d2", whiteSpace: "nowrap" }}>
                — More {post.county} County News
              </Typography>
            )
          )}
        </Box>

        {relatedPosts.length > 0 && (
          <>
            <Divider />
            <Box style={{ padding: "12px 10px 8px" }}>
              <Typography variant="h6" gutterBottom>
                More from {post.county} County
              </Typography>
              {relatedPosts.map((rp) => (
                <Box
                  key={rp.originalLink}
                  style={{ paddingBottom: 14, cursor: "pointer" }}
                  onClick={() => handleRelatedClick(rp)}
                >
                  <Typography variant="body2" style={{ color: "#1976d2", fontWeight: 500 }}>
                    {rp.title}
                  </Typography>
                  <Typography variant="caption" color="textSecondary">
                    {ToDateTime(rp.date)} · {extractSourceName(rp.originalLink || "")}
                  </Typography>
                </Box>
              ))}
            </Box>
          </>
        )}
      </Grid>
    </main>
  );
}

function extractSourceName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    const name = parts.length >= 2 ? parts[parts.length - 2] : host;
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return "Source";
  }
}

function categoryDisplayName(category) {
  const map = {
    today: "Local News",
    national: "National News",
    sports: "Sports",
    weather: "Weather",
    schools: "Schools",
    obituaries: "Obituaries",
  };
  return map[category] || (category ? category.charAt(0).toUpperCase() + category.slice(1) : "Local News");
}

function findPlayableVideo(post) {
  const candidates = [
    post?.originalLink,
    ...extractUrlsFromText(post?.description),
    ...extractUrlsFromText(post?.contentText),
    ...extractUrlsFromText(post?.shortDesc),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const detected = detectVideoSource(candidate);
    if (detected) return detected;
  }

  return null;
}

function extractUrlsFromText(input) {
  const text = String(input || "");
  if (!text) return [];

  const urls = [];
  const srcHrefMatches = text.matchAll(/(?:src|href)=["']([^"']+)["']/gi);
  for (const match of srcHrefMatches) {
    if (match?.[1]) urls.push(match[1]);
  }

  const plainUrlMatches = text.matchAll(/https?:\/\/[^\s"'<>]+/gi);
  for (const match of plainUrlMatches) {
    if (match?.[0]) urls.push(match[0]);
  }

  return urls;
}

function detectVideoSource(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    return null;
  }

  if (!(parsed.protocol === "https:" || parsed.protocol === "http:")) {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const pathname = parsed.pathname;

  const youtubeId = extractYouTubeId(host, parsed);
  if (youtubeId) {
    return { type: "youtube", src: `https://www.youtube.com/embed/${youtubeId}` };
  }

  const vimeoId = extractVimeoId(host, pathname);
  if (vimeoId) {
    const hash = parsed.searchParams.get("h");
    return {
      type: "vimeo",
      src: `https://player.vimeo.com/video/${vimeoId}${hash ? `?h=${encodeURIComponent(hash)}` : ""}`,
    };
  }

  if (/\.m3u8(?:$|\?)/i.test(`${pathname}${parsed.search}`)) {
    return { type: "hls", src: parsed.toString() };
  }

  if (/\.(mp4|webm|ogg)(?:$|\?)/i.test(`${pathname}${parsed.search}`)) {
    return { type: "mp4", src: parsed.toString() };
  }

  return null;
}

function extractYouTubeId(host, parsed) {
  if (host === "youtu.be") {
    return parsed.pathname.split("/").filter(Boolean)[0] || null;
  }

  if (!(host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com")) {
    return null;
  }

  if (parsed.pathname.startsWith("/watch")) {
    return parsed.searchParams.get("v");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] === "embed" || parts[0] === "shorts") {
    return parts[1] || null;
  }

  return null;
}

function extractVimeoId(host, pathname) {
  if (!(host === "vimeo.com" || host === "player.vimeo.com")) {
    return null;
  }

  const parts = pathname.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (/^\d+$/.test(parts[i])) {
      return parts[i];
    }
  }

  return null;
}

FeaturedPost.propTypes = {
  post: PropTypes.object,
};
