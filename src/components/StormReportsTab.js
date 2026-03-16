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

const EVENT_FULL_NAMES = {
  "Tstm Wnd Dmg":    "Thunderstorm Wind Damage",
  "Tstm Wnd Gst":    "Thunderstorm Wind Gust",
  "Flash Flood":     "Flash Flood",
  "Flood":           "Flood",
  "Tornado":         "Tornado",
  "Hail":            "Hail",
  "Heavy Rain":      "Heavy Rain",
  "High Wind":       "High Wind",
  "Funnel Cloud":    "Funnel Cloud",
  "Waterspout":      "Waterspout",
  "Marine Tstm Wind":"Marine Thunderstorm Wind",
  "Non-Tstm Wnd Gst":"Non-Thunderstorm Wind Gust",
  "Non-Tstm Wnd Dmg":"Non-Thunderstorm Wind Damage",
  "Winter Storm":    "Winter Storm",
  "Ice Storm":       "Ice Storm",
  "Sleet":           "Sleet",
  "Snow":            "Snow",
  "Freezing Rain":   "Freezing Rain",
  "Dense Fog":       "Dense Fog",
  "Lightning":       "Lightning",
};

const EVENT_EMOJI_MAP = [
  ["Tornado",        "🌪️"],
  ["Funnel Cloud",   "🌪️"],
  ["Waterspout",     "🌪️"],
  ["Flash Flood",    "🌊"],
  ["Flood",          "🌊"],
  ["Hail",           "🌨️"],
  ["Lightning",      "⚡"],
  ["Tstm Wnd",       "⛈️"],
  ["Marine Tstm",    "⛈️"],
  ["High Wind",      "💨"],
  ["Non-Tstm Wnd",   "💨"],
  ["Snow",           "❄️"],
  ["Blizzard",       "❄️"],
  ["Winter Storm",   "❄️"],
  ["Ice Storm",      "🧊"],
  ["Freezing Rain",  "🧊"],
  ["Sleet",          "🧊"],
  ["Heavy Rain",     "🌧️"],
  ["Dense Fog",      "🌫️"],
  ["Wildfire",       "🔥"],
];

function getEventEmoji(eventType) {
  const lower = eventType.toLowerCase();
  for (const [key, emoji] of EVENT_EMOJI_MAP) {
    if (lower.includes(key.toLowerCase())) return emoji;
  }
  return "⚠️";
}

// Parses a raw NWS LSR productText into a Facebook-ready formatted string.
// LSR fixed-width column layout (0-indexed):
//   Line 0: time=0-9, event=12-27, city=29-52
//   Line 1: date=0-9, mag=12-27, county=29-48, state=49-50, source=53+
function parseLsrForFacebook(productText, officeLabel) {
  if (!productText) return "";

  const headerMatch = productText.match(
    /National Weather Service (.+?)[\r\n]+(\d{3,4}\s+[AP]M\s+\w+\s+\w+\s+\w+\s+\d+\s+\d{4})/i
  );
  const issuedBy   = (headerMatch && headerMatch[1].trim()) || officeLabel || "NWS";
  const issuedTime = (headerMatch && headerMatch[2].trim()) || "";

  const remarksIdx = productText.indexOf("..REMARKS..");
  if (remarksIdx === -1) return productText;

  const body = productText.substring(remarksIdx + "..REMARKS..".length);
  const rawBlocks = body.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const eventBlocks = rawBlocks.filter(
    b => !/^&&/.test(b) && !/^\$\$/.test(b) && !/^[A-Z]{2,4}$/.test(b.trim())
  );
  if (eventBlocks.length === 0) return productText;

  const parsedEvents = eventBlocks.map(block => {
    const lines = block.split("\n");
    const l0 = (lines[0] || "").padEnd(80);
    const l1 = (lines[1] || "").padEnd(80);
    return {
      time:      l0.substring(0,  10).trim(),
      eventType: l0.substring(12, 28).trim(),
      city:      l0.substring(29, 53).trim(),
      date:      l1.substring(0,  10).trim(),
      mag:       l1.substring(12, 28).trim(),
      county:    l1.substring(29, 49).trim(),
      state:     l1.substring(49, 51).trim(),
      source:    l1.substring(53).trim(),
      remarks:   lines.slice(2).map(l => l.trim()).filter(Boolean).join(" "),
    };
  });

  const header = `🌩️ NWS Local Storm Report — ${issuedBy}${issuedTime ? "\n" + issuedTime : ""}`;

  const eventLines = parsedEvents.map(e => {
    const emoji     = getEventEmoji(e.eventType);
    const fullName  = EVENT_FULL_NAMES[e.eventType] || e.eventType;
    const countyStr = e.county ? e.county + " County" : "";
    const location  = [e.city, [countyStr, e.state].filter(Boolean).join(", ")].filter(Boolean).join(" — ");
    const parts = [`${emoji} ${fullName.toUpperCase()}`];
    if (location)  parts.push(`📍 ${location}`);
    parts.push(`🕐 ${e.time}${e.date ? "  |  " + e.date : ""}`);
    if (e.mag)     parts.push(`Magnitude: ${e.mag}`);
    if (e.source)  parts.push(`Source: ${e.source}`);
    if (e.remarks) parts.push(`\n${e.remarks}`);
    return parts.join("\n");
  });

  const countyTags = [...new Set(
    parsedEvents.map(e => e.county).filter(Boolean)
      .map(c => "#" + c.replace(/\s+/g, "") + "County")
  )].join(" ");

  return [
    header,
    "",
    eventLines.join("\n\n"),
    "",
    "——————————————",
    `LocalKYNews.com | #KentuckyWeather${countyTags ? "  " + countyTags : ""}`,
  ].join("\n");
}

export default function StormReportsTab() {
  const [byOffice, setByOffice] = React.useState({});
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [activeOffice, setActiveOffice] = React.useState("KJKL");
  const [expanded, setExpanded] = React.useState(null);
  const [texts, setTexts] = React.useState({});
  const [loadingId, setLoadingId] = React.useState(null);
  const [copiedId, setCopiedId] = React.useState(null);
  const [copiedFb, setCopiedFb] = React.useState(null);

  React.useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    setError("");
    setExpanded(null);
    try {
      const res = await fetch("https://api.weather.gov/products/types/LSR", {
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
      setError("Failed to fetch storm reports: " + e.message);
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

  function copyFb(pid) {
    const officeInfo = OFFICES.find(o => o.id === activeOffice);
    const fbText = parseLsrForFacebook(texts[pid] || "", officeInfo?.label || "");
    const markCopied = () => {
      setCopiedFb(pid);
      setTimeout(() => setCopiedFb(null), 2000);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(fbText).then(markCopied).catch(() => {
        fallbackCopy(fbText);
        markCopied();
      });
    } else {
      fallbackCopy(fbText);
      markCopied();
    }
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
            Storm Reports
          </Typography>
          <Typography variant="body2" color="textSecondary">
            Local Storm Reports (LSR) from NWS Jackson, Louisville, and Paducah
            offices. Click any report to read the full text.
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
                  {count} report{count !== 1 ? "s" : ""}
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
            No storm reports found for this office.
          </Typography>
        </Paper>
      )}

      {/* Report cards */}
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
                      Loading storm report text...
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
                        {copiedId === p.id ? "Copied!" : "Copy Raw Text"}
                      </Button>
                      <Button
                        size="small"
                        variant="contained"
                        color="primary"
                        onClick={() => copyFb(p.id)}
                      >
                        {copiedFb === p.id ? "Copied!" : "Copy for Facebook"}
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
