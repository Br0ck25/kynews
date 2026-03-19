import React from "react";
import {
  Box,
  Button,
  CircularProgress,
  Paper,
  Typography,
} from "@material-ui/core";

const OFFICES = [
  { id: "KJKL", label: "Jackson KY", sublabel: "Eastern Kentucky" },
  { id: "KLMK", label: "Louisville KY", sublabel: "Central Kentucky" },
  { id: "KPAH", label: "Paducah KY", sublabel: "Western Kentucky" },
];

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
  const [byOffice, setByOffice] = React.useState({});
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [activeOffice, setActiveOffice] = React.useState("KJKL");
  const [expanded, setExpanded] = React.useState(null);
  const [texts, setTexts] = React.useState({});
  const [loadingId, setLoadingId] = React.useState(null);
  const [copiedId, setCopiedId] = React.useState(null);
  const [copiedFbId, setCopiedFbId] = React.useState(null);

  function cleanTextForFacebook(raw) {
    if (!raw) return "";
    const lines = raw.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim());
    const out = [];
    for (const line of lines) {
      if (!line) {
        if (out.length === 0 || out[out.length - 1] === "") continue;
        out.push("");
        continue;
      }
      // Drop common NWS metadata lines that aren't useful in a Facebook post
      if (/^(FXUS|AFD|SYNOPSIS|AREA FORECAST DISCUSSION|NATIONAL WEATHER SERVICE|PREV DISCUSSION)/i.test(line)) {
        continue;
      }
      // Drop separator lines
      if (/^[\-=_~*\s]+$/.test(line)) continue;
      out.push(line);
    }
    const cleaned = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return cleaned;
  }

  function copyForFacebook(pid) {
    const text = texts[pid] || "";
    const cleaned = cleanTextForFacebook(text);
    const markCopied = () => {
      setCopiedFbId(pid);
      setTimeout(() => setCopiedFbId(null), 2000);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(cleaned).then(markCopied).catch(() => {
        fallbackCopy(cleaned);
        markCopied();
      });
    } else {
      fallbackCopy(cleaned);
      markCopied();
    }
  }

  React.useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    setError("");
    setExpanded(null);
    try {
      const res = await fetch("https://api.weather.gov/products/types/AFD", {
        headers: NWS_HEADERS,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const all = data["@graph"] || [];
      const grouped = {};
      for (const o of OFFICES) grouped[o.id] = [];
      for (const p of all) {
        if (grouped[p.issuingOffice]) grouped[p.issuingOffice].push(p);
      }
      setByOffice(grouped);
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

  const currentProducts = byOffice[activeOffice] || [];

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

      {/* Office selector */}
      <Box style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {OFFICES.map((o) => {
          const count = (byOffice[o.id] || []).length;
          return (
            <Paper
              key={o.id}
              onClick={() => {
                setActiveOffice(o.id);
                setExpanded(null);
              }}
              style={{
                padding: "10px 20px",
                cursor: "pointer",
                borderBottom:
                  activeOffice === o.id
                    ? "3px solid #1976d2"
                    : "3px solid transparent",
                minWidth: 140,
                textAlign: "center",
                userSelect: "none",
              }}
            >
              <Typography
                variant="subtitle2"
                style={{ fontWeight: activeOffice === o.id ? 700 : 400 }}
              >
                {o.label}
              </Typography>
              <Typography variant="caption" color="textSecondary" display="block">
                {o.sublabel}
              </Typography>
              {!loading && count > 0 && (
                <Typography
                  variant="caption"
                  color="textSecondary"
                  display="block"
                  style={{ marginTop: 2 }}
                >
                  {count} discussion{count !== 1 ? "s" : ""}
                </Typography>
              )}
            </Paper>
          );
        })}
      </Box>

      {/* Loading spinner */}
      {loading && (
        <Box style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <CircularProgress />
        </Box>
      )}

      {/* Empty state */}
      {!loading && currentProducts.length === 0 && !error && (
        <Paper style={{ padding: 24, textAlign: "center" }}>
          <Typography variant="body2" color="textSecondary">
            No discussions found for this office.
          </Typography>
        </Paper>
      )}

      {/* Discussion cards */}
      {!loading &&
        currentProducts.map((p) => (
          <Paper key={p.id} style={{ marginBottom: 10, overflow: "hidden" }}>
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
                <Typography variant="subtitle2" style={{ marginBottom: 2 }}>
                  {p.productName}
                </Typography>
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
                    <Box style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => copy(p.id)}
                      >
                        {copiedId === p.id ? "Copied!" : "Copy Text"}
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => copyForFacebook(p.id)}
                      >
                        {copiedFbId === p.id ? "Copied!" : "Copy for Facebook"}
                      </Button>
                    </Box>
                  </>
                )}
              </Box>
            )}
          </Paper>
        ))}
    </Box>
  );
}
