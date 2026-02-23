import React, { useEffect, useState } from "react";
import { Box, Button, Card, CardContent, Grid, Paper, TextField, Typography } from "@material-ui/core";
import CategoryFeedPage from "./category-feed-page";
import SiteService from "../services/siteService";
import { GetValue, SaveValue } from "../services/storageService";

const service = new SiteService(process.env.REACT_APP_API_BASE_URL);
const WEATHER_ZIP_KEY = "weather_zip";

function getWeekday(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
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
              Current: {weather.current?.temperature_2m ?? "N/A"}°F, Wind {weather.current?.wind_speed_10m ?? "N/A"} mph
            </Typography>

            <Typography variant="subtitle2" style={{ marginTop: 8 }}>7-Day Forecast</Typography>
            {Array.isArray(weather?.daily?.time) && weather.daily.time.length > 0 ? (
              <Grid container spacing={1} style={{ marginTop: 4, marginBottom: 6 }}>
                {weather.daily.time.slice(0, 7).map((day, idx) => (
                  <Grid item xs={12} sm={6} md={4} lg={3} key={`${day}-${idx}`}>
                    <Card variant="outlined">
                      <CardContent style={{ padding: 10 }}>
                        <Typography variant="subtitle2">{getWeekday(day)}</Typography>
                        <Typography variant="body2" color="textSecondary">
                          High {weather.daily.temperature_2m_max?.[idx] ?? "N/A"}°F
                        </Typography>
                        <Typography variant="body2" color="textSecondary">
                          Low {weather.daily.temperature_2m_min?.[idx] ?? "N/A"}°F
                        </Typography>
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
                <Typography key={`${alert.title}-${index}`} variant="body2">
                  • {alert.title}{alert.severity ? ` (${alert.severity})` : ""}
                </Typography>
              ))
            ) : (
              <Typography variant="body2">No active alerts for this ZIP.</Typography>
            )}
          </Box>
        )}
      </Paper>

      <CategoryFeedPage category="weather" title="Kentucky Weather" />
    </>
  );
}
