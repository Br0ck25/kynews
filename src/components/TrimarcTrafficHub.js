import React from "react";
import {
  Box,
  Button,
  CircularProgress,
  Paper,
  Typography,
} from "@material-ui/core";

// ─── Category classification ──────────────────────────────────────────────────
// TRIMARC description format: "Incident Type : Additional detail"
// We match on the incident type prefix (before the colon).

const TABS = [
  { id: "all",          label: "🚦 All Alerts" },
  { id: "construction", label: "🚧 Construction / Road Work" },
  { id: "maintenance",  label: "🔧 Freeway Maintenance" },
  { id: "disabled",     label: "🚗 Disabled Vehicle-Occupied" },
];

function classifyItem(item) {
  const type = (item.incidentType || item.description || "").toLowerCase();
  const location = (item.location || item.title || "").toLowerCase();

  if (
    type.includes("disabled vehicle-occupied") ||
    type.includes("disabled vehicle occupied")
  ) return "disabled";

  if (
    type.includes("maintenance") ||
    type.includes("freeway maintenance")
  ) return "maintenance";

  if (
    type.includes("construction") ||
    type.includes("road work") ||
    type.includes("roadwork") ||
    location.includes("lane closure")
  ) return "construction";

  return "other";
}

function fmtPubDate(raw) {
  if (!raw) return "";
  try {
    return new Date(raw).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    });
  } catch {
    return raw;
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

function buildFacebookText(item) {
  const lines = [];
  lines.push("🚧 TRIMARC Louisville Traffic Alert");
  lines.push("");
  if (item.incidentType) lines.push(`🚨 ${item.incidentType}`);
  if (item.location)     lines.push(`📍 ${item.location}`);
  if (item.county)       lines.push(`🏛️ ${item.county}, Kentucky`);
  if (item.notes)        lines.push(`📝 ${item.notes}`);
  if (item.reportNumber) lines.push(`🔢 Report #: ${item.reportNumber}`);
  if (item.pubDate)      lines.push(`📅 ${fmtPubDate(item.pubDate)}`);
  lines.push("");
  const countyTag = item.county
    ? "#" + item.county.replace(/\s+County$/i, "").replace(/\s+/g, "") + "County"
    : "";
  lines.push(`#LouisvilleTraffic #KentuckyTraffic #TRIMARC${countyTag ? " " + countyTag : ""} #RoadConditions`);
  return lines.join("\n");
}

// ─── Category chip colors ─────────────────────────────────────────────────────
const CATEGORY_STYLES = {
  disabled:     { background: "#ef5350", color: "#fff", label: "Disabled Vehicle-Occupied" },
  maintenance:  { background: "#ff9800", color: "#000", label: "Freeway Maintenance" },
  construction: { background: "#fbc02d", color: "#000", label: "Construction / Road Work" },
  other:        { background: "#78909c", color: "#fff", label: "Other" },
};

// ─── Main component ───────────────────────────────────────────────────────────

export default function TrimarcTrafficHub() {
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [activeTab, setActiveTab] = React.useState("all");
  const [copiedId, setCopiedId] = React.useState(null);

  React.useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/trimarc");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.items || []);
    } catch (e) {
      setError("Failed to load TRIMARC feed: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  function copyToFacebook(item) {
    const id = item.guid || item.title;
    const text = buildFacebookText(item);
    const markCopied = () => {
      setCopiedId(id);
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

  // Filter items for the active tab
  const classifiedItems = React.useMemo(() => {
    return items.map((item) => ({ ...item, _category: classifyItem(item) }));
  }, [items]);

  const visibleItems = React.useMemo(() => {
    if (activeTab === "all") return classifiedItems;
    return classifiedItems.filter((item) => item._category === activeTab);
  }, [classifiedItems, activeTab]);

  // Badge counts per tab
  const counts = React.useMemo(() => {
    const c = { all: classifiedItems.length, construction: 0, maintenance: 0, disabled: 0 };
    for (const item of classifiedItems) {
      if (item._category === "construction") c.construction++;
      else if (item._category === "maintenance") c.maintenance++;
      else if (item._category === "disabled") c.disabled++;
    }
    return c;
  }, [classifiedItems]);

  return (
    <Box>
      {/* ── Header ─────────────────────────────────────────────────────── */}
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
          <Typography variant="h5" component="h1" gutterBottom style={{ marginBottom: 2 }}>
            Road Work &amp; Traffic
          </Typography>
          <Typography variant="body2" color="textSecondary">
            Live traffic incidents and road-work alerts from{" "}
            <a
              href="https://www.trimarc.org"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#1976d2" }}
            >
              TRIMARC Louisville
            </a>
            . Data refreshed every minute.
          </Typography>
        </Box>
        <Button
          variant="contained"
          color="primary"
          onClick={load}
          disabled={loading}
          size="small"
        >
          {loading ? (
            <>
              <CircularProgress size={14} style={{ marginRight: 6 }} />
              Loading…
            </>
          ) : (
            "Refresh"
          )}
        </Button>
      </Box>

      {/* ── Error ──────────────────────────────────────────────────────── */}
      {error && (
        <Typography variant="body2" color="error" style={{ marginBottom: 8 }}>
          {error}
        </Typography>
      )}

      {/* ── Sub-tabs ───────────────────────────────────────────────────── */}
      <Box style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {TABS.map((tab) => {
          const count = counts[tab.id] ?? 0;
          const isActive = activeTab === tab.id;
          return (
            <Paper
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: "10px 20px",
                cursor: "pointer",
                borderBottom: isActive ? "3px solid #1976d2" : "3px solid transparent",
                minWidth: 140,
                textAlign: "center",
                userSelect: "none",
              }}
              elevation={isActive ? 3 : 1}
            >
              <Typography
                variant="subtitle2"
                style={{ fontWeight: isActive ? 700 : 400 }}
              >
                {tab.label}
              </Typography>
              {!loading && (
                <Typography
                  variant="caption"
                  color="textSecondary"
                  display="block"
                  style={{ marginTop: 2 }}
                >
                  {count} incident{count !== 1 ? "s" : ""}
                </Typography>
              )}
            </Paper>
          );
        })}
      </Box>

      {/* ── Loading spinner ─────────────────────────────────────────────── */}
      {loading && (
        <Box style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <CircularProgress />
        </Box>
      )}

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {!loading && visibleItems.length === 0 && !error && (
        <Paper style={{ padding: 24, textAlign: "center" }}>
          <Typography variant="body2" color="textSecondary">
            ✅ No active incidents in this category.
          </Typography>
        </Paper>
      )}

      {/* ── Incident cards ──────────────────────────────────────────────── */}
      {!loading &&
        visibleItems.map((item, idx) => {
          const id = item.guid || item.title || String(idx);
          const catStyle = CATEGORY_STYLES[item._category] || CATEGORY_STYLES.other;
          const isCopied = copiedId === id;

          return (
            <Paper key={id} style={{ marginBottom: 10, overflow: "hidden" }}>
              <Box style={{ padding: "12px 16px" }}>
                {/* Category chip + incident type headline */}
                <Box
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{
                      background: catStyle.background,
                      color: catStyle.color,
                      padding: "2px 10px",
                      borderRadius: 10,
                      fontSize: 11,
                      fontWeight: "bold",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {catStyle.label}
                  </span>
                  {item.reportNumber && (
                    <Typography variant="caption" color="textSecondary" style={{ flexShrink: 0, paddingTop: 2 }}>
                      Report #{item.reportNumber}
                    </Typography>
                  )}
                </Box>

                {/* Location */}
                {item.location && (
                  <Typography variant="subtitle2" style={{ fontWeight: 600, marginBottom: 4 }}>
                    📍 {item.location}
                  </Typography>
                )}

                {/* County */}
                {item.county && (
                  <Typography variant="body2" color="textSecondary" style={{ marginBottom: 4 }}>
                    🏛️ {item.county}, Kentucky
                  </Typography>
                )}

                {/* Notes / CCTV details */}
                {item.notes && (
                  <Typography variant="body2" color="textPrimary" style={{ marginBottom: 6, lineHeight: 1.5 }}>
                    📝 {item.notes}
                  </Typography>
                )}

                {/* Meta row */}
                <Box
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                    marginTop: 6,
                    paddingTop: 6,
                    borderTop: "1px solid rgba(0,0,0,0.06)",
                  }}
                >
                  {item.pubDate && (
                    <Typography variant="caption" color="textSecondary">
                      📅 {fmtPubDate(item.pubDate)}
                    </Typography>
                  )}
                  {item.link && (
                    <a
                      href={item.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 12, color: "#1976d2", textDecoration: "none" }}
                    >
                      View on TRIMARC ↗
                    </a>
                  )}
                  <Button
                    size="small"
                    variant="outlined"
                    color="primary"
                    onClick={() => copyToFacebook(item)}
                    style={{ marginLeft: "auto" }}
                  >
                    {isCopied ? "✓ Copied!" : "📋 Copy for Facebook"}
                  </Button>
                </Box>
              </Box>
            </Paper>
          );
        })}
    </Box>
  );
}
