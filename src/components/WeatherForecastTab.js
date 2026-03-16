import React from "react";
import {
  Box,
  Button,
  CircularProgress,
  Paper,
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

      {/* Office selector tabs */}
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
      </Box>

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
    </Box>
  );
}
