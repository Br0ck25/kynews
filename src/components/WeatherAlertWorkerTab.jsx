import React, { useState, useEffect } from "react";
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
import SiteService from "../services/siteService";

const service = new SiteService();

export default function WeatherAlertWorkerTab() {
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
    </Box>
  );
}
