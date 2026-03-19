import React, { useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  Paper,
  TextField,
  Typography,
} from "@material-ui/core";

/**
 * Article Testing tab — paste a link, AI rewrites it as an original LocalKYNews article.
 * Removes attribution language ("According to X", "X said in a social media post", etc.)
 * PREVIEW ONLY — nothing is published to the website.
 */
export default function ArticleTestingTab({ service }) {
  const [inputUrl, setInputUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { originalTitle, originalUrl, rewrittenTitle, rewrittenBody }
  const [copied, setCopied] = useState(false);

  async function handleTest() {
    const url = inputUrl.trim();
    if (!url) {
      setError("Please enter a URL.");
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setError("URL must start with http:// or https://");
      return;
    }

    setLoading(true);
    setError("");
    setResult(null);
    setCopied(false);

    try {
      const data = await service.testArticleRewrite(url);
      if (!data?.ok) {
        setError(data?.error || data?.message || "Rewrite failed. The site may be blocking automated access.");
      } else {
        setResult(data);
      }
    } catch (err) {
      setError(err?.errorMessage || err?.message || "Request failed. Check the URL and try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleCopy() {
    if (!result) return;
    const text = `${result.rewrittenTitle}\n\n${result.rewrittenBody}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleClear() {
    setResult(null);
    setError("");
    setInputUrl("");
    setCopied(false);
  }

  return (
    <Box>
      <Typography variant="h6" gutterBottom>Article Testing</Typography>
      <Typography variant="body2" color="textSecondary" style={{ marginBottom: 16 }}>
        Paste a link to a news article. The AI will rewrite it as an original LocalKYNews piece,
        removing attribution phrases like "According to the Fire Department" or "said in a social media post."
        <br />
        <strong>This is a preview only — nothing will be published to the website.</strong>
      </Typography>

      <Paper style={{ padding: 16, marginBottom: 24 }}>
        <Box style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <TextField
            variant="outlined"
            size="small"
            label="Article URL"
            placeholder="https://example.com/article..."
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !loading) handleTest(); }}
            style={{ flex: 1, minWidth: 280 }}
            disabled={loading}
          />
          <Button
            variant="contained"
            color="primary"
            onClick={handleTest}
            disabled={loading || !inputUrl.trim()}
            style={{ height: 40 }}
          >
            {loading ? <CircularProgress size={20} color="inherit" /> : "Rewrite Article"}
          </Button>
          {result && (
            <Button variant="outlined" size="small" onClick={handleClear} style={{ height: 40 }}>
              Clear
            </Button>
          )}
        </Box>

        {error && (
          <Typography color="error" variant="body2" style={{ marginTop: 12 }}>
            {error}
          </Typography>
        )}
      </Paper>

      {result && (
        <Paper style={{ padding: 20 }}>
          {/* Original vs Rewritten header */}
          <Box style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <Typography variant="subtitle2" color="textSecondary">
              Original source:{" "}
              <a href={result.originalUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>
                {result.originalUrl}
              </a>
            </Typography>
            <Button
              variant="outlined"
              size="small"
              onClick={handleCopy}
            >
              {copied ? "Copied!" : "Copy Article"}
            </Button>
          </Box>

          <Divider style={{ marginBottom: 16 }} />

          {/* Rewritten headline */}
          <Typography
            variant="h5"
            style={{ fontWeight: 700, marginBottom: 16, lineHeight: 1.3 }}
          >
            {result.rewrittenTitle}
          </Typography>

          {/* Rewritten body */}
          <Box>
            {result.rewrittenBody.split("\n\n").map((paragraph, i) => (
              <Typography
                key={i}
                variant="body1"
                style={{ marginBottom: 12, lineHeight: 1.7 }}
              >
                {paragraph.trim()}
              </Typography>
            ))}
          </Box>

          <Divider style={{ marginTop: 20, marginBottom: 12 }} />

          <Typography variant="caption" color="textSecondary">
            Original headline: <em>{result.originalTitle}</em>
          </Typography>
        </Paper>
      )}
    </Box>
  );
}
