import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import { Typography, Divider, Box } from "@material-ui/core";
import LockIcon from "@material-ui/icons/Lock";

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
}));

const s = (text) => (
  <Typography variant="body1" paragraph>
    {text}
  </Typography>
);

export default function PrivacyPolicyPage() {
  const classes = useStyles();

  React.useEffect(() => {
    document.title = "Privacy Policy — Local KY News";
    const desc =
      "Privacy policy for Local KY News. Learn what data we collect, how we use it, and your rights as a reader of our Kentucky news platform.";
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
          <LockIcon style={{ verticalAlign: "middle", marginRight: 10, fontSize: 36 }} />
          Privacy Policy
        </Typography>
        <Typography variant="body1" style={{ opacity: 0.9 }}>
          Local KY News does not sell your data. This policy explains what we collect,
          how we use it, and your rights.
        </Typography>
      </Box>

      <Box style={{ color: "#888", marginBottom: 24 }}>
        <Typography variant="caption">Effective Date: February 25, 2026</Typography>
      </Box>

      {/* Overview */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          Overview
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        {s(
          "Local KY News (\"we,\" \"us,\" or \"our\") operates localkynews.com, a Kentucky news aggregation platform. This Privacy Policy describes how we handle information when you use our website."
        )}
        {s(
          "We are committed to minimal data collection. We do not sell, rent, or trade any personal information to third parties."
        )}
      </Box>

      {/* What we collect */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          Information We Collect
        </Typography>
        <Divider style={{ marginBottom: 16 }} />

        <Typography variant="h6" style={{ fontWeight: 600, marginBottom: 8 }}>
          Information You Provide
        </Typography>
        {s(
          "We do not require account registration to read articles. If you use our Contact form, we collect the name, email address, and message you submit. This information is used only to respond to your inquiry."
        )}

        <Typography variant="h6" style={{ fontWeight: 600, marginBottom: 8 }}>
          Automatically Collected Information
        </Typography>
        {s(
          "Like most websites, our server infrastructure (Cloudflare) automatically collects standard log information including IP addresses, browser type, referring URLs, and pages visited. This information is used to operate and maintain the service and is governed by Cloudflare's privacy policy."
        )}

        <Typography variant="h6" style={{ fontWeight: 600, marginBottom: 8 }}>
          Locally Stored Preferences
        </Typography>
        {s(
          "This app stores certain preferences on your device using browser localStorage. These stored values include: your selected county filters, saved articles, dark/light theme preference, and saved ZIP code for weather. This information never leaves your device and is not transmitted to our servers."
        )}
      </Box>

      {/* How we use it */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          How We Use Information
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        {s(
          "Information collected is used to: operate and improve the Local KY News platform, respond to contact form submissions, analyze aggregate traffic patterns (no individual tracking), and detect and prevent abuse of our services."
        )}
      </Box>

      {/* Advertising */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          Advertising
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        {s(
          "Local KY News may display advertisements served by Google AdSense. Google may use cookies to serve ads based on your prior visits to this website or other websites. You can opt out of personalized advertising by visiting Google's Ads Settings at adssettings.google.com."
        )}
        {s(
          "We do not share personally identifiable information with our advertising partners."
        )}
      </Box>

      {/* Third-party links */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          External Links
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        {s(
          "Every article summary on this platform links to the original publisher's website. We are not responsible for the privacy practices of those external websites. We encourage you to review the privacy policies of any website you visit."
        )}
      </Box>

      {/* Children */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          Children's Privacy
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        {s(
          "Local KY News is not directed at children under 13. We do not knowingly collect personal information from children under 13. If you believe we have inadvertently collected such information, please contact us and we will delete it promptly."
        )}
      </Box>

      {/* Your rights */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          Your Rights
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        {s(
          "You may request access to, correction of, or deletion of any personal information we hold about you by contacting us at contact@localkynews.com. Since we collect minimal personal information (contact form submissions only), most user data is stored locally on your own device and can be cleared by clearing your browser's localStorage."
        )}
      </Box>

      {/* Changes */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          Changes to This Policy
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        {s(
          "We may update this Privacy Policy periodically. The effective date at the top of this page indicates when the policy was last revised. We encourage you to review this page periodically. Continued use of the platform after changes constitutes acceptance of the revised policy."
        )}
      </Box>

      {/* Contact */}
      <Box className={classes.section}>
        <Typography variant="h5" component="h2" gutterBottom style={{ fontWeight: 700 }}>
          Contact
        </Typography>
        <Divider style={{ marginBottom: 16 }} />
        <Typography variant="body1">
          Questions about this policy?{" "}
          <a href="mailto:contact@localkynews.com" style={{ color: "#1565c0" }}>
            contact@localkynews.com
          </a>{" "}
          or visit our <a href="/contact" style={{ color: "#1565c0" }}>Contact page</a>.
        </Typography>
      </Box>

      <Box style={{ color: "#888", marginTop: 16 }}>
        <Typography variant="caption">
          Local KY News · localkynews.com · Privacy Policy · Effective February 2026
        </Typography>
      </Box>
    </div>
  );
}
