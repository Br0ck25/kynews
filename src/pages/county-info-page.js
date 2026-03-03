import React, { useEffect } from "react";
import { useParams, useHistory } from "react-router-dom";
import { makeStyles } from "@material-ui/core/styles";
import { Typography, Box, Tabs, Tab, Card, CardContent } from "@material-ui/core";
import { slugToCounty } from "../utils/functions";
import { countyInfo } from "../data/countyInfo";

const useStyles = makeStyles((theme) => ({
  root: {},
  card: {
    marginBottom: theme.spacing(2),
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

  if (!countyName || !info) {
    return (
      <Typography variant="body1" color="error">
        County information not found.
      </Typography>
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
      <Card data-testid="county-card" className={classes.card}>
        <CardContent>
          <Typography variant="h5" gutterBottom>
            {countyName} County
          </Typography>
          <Box style={{ marginBottom: 16 }}>{content}</Box>
        </CardContent>
      </Card>
    </div>
  );
}
