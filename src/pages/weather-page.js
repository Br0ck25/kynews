import React, { useEffect, useState } from "react";
import { Box, Button, Card, CardContent, Grid, Paper, TextField, Typography } from "@material-ui/core";
import CategoryFeedPage from "./category-feed-page";
import SiteService from "../services/siteService";
import { GetValue, SaveValue } from "../services/storageService";

// WMO Weather interpretation codes → human-readable condition + emoji
function getWeatherCondition(code) {
  if (code === 0) return { label: "Clear Sky", emoji: "☀️" };
  if (code === 1) return { label: "Mainly Clear", emoji: "🌤️" };
  if (code === 2) return { label: "Partly Cloudy", emoji: "⛅" };
  if (code === 3) return { label: "Overcast", emoji: "☁️" };
  if (code === 45 || code === 48) return { label: "Foggy", emoji: "🌫️" };
  if (code >= 51 && code <= 55) return { label: "Drizzle", emoji: "🌦️" };
  if (code >= 56 && code <= 57) return { label: "Freezing Drizzle", emoji: "🌧️" };
  if (code >= 61 && code <= 65) return { label: "Rain", emoji: "🌧️" };
  if (code >= 66 && code <= 67) return { label: "Freezing Rain", emoji: "🌨️" };
  if (code >= 71 && code <= 77) return { label: "Snow", emoji: "❄️" };
  if (code >= 80 && code <= 82) return { label: "Rain Showers", emoji: "🌧️" };
  if (code >= 85 && code <= 86) return { label: "Snow Showers", emoji: "🌨️" };
  if (code === 95) return { label: "Thunderstorm", emoji: "⛈️" };
  if (code >= 96) return { label: "Thunderstorm + Hail", emoji: "⛈️" };
  return { label: "Mixed", emoji: "🌡️" };
}

const service = new SiteService();
const WEATHER_ZIP_KEY = "weather_zip";

function getWeekday(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatDateTime(dateString) {
  if (!dateString) return "N/A";
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleString();
}

export default function WeatherPage() {
  const [zip, setZip] = useState(GetValue(WEATHER_ZIP_KEY) || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [weather, setWeather] = useState(null);

  const fetchWeather = async (targetZip) => {
    if (!targetZip) return;
    setLoading(true);
    setError("");
    try {
      const data = await service.getWeatherByZip(targetZip);
      setWeather(data);
      SaveValue(WEATHER_ZIP_KEY, targetZip);
    } catch (err) {
      setError(err?.errorMessage || "Unable to load weather for this ZIP code.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (zip) {
      fetchWeather(zip);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <Paper style={{ padding: 16, marginBottom: 16 }}>
        <Typography variant="h6" gutterBottom>Kentucky Weather by ZIP</Typography>
        <Box style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <TextField
            variant="outlined"
            size="small"
            label="ZIP Code"
            value={zip}
            onChange={(e) => setZip(e.target.value.replace(/[^0-9]/g, "").slice(0, 5))}
          />
          <Button variant="contained" color="primary" onClick={() => fetchWeather(zip)} disabled={loading}>
            {loading ? "Loading..." : "Get Weather"}
          </Button>
        </Box>

        {error && (
          <Typography color="error" variant="body2" style={{ marginTop: 10 }}>
            {error}
          </Typography>
        )}

        {weather && (
          <Box style={{ marginTop: 14 }}>
            <Typography variant="body1" gutterBottom>
              {weather.city}, {weather.state} ({weather.zip})
            </Typography>
            <Typography variant="body2" gutterBottom>
              {weather.current?.weather_code != null
                ? (() => { const c = getWeatherCondition(weather.current.weather_code); return `${c.emoji} ${c.label} · `; })()
                : ""}
              {weather.current?.temperature_2m ?? "N/A"}°F · Wind {weather.current?.wind_speed_10m ?? "N/A"} mph
            </Typography>

            <Typography variant="subtitle2" style={{ marginTop: 8 }}>7-Day Forecast</Typography>
            {Array.isArray(weather?.daily?.time) && weather.daily.time.length > 0 ? (
              <Grid container spacing={1} style={{ marginTop: 4, marginBottom: 6 }}>
                {weather.daily.time.slice(0, 7).map((day, idx) => (
                  <Grid item xs={12} sm={6} md={4} lg={3} key={`${day}-${idx}`}>
                    <Card variant="outlined">
                      <CardContent style={{ padding: 10 }}>
                        <Typography variant="subtitle2">{getWeekday(day)}</Typography>
                        {weather.daily.weather_code?.[idx] != null && (() => {
                          const cond = getWeatherCondition(weather.daily.weather_code[idx]);
                          return (
                            <Typography variant="body2" style={{ fontWeight: 500 }}>
                              {cond.emoji} {cond.label}
                            </Typography>
                          );
                        })()}
                        <Typography variant="body2" color="textSecondary">
                          High {weather.daily.temperature_2m_max?.[idx] ?? "N/A"}°F · Low {weather.daily.temperature_2m_min?.[idx] ?? "N/A"}°F
                        </Typography>
                        {weather.daily.precipitation_probability_max?.[idx] != null && (
                          <Typography variant="body2" color="textSecondary">
                            💧 {weather.daily.precipitation_probability_max[idx]}% chance of precip
                          </Typography>
                        )}
                        {weather.daily.precipitation_sum?.[idx] != null && weather.daily.precipitation_sum[idx] > 0 && (
                          <Typography variant="body2" color="textSecondary">
                            🌂 {weather.daily.precipitation_sum[idx].toFixed(2)}" total
                          </Typography>
                        )}
                      </CardContent>
                    </Card>
                  </Grid>
                ))}
              </Grid>
            ) : (
              <Typography variant="body2">7-day forecast unavailable.</Typography>
            )}

            <Typography variant="subtitle2">Alerts</Typography>
            {weather.alerts?.length > 0 ? (
              weather.alerts.map((alert, index) => (
                <Card key={`${alert.title}-${index}`} variant="outlined" style={{ marginTop: 8 }}>
                  <CardContent style={{ padding: 12 }}>
                    <Typography variant="subtitle2" gutterBottom>
                      {alert.title}
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Event: {alert.event || "N/A"}
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Severity: {alert.severity || "N/A"} • Urgency: {alert.urgency || "N/A"} • Certainty: {alert.certainty || "N/A"}
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Areas: {alert.areaDesc || "N/A"}
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Sent: {formatDateTime(alert.sent)}
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Effective: {formatDateTime(alert.effective)}
                    </Typography>
                    <Typography variant="body2" color="textSecondary" gutterBottom>
                      Expires: {formatDateTime(alert.expires)}
                    </Typography>
                    {!!alert.description && (
                      <Typography variant="body2" style={{ whiteSpace: "pre-line", marginBottom: 6 }}>
                        {alert.description}
                      </Typography>
                    )}
                    {!!alert.instruction && (
                      <Typography variant="body2" style={{ whiteSpace: "pre-line", marginBottom: 6 }}>
                        <strong>Instructions:</strong> {alert.instruction}
                      </Typography>
                    )}
                    {!!alert.senderName && (
                      <Typography variant="caption" display="block" color="textSecondary">
                        Issued by: {alert.senderName}
                      </Typography>
                    )}
                    {!!alert.web && (
                      <Button
                        size="small"
                        color="primary"
                        href={alert.web}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ marginTop: 8 }}
                      >
                        Alert details
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))
            ) : (
              <Typography variant="body2">No active alerts for this ZIP.</Typography>
            )}
          </Box>
        )}
      </Paper>

      <CategoryFeedPage
        category="weather"
        title="Kentucky Weather"
        filterPosts={(post) => {
          // Only show articles that contain genuine weather-related terms in title or summary.
          // This filters out any articles that were mis-classified as weather during ingest.
          const text = `${post.title || ""} ${post.shortDesc || ""}`.toLowerCase();
          return /weather|storm|tornado|flood|snow|rain|ice\s|wind|temperature|forecast|freez|cold snap|heat wave|thunder|lightning|blizzard|hail|drought|hurricane|tropical storm|winter advisory|winter watch|severe|nws\b|national weather/i.test(text);
        }}
      />
    </>
  );
}
