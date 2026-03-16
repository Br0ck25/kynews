import React from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Typography,
} from "@material-ui/core";

const KY_OFFICES = new Set(["KJKL", "KLMK", "KPAH"]);

const OFFICE_LABELS = {
  KJKL: "NWS Jackson KY",
  KLMK: "NWS Louisville KY",
  KPAH: "NWS Paducah KY",
};

const NWS_HEADERS = {
  "User-Agent": "LocalKYNews/1.0 (localkynews.com; news@localkynews.com)",
  Accept: "application/geo+json, application/json",
};

function fmtTime(dateStr) {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    });
  } catch {
    return dateStr;
  }
}

export default function NwsDiscussionsTab() {
  const [products, setProducts] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [expanded, setExpanded] = React.useState(null);
  const [texts, setTexts] = React.useState({});
  const [loadingId, setLoadingId] = React.useState(null);
  const [copiedId, setCopiedId] = React.useState(null);

  React.useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("https://api.weather.gov/products/types/AFD", {
        headers: NWS_HEADERS,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const all = data["@graph"] || [];
      const ky = all.filter((p) => KY_OFFICES.has(p.issuingOffice));
      setProducts(ky);
    } catch (e) {
      setError("Failed to fetch discussions: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  async function toggle(product) {
    const pid = product.id;
    if (expanded === pid) {
      setExpanded(null);
      return;
    }
    setExpanded(pid);
    if (texts[pid] !== undefined) return;
    setLoadingId(pid);
    try {
      const res = await fetch(`https://api.weather.gov/products/${pid}`, {
        headers: NWS_HEADERS,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTexts((prev) => ({ ...prev, [pid]: data.productText || "(No text available)" }));
    } catch (e) {
      setTexts((prev) => ({ ...prev, [pid]: "Error loading text: " + e.message }));
    } finally {
      setLoadingId(null);
    }
  }

  function copy(pid) {
    const text = texts[pid] || "";
    const markCopied = () => {
      setCopiedId(pid);
      setTimeout(() => setCopiedId(null), 2000);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(markCopied).catch(() => {
        fallbackCopy(text);
        markCopied();
      });
    } else {
      fallbackCopy(text);
      markCopied();
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }

  return (
    <Box>
      {/* Header */}
      <Box
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Box>
          <Typography variant="h6" style={{ marginBottom: 2 }}>
            NWS Discussions
          </Typography>
          <Typography variant="body2" color="textSecondary">
            Area Forecast Discussions from NWS Jackson, Louisville, and Paducah
            offices. Click any discussion to read the full text.
          </Typography>
        </Box>
        <Button
          variant="contained"
          color="primary"
          onClick={load}
          disabled={loading}
        >
          {loading ? (
            <>
              <CircularProgress size={14} style={{ marginRight: 6 }} />
              Loading...
            </>
          ) : (
            "Refresh"
          )}
        </Button>
      </Box>

      {error && (
        <Typography variant="body2" color="error" style={{ marginBottom: 8 }}>
          {error}
        </Typography>
      )}

      {!loading && products.length === 0 && !error && (
        <Paper style={{ padding: 24, textAlign: "center" }}>
          <Typography variant="body2" color="textSecondary">
            No discussions found for Kentucky NWS offices.
          </Typography>
        </Paper>
      )}

      {products.map((p) => (
        <Paper key={p.id} style={{ marginBottom: 10, overflow: "hidden" }}>
          {/* Clickable header row */}
          <Box
            style={{
              padding: "12px 16px",
              cursor: "pointer",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              userSelect: "none",
            }}
            onClick={() => toggle(p)}
          >
            <Box>
              <Box
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                  marginBottom: 4,
                }}
              >
                <Chip
                  label={OFFICE_LABELS[p.issuingOffice] || p.issuingOffice}
                  size="small"
                  color="primary"
                />
                <Typography variant="subtitle2">{p.productName}</Typography>
              </Box>
              <Typography variant="caption" color="textSecondary">
                {fmtTime(p.issuanceTime)}
              </Typography>
            </Box>
            <Typography
              variant="body2"
              color="textSecondary"
              style={{ marginLeft: 8, flexShrink: 0 }}
            >
              {expanded === p.id ? "▲ Collapse" : "▼ Expand"}
            </Typography>
          </Box>

          {/* Expanded text */}
          {expanded === p.id && (
            <Box
              style={{
                borderTop: "1px solid rgba(0,0,0,0.08)",
                padding: "12px 16px",
              }}
            >
              {loadingId === p.id ? (
                <Box style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <CircularProgress size={16} />
                  <Typography variant="body2" color="textSecondary">
                    Loading discussion text...
                  </Typography>
                </Box>
              ) : (
                <>
                  <Paper
                    variant="outlined"
                    style={{
                      padding: 12,
                      marginBottom: 8,
                      background: "rgba(0,0,0,0.02)",
                      whiteSpace: "pre-wrap",
                      fontFamily: "monospace",
                      fontSize: 12,
                      lineHeight: 1.6,
                      maxHeight: 500,
                      overflow: "auto",
                    }}
                  >
                    {texts[p.id]}
                  </Paper>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => copy(p.id)}
                  >
                    {copiedId === p.id ? "Copied!" : "Copy Text"}
                  </Button>
                </>
              )}
            </Box>
          )}
        </Paper>
      ))}
    </Box>
  );
}
