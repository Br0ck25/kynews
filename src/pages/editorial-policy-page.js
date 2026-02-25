import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import { Typography, Divider, Box, Paper } from "@material-ui/core";
import GavelIcon from "@material-ui/icons/Gavel";

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
  callout: {
    padding: theme.spacing(2, 2.5),
    borderLeft: "4px solid #1565c0",
    backgroundColor: "#f5f8ff",
    borderRadius: "0 4px 4px 0",
    marginBottom: theme.spacing(2),
  },
  principle: {
    padding: theme.spacing(2),
    marginBottom: theme.spacing(1.5),
    borderRadius: 6,
  },
}));

const principles = [
  {
    heading: "Factual accuracy",
    body:
      "Summaries preserve the specific facts, names, dates, numbers, and attributed statements from the original article. Nothing is added, softened, exaggerated, or reframed.",
  },
  {
    heading: "Neutrality",
    body:
      "Summaries contain no editorial opinion, value judgments, or analytical framing. If the original article contains a quote or analysis, it is reported as such — never adopted as the platform's perspective.",
  },
  {
    heading: "Attribution",
    body:
      "Every article page prominently displays the original publisher's name and a direct link labeled \"Read full story at [Publisher Name].\" If the original article provides the author's name, that name is displayed.",
  },
  {
    heading: "Transparency",
    body:
      "Every summary is clearly labeled as a summary. The phrase \"Summary — Original reporting by [Publisher Name]\" appears on every article page. Readers are never left to wonder whether they are reading original reporting.",
  },
  {
    heading: "Proportionality",
    body:
      "Summaries are limited to 35–50% of the original article's length. For articles under 400 words, summaries are capped at 200 words. This ensures the original article retains its value and readership.",
  },
];

export default function EditorialPolicyPage() {
  const classes = useStyles();

  React.useEffect(() => {
    document.title = "Editorial Policy — Local KY News";
    const desc =
      "Learn how Local KY News generates AI-assisted news summaries, maintains attribution standards, and ensures factual accuracy for all 120 Kentucky counties.";
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
          <GavelIcon style={{ verticalAlign: "middle", marginRight: 10, fontSize: 36 }} />
          Editorial Policy
        </Typography>
        <Typography variant="body1" style={{ opacity: 0.9, maxWidth: 640 }}>
          Local KY News is a news aggregation and summarization service. This policy
          explains how we source content, generate summaries, attribute original
          publishers, and maintain accuracy.
        </Typography>
      </Box>

      {/* What we are */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          What This Platform Is
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        <Typography variant="body1" paragraph>
          Local KY News is a news aggregator and summarization service. We do not
          employ reporters. We do not conduct original interviews. We do not publish
          opinion columns, endorsements, or investigative journalism.
        </Typography>
        <Typography variant="body1" paragraph>
          We monitor Kentucky news sources, summarize their published articles using
          AI-assisted tools, and display those summaries alongside prominent attribution
          to the original publisher. Our purpose is to improve the discoverability and
          accessibility of Kentucky local journalism — not to replace it.
        </Typography>
      </Box>

      {/* Source selection */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          Source Selection
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        <Typography variant="body1" paragraph>
          Sources are selected based on the following criteria:
        </Typography>
        <Box style={{ marginLeft: 16 }}>
          {[
            "The source publishes original Kentucky news coverage.",
            "The source has a functioning RSS feed or discoverable article index.",
            "The source is a credentialed news organization (newspaper, TV station, radio station, wire service, or established digital news outlet).",
            "The source serves at least one Kentucky county or covers statewide Kentucky topics.",
          ].map((item, i) => (
            <Box key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <Typography variant="body2" style={{ color: "#1565c0" }}>•</Typography>
              <Typography variant="body1">{item}</Typography>
            </Box>
          ))}
        </Box>
        <Typography variant="body1" paragraph style={{ marginTop: 12 }}>
          We do not accept payment for source inclusion. Sources are not added or
          removed at the request of any advertiser.
        </Typography>
      </Box>

      {/* AI Summarization */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          AI Summarization Methodology
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        <Box className={classes.callout}>
          <Typography variant="subtitle2" style={{ fontWeight: 700, color: "#1565c0", marginBottom: 4 }}>
            Our AI summarization model operates under strict content rules.
          </Typography>
          <Typography variant="body2">
            No new facts, no speculation, no opinion language, no filler, and no
            assumptions about cause, intent, or future events are permitted.
          </Typography>
        </Box>
        <Typography variant="body1" paragraph>
          When a new article is detected from a monitored source, our system:
        </Typography>
        <Box style={{ marginLeft: 16 }}>
          {[
            "Fetches the article content from the original publisher's URL.",
            "Cleans the HTML to remove navigation, advertisements, copyright notices, bylines, and boilerplate.",
            "Sends the cleaned article text to our AI summarization model with the following rules enforced: summarize to 35–50% of original length, preserve all facts exactly, produce readable 2–3 sentence paragraphs, and never end mid-sentence.",
            "Validates that no new entities (names, dates, numbers) were introduced by the AI.",
            "Publishes the summary with the original publisher's name, author, publication date, and a direct link to the full story.",
          ].map((item, i) => (
            <Box key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <Typography variant="body2" style={{ color: "#1565c0", fontWeight: 700, minWidth: 18 }}>
                {i + 1}.
              </Typography>
              <Typography variant="body1">{item}</Typography>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Core Principles */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          Core Editorial Principles
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        {principles.map((p) => (
          <Paper key={p.heading} variant="outlined" className={classes.principle}>
            <Typography variant="subtitle1" style={{ fontWeight: 700, marginBottom: 4 }}>
              {p.heading}
            </Typography>
            <Typography variant="body2" color="textSecondary">
              {p.body}
            </Typography>
          </Paper>
        ))}
      </Box>

      {/* Corrections */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          Corrections Policy
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        <Typography variant="body1" paragraph>
          If a summary contains a factual error — a misspelled name, a wrong date, an
          incorrect number — we correct it promptly. Corrections are made to the live
          article without appending a correction note unless the error was materially
          misleading, in which case a correction notice is added.
        </Typography>
        <Typography variant="body1" paragraph>
          Publishers, journalists, or readers who identify an error should{" "}
          <a href="/contact" style={{ color: "#1565c0" }}>contact us</a>. We review
          all correction requests within one business day.
        </Typography>
      </Box>

      {/* What we don't do */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          What We Do Not Do
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        <Box style={{ marginLeft: 16 }}>
          {[
            "We do not publish full article texts. Our summaries are 35–50% of the original.",
            "We do not add information that was not in the original article.",
            "We do not editorialize, analyze, or express opinions on the news we summarize.",
            "We do not accept payment for story placement or removal.",
            "We do not generate clickbait headlines that misrepresent the original article.",
            "We do not publish AI-generated content that has not passed our anti-hallucination validation step.",
          ].map((item, i) => (
            <Box key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <Typography variant="body2" style={{ color: "#c62828" }}>✗</Typography>
              <Typography variant="body1">{item}</Typography>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Contact */}
      <Box className={classes.callout}>
        <Typography variant="subtitle2" style={{ fontWeight: 700, marginBottom: 4 }}>
          Questions about our editorial standards?
        </Typography>
        <Typography variant="body2">
          Contact us at{" "}
          <a href="mailto:contact@localkynews.com" style={{ color: "#1565c0" }}>
            contact@localkynews.com
          </a>{" "}
          or visit our <a href="/contact" style={{ color: "#1565c0" }}>Contact page</a>.
        </Typography>
      </Box>

      <Box style={{ color: "#888", marginTop: 24 }}>
        <Typography variant="caption">
          Local KY News Editorial Policy · Last updated February 2026
        </Typography>
      </Box>
    </div>
  );
}
