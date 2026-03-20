import React, { useState, useEffect, useCallback } from "react";
import { useTheme } from "@material-ui/core/styles";
import {
  Typography,
  CircularProgress,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Box,
  useMediaQuery,
} from "@material-ui/core";

// All NWS-supported area codes (50 states + DC + territories)
const US_AREAS = [
  { code: "ALL", label: "All States & Territories" },
  { code: "AL", label: "Alabama" },
  { code: "AK", label: "Alaska" },
  { code: "AZ", label: "Arizona" },
  { code: "AR", label: "Arkansas" },
  { code: "CA", label: "California" },
  { code: "CO", label: "Colorado" },
  { code: "CT", label: "Connecticut" },
  { code: "DE", label: "Delaware" },
  { code: "FL", label: "Florida" },
  { code: "GA", label: "Georgia" },
  { code: "HI", label: "Hawaii" },
  { code: "ID", label: "Idaho" },
  { code: "IL", label: "Illinois" },
  { code: "IN", label: "Indiana" },
  { code: "IA", label: "Iowa" },
  { code: "KS", label: "Kansas" },
  { code: "KY", label: "Kentucky" },
  { code: "LA", label: "Louisiana" },
  { code: "ME", label: "Maine" },
  { code: "MD", label: "Maryland" },
  { code: "MA", label: "Massachusetts" },
  { code: "MI", label: "Michigan" },
  { code: "MN", label: "Minnesota" },
  { code: "MS", label: "Mississippi" },
  { code: "MO", label: "Missouri" },
  { code: "MT", label: "Montana" },
  { code: "NE", label: "Nebraska" },
  { code: "NV", label: "Nevada" },
  { code: "NH", label: "New Hampshire" },
  { code: "NJ", label: "New Jersey" },
  { code: "NM", label: "New Mexico" },
  { code: "NY", label: "New York" },
  { code: "NC", label: "North Carolina" },
  { code: "ND", label: "North Dakota" },
  { code: "OH", label: "Ohio" },
  { code: "OK", label: "Oklahoma" },
  { code: "OR", label: "Oregon" },
  { code: "PA", label: "Pennsylvania" },
  { code: "RI", label: "Rhode Island" },
  { code: "SC", label: "South Carolina" },
  { code: "SD", label: "South Dakota" },
  { code: "TN", label: "Tennessee" },
  { code: "TX", label: "Texas" },
  { code: "UT", label: "Utah" },
  { code: "VT", label: "Vermont" },
  { code: "VA", label: "Virginia" },
  { code: "WA", label: "Washington" },
  { code: "DC", label: "Washington, D.C." },
  { code: "WV", label: "West Virginia" },
  { code: "WI", label: "Wisconsin" },
  { code: "WY", label: "Wyoming" },
  { code: "AS", label: "American Samoa" },
  { code: "GU", label: "Guam" },
  { code: "MP", label: "Northern Mariana Islands" },
  { code: "PR", label: "Puerto Rico" },
  { code: "VI", label: "U.S. Virgin Islands" },
];

const ALERT_COLORS = {
  "Tornado Warning": { bg: "#FF0000", text: "#fff", icon: "🌪️" },
  "Tornado Watch": { bg: "#FF6600", text: "#fff", icon: "🌪️" },
  "Flash Flood Warning": { bg: "#8B0000", text: "#fff", icon: "🌊" },
  "Flash Flood Watch": { bg: "#2E8B57", text: "#fff", icon: "🌊" },
  "Flood Warning": { bg: "#00CC44", text: "#000", icon: "💧" },
  "Flood Watch": { bg: "#2E8B57", text: "#fff", icon: "💧" },
  "Winter Storm Warning": { bg: "#FF69B4", text: "#fff", icon: "❄️" },
  "Winter Storm Watch": { bg: "#4169E1", text: "#fff", icon: "❄️" },
  "Severe Thunderstorm Warning": { bg: "#FFA500", text: "#000", icon: "⛈️" },
  "Severe Thunderstorm Watch": { bg: "#DB7093", text: "#fff", icon: "⛈️" },
  "Hurricane Warning": { bg: "#DC143C", text: "#fff", icon: "🌀" },
  "Hurricane Watch": { bg: "#FF00FF", text: "#fff", icon: "🌀" },
  "Tropical Storm Warning": { bg: "#B22222", text: "#fff", icon: "🌀" },
  "Tropical Storm Watch": { bg: "#F08080", text: "#000", icon: "🌀" },
  "Blizzard Warning": { bg: "#FF4500", text: "#fff", icon: "🌨️" },
  "Ice Storm Warning": { bg: "#8B008B", text: "#fff", icon: "🧊" },
  "Dense Fog Advisory": { bg: "#708090", text: "#fff", icon: "🌫️" },
  "High Wind Warning": { bg: "#DAA520", text: "#000", icon: "💨" },
  "High Wind Watch": { bg: "#B8860B", text: "#fff", icon: "💨" },
  "Wind Advisory": { bg: "#D2691E", text: "#fff", icon: "💨" },
  "Frost Advisory": { bg: "#6495ED", text: "#fff", icon: "🌡️" },
  "Freeze Warning": { bg: "#483D8B", text: "#fff", icon: "🌡️" },
  "Freeze Watch": { bg: "#00CED1", text: "#000", icon: "🌡️" },
  "Heat Advisory": { bg: "#FF7F50", text: "#fff", icon: "🌡️" },
  "Excessive Heat Warning": { bg: "#C71585", text: "#fff", icon: "🌡️" },
  "Excessive Heat Watch": { bg: "#FF4500", text: "#fff", icon: "🌡️" },
  "Air Quality Alert": { bg: "#808000", text: "#fff", icon: "😷" },
  default: { bg: "#FFD700", text: "#000", icon: "⚠️" },
};

// Severity badge sort priority (lower = higher priority at top)
const SEVERITY_ORDER = { "Extreme": 0, "Severe": 1, "Moderate": 2, "Minor": 3, "Unknown": 4 };

function getAlertStyle(event = "") {
  return ALERT_COLORS[event] || ALERT_COLORS.default;
}

function formatAlertDescription(desc = "") {
  const lines = desc.split("\n");
  const blocks = [];
  let current = null;
  let skipBlock = false;

  for (const raw of lines) {
    const trimmed = raw.trimEnd().trim();

    if (/^\*\s*[A-Z]/.test(trimmed)) {
      if (/^\*\s*WHEN\b/i.test(trimmed)) {
        skipBlock = true;
        current = null;
        continue;
      }
      skipBlock = false;
      current = null;
      const converted = trimmed.replace(/^\*\s*([A-Z][A-Z ]+?)\.\.\.(.*)/, (_, label, rest) => `${label.trim()}: ${rest.trim()}`);
      current = { type: "label", text: converted };
      blocks.push(current);
      continue;
    }

    if (skipBlock) continue;

    if (trimmed === "") {
      current = null;
      continue;
    }

    if (current) {
      current.text = current.text.trimEnd() + " " + trimmed;
    } else {
      current = { type: "intro", text: trimmed };
      blocks.push(current);
    }
  }

  return blocks.map(block => {
    if (block.type === "intro") {
      return block.text
        .replace(/^\.+\s*/, "")
        .replace(/\.\.\./g, ", ")
        .replace(/,\s*,/g, ",")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
    return block.text.replace(/\s{2,}/g, " ").trim();
  }).filter(Boolean).join("\n\n").trim();
}

function AlertCard({ alert, theme }) {
  const [expanded, setExpanded] = useState(false);
  const props = alert.properties;
  const s = getAlertStyle(props.event);
  const alertUrl = props?.["@id"] || alert.id || props?.id || null;
  const hasDetail = !!(props.description || props.instruction);

  return (
    <div
      style={{
        background: `${s.bg}22`,
        border: `1px solid ${s.bg}`,
        borderLeft: `4px solid ${s.bg}`,
        borderRadius: 8,
        padding: "12px 14px",
        marginBottom: 0,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <span style={{ fontSize: 20, flexShrink: 0, marginTop: 1 }}>{s.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontWeight: "bold", color: "#000", fontSize: 15, lineHeight: 1.2 }}>{props.event}</span>
            <span style={{
              background: s.bg,
              color: s.text,
              padding: "1px 7px",
              borderRadius: 10,
              fontSize: 10,
              fontWeight: "bold",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
            }}>
              {props.severity}
            </span>
            {props.urgency && props.urgency !== "Unknown" && (
              <span style={{
                background: "rgba(0,0,0,0.12)",
                color: "#333",
                padding: "1px 7px",
                borderRadius: 10,
                fontSize: 10,
                textTransform: "uppercase",
                whiteSpace: "nowrap",
              }}>
                {props.urgency}
              </span>
            )}
          </div>

          {/* Affected areas — show up to 5 zones before truncating */}
          {props.areaDesc && (
            <div style={{ fontSize: 13, color: "#333", marginBottom: 3, lineHeight: 1.4 }}>
              📍 {props.areaDesc.split(";").map(s => s.trim()).filter(Boolean).slice(0, 5).join(" • ")}
              {props.areaDesc.split(";").length > 5 && ` • +${props.areaDesc.split(";").length - 5} more areas`}
            </div>
          )}

          <div style={{ fontSize: 12, color: "#555", marginBottom: props.headline ? 6 : 0 }}>
            {props.effective && (
              <span style={{ marginRight: 12 }}>
                Issued: {new Date(props.effective).toLocaleString()}
              </span>
            )}
            <span>
              Expires: {props.expires ? new Date(props.expires).toLocaleString() : "Unknown"}
            </span>
          </div>

          {props.headline && (
            <div style={{ fontSize: 13, color: "#222", marginTop: 4, fontStyle: "italic", lineHeight: 1.4 }}>
              {props.headline}
            </div>
          )}
        </div>
      </div>

      {/* Expand/collapse detail */}
      {hasDetail && (
        <>
          <button
            onClick={() => setExpanded(v => !v)}
            style={{
              marginTop: 10,
              background: "rgba(0,0,0,0.08)",
              border: "1px solid rgba(0,0,0,0.15)",
              borderRadius: 6,
              padding: "4px 12px",
              cursor: "pointer",
              fontSize: 12,
              color: "#333",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
            aria-expanded={expanded}
          >
            {expanded ? "▲ Hide Details" : "▼ Show Details"}
          </button>

          {expanded && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(0,0,0,0.1)" }}>
              {props.description && (
                <div style={{ fontSize: 13, color: "#333", whiteSpace: "pre-wrap", lineHeight: 1.7, marginBottom: props.instruction ? 12 : 0 }}>
                  {formatAlertDescription(props.description)}
                </div>
              )}
              {props.instruction && (
                <div style={{ fontSize: 13, color: "#333", lineHeight: 1.6, fontStyle: "italic" }}>
                  💡 {props.instruction.split("\n").map(l => l.trim()).filter(Boolean).join(" ")}
                </div>
              )}
              {alertUrl && (
                <a
                  href={alertUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: "inline-block", marginTop: 8, fontSize: 12, color: theme.palette.primary.main, textDecoration: "none" }}
                >
                  View on NWS →
                </a>
              )}
            </div>
          )}
        </>
      )}

      {!hasDetail && alertUrl && (
        <div style={{ marginTop: 8 }}>
          <a
            href={alertUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12, color: theme.palette.primary.main, textDecoration: "none" }}
          >
            View on NWS →
          </a>
        </div>
      )}
    </div>
  );
}

export default function LiveWeatherAlertsPage() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const paperBg = theme.palette.background.paper;
  const textColor = theme.palette.text.primary;
  const divider = theme.palette.divider;
  const primary = theme.palette.primary.main;

  const [selectedArea, setSelectedArea] = useState("ALL");
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Set page meta
  useEffect(() => {
    document.title = "Live Weather Alerts — All States | Local KY News";
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    meta.setAttribute(
      "content",
      "Live National Weather Service alerts for every US state and territory. Filter by state and see active tornado warnings, flood warnings, severe thunderstorm alerts, and more."
    );
    return () => {
      document.title = "Local KY News — Kentucky's Local News Aggregator";
      meta?.setAttribute(
        "content",
        "Local KY News — AI-assisted news summaries covering all 120 Kentucky counties. Local government, schools, sports, weather, and more."
      );
    };
  }, []);

  const fetchAlerts = useCallback(async (areaCode) => {
    setLoading(true);
    setError(null);
    try {
      const url =
        areaCode === "ALL"
          ? "https://api.weather.gov/alerts/active?status=actual&message_type=alert,update"
          : `https://api.weather.gov/alerts/active?area=${areaCode}&status=actual&message_type=alert,update`;
      const res = await fetch(url, {
        headers: { "User-Agent": "LocalKYNews/1.0 (kynews.com)" },
      });
      if (!res.ok) throw new Error(`NWS API returned ${res.status}`);
      const data = await res.json();
      const sorted = (data.features || []).sort((a, b) => {
        const sa = SEVERITY_ORDER[a.properties?.severity] ?? 4;
        const sb = SEVERITY_ORDER[b.properties?.severity] ?? 4;
        return sa - sb;
      });
      setAlerts(sorted);
      setLastUpdated(new Date());
    } catch (err) {
      setError("Unable to load weather alerts. The NWS API may be temporarily unavailable.");
      setAlerts([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAlerts(selectedArea);
  }, [selectedArea, fetchAlerts]);

  // Auto-refresh every 3 minutes
  useEffect(() => {
    const interval = setInterval(() => fetchAlerts(selectedArea), 3 * 60 * 1000);
    return () => clearInterval(interval);
  }, [selectedArea, fetchAlerts]);

  const selectedAreaLabel = US_AREAS.find(a => a.code === selectedArea)?.label || selectedArea;

  // Count by severity for the summary bar
  const extremeCount = alerts.filter(a => a.properties?.severity === "Extreme").length;
  const severeCount = alerts.filter(a => a.properties?.severity === "Severe").length;
  const moderateCount = alerts.filter(a => a.properties?.severity === "Moderate").length;

  return (
    <div style={{ fontFamily: "Georgia, serif", background: theme.palette.background.default, color: textColor, paddingBottom: 40 }}>
      {/* Page header */}
      <Typography variant="h5" component="h1" gutterBottom style={{ fontFamily: "Georgia, serif", marginTop: 8 }}>
        Live Weather Alerts
      </Typography>
      <Typography variant="body2" style={{ color: theme.palette.text.secondary, marginBottom: 16, fontSize: 13 }}>
        Active National Weather Service alerts for the United States. Data sourced directly from{" "}
        <a href="https://www.weather.gov" target="_blank" rel="noopener noreferrer" style={{ color: primary }}>weather.gov</a>.
      </Typography>

      {/* State selector + refresh controls */}
      <div
        style={{
          background: paperBg,
          border: `1px solid ${divider}`,
          borderRadius: 12,
          padding: "14px 16px",
          marginBottom: 14,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 11, color: primary, textTransform: "uppercase", letterSpacing: 2, fontWeight: "bold", flexShrink: 0 }}>
          📍 Filter by State
        </div>

        <FormControl variant="outlined" size="small" style={{ minWidth: isMobile ? "100%" : 260 }}>
          <InputLabel id="state-select-label">State / Territory</InputLabel>
          <Select
            labelId="state-select-label"
            id="state-select"
            value={selectedArea}
            onChange={e => setSelectedArea(e.target.value)}
            label="State / Territory"
          >
            {US_AREAS.map(area => (
              <MenuItem key={area.code} value={area.code}>
                {area.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto", flexWrap: "wrap" }}>
          {lastUpdated && !loading && (
            <span style={{ fontSize: 11, color: theme.palette.text.secondary }}>
              Updated: {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={() => fetchAlerts(selectedArea)}
            disabled={loading}
            style={{
              background: loading ? "rgba(100,181,246,0.1)" : "rgba(100,181,246,0.18)",
              border: `1px solid ${primary}`,
              color: loading ? theme.palette.text.disabled : primary,
              borderRadius: 6,
              padding: "5px 14px",
              cursor: loading ? "default" : "pointer",
              fontSize: 12,
              fontWeight: "bold",
            }}
          >
            {loading ? "Loading…" : "⟳ Refresh"}
          </button>
        </div>
      </div>

      {/* Alert count banner */}
      {!loading && !error && (
        alerts.length > 0 ? (
          <div
            style={{
              background: "linear-gradient(90deg,#7b0000,#c62828,#7b0000)",
              padding: "10px 20px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              borderRadius: 8,
              marginBottom: 14,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: 18 }}>🚨</span>
            <div style={{ flex: 1 }}>
              <span style={{ fontWeight: "bold", fontSize: 12, color: "#fff", letterSpacing: 1, textTransform: "uppercase" }}>
                {alerts.length} Active Alert{alerts.length !== 1 ? "s" : ""} — {selectedAreaLabel}
              </span>
              {(extremeCount > 0 || severeCount > 0) && (
                <span style={{ fontSize: 12, color: "#ffcdd2", marginLeft: 10 }}>
                  {extremeCount > 0 && `${extremeCount} Extreme`}
                  {extremeCount > 0 && severeCount > 0 && " • "}
                  {severeCount > 0 && `${severeCount} Severe`}
                  {moderateCount > 0 && ` • ${moderateCount} Moderate`}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div
            style={{
              background: "linear-gradient(90deg,#1a3a1a,#2e7d32,#1a3a1a)",
              padding: "10px 20px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              borderRadius: 8,
              marginBottom: 14,
            }}
          >
            <span>✅</span>
            <span style={{ fontSize: 13, color: "#a5d6a7" }}>
              No active weather alerts for {selectedAreaLabel}
            </span>
          </div>
        )
      )}

      {/* Main content area */}
      <div
        style={{
          background: paperBg,
          border: `1px solid ${divider}`,
          borderRadius: 12,
          padding: 16,
          minHeight: 200,
        }}
      >
        {loading && (
          <Box style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: 48, gap: 16 }}>
            <CircularProgress size={32} />
            <Typography variant="body2" style={{ color: theme.palette.text.secondary }}>
              Loading alerts from National Weather Service…
            </Typography>
          </Box>
        )}

        {!loading && error && (
          <div style={{ textAlign: "center", padding: 48 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
            <div style={{ color: "#ef5350", fontSize: 15, marginBottom: 8 }}>{error}</div>
            <button
              onClick={() => fetchAlerts(selectedArea)}
              style={{
                marginTop: 8,
                background: "rgba(100,181,246,0.15)",
                border: `1px solid ${primary}`,
                color: primary,
                borderRadius: 6,
                padding: "6px 18px",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              Try Again
            </button>
          </div>
        )}

        {!loading && !error && alerts.length === 0 && (
          <div style={{ textAlign: "center", padding: 48 }}>
            <div style={{ fontSize: 44, marginBottom: 10 }}>✅</div>
            <div style={{ color: theme.palette.text.secondary, fontSize: 16 }}>
              No active weather alerts for {selectedAreaLabel}
            </div>
          </div>
        )}

        {!loading && !error && alerts.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {alerts.map((alert, i) => (
              <AlertCard key={alert.id || i} alert={alert} theme={theme} />
            ))}
          </div>
        )}
      </div>

      {/* Attribution footer */}
      <div style={{ textAlign: "center", marginTop: 16, fontSize: 11, color: theme.palette.text.secondary }}>
        Alert data provided by the{" "}
        <a href="https://www.weather.gov/documentation/services-web-api" target="_blank" rel="noopener noreferrer" style={{ color: primary }}>
          National Weather Service API
        </a>
        . Auto-refreshes every 3 minutes.
      </div>
    </div>
  );
}
