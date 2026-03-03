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
          <Typography variant="h6" gutterBottom>
            Primary County Offices
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Judge Office</strong> – County Judge
                Executive<br />
                Address: 22010 Main St, Hyden, KY 41749<br />
                Phone: (606) 672-3200<br />
                Website: <a target="_blank" rel="noopener noreferrer" href="https://lesliecounty.ky.gov">lesliecounty.ky.gov</a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Court Clerk's</strong> – County Court /
                Clerk<br />
                Address: 22010 Main St, Hyden, KY 41749<br />
                Phone: (606) 672-2193<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://lesliecountyclerk.ky.gov/">
                  https://lesliecountyclerk.ky.gov/
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Property Vltn</strong> – Property Valuation
                Administrator (PVA)<br />
                Address: 22010 Main St #104, Hyden, KY 41749<br />
                Phone: (606) 672-2456
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Treasurer's</strong> – County Treasurer<br />
                Address: 22010 Main St, Hyden, KY 41749<br />
                Phone: (606) 672-3901
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom>
            Law Enforcement & Emergency Services
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Sheriff Department</strong> – Sheriff’s
                Office<br />
                Address: 22010 Main St, Hyden, KY 41749<br />
                Phone: (606) 672-2200<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://lesliecounty.ky.gov/">
                  https://lesliecounty.ky.gov/
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County E-911 Dispatch</strong> – 911 Dispatch<br />
                Address: 24770 US-421, Hyden, KY 41749<br />
                Phone: (606) 672-2986<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="http://leslie911.com/">http://leslie911.com/</a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom>
            Health & Social Services
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Home Health</strong> – Public health / health
                department services<br />
                Address: 78 Maple St #2, Hyden, KY 41749<br />
                Phone: (606) 672-2393
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Child Support</strong> – Child Support
                Services<br />
                Address: 21892 Main St, Hyden, KY 41749<br />
                Phone: (606) 672-4452<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://csws.chfs.ky.gov/csws/General/LocateOffice.aspx?selIndex=066">
                  CSWS Child Support Locator
                </a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom>
            Other County Services
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Extension Office</strong> – Cooperative
                Extension (UK)<br />
                Address: 22045 Main St #514, Hyden, KY 41749<br />
                Phone: (606) 672-2154<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://leslie.ca.uky.edu/">https://leslie.ca.uky.edu/</a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County 4-H Office</strong> – County 4-H Youth
                Services<br />
                Address: 22045 Main St #514, Hyden, KY 41749<br />
                Phone: (606) 672-3125
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Road Department Garage</strong> – Road
                Department<br />
                Address: 332 Wendover Rd, Hyden, KY 41749<br />
                Phone: (606) 672-2720
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Senior Citizens</strong> – Senior Citizen
                Services Center<br />
                Address: 178 Wendover Rd, Hyden, KY 41749<br />
                Phone: (606) 672-3222<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://seniorcenter.us/sc/leslie_county_senior_citizens_center_hyden_ky">
                  County Senior Center
                </a>
              </Typography>
            </CardContent>
          </Card>

          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Judge Executive</strong> (Jimmy Sizemore) – P.O. Box
                619, Hyden, KY 41749 – Phone: (606) 672-3200
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>County Clerk</strong> – at the County Courthouse – (606)
                672-2193
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Circuit Court Clerk</strong> – at Courthouse – (606)
                672-2503/2505
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                County Coroner, Jailer, PVA, Solid Waste Coordinator, Road
                Supervisor, Animal Control, etc. – Listed through county records.
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Leslie County Government Website</strong> – For general contact and
                more department info:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://lesliecounty.ky.gov/">
                  https://lesliecounty.ky.gov/
                </a>
              </Typography>
            </CardContent>
          </Card>
        </>
      ),
      utilities: (
        <>
          <Typography variant="h6" gutterBottom>
            Electric Utilities
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Kentucky Power</strong> – Investor-owned utility serving
                most of eastern Kentucky, including Leslie County.<br />
                Website: <a target="_blank" rel="noopener noreferrer" href="https://www.kentuckypower.com/">kentuckypower.com</a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Cumberland Valley Electric, Inc.</strong> – Member-owned
                electric cooperative serving rural customers.<br />
                Phone: 1-800-513-2677<br />
                Website: <a target="_blank" rel="noopener noreferrer" href="https://www.cumberlandvalley.coop/">cumberlandvalley.coop</a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Jackson Energy Cooperative</strong> – Electric distribution
                co-op (smaller portion of county coverage). See website for
                contact info.<br />
                <a target="_blank" rel="noopener noreferrer" href="https://www.jacksonenergy.com/">jacksonenergy.com</a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom>
            Water Utilities
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Hyden-Leslie County Water District</strong> – Local water
                supply and treatment provider for the Hyden/Leslie area.<br />
                Website: <a target="_blank" rel="noopener noreferrer" href="https://www.doxo.com/u/biller/hyden-leslie-county-water-district-19AAD20">
                  doxo profile
                </a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom>
            Trash & Waste Services
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Rumpke Waste & Recycling</strong> – Trash collection and
                recycling services in parts of Hyden/Leslie County.<br />
                Leslie County Transfer Station: 2125 KY-118, Hyden, KY 41749<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://www.rumpke.com/">rumpke.com</a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom>
            Internet / Phone / TV Providers
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>TDS Telecom (Leslie County Telephone Co.)</strong> –
                Internet, telephone, and TV services.<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://tdstelecom.com/local/kentucky/hyden.html">
                  tdstelecom.com
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Spectrum Internet & TV</strong> – Cable internet, home phone,
                and TV services in parts of the county.<br />
                Website:{' '}
                <a target="_blank" rel="noopener noreferrer" href="https://www.spectrum.com/internet-service/kentucky/leslie-county">
                  spectrum.com
                </a>
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Thacker-Grigsby Cable/Internet</strong> – Cable internet
                service in some county areas; contact via availability check on
                their site.
              </Typography>
            </CardContent>
          </Card>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Other ISPs</strong> (varies by address) – Providers like
                T-Mobile Home Internet, Starlink Satellite Internet, HughesNet, etc.
                may be available depending on location.
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom>
            Propane / Alternative Fuel Providers
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>AmeriGas Propane</strong> (Leitchfield, KY) – Propane delivery
                and tank services.<br />
                207 N Main St, Leitchfield, KY 42754<br />
                <a target="_blank" rel="noopener noreferrer" href="https://www.amerigas.com/locations/propane-offices/kentucky/leitchfield/">
                  amerigas.com
                </a>
              </Typography>
            </CardContent>
          </Card>

          <Typography variant="h6" gutterBottom>
            Regulatory Body
          </Typography>
          <Card className={classes.infoCard}>
            <CardContent>
              <Typography variant="body2" paragraph>
                <strong>Kentucky Public Service Commission (PSC)</strong> — Regulates
                electric, water, gas, and telecom utilities in Kentucky (including
                companies serving Leslie County).
                <br />
                <a target="_blank" rel="noopener noreferrer" href="https://www.psc.ky.gov/">psc.ky.gov</a>
              </Typography>
            </CardContent>
          </Card>
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
