import React, { useEffect, useState } from "react";
import { makeStyles } from "@material-ui/core/styles";
import {
  Typography,
  Divider,
  IconButton,
  Button,
  Box,
  Tabs,
  Tab,
  Card,
  CardContent,
} from "@material-ui/core";
import { useLocation } from "react-router-dom";
import { countyInfo } from "../data/countyInfo";
import FullScreenPostDialog from "../components/post/dialog-fullscreen-component";
import ShareIcon from "@material-ui/icons/Share";
import FavoriteIcon from "@material-ui/icons/Favorite";
import SiteService from "../services/siteService";
import FeaturedPost from "../components/featured-post-component";
import Posts from "../components/home/posts-component";
import Skeletons from "../components/skeletons-component";
import SnackbarNotify from "../components/snackbar-notify-component";
import { slugToCounty, getCountyIntro, countyToSlug } from "../utils/functions";
import { useParams, useHistory } from "react-router-dom";
import { __RouterContext } from "react-router";
import { ToggleSavedCounty, GetSavedCounties } from "../services/storageService";

const useStyles = makeStyles((theme) => ({
  root: {},
  card: {
    marginBottom: theme.spacing(2),
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: theme.palette.background.paper,
    boxShadow: theme.shadows[1],
    transition: "transform .18s ease, box-shadow .18s ease",
    "&:hover": {
      transform: "translateY(-2px)",
      boxShadow: theme.shadows[4],
    },
  },
  infoCard: {
    marginBottom: theme.spacing(2),
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: theme.palette.background.paper,
    boxShadow: "0 2px 8px rgba(17, 24, 39, .10)",
    transition: "transform .18s ease, box-shadow .18s ease",
    "&:hover": {
      transform: "translateY(-2px)",
      boxShadow: "0 8px 24px rgba(17, 24, 39, .14)",
    },
  },
  headerActions: {
    display: "inline-flex",
    verticalAlign: "middle",
    marginLeft: theme.spacing(1),
  },
  backLink: {
    marginBottom: theme.spacing(2),
  },
  divider: {
    margin: theme.spacing(2, 0),
  },
}));

const service = new SiteService();

const SITE_URL = "https://localkynews.com";

// utility used by multiple pages to inject/update meta tags
function setMeta(attr, value, content) {
  let el = document.querySelector(`meta[${attr}="${value}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, value);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}
const SITE_NAME = "Local KY News";

// helper for injecting/updating <meta> tags
function setMeta(attr, value, content) {
  let el = document.querySelector(`meta[${attr}="${value}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, value);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

/** Inject JSON-LD structured data for a county page */
function setCountyJsonLd(countyName) {
  const pageUrl = `${SITE_URL}/news/kentucky/${countyName.toLowerCase().replace(/\s+/g, "-")}-county`;
  const schema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${countyName} County, KY News`,
    description: `Latest news from ${countyName} County, Kentucky — including local government, schools, sports, weather, and community updates.`,
    url: pageUrl,
    publisher: { "@type": "Organization", name: "Local KY News", url: SITE_URL },
    breadcrumb: {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Kentucky Counties", item: `${SITE_URL}/local` },
        { "@type": "ListItem", position: 3, name: `${countyName} County`, item: pageUrl },
      ],
    },
  };
  let el = document.getElementById("json-ld-county");
  if (!el) {
    el = document.createElement("script");
    el.type = "application/ld+json";
    el.id = "json-ld-county";
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(schema);
}

/**
 * Returns a 300–500 word introductory text about a given KY county.
 * Used to satisfy Section 5.4 of the SEO implementation plan.
 */

export default function CountyPage({ countySlugProp = null, onClose = null, infoType = null }) {
  const classes = useStyles();
  // Determine if we're within a router context (dialogs may break the context due
  // to portals).  We'll always call the hooks but only use them when a router
  // exists so we don't violate the Rules of Hooks by changing call order.
  const router = React.useContext(__RouterContext);
  const hasRouter = !!router;
  const params = useParams();
  const history = useHistory();

  const countySlug =
    countySlugProp || (hasRouter ? params.countySlug : "") || "";
  // infoType may come from props (via KentuckyNewsPage) or from params when
  // rendered via dialog memory router.
  const paramInfo = hasRouter ? params.infoType : undefined;
  const effectiveInfoType = infoType || paramInfo || null;

  const countyName = slugToCounty(countySlug);

  const [posts, setPosts] = useState([]);
  const [statePosts, setStatePosts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errors, setErrors] = useState("");
  const [saved, setSaved] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState("");
  // County intro: first paragraph always visible, rest collapsed by default
  const [introExpanded, setIntroExpanded] = useState(false);

  const location = useLocation();

  // robots meta for paginated variants
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const hasCursor = params.has('cursor');
    let robotsMeta = document.querySelector('meta[name="robots"]');
    if (!robotsMeta) {
      robotsMeta = document.createElement('meta');
      robotsMeta.name = 'robots';
      document.head.appendChild(robotsMeta);
    }
    robotsMeta.setAttribute('content', hasCursor ? 'noindex, follow' : 'index, follow');
    return () => {
      robotsMeta?.setAttribute('content', 'index, follow');
    };
  }, [location.search]);
  // dialog state for info pages
  const [infoDialogOpen, setInfoDialogOpen] = useState(false);


  // open/close info dialog whenever information path changes
  useEffect(() => {
    setInfoDialogOpen(!!effectiveInfoType);
  }, [effectiveInfoType]);

  // update page metadata when county changes
  useEffect(() => {
    if (!countyName) return;

    document.title = `${countyName} County, KY News — Local KY News`;
    const description = `The latest news from ${countyName} County, Kentucky — local government, schools, sports, weather, and community stories.`;
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", description);

    // Self-referencing canonical (Section 5.2)
    const pageUrl = `${SITE_URL}/news/kentucky/${countyName.toLowerCase().replace(/\s+/g, "-")}-county`;
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.setAttribute("rel", "canonical");
      document.head.appendChild(canonical);
    }
    canonical.setAttribute("href", pageUrl);

    // JSON-LD schema (Section 5.5)
    setCountyJsonLd(countyName);

    // Open Graph / Twitter cards
    const ogTitle = `${countyName} County, KY News — Local KY News`;
    const ogDesc = `The latest news from ${countyName} County, Kentucky — local government, schools, sports, weather, and community stories.`;
    const defaultImage = 'https://localkynews.com/img/preview.png';

    setMeta('property', 'og:type', 'website');
    setMeta('property', 'og:title', ogTitle);
    setMeta('property', 'og:description', ogDesc);
    setMeta('property', 'og:url', pageUrl);
    setMeta('property', 'og:image', defaultImage);
    setMeta('property', 'og:site_name', 'Local KY News');
    setMeta('name', 'twitter:card', 'summary_large_image');
    setMeta('name', 'twitter:title', ogTitle);
    setMeta('name', 'twitter:description', ogDesc);
    setMeta('name', 'twitter:image', defaultImage);

    // handle pagination robots tags when ?cursor is present
    const params = new URLSearchParams(location.search);
    const hasCursor = params.has('cursor');
    let robotsMeta = document.querySelector('meta[name="robots"]');
    if (!robotsMeta) {
      robotsMeta = document.createElement('meta');
      robotsMeta.name = 'robots';
      document.head.appendChild(robotsMeta);
    }
    robotsMeta.setAttribute('content', hasCursor ? 'noindex, follow' : 'index, follow');

    return () => {
      // cleanup generic metadata
      document.title = SITE_NAME;      const genericDesc =
        "Kentucky News - local, state, and national updates for all 120 Kentucky counties.";
      let meta = document.querySelector('meta[name="description"]');
      if (meta) meta.setAttribute('content', genericDesc);
      setCanonical(SITE_URL);
      // clear OG/Twitter back to defaults
      setMeta('property', 'og:image', `${SITE_URL}/img/preview.png`);
      setMeta('name', 'twitter:image', `${SITE_URL}/img/preview.png`);
      setMeta('property', 'og:title', SITE_URL);
      setMeta('property', 'og:description', genericDesc);
      setMeta('name', 'twitter:title', SITE_URL);
      setMeta('name', 'twitter:description', genericDesc);
      setMeta('property', 'og:url', SITE_URL);
      setMeta('property', 'og:site_name', 'Local KY News');
      robotsMeta?.setAttribute('content', 'index, follow');
    };
  }, [countyName]);

  // Determine whether this county is in the dedicated saved-counties list.
  useEffect(() => {
    if (!countyName) return;
    const savedCounties = GetSavedCounties();
    setSaved(savedCounties.includes(countyName));
  }, [countyName]);

  // fetch county-specific posts (and fallback state posts if needed)
  useEffect(() => {
    if (!countyName) return;
    setIsLoading(true);
    setErrors("");

    service
      .getPosts({ category: "today", counties: [countyName], limit: 50 })
      .then((countyData) => {
        setPosts(countyData);

        if (countyData.length < 5) {
          // grab some extra statewide kentucky posts to pad the page
          return service
            .getPosts({ category: "today", limit: 10 })
            .then((stateData) => {
              const extras = stateData
                .filter((p) => p.county !== countyName)
                .slice(0, 5 - countyData.length);
              setStatePosts(extras);
            });
        }
      })
      .catch((err) => {
        setErrors(err.errorMessage || "Failed to load posts.");
      })
      .finally(() => setIsLoading(false));
  }, [countyName]);

  const handleShare = async () => {
    const title = `${countyName} County, KY News`;
    // build canonical URL rather than relying on window.location (which will be
    // "/local" when this page is shown via dialog).
    const slug = countyToSlug(countyName);
    const url = `${SITE_URL}/news/kentucky/${slug}`;
    const text = `Latest from ${countyName} County on Kentucky News`;

    try {
      if (navigator.share) {
        await navigator.share({ title, text, url });
      } else {
        await navigator.clipboard.writeText(url);
        setSnackbarMessage("Link copied to clipboard");
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleSave = () => {
    if (!countyName) return;
    const nowSaved = ToggleSavedCounty(countyName);
    setSaved(nowSaved);

    if (nowSaved) {
      // Saving a county only bookmarks it; feed filters are managed in Settings.
      setSnackbarMessage(
        `${countyName} County saved. To filter your home feed by county, go to Settings → County Filters.`
      );
    } else {
      setSnackbarMessage(`${countyName} County removed from saved list.`);
    }
  };

  const handleBack = () => {
    // unused since we no longer show a back button; navigation is handled
    // by the UI that opened this page/dialog.
    if (countySlugProp && props?.onClose) {
      props.onClose();
    } else if (history) {
      history.push("/local");
    }
  };

  if (!countyName) {
    return (
      <Card data-testid="county-card" className={classes.card}>
        <CardContent>
          <Typography variant="h5">County not found</Typography>
          <Typography variant="body2">
            The URL you provided does not match a valid Kentucky county.
          </Typography>
        </CardContent>
      </Card>
    );
  }

  // static per-county info.  only Leslie has content at the moment.
  const perCountyInfo = {
    Leslie: {
      government: (
        <>
          <Typography variant="h4" gutterBottom>
            Leslie County, Kentucky Government Offices
          </Typography>
          <Typography variant="body2" paragraph>
            Find contact information for Leslie County elected officials, courts,
            sheriff, jail, property valuation administrator (PVA), fiscal court,
            elections, health services, and more.
          </Typography>

          {/* quick links buttons */}
          <Box display="flex" flexWrap="wrap" mb={2}>
            {[
              { label: 'Property Search (PVA)', href: '#property-taxes' },
              { label: 'Pay Property Taxes', href: '#property-taxes' },
              { label: 'Jail Inmate Search', href: '#jail-courts' },
              { label: 'Court Docket', href: '#jail-courts' },
              { label: 'Voter Registration', href: '#elections-voting' },
            ].map((link) => (
              <Button
                key={link.label}
                variant="outlined"
                color="primary"
                size="small"
                component="a"
                href={link.href}
                style={{ margin: 4 }}
              >
                {link.label}
              </Button>
            ))}
          </Box>

          <Typography variant="h6" gutterBottom id="property-taxes">
            Property & Taxes
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Property Valuation Administrator (PVA)</strong> – Property
                assessments, homestead exemption, farm classification, property
                search<br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
                >
                  22010 Main St, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066722456">(606) 672-2456</a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Sheriff Tax Collection</strong> – County sheriff collects
                property taxes on behalf of the PVA.<br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
                >
                  22010 Main St, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066722200">(606) 672-2200</a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>County Treasurer</strong><br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
                >
                  22010 Main St, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066723901">(606) 672-3901</a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom id="jail-courts">
            Jail & Courts
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Detention Center</strong> – County jail<br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=2125+KY-118,+Hyden,+KY+41749"
                >
                  2125 KY-118, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066723548">(606) 672-3548</a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Circuit Court Clerk</strong><br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
                >
                  22010 Main St, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066722503">(606) 672-2503</a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Commonwealth’s Attorney (Circuit #27)</strong> – Felony
                prosecutions<br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
                >
                  22010 Main St, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066724421">(606) 672-4421</a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom id="elected-officials">
            Elected Officials
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>County Judge/Executive</strong> – Jimmy Sizemore<br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
                >
                  22010 Main St, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066723200">(606) 672-3200</a>
                <br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://lesliecounty.ky.gov">
                  lesliecounty.ky.gov
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>County Attorney</strong><br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
                >
                  22010 Main St, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066724452">(606) 672-4452</a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Sheriff</strong><br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
                >
                  22010 Main St, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066722200">(606) 672-2200</a>
                <br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://lesliecounty.ky.gov">
                  lesliecounty.ky.gov
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>County Clerk</strong><br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
                >
                  22010 Main St, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066722193">(606) 672-2193</a>
                <br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://lesliecountyclerk.ky.gov">
                  lesliecountyclerk.ky.gov
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>County Coroner</strong><br />
                Phone: (606) 672-3200 (contact Judge Executive’s office for current
                name)
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Constables</strong><br />
                (Contact Fiscal Court for current district listings)
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom id="elections-voting">
            Elections & Voting
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>County Clerk – Election Services</strong><br />
                Voter registration, absentee ballots, polling locations (see
                state board website).<br />
                Website: <a target="_blank" rel="noopener noreferrer" href="https://elect.ky.gov">
                  elect.ky.gov
                </a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom id="public-safety">
            Public Safety & Emergency Services
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Sheriff’s Office</strong><br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749"
                >
                  22010 Main St, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066722200">(606) 672-2200</a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Emergency Management (EMA)</strong> – 24770 US-421,<br />
                Hyden, KY 41749 – Phone:{' '}
                <a href="tel:+16066722986">(606) 672-2986</a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Animal Control</strong> – handled through Sheriff’s
                Office<br />
                Phone: <a href="tel:+16066722200">(606) 672-2200</a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom id="health-services">
            Health & Social Services
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Home Health</strong><br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=78+Maple+St+%232,+Hyden,+KY+41749"
                >
                  78 Maple St #2, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066722393">(606) 672-2393</a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Child Support</strong><br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=21892+Main+St,+Hyden,+KY+41749"
                >
                  21892 Main St, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066724452">(606) 672-4452</a><br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://csws.chfs.ky.gov">
                  csws.chfs.ky.gov
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Department for Community Based Services (DCBS)</strong><br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=21892+Main+St,+Hyden,+KY+41749"
                >
                  21892 Main St, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+18553068959">(855) 306-8959</a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom id="community">
            Community & Agricultural Services
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Cooperative Extension Office</strong> (UK)<br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=22045+Main+St+%23514,+Hyden,+KY+41749"
                >
                  22045 Main St #514, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066722154">(606) 672-2154</a><br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://leslie.ca.uky.edu">
                  leslie.ca.uky.edu
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>4-H Youth Development</strong><br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=22045+Main+St+%23514,+Hyden,+KY+41749"
                >
                  22045 Main St #514, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066723125">(606) 672-3125</a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Road Department / County Garage</strong><br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=332+Wendover+Rd,+Hyden,+KY+41749"
                >
                  332 Wendover Rd, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066722720">(606) 672-2720</a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Public Library</strong><br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=22065+Main+St,+Hyden,+KY+41749"
                >
                  22065 Main St, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066722464">(606) 672-2464</a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom id="planning">
            Planning & Zoning
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                Contact Leslie County Judge Executive’s Office<br />
                Phone: <a href="tel:+16066723200">(606) 672-3200</a>
              </Typography>
            </CardContent>
          </Card>

          <Box mt={2}>
            <Typography variant="body2">
              Looking for utility providers in Leslie County?{' '}
              <a href="/news/kentucky/leslie-county/utilities">
                View our Leslie County Utilities Directory →
              </a>
            </Typography>
          </Box>
        </>
      ),
      utilities: (
        <>
          <Typography variant="h4" gutterBottom>
            Leslie County, Kentucky Utilities Directory
          </Typography>
          <Typography variant="body2" paragraph>
            Find electric, water, sewer, trash, internet, phone, and natural gas
            providers serving Leslie County, Kentucky.
          </Typography>

          <Typography variant="h6" gutterBottom id="electric-utilities">
            Electric Utilities
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Kentucky Power</strong> – Investor-owned utility serving
                most of eastern Kentucky, including Leslie County.<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://kentuckypower.com">
                  kentuckypower.com
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Cumberland Valley Electric</strong> – Member-owned
                electric cooperative serving rural customers.<br />
                Phone: 1-800-513-2677<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://cumberlandvalley.coop">
                  cumberlandvalley.coop
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Jackson Energy Cooperative</strong> – Electric distribution
                co-op (smaller portion of county coverage).<br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=115+Jackson+Energy+Lane,+McKee,+KY+40447"
                >
                  115 Jackson Energy Lane, McKee, KY 40447
                </a>
                <br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://www.jacksonenergy.com/">
                  jacksonenergy.com
                </a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom>
            Water & Sewer
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Hyden-Leslie Water District</strong> – Local water
                supply and treatment provider for the Hyden/Leslie area.<br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=325+Wendover+Rd,+Hyden,+KY+41749"
                >
                  325 Wendover Rd, Hyden, KY 41749
                </a>
                <br />
                Phone:{' '}
                <a href="tel:+16066722791">(606) 672-2791</a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom>
            Trash & Waste
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Rumpke Waste & Recycling</strong> – Trash collection and
                recycling services in parts of Hyden/Leslie County.<br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=2125+KY-118,+Hyden,+KY+41749"
                >
                  2125 KY-118, Hyden, KY 41749
                </a>
                <br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://rumpke.com">
                  rumpke.com
                </a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom>
            Natural Gas
          </Typography>
          <Typography variant="body2" paragraph>
            Limited natural gas coverage; availability must be verified by
            address.
          </Typography>

          <Typography variant="h6" gutterBottom>
            Internet & Cable
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>TDS Telecom</strong> – Internet, phone, TV services.<br />
                Phone:{' '}
                <a href="tel:+16066722303">(606) 672-2303</a><br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://tdstelecom.com">
                  tdstelecom.com
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Spectrum</strong> – Cable internet, TV, phone.<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://spectrum.com">
                  spectrum.com
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Thacker-Grigsby</strong><br />
                Address:{' '}
                <a
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://www.google.com/maps/search/?api=1&query=60+Communication+Lane,+Hindman,+KY+41822"
                >
                  60 Communication Lane, Hindman, KY 41822
                </a>
                <br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://tgtel.com/">
                  tgtel.com
                </a>
              </Typography>
            </CardContent>
          </Card>

          {/* new satellite provider cards */}
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Starlink</strong> – Satellite internet available countywide.<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://www.starlink.com">
                  starlink.com
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Viasat</strong> – Satellite broadband provider.<br />
                Phone: 1-855-810-1308<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://www.viasat.com">
                  viasat.com
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>HughesNet</strong> – Satellite internet provider.<br />
                Phone: 1-866-347-3292<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://www.hughesnet.com">
                  hughesnet.com
                </a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom>
            Phone & Cellular
          </Typography>
          <Typography variant="body2" paragraph>
            Providers such as T-Mobile, Verizon, and AT&T offer service in the
            region depending on coverage.
          </Typography>

          <Typography variant="h6" gutterBottom>
            Broadband Resources
          </Typography>
          <Typography variant="body2" paragraph>
            <a target="_blank" rel="noopener noreferrer" href="https://broadbandmap.fcc.gov">
              FCC Broadband Map
            </a>
            <br />
            <a target="_blank" rel="noopener noreferrer" href="https://broadband.ky.gov">
              Kentucky Broadband Office
            </a>
          </Typography>

          <Box mt={2}>
            <Typography variant="body2">
              Need government office contact information?{' '}
              <a href="/news/kentucky/leslie-county/government-offices">
                View our Leslie County Government Offices Directory →
              </a>
            </Typography>
          </Box>
        </>
      ),
      },
  };

  return (
    <div className={classes.root}>
      <Card data-testid="county-card" className={classes.card}>
        <CardContent>
          <Typography variant="h5" gutterBottom>
            {countyName} County
            <span className={classes.headerActions}>
              <IconButton
                color="primary"
                size="small"
                aria-label="Share county"
                onClick={handleShare}
              >
                <ShareIcon fontSize="small" />
              </IconButton>
              <IconButton
                color={saved ? "secondary" : "primary"}
                size="small"
                aria-label="Save county"
                onClick={handleSave}
              >
                <FavoriteIcon fontSize="small" />
              </IconButton>
            </span>
          </Typography>

          {/* County introductory content — 300–500 words (Section 5.4)
               First paragraph always visible; remaining paragraphs collapsible. */}
          <Box
            style={{
              background: "#f5f8ff",
              border: "1px solid #d0d9f0",
              borderRadius: 6,
              padding: "14px 16px",
              marginBottom: 20,
            }}
          >
            {getCountyIntro(countyName)
              .split("\n\n")
              .map((para, i) => {
                if (i === 0) {
                  return (
                    <Typography key={i} variant="body2" color="textSecondary" paragraph style={{ marginBottom: 8 }} dangerouslySetInnerHTML={{ __html: para }} />
                  );
                }
                if (!introExpanded) return null;
                return (
                  <Typography key={i} variant="body2" color="textSecondary" paragraph style={{ marginBottom: i < 2 ? 8 : 0 }} dangerouslySetInnerHTML={{ __html: para }} />
                );
              })}
            <Button
              size="small"
              color="primary"
              onClick={() => setIntroExpanded((v) => !v)}
              style={{ padding: "0 0 4px", minWidth: 0, textTransform: "none", fontSize: "0.78rem" }}
            >
              {introExpanded ? "Show less" : "Show more"}
            </Button>
          </Box>

          {/* navigation buttons for county info pages; always available unless already viewing an info subpage */}
          {!effectiveInfoType && (
            <Tabs
              indicatorColor="primary"
              textColor="primary"
              variant="scrollable"
              scrollButtons="auto"
              aria-label="County info navigation"
              value={
                location.pathname.endsWith("government-offices")
                  ? 0
                  : location.pathname.endsWith("utilities")
                  ? 1
                  : false
              }
              style={{ marginBottom: 8 }}
            >
              <Tab
                label="Government Offices"
                onClick={() =>
                  history.push(`/news/kentucky/${countySlug}/government-offices`)
                }
              />
              <Tab
                label="Utilities"
                onClick={() =>
                  history.push(`/news/kentucky/${countySlug}/utilities`)
                }
              />
            </Tabs>
          )}
        </CardContent>
      </Card>

      <Divider className={classes.divider} />

      {isLoading ? (
        <Skeletons showFeaturedSkeleton />
      ) : (
        <>
          {errors && (
            <Typography color="error" variant="body2">
              {errors}
            </Typography>
          )}

          {posts && posts.length > 0 ? (
            <>
              <FeaturedPost post={posts[0]} />
              <Posts posts={posts.slice(1)} />
            </>
          ) : (
            <Typography variant="body1">
              No articles found for {countyName} County.
            </Typography>
          )}

          {posts.length < 5 && statePosts.length > 0 && (
            <>
              <Divider className={classes.divider} />
              <Typography variant="subtitle1" gutterBottom>
                More from Kentucky
              </Typography>
              <Posts posts={statePosts} />
            </>
          )}
        </>
      )}

      {snackbarMessage && <SnackbarNotify message={snackbarMessage} />}

      {/* full-screen dialog showing county info pages when requested */}
      {infoDialogOpen && (
        <FullScreenPostDialog
          countySlug={countySlug}
          infoType={effectiveInfoType}
          onClose={() => history.push(`/news/kentucky/${countySlug}`)}
        />
      )}
    </div>
  );
}
