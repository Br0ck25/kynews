import React, { useState, useEffect, useCallback } from "react";
import {
  Box,
  Button,
  Typography,
  CircularProgress,
  Switch,
  FormControlLabel,
  Paper,
  Chip,
  TextField,
  Divider,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from "@material-ui/core";
import ExpandMoreIcon from "@material-ui/icons/ExpandMore";
import { useTheme } from "@material-ui/core/styles";
import SiteService from "../services/siteService";

// ── Alert feed helpers ────────────────────────────────────────────────────────

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
      if (/^\*\s*WHEN\b/i.test(trimmed)) { skipBlock = true; current = null; continue; }
      skipBlock = false; current = null;
      const converted = trimmed.replace(/^\*\s*([A-Z][A-Z ]+?)\.\.\.(.*)/, (_, label, rest) => `${label.trim()}: ${rest.trim()}`);
      current = { type: "label", text: converted };
      blocks.push(current);
      continue;
    }
    if (skipBlock) continue;
    if (trimmed === "") { current = null; continue; }
    if (current) { current.text = current.text.trimEnd() + " " + trimmed; }
    else { current = { type: "intro", text: trimmed }; blocks.push(current); }
  }
  return blocks.map(b => b.type === "intro"
    ? b.text.replace(/^\.+\s*/, "").replace(/\.\.\./g, ", ").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").trim()
    : b.text.replace(/\s{2,}/g, " ").trim()
  ).filter(Boolean).join("\n\n").trim();
}

function AlertCard({ alert, theme }) {
  const [expanded, setExpanded] = useState(false);
  const props = alert.properties;
  const s = getAlertStyle(props.event);
  const alertUrl = props?.["@id"] || alert.id || props?.id || null;
  const hasDetail = !!(props.description || props.instruction);

  return (
    <div style={{
      background: `${s.bg}22`,
      border: `1px solid ${s.bg}`,
      borderLeft: `4px solid ${s.bg}`,
      borderRadius: 8,
      padding: "12px 14px",
      marginBottom: 0,
    }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <span style={{ fontSize: 20, flexShrink: 0, marginTop: 1 }}>{s.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontWeight: "bold", color: "#000", fontSize: 15, lineHeight: 1.2 }}>{props.event}</span>
            <span style={{ background: s.bg, color: s.text, padding: "1px 7px", borderRadius: 10, fontSize: 10, fontWeight: "bold", textTransform: "uppercase", whiteSpace: "nowrap" }}>
              {props.severity}
            </span>
            {props.urgency && props.urgency !== "Unknown" && (
              <span style={{ background: "rgba(0,0,0,0.12)", color: "#333", padding: "1px 7px", borderRadius: 10, fontSize: 10, textTransform: "uppercase", whiteSpace: "nowrap" }}>
                {props.urgency}
              </span>
            )}
          </div>
          {props.areaDesc && (
            <div style={{ fontSize: 13, color: "#333", marginBottom: 3, lineHeight: 1.4, wordBreak: "break-word" }}>
              📍 {props.areaDesc.split(";").map(a => a.trim()).filter(Boolean).join(" • ")}
            </div>
          )}
          <div style={{ fontSize: 12, color: "#555", marginBottom: props.headline ? 6 : 0 }}>
            {props.effective && <span style={{ marginRight: 12 }}>Issued: {new Date(props.effective).toLocaleString()}</span>}
            <span>Expires: {props.expires ? new Date(props.expires).toLocaleString() : "Unknown"}</span>
          </div>
          {props.headline && (
            <div style={{ fontSize: 13, color: "#222", marginTop: 4, fontStyle: "italic", lineHeight: 1.4 }}>{props.headline}</div>
          )}
        </div>
      </div>
      {hasDetail && (
        <>
          <button
            onClick={() => setExpanded(v => !v)}
            style={{ marginTop: 10, background: "rgba(0,0,0,0.08)", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 12, color: "#333", display: "flex", alignItems: "center", gap: 4 }}
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
                <a href={alertUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: 8, fontSize: 12, color: theme.palette.primary.main, textDecoration: "none" }}>
                  View on NWS →
                </a>
              )}
            </div>
          )}
        </>
      )}
      {!hasDetail && alertUrl && (
        <div style={{ marginTop: 8 }}>
          <a href={alertUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: theme.palette.primary.main, textDecoration: "none" }}>
            View on NWS →
          </a>
        </div>
      )}
    </div>
  );
}

const service = new SiteService();

export default function WeatherAlertWorkerTab() {
  const theme = useTheme();

  const [config, setConfig] = useState({ warnings: true, watches: true, others: false });
  const [lastSweep, setLastSweep] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveResult, setSaveResult] = useState(null);

  // Token exchange state
  const [shortLivedToken, setShortLivedToken] = useState("");
  const [exchangeLoading, setExchangeLoading] = useState(false);
  const [exchangeResult, setExchangeResult] = useState(null);
  const [exchangeError, setExchangeError] = useState("");

  // Active KY alerts feed
  const [alerts, setAlerts] = useState([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsError, setAlertsError] = useState(null);
  const [alertsUpdated, setAlertsUpdated] = useState(null);

  const fetchAlerts = useCallback(async () => {
    setAlertsLoading(true);
    setAlertsError(null);
    try {
      const res = await fetch(
        "https://api.weather.gov/alerts/active?area=KY&status=actual&message_type=alert,update",
        { headers: { "User-Agent": "LocalKYNews/1.0 (kynews.com)" } }
      );
      if (!res.ok) throw new Error(`NWS API returned ${res.status}`);
      const data = await res.json();
      const sorted = (data.features || []).slice().sort((a, b) => {
        const t = item => { const e = item?.properties?.effective || item?.properties?.sent || null; const v = e ? new Date(e).getTime() : 0; return isNaN(v) ? 0 : v; };
        return t(b) - t(a);
      });
      setAlerts(sorted);
      setAlertsUpdated(new Date());
    } catch (err) {
      setAlertsError("Unable to load alerts from NWS.");
    } finally {
      setAlertsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchAlerts]);

  const loadConfig = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await service.getWeatherWorkerConfig();
      if (res.ok) {
        setConfig(res.config);
        setLastSweep(res.lastSweep || null);
      } else {
        setError(res.error || "Failed to load config");
      }
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggle = (field) => async (e) => {
    const next = { ...config, [field]: e.target.checked };
    setConfig(next);
    setSaving(true);
    setSaveResult(null);
    setError("");
    try {
      const res = await service.setWeatherWorkerConfig(next);
      if (res.ok) {
        setConfig(res.config);
        setSaveResult("Saved");
      } else {
        setError(res.error || "Failed to save config");
        // Revert
        setConfig(config);
      }
    } catch (err) {
      setError(err?.message || String(err));
      setConfig(config);
    } finally {
      setSaving(false);
    }
  };

  const handleExchange = async () => {
    const token = shortLivedToken.trim();
    if (!token) return;
    setExchangeLoading(true);
    setExchangeResult(null);
    setExchangeError("");
    try {
      const res = await service.exchangeWeatherWorkerToken(token);
      if (res.ok) {
        setExchangeResult(res);
        setShortLivedToken("");
      } else {
        setExchangeError(res.error || "Token exchange failed");
      }
    } catch (err) {
      setExchangeError(err?.message || String(err));
    } finally {
      setExchangeLoading(false);
    }
  };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Live Weather Alerts Worker
      </Typography>
      <Typography variant="body2" color="textSecondary" style={{ marginBottom: 16 }}>
        Controls which NWS alert types are automatically posted to the{" "}
        <strong>Live Weather Alerts</strong> Facebook page. The worker runs every 60
        seconds and checks for new or updated Kentucky weather alerts.
      </Typography>

      {loading ? (
        <CircularProgress size={24} />
      ) : (
        <Paper style={{ padding: 16, maxWidth: 520 }}>
          <Box style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <Typography variant="subtitle1" style={{ fontWeight: 700 }}>
              Auto-Post Settings
            </Typography>
            {saving && <CircularProgress size={16} />}
            {saveResult && !saving && (
              <Chip label="✓ Saved" size="small" style={{ background: "#4caf50", color: "#fff" }} />
            )}
          </Box>

          <FormControlLabel
            control={
              <Switch
                checked={config.warnings}
                onChange={handleToggle("warnings")}
                color="primary"
                disabled={saving}
              />
            }
            label={
              <Box>
                <Typography variant="body1" style={{ fontWeight: 600 }}>
                  Warning Auto-Post
                </Typography>
                <Typography variant="caption" color="textSecondary">
                  Tornado Warning, Flash Flood Warning, Winter Storm Warning, Severe Thunderstorm
                  Warning, Ice Storm Warning, Blizzard Warning, High Wind Warning, Freeze Warning,
                  Red Flag Warning, and other warning-tier alerts
                </Typography>
              </Box>
            }
            style={{ display: "flex", alignItems: "flex-start", marginBottom: 16 }}
          />

          <FormControlLabel
            control={
              <Switch
                checked={config.watches}
                onChange={handleToggle("watches")}
                color="primary"
                disabled={saving}
              />
            }
            label={
              <Box>
                <Typography variant="body1" style={{ fontWeight: 600 }}>
                  Watch Auto-Post
                </Typography>
                <Typography variant="caption" color="textSecondary">
                  Tornado Watch, Flash Flood Watch, Winter Storm Watch, Severe Thunderstorm Watch,
                  Flood Watch, High Wind Watch, Blizzard Watch, Ice Storm Watch, and other
                  watch-tier alerts
                </Typography>
              </Box>
            }
            style={{ display: "flex", alignItems: "flex-start", marginBottom: 16 }}
          />

          <FormControlLabel
            control={
              <Switch
                checked={config.others}
                onChange={handleToggle("others")}
                color="primary"
                disabled={saving}
              />
            }
            label={
              <Box>
                <Typography variant="body1" style={{ fontWeight: 600 }}>
                  Other Alerts Auto-Post
                </Typography>
                <Typography variant="caption" color="textSecondary">
                  Advisories, Statements, Outlooks, Special Weather Statements, and all other
                  alert types not classified as warnings or watches
                </Typography>
              </Box>
            }
            style={{ display: "flex", alignItems: "flex-start", marginBottom: 8 }}
          />

          {error && (
            <Typography color="error" variant="body2" style={{ marginTop: 8 }}>
              {error}
            </Typography>
          )}

          <Box style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}>
            <Button variant="outlined" size="small" onClick={loadConfig} disabled={loading || saving}>
              Refresh
            </Button>
            {lastSweep && (
              <Typography variant="caption" color="textSecondary">
                Last sweep: {new Date(lastSweep).toLocaleString()}
              </Typography>
            )}
          </Box>
        </Paper>
      )}

      {/* ── Token Exchange ─────────────────────────────────────────────── */}
      <Box style={{ marginTop: 24, maxWidth: 520 }}>
        <Accordion>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="subtitle1" style={{ fontWeight: 600 }}>
              Convert User Token → Long-Lived Page Token
            </Typography>
          </AccordionSummary>
          <AccordionDetails style={{ display: "block" }}>
            <Typography variant="body2" color="textSecondary" style={{ marginBottom: 12 }}>
              Paste a short-lived Facebook user access token (valid ~1 hour, obtained from Graph
              API Explorer or the developer dashboard). The worker will exchange it for a
              long-lived user token (~60 days) and then retrieve a <strong>never-expiring page
              access token</strong> for the configured page.
            </Typography>
            <Typography variant="body2" color="textSecondary" style={{ marginBottom: 12 }}>
              Requirements: <code>LIVE_WEATHER_ALERTS_FB_APP_ID</code> and{" "}
              <code>LIVE_WEATHER_ALERTS_FB_APP_SECRET</code> must be set as worker secrets.
            </Typography>

            <TextField
              fullWidth
              variant="outlined"
              size="small"
              label="Short-lived user access token"
              placeholder="EAA6q9fBiC74..."
              value={shortLivedToken}
              onChange={(e) => {
                setShortLivedToken(e.target.value);
                setExchangeResult(null);
                setExchangeError("");
              }}
              disabled={exchangeLoading}
              style={{ marginBottom: 8 }}
              inputProps={{ autoComplete: "off" }}
            />
            <Button
              variant="contained"
              color="primary"
              disabled={exchangeLoading || !shortLivedToken.trim()}
              onClick={handleExchange}
            >
              {exchangeLoading ? <CircularProgress size={16} color="inherit" style={{ marginRight: 8 }} /> : null}
              {exchangeLoading ? "Exchanging…" : "Get Long-Lived Token"}
            </Button>

            {exchangeError && (
              <Typography color="error" variant="body2" style={{ marginTop: 10 }}>
                {exchangeError}
              </Typography>
            )}

            {exchangeResult && (
              <Box style={{ marginTop: 16 }}>
                <Divider style={{ marginBottom: 12 }} />

                {exchangeResult.targetPageToken && (
                  <Box style={{ marginBottom: 12, padding: 12, background: "#f0fff4", border: "1px solid #86efac", borderRadius: 4 }}>
                    <Typography variant="subtitle2" style={{ marginBottom: 4, color: "#166534" }}>
                      ✅ Page Access Token (never expires)
                    </Typography>
                    <Typography variant="caption" style={{ color: "#166534", display: "block", marginBottom: 4 }}>
                      Page: <strong>{exchangeResult.targetPageName}</strong> (ID: {exchangeResult.targetPageId})
                    </Typography>
                    <TextField
                      fullWidth
                      variant="outlined"
                      size="small"
                      value={exchangeResult.targetPageToken}
                      InputProps={{ readOnly: true }}
                      onClick={(e) => e.target.select()}
                    />
                    <Typography variant="caption" color="textSecondary" style={{ display: "block", marginTop: 6 }}>
                      Copy this value and run:
                    </Typography>
                    <Box component="pre" style={{ margin: "4px 0 0", fontSize: 11, background: "#f5f5f5", padding: "6px 10px", borderRadius: 4, overflowX: "auto" }}>
                      {`npx wrangler secret put LIVE_WEATHER_ALERTS_FB_PAGE_TOKEN\n# then paste the token above`}
                    </Box>
                  </Box>
                )}

                <Box style={{ marginBottom: 8 }}>
                  <Typography variant="caption" color="textSecondary">
                    Long-lived user token (expires in ~{exchangeResult.expiresInDays} days):
                  </Typography>
                  <TextField
                    fullWidth
                    variant="outlined"
                    size="small"
                    value={exchangeResult.longLivedUserToken}
                    InputProps={{ readOnly: true }}
                    onClick={(e) => e.target.select()}
                    style={{ marginTop: 4 }}
                  />
                </Box>

                {exchangeResult.pages && exchangeResult.pages.length > 1 && (
                  <Box>
                    <Typography variant="caption" color="textSecondary" style={{ marginBottom: 4, display: "block" }}>
                      All pages on this account:
                    </Typography>
                    {exchangeResult.pages.map((p) => (
                      <Chip
                        key={p.id}
                        size="small"
                        label={`${p.name} (${p.id})`}
                        style={{ margin: "2px 4px 2px 0" }}
                      />
                    ))}
                  </Box>
                )}
              </Box>
            )}
          </AccordionDetails>
        </Accordion>
      </Box>

      {/* ── Active Kentucky Alerts Feed ────────────────────────────────────── */}
      <Box style={{ marginTop: 32 }}>
        <Box style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
          <Typography variant="h6" style={{ fontWeight: 700, margin: 0 }}>
            Active Kentucky Alerts
          </Typography>
          <Chip
            label={`${alerts.length} active`}
            size="small"
            style={{ background: alerts.length > 0 ? "#ef5350" : "#bdbdbd", color: "#fff", fontWeight: 700 }}
          />
          {alertsLoading && <CircularProgress size={16} />}
          <Button variant="outlined" size="small" onClick={fetchAlerts} disabled={alertsLoading}>
            Refresh
          </Button>
          {alertsUpdated && (
            <Typography variant="caption" color="textSecondary">
              Updated: {alertsUpdated.toLocaleTimeString()}
            </Typography>
          )}
        </Box>

        <Typography variant="caption" color="textSecondary" style={{ display: "block", marginBottom: 12 }}>
          Live feed from NWS — same data the worker monitors. Refreshes every 60 seconds.
        </Typography>

        {alertsError && (
          <Typography color="error" variant="body2" style={{ marginBottom: 8 }}>
            {alertsError}
          </Typography>
        )}

        {!alertsLoading && alerts.length === 0 && !alertsError && (
          <Paper style={{ padding: "16px 20px", textAlign: "center", color: "#555" }}>
            <Typography variant="body2">✅ No active weather alerts for Kentucky right now.</Typography>
          </Paper>
        )}

        {alerts.length > 0 && (
          <Box style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {alerts.map((alert) => (
              <AlertCard key={alert.id || alert.properties?.id} alert={alert} theme={theme} />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
