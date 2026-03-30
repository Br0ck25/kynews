import React from "react";
import {
  Box,
  Chip,
  CircularProgress,
  FormControlLabel,
  Paper,
  Switch,
  Typography,
} from "@material-ui/core";

const ROWS = [
  {
    key: "warnings",
    label: "Warning Auto-Post",
    description: "Tornado Warning, Flash Flood Warning, Winter Storm Warning, etc.",
  },
  {
    key: "watches",
    label: "Watch Auto-Post",
    description: "Tornado Watch, Flash Flood Watch, Winter Storm Watch, etc.",
  },
  {
    key: "others",
    label: "Other Alerts Auto-Post",
    description: "Advisories, Statements, Outlooks, and all other alert types.",
  },
];

export default function WeatherAlertAutopostSettings({ service }) {
  const [settings, setSettings] = React.useState({
    warnings: false,
    watches: false,
    others: false,
  });
  const [loading, setLoading] = React.useState(true);
  const [savingKey, setSavingKey] = React.useState(null);
  const [error, setError] = React.useState("");

  const enabledCount = Object.values(settings).filter(Boolean).length;

  const loadSettings = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await service.getWeatherAlertAutopostSettings();
      setSettings((prev) => ({
        ...prev,
        warnings: Boolean(res?.warnings),
        watches: Boolean(res?.watches),
        others: Boolean(res?.others),
      }));
    } catch (err) {
      setError(err?.errorMessage || err?.message || "Failed to load auto-post settings.");
    } finally {
      setLoading(false);
    }
  }, [service]);

  React.useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  async function handleToggle(key) {
    const nextValue = !settings[key];
    const previous = settings;
    setSavingKey(key);
    setError("");
    setSettings((prev) => ({ ...prev, [key]: nextValue }));
    try {
      const updated = await service.setWeatherAlertAutopostSettings({ [key]: nextValue });
      setSettings({
        warnings: Boolean(updated?.warnings),
        watches: Boolean(updated?.watches),
        others: Boolean(updated?.others),
      });
    } catch (err) {
      setSettings(previous);
      setError(err?.errorMessage || err?.message || "Failed to save auto-post setting.");
    } finally {
      setSavingKey(null);
    }
  }

  if (loading) {
    return (
      <Paper style={{ padding: 20 }}>
        <Box style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <CircularProgress size={22} />
          <Typography variant="body2" color="textSecondary">
            Loading weather alert auto-post settings...
          </Typography>
        </Box>
      </Paper>
    );
  }

  return (
    <Paper style={{ padding: 20 }}>
      <Box
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 14,
        }}
      >
        <Box>
          <Typography variant="h6" style={{ marginBottom: 4 }}>
            Weather Alert Auto-Post
          </Typography>
          <Typography variant="body2" color="textSecondary">
            Automatically posts new active Kentucky NWS alerts to the Local KY News Facebook page every 2 minutes.
            Manual posting from the Posts tab still works regardless of these switches.
          </Typography>
        </Box>
        <Chip
          label={enabledCount > 0 ? `${enabledCount} enabled` : "All disabled"}
          size="small"
          style={{
            background: enabledCount > 0 ? "#e8f5e9" : "#eeeeee",
            color: enabledCount > 0 ? "#1b5e20" : "#616161",
            fontWeight: 600,
          }}
        />
      </Box>

      {ROWS.map(({ key, label, description }) => (
        <Box
          key={key}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            padding: "14px 0",
            borderTop: "1px solid #ececec",
          }}
        >
          <Box style={{ flex: 1, minWidth: 220 }}>
            <Typography variant="subtitle2" style={{ fontWeight: 700, marginBottom: 4 }}>
              {label}
            </Typography>
            <Typography variant="body2" color="textSecondary">
              {description}
            </Typography>
          </Box>
          <Box style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 150, justifyContent: "flex-end" }}>
            {savingKey === key && <CircularProgress size={16} />}
            <FormControlLabel
              style={{ marginRight: 0 }}
              control={
                <Switch
                  checked={settings[key]}
                  onChange={() => handleToggle(key)}
                  color="primary"
                  disabled={savingKey !== null}
                />
              }
              label={
                <Typography
                  variant="caption"
                  style={{
                    color: settings[key] ? "#1b5e20" : "#b71c1c",
                    fontWeight: 700,
                    minWidth: 54,
                  }}
                >
                  {settings[key] ? "Enabled" : "Disabled"}
                </Typography>
              }
            />
          </Box>
        </Box>
      ))}

      {error && (
        <Box
          style={{
            marginTop: 14,
            padding: "10px 12px",
            background: "#fdecea",
            border: "1px solid #ef9a9a",
            borderRadius: 4,
          }}
        >
          <Typography variant="body2" color="error">
            {error}
          </Typography>
        </Box>
      )}
    </Paper>
  );
}
