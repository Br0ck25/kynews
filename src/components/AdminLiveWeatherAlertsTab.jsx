import React, { useState, useEffect, useCallback } from "react";
import {
  Box,
  Button,
  Typography,
  CircularProgress,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  TextField,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Chip,
} from "@material-ui/core";
import ExpandMoreIcon from "@material-ui/icons/ExpandMore";
import SiteService from "../services/siteService";

const service = new SiteService();

// All NWS area codes
const US_AREAS = [
  { code: "ALL", label: "All Active (Nationwide)" },
  { code: "KY", label: "Kentucky" },
  { code: "AL", label: "Alabama" }, { code: "AK", label: "Alaska" },
  { code: "AZ", label: "Arizona" }, { code: "AR", label: "Arkansas" },
  { code: "CA", label: "California" }, { code: "CO", label: "Colorado" },
  { code: "CT", label: "Connecticut" }, { code: "DE", label: "Delaware" },
  { code: "FL", label: "Florida" }, { code: "GA", label: "Georgia" },
  { code: "HI", label: "Hawaii" }, { code: "ID", label: "Idaho" },
  { code: "IL", label: "Illinois" }, { code: "IN", label: "Indiana" },
  { code: "IA", label: "Iowa" }, { code: "KS", label: "Kansas" },
  { code: "LA", label: "Louisiana" }, { code: "ME", label: "Maine" },
  { code: "MD", label: "Maryland" }, { code: "MA", label: "Massachusetts" },
  { code: "MI", label: "Michigan" }, { code: "MN", label: "Minnesota" },
  { code: "MS", label: "Mississippi" }, { code: "MO", label: "Missouri" },
  { code: "MT", label: "Montana" }, { code: "NE", label: "Nebraska" },
  { code: "NV", label: "Nevada" }, { code: "NH", label: "New Hampshire" },
  { code: "NJ", label: "New Jersey" }, { code: "NM", label: "New Mexico" },
  { code: "NY", label: "New York" }, { code: "NC", label: "North Carolina" },
  { code: "ND", label: "North Dakota" }, { code: "OH", label: "Ohio" },
  { code: "OK", label: "Oklahoma" }, { code: "OR", label: "Oregon" },
  { code: "PA", label: "Pennsylvania" }, { code: "RI", label: "Rhode Island" },
  { code: "SC", label: "South Carolina" }, { code: "SD", label: "South Dakota" },
  { code: "TN", label: "Tennessee" }, { code: "TX", label: "Texas" },
  { code: "UT", label: "Utah" }, { code: "VT", label: "Vermont" },
  { code: "VA", label: "Virginia" }, { code: "WA", label: "Washington" },
  { code: "DC", label: "Washington D.C." }, { code: "WV", label: "West Virginia" },
  { code: "WI", label: "Wisconsin" }, { code: "WY", label: "Wyoming" },
  { code: "PR", label: "Puerto Rico" }, { code: "GU", label: "Guam" },
];

const SEVERITY_COLOR = {
  Extreme: "#d32f2f", Severe: "#f57c00", Moderate: "#fbc02d", Minor: "#388e3c",
};

// Mirror the worker's buildWeatherAlertFbCaption for preview
function buildPreviewCaption(props) {
  const area = (props.areaDesc || "").split(/;\s*/).join(",  ");
  let expiresLine = "";
  if (props.expires) {
    expiresLine = new Date(props.expires).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      timeZone: "America/New_York", timeZoneName: "short",
    });
  }
  const lines = [
    (props.event || "WEATHER ALERT").toUpperCase(), "",
    `Area: ${area}`,
  ];
  if (expiresLine) lines.push(`Expires: ${expiresLine}`);
  lines.push(`Severity: ${props.severity || "Unknown"}`);
  lines.push("");
  if (props.headline) lines.push(props.headline);
  lines.push("");
  lines.push((props.description || "").trim());
  lines.push("");
  lines.push(
    "#WeatherAlert #SevereWeather #NWS #LocalKYNews #StaySafe #WeatherWarning #EmergencyAlert"
  );
  return lines.join("\n");
}

function AlertAdminCard({ alert }) {
  const props = alert.properties;
  const [posting, setPosting] = useState(false);
  const [postResult, setPostResult] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const severityColor = SEVERITY_COLOR[props.severity] || "#757575";
  const alertId = alert.id || props?.id || props?.["@id"] || "";
  const previewCaption = buildPreviewCaption(props);

  const handlePost = async () => {
    setPosting(true);
    setPostResult(null);
    try {
      const result = await service.postWeatherAlertToFacebook(alertId);
      setPostResult({ ok: true, fbPostId: result?.fbPostId ?? result?.result?.id ?? "" });
    } catch (err) {
      setPostResult({ ok: false, error: err?.message || String(err) });
    }
    setPosting(false);
  };

  return (
    <Box
      style={{
        border: `1px solid ${severityColor}`,
        borderLeft: `4px solid ${severityColor}`,
        borderRadius: 8,
        padding: "12px 16px",
        marginBottom: 12,
        background: "#fff",
      }}
    >
      <Box style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <Box style={{ flex: 1, minWidth: 220 }}>
          <Box style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <Typography variant="subtitle1" style={{ fontWeight: "bold", fontSize: 15 }}>
              {props.event}
            </Typography>
            <Chip
              label={props.severity}
              size="small"
              style={{ background: severityColor, color: "#fff", fontSize: 11, height: 20 }}
            />
            {props.urgency && props.urgency !== "Unknown" && (
              <Chip label={props.urgency} size="small" style={{ fontSize: 11, height: 20 }} />
            )}
          </Box>
          <Typography variant="body2" color="textSecondary" style={{ marginBottom: 2, fontSize: 12 }}>
            📍 {(props.areaDesc || "").split(";").slice(0, 4).map(s => s.trim()).filter(Boolean).join(" • ")}
            {(props.areaDesc || "").split(";").length > 4 && ` • +${(props.areaDesc || "").split(";").length - 4} more`}
          </Typography>
          <Typography variant="body2" color="textSecondary" style={{ fontSize: 11 }}>
            Expires: {props.expires ? new Date(props.expires).toLocaleString() : "Unknown"}
          </Typography>
          {props.headline && (
            <Typography variant="body2" style={{ marginTop: 4, fontSize: 13, fontStyle: "italic" }}>
              {props.headline}
            </Typography>
          )}
        </Box>

        <Box style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, minWidth: 160 }}>
          <Button
            variant="contained"
            color="primary"
            disabled={posting || postResult?.ok}
            size="small"
            onClick={handlePost}
            style={{ minWidth: 160, background: postResult?.ok ? "#388e3c" : undefined }}
          >
            {posting ? <CircularProgress size={16} color="inherit" /> :
              postResult?.ok ? "✅ Posted!" : "📘 Post to Facebook"}
          </Button>

          <Button
            variant="outlined"
            size="small"
            onClick={() => setShowPreview(v => !v)}
            style={{ minWidth: 160, fontSize: 11 }}
          >
            {showPreview ? "Hide Preview" : "Preview Caption"}
          </Button>
        </Box>
      </Box>

      {postResult && !postResult.ok && (
        <Box
          style={{
            marginTop: 8, padding: "6px 10px", background: "#fdecea",
            border: "1px solid #ef9a9a", borderRadius: 4,
          }}
        >
          <Typography variant="body2" color="error" style={{ fontSize: 12 }}>
            ❌ {postResult.error}
          </Typography>
        </Box>
      )}
      {postResult?.ok && postResult.fbPostId && (
        <Box
          style={{
            marginTop: 8, padding: "6px 10px", background: "#e8f5e9",
            border: "1px solid #a5d6a7", borderRadius: 4,
          }}
        >
          <Typography variant="body2" style={{ fontSize: 12, color: "#2e7d32" }}>
            ✅ Posted to Facebook · ID: {postResult.fbPostId}
          </Typography>
        </Box>
      )}

      {showPreview && (
        <Box
          style={{
            marginTop: 10, padding: 10,
            background: "#f5f5f5", border: "1px solid #e0e0e0",
            borderRadius: 4,
          }}
        >
          <Typography variant="caption" style={{ fontWeight: "bold", display: "block", marginBottom: 4 }}>
            Caption Preview (what will be posted)
          </Typography>
          <Typography
            variant="body2"
            component="pre"
            style={{
              fontSize: 11, whiteSpace: "pre-wrap", fontFamily: "monospace",
              margin: 0, color: "#333",
            }}
          >
            {previewCaption}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

// ── Token Management section ──────────────────────────────────────────────────
function TokenManagementPanel() {
  const [shortToken, setShortToken] = useState("");
  const [exchanging, setExchanging] = useState(false);
  const [result, setResult] = useState(null);

  const handleExchange = async () => {
    if (!shortToken.trim()) return;
    setExchanging(true);
    setResult(null);
    try {
      const data = await service.exchangeFacebookToken(shortToken.trim());
      setResult({ ok: true, ...data });
    } catch (err) {
      setResult({ ok: false, error: err?.message || String(err) });
    }
    setExchanging(false);
  };

  return (
    <Accordion style={{ marginBottom: 16 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle2" style={{ fontWeight: "bold" }}>
          🔑 Facebook Token Management
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Box style={{ width: "100%" }}>
          <Typography variant="body2" color="textSecondary" style={{ marginBottom: 8, fontSize: 12 }}>
            Paste a short-lived Facebook User Token to exchange it for a long-lived Page Access Token.
            The resulting token should be saved as the <code>FACEBOOK_PAGE_ACCESS_TOKEN</code> Wrangler secret.
          </Typography>
          <Box style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
            <TextField
              label="Short-Lived User Token"
              value={shortToken}
              onChange={e => setShortToken(e.target.value)}
              variant="outlined"
              size="small"
              style={{ flex: 1, minWidth: 260 }}
              inputProps={{ style: { fontFamily: "monospace", fontSize: 12 } }}
            />
            <Button
              variant="contained"
              color="primary"
              onClick={handleExchange}
              disabled={exchanging || !shortToken.trim()}
              size="small"
            >
              {exchanging ? <CircularProgress size={16} color="inherit" /> : "Exchange Token"}
            </Button>
          </Box>

          {result && !result.ok && (
            <Box style={{ marginTop: 10, padding: "8px 12px", background: "#fdecea", border: "1px solid #ef9a9a", borderRadius: 4 }}>
              <Typography variant="body2" color="error" style={{ fontSize: 12 }}>
                ❌ {result.error}
              </Typography>
            </Box>
          )}

          {result?.ok && (
            <Box style={{ marginTop: 10, padding: "10px 14px", background: "#e8f5e9", border: "1px solid #a5d6a7", borderRadius: 4 }}>
              <Typography variant="body2" style={{ fontSize: 12, color: "#1b5e20", marginBottom: 6 }}>
                ✅ Token exchanged successfully for page: <strong>{result.pageName}</strong>
              </Typography>
              <Typography variant="caption" style={{ fontWeight: "bold", display: "block", marginBottom: 4 }}>
                Long-Lived Page Access Token (copy this):
              </Typography>
              <TextField
                value={result.pageAccessToken}
                variant="outlined"
                size="small"
                fullWidth
                InputProps={{ readOnly: true, style: { fontFamily: "monospace", fontSize: 11 } }}
                onClick={e => e.target.select()}
              />
              <Typography variant="caption" style={{ display: "block", marginTop: 6, color: "#555" }}>
                Save it: <code>npx wrangler secret put LIVE_ALERTS_PAGE_ACCESS_TOKEN</code> then paste the token above.
                <br />This is separate from the Local KY News page token and will NOT affect existing auto-posting.
              </Typography>
            </Box>
          )}
        </Box>
      </AccordionDetails>
    </Accordion>
  );
}

// ── Main tab component ────────────────────────────────────────────────────────
export default function AdminLiveWeatherAlertsTab() {
  const [selectedArea, setSelectedArea] = useState("KY");
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchAlerts = useCallback(async (areaCode) => {
    setLoading(true);
    setError(null);
    try {
      const url = areaCode === "ALL"
        ? "https://api.weather.gov/alerts/active?status=actual&message_type=alert,update"
        : `https://api.weather.gov/alerts/active?area=${areaCode}&status=actual&message_type=alert,update`;
      const res = await fetch(url, { headers: { "User-Agent": "LocalKYNews/1.0 (localkynews.com)" } });
      if (!res.ok) throw new Error(`NWS API returned ${res.status}`);
      const data = await res.json();
      const SEVERITY_ORDER = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
      const sorted = (data.features || []).sort((a, b) =>
        (SEVERITY_ORDER[a.properties?.severity] ?? 4) - (SEVERITY_ORDER[b.properties?.severity] ?? 4)
      );
      setAlerts(sorted);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err?.message || "Failed to load weather alerts");
      setAlerts([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAlerts(selectedArea); }, [selectedArea, fetchAlerts]);

  return (
    <Box>
      <Typography variant="h6" gutterBottom style={{ marginBottom: 4 }}>
        Live Weather Alerts
      </Typography>
      <Typography variant="body2" color="textSecondary" style={{ marginBottom: 16, fontSize: 12 }}>
        Fetch active NWS alerts and post them directly to Facebook. Each card shows a caption preview before you post.
      </Typography>

      <TokenManagementPanel />

      {/* Controls */}
      <Box style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <FormControl variant="outlined" size="small" style={{ minWidth: 220 }}>
          <InputLabel id="admin-alert-state-label">State / Territory</InputLabel>
          <Select
            labelId="admin-alert-state-label"
            value={selectedArea}
            onChange={e => setSelectedArea(e.target.value)}
            label="State / Territory"
          >
            {US_AREAS.map(a => (
              <MenuItem key={a.code} value={a.code}>{a.label}</MenuItem>
            ))}
          </Select>
        </FormControl>

        <Button
          variant="outlined"
          size="small"
          onClick={() => fetchAlerts(selectedArea)}
          disabled={loading}
        >
          {loading ? <CircularProgress size={14} /> : "⟳ Refresh"}
        </Button>

        {lastUpdated && !loading && (
          <Typography variant="caption" color="textSecondary">
            Updated: {lastUpdated.toLocaleTimeString()}
          </Typography>
        )}

        {!loading && !error && (
          <Chip
            label={`${alerts.length} Active Alert${alerts.length !== 1 ? "s" : ""}`}
            size="small"
            style={{
              background: alerts.length > 0 ? "#d32f2f" : "#388e3c",
              color: "#fff",
            }}
          />
        )}
      </Box>

      {/* Alert list */}
      {loading && (
        <Box style={{ display: "flex", justifyContent: "center", padding: 40 }}>
          <CircularProgress />
        </Box>
      )}

      {!loading && error && (
        <Box style={{ padding: "16px", background: "#fdecea", border: "1px solid #ef9a9a", borderRadius: 6 }}>
          <Typography color="error" variant="body2">⚠️ {error}</Typography>
        </Box>
      )}

      {!loading && !error && alerts.length === 0 && (
        <Box style={{ textAlign: "center", padding: 40, color: "#555" }}>
          <Typography>✅ No active weather alerts for {US_AREAS.find(a => a.code === selectedArea)?.label || selectedArea}</Typography>
        </Box>
      )}

      {!loading && !error && alerts.length > 0 && (
        <Box>
          {alerts.map((alert, i) => (
            <AlertAdminCard key={alert.id || i} alert={alert} />
          ))}
        </Box>
      )}
    </Box>
  );
}
