import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import {
  Typography,
  Divider,
  Box,
  TextField,
  Button,
  Paper,
  Snackbar,
} from "@material-ui/core";
import EmailIcon from "@material-ui/icons/Email";

const useStyles = makeStyles((theme) => ({
  root: {
    maxWidth: 720,
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
  form: {
    padding: theme.spacing(3),
    marginTop: theme.spacing(3),
  },
  field: {
    marginBottom: theme.spacing(2),
  },
  infoBox: {
    padding: theme.spacing(2, 2.5),
    borderLeft: "4px solid #1565c0",
    backgroundColor: "#f5f8ff",
    borderRadius: "0 4px 4px 0",
    marginBottom: theme.spacing(3),
  },
}));

export default function ContactPage() {
  const classes = useStyles();
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    document.title = "Contact Local KY News — Kentucky News Aggregator";
    const desc = "Contact the Local KY News team with questions, corrections, publisher inquiries, or feedback about Kentucky news coverage.";
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", desc);
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !message.trim()) {
      setError("Please fill in all required fields.");
      return;
    }
    // Build a mailto: link as the contact mechanism (no backend required)
    const body = encodeURIComponent(
      `Name: ${name}\nEmail: ${email}\n\n${message}`
    );
    const subjectEncoded = encodeURIComponent(subject || "Local KY News Inquiry");
    window.location.href = `mailto:contact@localkynews.com?subject=${subjectEncoded}&body=${body}`;
    setSent(true);
  };

  return (
    <div className={classes.root}>
      {/* Hero */}
      <Box className={classes.hero}>
        <Typography variant="h4" component="h1" gutterBottom style={{ fontWeight: 700 }}>
          Contact Us
        </Typography>
        <Typography variant="body1" style={{ opacity: 0.9 }}>
          Questions, corrections, publisher inquiries, or feedback — we want to hear from you.
        </Typography>
      </Box>

      {/* Publisher note */}
      <Box className={classes.infoBox}>
        <Typography variant="subtitle2" style={{ fontWeight: 700, marginBottom: 4, color: "#1565c0" }}>
          Are you a publisher or journalist?
        </Typography>
        <Typography variant="body2">
          If you represent a Kentucky news organization and have a concern about how your
          content is summarized or attributed on this platform, please use the form below
          and select "Publisher Inquiry" as the subject. We take attribution accuracy
          seriously and will respond within one business day.
        </Typography>
      </Box>

      {/* Contact info */}
      <Box style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <EmailIcon style={{ color: "#1565c0" }} />
        <Typography variant="body1">
          <a href="mailto:contact@localkynews.com" style={{ color: "#1565c0" }}>
            contact@localkynews.com
          </a>
        </Typography>
      </Box>

      <Divider style={{ marginBottom: 24 }} />

      <Paper variant="outlined" className={classes.form}>
        <Typography variant="h6" gutterBottom style={{ fontWeight: 700 }}>
          Send a Message
        </Typography>
        <form onSubmit={handleSubmit}>
          <TextField
            label="Your Name *"
            variant="outlined"
            fullWidth
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={classes.field}
            size="small"
          />
          <TextField
            label="Email Address *"
            variant="outlined"
            fullWidth
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={classes.field}
            size="small"
          />
          <TextField
            label="Subject"
            variant="outlined"
            fullWidth
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className={classes.field}
            size="small"
            placeholder="e.g. Correction Request, Publisher Inquiry, General Question"
          />
          <TextField
            label="Message *"
            variant="outlined"
            fullWidth
            multiline
            minRows={5}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className={classes.field}
          />
          {error && (
            <Typography variant="body2" color="error" style={{ marginBottom: 12 }}>
              {error}
            </Typography>
          )}
          <Button
            type="submit"
            variant="contained"
            color="primary"
            size="large"
            style={{ fontWeight: 600 }}
          >
            Send Message
          </Button>
        </form>
      </Paper>

      <Snackbar
        open={sent}
        autoHideDuration={5000}
        onClose={() => setSent(false)}
        message="Opening your email client. Thank you for reaching out!"
      />
    </div>
  );
}
