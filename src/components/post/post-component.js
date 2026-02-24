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
import "./post-component.css";
import { ShareAPI, ToDateTime } from "../../utils/functions";

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
  const [showFullText, setShowFullText] = React.useState(false);
  const bodyText = String(post?.contentText || "").trim();
  const summaryText = String(post?.shortDesc || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const articleHtml = String(post?.description || "").trim();
  const paragraphs = bodyText
    ? bodyText.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean)
    : [];
  const previewParagraphs = paragraphs.slice(0, 5);

  const video = React.useMemo(() => findPlayableVideo(post), [post]);

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
        <Typography variant="body2" color="textSecondary" style={{ padding: "0 10px 10px" }}>
          {ToDateTime(post.date)}
        </Typography>
        <Divider />
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
        {summaryText && (
          <div className={"description"} style={{ paddingBottom: 0 }}>
            <Typography variant="subtitle2" color="textSecondary" gutterBottom>
              Summary
            </Typography>
            <Typography variant="body1" paragraph>
              {summaryText}
            </Typography>
          </div>
        )}
        <div className={"description"}>
          {articleHtml ? (
            <div dangerouslySetInnerHTML={{ __html: articleHtml }} />
          ) : previewParagraphs.length > 0 ? (
            <>
              {previewParagraphs.map((paragraph, index) => (
                <Typography key={`${post.title}-${index}`} variant="body1" paragraph>
                  {paragraph}
                </Typography>
              ))}
              {paragraphs.length > previewParagraphs.length && !showFullText && (
                <Button size="small" color="primary" onClick={() => setShowFullText(true)}>
                  Show more
                </Button>
              )}
              {showFullText && paragraphs.slice(previewParagraphs.length).map((paragraph, index) => (
                <Typography key={`${post.title}-full-${index}`} variant="body1" paragraph>
                  {paragraph}
                </Typography>
              ))}
            </>
          ) : (
            <Typography variant="body1">No article body available.</Typography>
          )}
        </div>
        <Box style={{ display: "flex", justifyContent: "flex-start", gap: 8, padding: "0 10px 12px" }}>
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
