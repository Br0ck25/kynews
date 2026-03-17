import React from "react";
import {
  Box,
  Button,
  CircularProgress,
  Paper,
  TextField,
  Typography,
} from "@material-ui/core";

const OFFICES = [
  {
    id: "JKL",
    label: "Jackson KY",
    sublabel: "Eastern Kentucky",
    url: "https://api.weather.gov/gridpoints/JKL/65,58/forecast",
  },
  {
    id: "LMK",
    label: "Louisville KY",
    sublabel: "Central Kentucky",
    url: "https://api.weather.gov/gridpoints/LMK/48,72/forecast",
  },
  {
    id: "PAH",
    label: "Paducah KY",
    sublabel: "Western Kentucky",
    url: "https://api.weather.gov/gridpoints/PAH/70,60/forecast",
  },
];

const NWS_HEADERS = {
  "User-Agent": "LocalKYNews/1.0 (localkynews.com; news@localkynews.com)",
  Accept: "application/geo+json, application/json",
};

function tempColor(temp, unit) {
  const f = unit === "C" ? temp * 9 / 5 + 32 : temp;
  if (f >= 90) return "#e53935";
  if (f >= 75) return "#fb8c00";
  if (f >= 55) return "#43a047";
  if (f >= 32) return "#1e88e5";
  return "#8e24aa";
}

function fmtUpdated(dateStr) {
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

export default function WeatherForecastTab() {
  const [forecasts, setForecasts] = React.useState({});
  const [errors, setErrors] = React.useState({});
  const [loading, setLoading] = React.useState(false);
  const [activeOffice, setActiveOffice] = React.useState("JKL");

  // Forecast tab state
  const [forecastText, setForecastText] = React.useState("");
  const [editingForecast, setEditingForecast] = React.useState(false);
  const [editForecastText, setEditForecastText] = React.useState("");
  const [copiedForecast, setCopiedForecast] = React.useState(false);
  const [forecastError, setForecastError] = React.useState("");

  React.useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    setErrors({});
    const newForecasts = {};
    const newErrors = {};

    await Promise.all(
      OFFICES.map(async (office) => {
        try {
          const res = await fetch(office.url, { headers: NWS_HEADERS });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          newForecasts[office.id] = {
            periods: data.properties?.periods || [],
            updated: data.properties?.updated || null,
            generatedAt: data.properties?.generatedAt || null,
          };
        } catch (e) {
          newErrors[office.id] = e.message;
        }
      })
    );

    setForecasts(newForecasts);
    setErrors(newErrors);
    setLoading(false);
  }

  // ── Forecast text generator ───────────────────────────────────────────────

  function buildForecastText(fcs) {
    const allLoaded = OFFICES.every((o) => fcs[o.id]?.periods?.length > 0);
    if (!allLoaded) return null;

    const lines = [];

    // Work out the date range label from the first daytime period name
    const jklPeriods = fcs["JKL"].periods.slice(0, 6);
    const firstDay = jklPeriods.find((p) => p.isDaytime)?.name || "Coming Days";
    const days = jklPeriods.filter((p) => p.isDaytime).slice(0, 3).map((p) => p.name);
    const rangeLabel =
      days.length >= 2 ? `${days[0]} – ${days[days.length - 1]}` : firstDay;

    lines.push(`🌤️ 3-Day Forecast: ${rangeLabel}`);
    lines.push("");

    // Per-office section
    for (const office of OFFICES) {
      const periods = fcs[office.id].periods.slice(0, 6);
      lines.push(`${office.label} (${office.sublabel})`);
      for (const p of periods) {
        const precip =
          p.probabilityOfPrecipitation?.value != null &&
          p.probabilityOfPrecipitation.value > 0
            ? `, ${p.probabilityOfPrecipitation.value}% precip`
            : "";
        const tempLabel = p.isDaytime ? "high" : "low";
        lines.push(
          `${p.name}: ${p.shortForecast}, ${tempLabel} ${p.temperature}°${p.temperatureUnit}${precip}`
        );
      }
      lines.push("");
    }

    // Weather story bullets — scan all offices for notable conditions
    const allPeriods = OFFICES.flatMap((o) => fcs[o.id].periods.slice(0, 8));
    const bullets = [];
    const hasSnow = allPeriods.some((p) =>
      /snow/i.test(p.shortForecast)
    );
    const hasRain = allPeriods.some((p) =>
      /rain|shower/i.test(p.shortForecast)
    );
    const eastTemps = fcs["JKL"].periods.filter((p) => p.isDaytime).map((p) => p.temperature);
    const westTemps = fcs["PAH"].periods.filter((p) => p.isDaytime).map((p) => p.temperature);
    const maxEast = Math.max(...eastTemps);
    const maxWest = Math.max(...westTemps);
    const split = maxWest - maxEast >= 10;

    if (hasSnow) bullets.push("• Winter weather lingers with snow chances across parts of the state");
    if (hasRain) bullets.push("• Rain chances increase as the week progresses");
    if (split)
      bullets.push(
        `• Big temperature split across Kentucky (${maxEast}° east → ${maxWest}° west)`
      );
    // Check for warm-up: last daytime periods vs first
    const jklDays = fcs["JKL"].periods.filter((p) => p.isDaytime);
    if (jklDays.length >= 2 && jklDays[jklDays.length - 1].temperature > jklDays[0].temperature + 8) {
      bullets.push("• Gradual warm-up expected later in the forecast period");
    }
    if (bullets.length === 0) bullets.push("• Conditions vary across the Commonwealth — check your local forecast");

    lines.push("🧭 Kentucky Weather Story");
    lines.push("");
    lines.push(...bullets);
    lines.push("");
    lines.push(
      "#KYwx #KentuckyWeather #LocalForecast #KentuckyNews #WeatherAlert #KYWeatherUpdate"
    );

    return lines.join("\n");
  }

  function handleGenerateForecast() {
    setForecastError("");
    const text = buildForecastText(forecasts);
    if (!text) {
      setForecastError(
        "Forecast data not yet loaded for all offices. Click Refresh first."
      );
      return;
    }
    setForecastText(text);
    setEditingForecast(false);
  }

  async function handleCopyForecast() {
    try {
      await navigator.clipboard.writeText(forecastText);
      setCopiedForecast(true);
      setTimeout(() => setCopiedForecast(false), 2500);
    } catch {
      setForecastError("Copy failed — please select and copy manually.");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  const current = forecasts[activeOffice];
  const currentError = errors[activeOffice];

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
            Kentucky Weather Forecast
          </Typography>
          <Typography variant="body2" color="textSecondary">
            7-day NWS forecasts for Eastern, Central, and Western Kentucky grid
            points.
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

      {/* Office selector tabs — includes Forecast tab */}
      <Box style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {OFFICES.map((o) => (
          <Paper
            key={o.id}
            onClick={() => setActiveOffice(o.id)}
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
            {forecasts[o.id]?.updated && (
              <Typography
                variant="caption"
                color="textSecondary"
                display="block"
                style={{ marginTop: 2, fontSize: 10 }}
              >
                {fmtUpdated(forecasts[o.id].updated)}
              </Typography>
            )}
            {errors[o.id] && (
              <Typography
                variant="caption"
                color="error"
                display="block"
                style={{ marginTop: 2 }}
              >
                Error
              </Typography>
            )}
          </Paper>
        ))}

        {/* Forecast tab */}
        <Paper
          onClick={() => setActiveOffice("FORECAST")}
          style={{
            padding: "10px 20px",
            cursor: "pointer",
            borderBottom:
              activeOffice === "FORECAST"
                ? "3px solid #e65100"
                : "3px solid transparent",
            minWidth: 140,
            textAlign: "center",
            userSelect: "none",
            background: activeOffice === "FORECAST" ? "#fff3e0" : undefined,
          }}
        >
          <Typography
            variant="subtitle2"
            style={{ fontWeight: activeOffice === "FORECAST" ? 700 : 400, color: "#e65100" }}
          >
            📋 Forecast
          </Typography>
          <Typography variant="caption" color="textSecondary" display="block">
            3-Day Summary
          </Typography>
        </Paper>
      </Box>

      {/* ── FORECAST PANEL ─────────────────────────────────────────────── */}
      {activeOffice === "FORECAST" && (
        <Paper style={{ padding: 20 }}>
          {/* Action bar */}
          <Box
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 16,
            }}
          >
            <Typography variant="h6" style={{ fontWeight: 700 }}>
              3-Day Kentucky Forecast
            </Typography>
            <Box style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {forecastText && !editingForecast && (
                <>
                  <Button
                    variant="contained"
                    color="primary"
                    size="small"
                    onClick={handleCopyForecast}
                  >
                    {copiedForecast ? "✓ Copied!" : "Copy for Facebook"}
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => {
                      setEditForecastText(forecastText);
                      setEditingForecast(true);
                    }}
                  >
                    Edit
                  </Button>
                </>
              )}
              {editingForecast && (
                <>
                  <Button
                    variant="contained"
                    color="primary"
                    size="small"
                    onClick={() => {
                      setForecastText(editForecastText);
                      setEditingForecast(false);
                    }}
                  >
                    Save
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => setEditingForecast(false)}
                  >
                    Cancel
                  </Button>
                </>
              )}
              <Button
                variant="contained"
                size="small"
                style={{ background: "#e65100", color: "#fff" }}
                onClick={handleGenerateForecast}
              >
                Generate New
              </Button>
            </Box>
          </Box>

          {forecastError && (
            <Typography color="error" variant="body2" style={{ marginBottom: 12 }}>
              {forecastError}
            </Typography>
          )}

          {editingForecast ? (
            <TextField
              multiline
              fullWidth
              rows={24}
              variant="outlined"
              value={editForecastText}
              onChange={(e) => setEditForecastText(e.target.value)}
              inputProps={{
                style: { fontFamily: "monospace", fontSize: 13, lineHeight: 1.6 },
              }}
            />
          ) : forecastText ? (
            <Box
              component="pre"
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "monospace",
                fontSize: 13,
                lineHeight: 1.6,
                background: "#f5f5f5",
                border: "1px solid #e0e0e0",
                borderRadius: 4,
                padding: "12px 14px",
                margin: 0,
              }}
            >
              {forecastText}
            </Box>
          ) : (
            <Box style={{ textAlign: "center", padding: "40px 0" }}>
              <Typography color="textSecondary" variant="body2" style={{ marginBottom: 16 }}>
                Click <strong>Generate New</strong> to build a Facebook-ready 3-day forecast
                from the loaded NWS data for Jackson, Louisville, and Paducah.
              </Typography>
              <Button
                variant="contained"
                size="small"
                style={{ background: "#e65100", color: "#fff" }}
                onClick={handleGenerateForecast}
              >
                Generate New
              </Button>
            </Box>
          )}
        </Paper>
      )}

      {/* ── NWS OFFICE PANELS ──────────────────────────────────────────── */}
      {activeOffice !== "FORECAST" && (
        <>
          {/* Loading spinner on first load */}
          {loading && !current && (
            <Box style={{ display: "flex", justifyContent: "center", padding: 48 }}>
              <CircularProgress />
            </Box>
          )}

          {/* Error for selected office */}
          {!loading && currentError && (
            <Paper style={{ padding: 24, textAlign: "center" }}>
              <Typography variant="body2" color="error">
                Failed to load forecast for {activeOffice}: {currentError}
              </Typography>
            </Paper>
          )}

          {/* No periods */}
          {!loading && current && current.periods.length === 0 && (
            <Paper style={{ padding: 24, textAlign: "center" }}>
              <Typography variant="body2" color="textSecondary">
                No forecast periods available.
              </Typography>
            </Paper>
          )}

          {/* Forecast periods */}
          {current &&
            current.periods.map((period) => (
              <Paper
                key={period.number}
                style={{
                  padding: 16,
                  marginBottom: 8,
                  borderLeft: `4px solid ${period.isDaytime ? "#ff9800" : "#5c6bc0"}`,
                }}
              >
                <Box
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    gap: 8,
                    marginBottom: period.detailedForecast ? 8 : 0,
                  }}
                >
                  <Box>
                    <Typography variant="subtitle2" style={{ marginBottom: 2 }}>
                      {period.name}
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      {period.shortForecast}
                    </Typography>
                  </Box>
                  <Box style={{ textAlign: "right", flexShrink: 0 }}>
                    <Typography
                      variant="h5"
                      style={{
                        color: tempColor(period.temperature, period.temperatureUnit),
                        fontWeight: 700,
                        lineHeight: 1,
                      }}
                    >
                      {period.temperature}°{period.temperatureUnit}
                    </Typography>
                    {(period.windSpeed || period.windDirection) && (
                      <Typography
                        variant="caption"
                        color="textSecondary"
                        display="block"
                      >
                        {period.windSpeed} {period.windDirection}
                      </Typography>
                    )}
                    {period.probabilityOfPrecipitation?.value != null && (
                      <Typography
                        variant="caption"
                        color="textSecondary"
                        display="block"
                      >
                        Precip: {period.probabilityOfPrecipitation.value}%
                      </Typography>
                    )}
                  </Box>
                </Box>
                {period.detailedForecast && (
                  <Typography variant="body2" style={{ lineHeight: 1.6 }}>
                    {period.detailedForecast}
                  </Typography>
                )}
              </Paper>
            ))}
        </>
      )}
    </Box>
  );
}
