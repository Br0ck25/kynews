import React, { useEffect, useState } from "react";
import { useParams, useHistory } from "react-router-dom";
import { makeStyles } from "@material-ui/core/styles";
import { Typography, Box, IconButton } from "@material-ui/core";
import ShareIcon from "@material-ui/icons/Share";
import FavoriteIcon from "@material-ui/icons/Favorite";
import { slugToCounty, countyToSlug } from "../utils/functions";
import { countyInfo } from "../data/countyInfo";
import { ToggleSavedCounty, GetSavedCounties } from "../services/storageService";

const useStyles = makeStyles((theme) => ({
  root: {},
  headerActions: {
    display: "inline-flex",
    verticalAlign: "middle",
    marginLeft: theme.spacing(1),
  },
}));

export default function CountyInfoPage({ countySlugProp = null, infoTypeProp = null, onClose = null }) {
  const classes = useStyles();
  const history = useHistory();
  const params = useParams();
  const countySlug = countySlugProp || params.countySlug || "";
  const infoType = infoTypeProp || params.infoType || "";
  const countyName = slugToCounty(countySlug || "");
  const info = countyInfo[countyName];

  // share & save state for info pages
  const [saved, setSaved] = useState(false);

  // keep saved status in sync with global list
  useEffect(() => {
    if (!countyName) return;
    const savedCounties = GetSavedCounties();
    setSaved(savedCounties.includes(countyName));
  }, [countyName]);

  const handleShare = async () => {
    if (!countyName || !infoType) return;
    const title = `${countyName} County, KY News`;
    const slug = countyToSlug(countyName);
    const url = `https://localkynews.com/news/kentucky/${slug}/${infoType}`;
    const text = `Latest ${
      infoType === "government-offices" ? "government offices" : "utilities"
    } for ${countyName} County on Kentucky News`;

    try {
      if (navigator.share) {
        await navigator.share({ title, text, url });
      } else {
        await navigator.clipboard.writeText(url);
        // silent; parent component may show snackbar but not available here
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleSave = () => {
    if (!countyName) return;
    const nowSaved = ToggleSavedCounty(countyName);
    setSaved(nowSaved);
  };

  useEffect(() => {
    if (!countyName) return;
    let titleSuffix = "";
    let description = "";
    if (infoType === "government-offices") {
      titleSuffix = " — Government Offices";
      description = `Contact information for government offices in ${countyName} County, Kentucky.`;
    } else if (infoType === "utilities") {
      titleSuffix = " — Utilities";
      description = `Utility providers and contact details serving ${countyName} County, Kentucky.`;
    }
    document.title = `${countyName} County${titleSuffix} — Local KY News`;

    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", description);

    // canonical URL for the specific info page
    const SITE_URL = "https://localkynews.com";
    const canonicalHref = `${SITE_URL}/news/kentucky/${countySlug}/${infoType}`;
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.setAttribute("rel", "canonical");
      document.head.appendChild(canonical);
    }
    canonical.setAttribute("href", canonicalHref);
  }, [countyName, infoType, countySlug]);

  if (!countyName) {
    return (
      <Typography variant="body1" color="error">
        County information not found.
      </Typography>
    );
  }

  if (!info) {
    // we still render the page structure but show a placeholder message
    return (
      <div className={classes.root}>
        <Typography variant="h5" gutterBottom>
          {countyName} County
        </Typography>
        <Typography variant="body1" color="textSecondary">
          Information for this category is not yet available for {countyName} County.
        </Typography>
      </div>
    );
  }

  let content = null;
  if (infoType === "government-offices")
    content = info.government;
  else if (infoType === "utilities") content = info.utilities;
  else {
    return (
      <Typography variant="body1" color="error">
        Page not found.
      </Typography>
    );
  }

  return (
    <div className={classes.root}>
      <Box display="flex" alignItems="center" justifyContent="space-between">
        <Typography variant="h5" gutterBottom>
          {countyName} County
        </Typography>
        <span className={classes.headerActions}>
          <IconButton
            color="primary"
            size="small"
            aria-label="Share page"
            onClick={handleShare}
          >
            <ShareIcon fontSize="small" />
          </IconButton>
          <IconButton
            color={saved ? "secondary" : "primary"}
            size="small"
            aria-label="Save page"
            onClick={handleSave}
          >
            <FavoriteIcon fontSize="small" />
          </IconButton>
        </span>
      </Box>
      <Box style={{ marginBottom: 16 }}>{content}</Box>
    </div>
  );
}
