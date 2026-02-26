import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import {
  Typography,
  Divider,
  Box,
  Paper,
  Avatar,
  Grid,
} from "@material-ui/core";
import NewspaperIcon from "@material-ui/icons/MenuBook";
import PeopleIcon from "@material-ui/icons/People";
import PolicyIcon from "@material-ui/icons/Policy";

const useStyles = makeStyles((theme) => ({
  root: {
    maxWidth: 860,
    margin: "0 auto",
    padding: theme.spacing(2, 2, 6),
  },
  hero: {
    background: "linear-gradient(135deg, #0d47a1 0%, #1565c0 100%)",
    color: "#fff",
    borderRadius: 8,
    padding: theme.spacing(4, 3),
    marginBottom: theme.spacing(4),
  },
  section: {
    marginBottom: theme.spacing(4),
  },
  teamCard: {
    padding: theme.spacing(2.5),
    display: "flex",
    gap: theme.spacing(2),
    alignItems: "flex-start",
  },
  avatar: {
    width: 56,
    height: 56,
    backgroundColor: "#1565c0",
    flexShrink: 0,
  },
  featureItem: {
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(1.5),
    marginBottom: theme.spacing(1.5),
  },
  icon: {
    color: "#1565c0",
    fontSize: 22,
  },
}));

export default function AboutPage() {
  const classes = useStyles();

  React.useEffect(() => {
    document.title = "About Local KY News — Kentucky's Local News Aggregator";
    const desc =
      "Learn about Local KY News, our editorial team, our mission to cover all 120 Kentucky counties, and our commitment to accurate, attributed news summaries.";
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", desc);
  }, []);

  return (
    <div className={classes.root}>
      {/* Hero */}
      <Box className={classes.hero}>
        <Typography variant="h4" component="h1" gutterBottom style={{ fontWeight: 700 }}>
          About Local KY News
        </Typography>
        <Typography variant="body1" style={{ opacity: 0.9, maxWidth: 620 }}>
          Kentucky's dedicated local news aggregator — covering all 120 counties
          with AI-assisted summaries that always credit the original reporters
          who make local journalism possible.
        </Typography>
      </Box>

      {/* Mission */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          Our Mission
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        <Typography variant="body1" paragraph>
          Local KY News exists to make Kentucky's local journalism more accessible.
          Eastern Kentucky, Western Kentucky, the Bluegrass region, and every county
          in between have stories worth reading — but those stories are scattered across
          dozens of newspapers, television station websites, and radio station pages.
          We bring them together in one place.
        </Typography>
        <Typography variant="body1" paragraph>
          We are a news aggregation and summarization service. We do not produce
          original journalism. Every story on this platform originates with a credentialed
          Kentucky news organization, and every summary on this platform links directly
          back to that organization's full article. Our role is to summarize, attribute,
          and surface — never to replace the reporters doing the work.
        </Typography>
        <Typography variant="body1" paragraph>
          Kentucky has 120 counties, many of them served by small, under-resourced
          newsrooms. We believe those communities deserve the same visibility as
          Louisville and Lexington. Our county-based organization ensures that news
          from Leslie County, Owsley County, or Elliott County reaches readers who
          care about those communities.
        </Typography>
      </Box>

      {/* What We Do */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          What We Do
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        <Typography variant="body1" paragraph>
          We monitor RSS feeds and news sources from across Kentucky every few minutes.
          When a new article is published, our platform:
        </Typography>
        <Box style={{ marginLeft: 16 }}>
          {[
            "Fetches the article content from the original publisher.",
            "Generates an AI-assisted summary — approximately 35–50% of the original length.",
            "Classifies the article by county and topic category (sports, weather, schools, etc.).",
            "Publishes the summary with full attribution to the original reporter and outlet.",
            "Provides a direct link to read the complete article at the original source.",
          ].map((item, i) => (
            <Box key={i} className={classes.featureItem}>
              <Typography variant="body2" style={{ color: "#1565c0", fontWeight: 700, minWidth: 20 }}>
                {i + 1}.
              </Typography>
              <Typography variant="body1">{item}</Typography>
            </Box>
          ))}
        </Box>
        <Typography variant="body1" paragraph style={{ marginTop: 16 }}>
          Our summaries are generated under strict rules: no new facts, no opinions,
          no speculation, and no editorializing. The summary exists solely to help
          readers decide whether they want to read the full article from the original
          publisher. We encourage every reader to click through.
        </Typography>
      </Box>

      {/* Editorial Team */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          <PeopleIcon style={{ verticalAlign: "middle", marginRight: 8, color: "#1565c0" }} />
          Editorial Team
        </Typography>
        <Divider style={{ marginBottom: 16 }} />

        <Grid container spacing={2}>
          {[
            {
              name: "Editorial Standards Board",
              role: "AI Summary Oversight",
              bio:
                "Our summarization process is governed by a strict prompt policy reviewed quarterly to ensure accuracy, neutrality, and proper attribution. Any summary flagged for inaccuracy is reviewed, corrected, and re-published within 24 hours.",
              initials: "ES",
            },
          ].map((member) => (
            <Grid item xs={12} sm={6} key={member.name}>
              <Paper variant="outlined" className={classes.teamCard}>
                <Avatar className={classes.avatar}>{member.initials}</Avatar>
                <Box>
                  <Typography variant="subtitle1" style={{ fontWeight: 700 }}>
                    {member.name}
                  </Typography>
                  <Typography
                    variant="caption"
                    display="block"
                    color="primary"
                    style={{ marginBottom: 6 }}
                  >
                    {member.role}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    {member.bio}
                  </Typography>
                </Box>
              </Paper>
            </Grid>
          ))}
        </Grid>
      </Box>

      {/* Organization */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          Organization
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        <Typography variant="body1" paragraph>
          Local KY News is operated as an independent digital media platform based in
          Kentucky. We are not affiliated with any political party, government agency,
          or corporate news conglomerate. We do not accept payment for story placement,
          and no advertiser has any influence over editorial decisions.
        </Typography>
        <Typography variant="body1" paragraph>
          We serve Kentucky readers. Our sole interest is making sure that the news
          happening in every corner of the Commonwealth is findable, readable, and
          properly attributed.
        </Typography>
      </Box>

      {/* Our Commitment */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          <PolicyIcon style={{ verticalAlign: "middle", marginRight: 8, color: "#1565c0" }} />
          Our Commitment to Original Publishers
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        <Typography variant="body1" paragraph>
          We believe strongly that local journalism must be supported, not undermined.
          Every summary on this platform:
        </Typography>
        <Box style={{ marginLeft: 16 }}>
          {[
            "Names the original publication prominently.",
            "Names the original author wherever provided by the source.",
            'Links directly to the full article at the original source with the text "Read full story at [Publisher Name]".',
            "Is labeled clearly as a summary — never presented as original reporting.",
            "Is limited to 35–50% of the original article's length to preserve the value of reading the full story.",
          ].map((item, i) => (
            <Box key={i} className={classes.featureItem}>
              <Typography variant="body2" style={{ color: "#1565c0" }}>•</Typography>
              <Typography variant="body1">{item}</Typography>
            </Box>
          ))}
        </Box>
        <Typography variant="body1" paragraph style={{ marginTop: 16 }}>
          If you are a publisher and have a question or concern about how your content
          is being summarized or attributed, please{" "}
          <a href="/contact" style={{ color: "#1565c0" }}>contact us</a>. We will
          respond promptly.
        </Typography>
      </Box>

      <Box style={{ color: "#888", marginTop: 32 }}>
        <Typography variant="caption">
          Local KY News · localkynews.com · Covering all 120 Kentucky counties
        </Typography>
      </Box>
    </div>
  );
}
