import React, { useState, useEffect, useCallback } from "react";
import { useTheme, fade } from "@material-ui/core/styles";
import { Typography, Grid } from "@material-ui/core";
import CategoryFeedPage from "../pages/category-feed-page";

const KY_COUNTIES = [
  { name: "Jefferson (Louisville)", lat: 38.2527, lon: -85.7585 },
  { name: "Fayette (Lexington)", lat: 38.0406, lon: -84.5037 },
  { name: "Warren (Bowling Green)", lat: 36.9685, lon: -86.4808 },
  { name: "McCracken (Paducah)", lat: 37.0834, lon: -88.6001 },
  { name: "Perry (Hazard)", lat: 37.2498, lon: -83.1932 },
  { name: "Pike (Pikeville)", lat: 37.4793, lon: -82.5185 },
  { name: "Boone (Florence)", lat: 38.9979, lon: -84.6266 },
  { name: "Madison (Richmond)", lat: 37.7479, lon: -84.2947 },
];

const ALERT_COLORS = {
  "Tornado Warning": { bg: "#FF0000", text: "#fff", icon: "🌪️" },
  "Tornado Watch": { bg: "#FF6600", text: "#fff", icon: "🌪️" },
  "Flash Flood Warning": { bg: "#8B0000", text: "#fff", icon: "🌊" },
  "Flash Flood Watch": { bg: "#2E8B57", text: "#fff", icon: "🌊" },
  "Winter Storm Warning": { bg: "#FF69B4", text: "#fff", icon: "❄️" },
  "Winter Storm Watch": { bg: "#4169E1", text: "#fff", icon: "❄️" },
  "Severe Thunderstorm Warning": { bg: "#FFA500", text: "#000", icon: "⛈️" },
  "Flood Warning": { bg: "#006400", text: "#fff", icon: "💧" },
  default: { bg: "#FFD700", text: "#000", icon: "⚠️" },
};

const WX_ICONS = {
  "sunny": "☀️", "clear": "🌙", "partly cloudy": "⛅",
  "mostly cloudy": "☁️", "cloudy": "☁️", "overcast": "☁️",
  "rain": "🌧️", "shower": "🌦️", "thunder": "⛈️",
  "snow": "❄️", "sleet": "🌨️", "fog": "🌫️", "wind": "💨",
};

function getWeatherIcon(text = "") {
  const t = text.toLowerCase();
  for (const [key, icon] of Object.entries(WX_ICONS)) {
    if (t.includes(key)) return icon;
  }
  return "🌤️";
}

function getAlertStyle(event = "") {
  return ALERT_COLORS[event] || ALERT_COLORS.default;
}

export default function KYWeatherHub() {
  const theme = useTheme();
  const bgDefault = theme.palette.background.default;
  const paperBg = theme.palette.background.paper;
  const textColor = theme.palette.text.primary;
  const divider = theme.palette.divider;
  // common colors pulled from theme so we can stay in sync
  const primary = theme.palette.primary.main;
  const primaryLight = theme.palette.primary.light;
  const primaryAlpha15 = fade(primary, 0.15);
  const successLight = theme.palette.success.light;

  const [alerts, setAlerts] = useState([]);
  const [forecast, setForecast] = useState(null);
  const [currentObs, setCurrentObs] = useState(null);
  const [selectedCounty, setSelectedCounty] = useState(KY_COUNTIES[0]);
  const [loading, setLoading] = useState(true);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [time, setTime] = useState(new Date());
  const [activeTab, setActiveTab] = useState("forecast");

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const fetchAlerts = useCallback(async () => {
    setAlertsLoading(true);
    try {
      const res = await fetch("https://api.weather.gov/alerts/active?area=KY");
      const data = await res.json();
      setAlerts(data.features || []);
    } catch { setAlerts([]); }
    setAlertsLoading(false);
  }, []);

  const fetchWeather = useCallback(async (county) => {
    setLoading(true);
    setForecast(null);
    setCurrentObs(null);
    try {
      const pointRes = await fetch(`https://api.weather.gov/points/${county.lat},${county.lon}`);
      const pointData = await pointRes.json();
      const { forecast: fUrl, observationStations } = pointData.properties;
      const [fRes, sRes] = await Promise.all([fetch(fUrl), fetch(observationStations)]);
      const fData = await fRes.json();
      const sData = await sRes.json();
      setForecast(fData.properties?.periods || []);
      if (sData.features?.length) {
        const sid = sData.features[0].properties.stationIdentifier;
        const oRes = await fetch(`https://api.weather.gov/stations/${sid}/observations/latest`);
        const oData = await oRes.json();
        setCurrentObs(oData.properties);
      }
    } catch { setForecast([]); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAlerts(); }, [fetchAlerts]);
  useEffect(() => { fetchWeather(selectedCounty); }, [selectedCounty, fetchWeather]);

  const tempC = currentObs?.temperature?.value;
  const tempF = tempC != null ? Math.round(tempC * 9 / 5 + 32) : null;
  const windMs = currentObs?.windSpeed?.value;
  const windMph = windMs != null ? Math.round(windMs * 2.237) : null;
  const humidity = currentObs?.relativeHumidity?.value;
  const visM = currentObs?.visibility?.value;
  const visMi = visM != null ? (visM / 1609).toFixed(1) : null;
  const activeWarnings = alerts.filter(a => a.properties?.event?.match(/Warning|Watch/));

  return (
    <div style={{ fontFamily: "Georgia, serif", background: bgDefault, color: textColor }}>


      {/* page title above banner */}
      <Typography variant="h5" component="h1" gutterBottom align="left">
        Kentucky Weather
      </Typography>

      {/* Alert Banner */}
      {!alertsLoading && activeWarnings.length > 0 && (
        <div style={{ background: "linear-gradient(90deg,#7b0000,#c62828,#7b0000)", padding: "10px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: "2px solid #ef9a9a", borderRadius: 8 }}>
          <span style={{ fontSize: 18 }}>{"🚨"}</span>
          <div style={{ flex: 1 }}>
            <span style={{ fontWeight: "bold", fontSize: 12, color: textColor, letterSpacing: 1, textTransform: "uppercase" }}>
              {activeWarnings.length} ACTIVE ALERT{activeWarnings.length > 1 ? "S" : ""} FOR KENTUCKY: &nbsp;
            </span>
            <span style={{ fontSize: 12, color: theme.palette.text.secondary }}>
              {activeWarnings.slice(0, 3).map(a => a.properties?.event).join(" • ")}
              {activeWarnings.length > 3 && ` • +${activeWarnings.length - 3} more`}
            </span>
          </div>
          <button onClick={fetchAlerts} style={{ background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.3)", color: textColor, borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 11 }}>Refresh</button>
        </div>
      )}
      {!alertsLoading && activeWarnings.length === 0 && (
        <div style={{ background: "linear-gradient(90deg,#1a3a1a,#2e7d32,#1a3a1a)", padding: "8px 20px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #4caf50" }}>
          <span>{"✅"}</span>
          <span style={{ fontSize: 12, color: successLight }}>No active weather alerts for Kentucky</span>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "#81c784" }}>Updated: {time.toLocaleTimeString()}</span>
        </div>
      )}

      <div style={{ maxWidth: 1200, width: "100%", margin: "0 auto", padding: "18px 1px" }}>

        {/* County Selector */}
        <div style={{ background: paperBg, border: `1px solid ${divider}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: primary, textTransform: "uppercase", letterSpacing: 2, marginBottom: 10, fontWeight: "bold" }}>{"📍 Select Your Area"}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {KY_COUNTIES.map(c => (
              <button key={c.name} onClick={() => setSelectedCounty(c)} style={{
                padding: "6px 14px", borderRadius: 20, cursor: "pointer", fontSize: 12,
                border: selectedCounty.name === c.name ? `2px solid ${theme.palette.primary.main}` : "1px solid #2a4a6f",
                background: selectedCounty.name === c.name ? theme.palette.action.hover : "rgba(255,255,255,0.04)",
                color: selectedCounty.name === c.name ? theme.palette.primary.main : theme.palette.text.secondary,
                fontWeight: selectedCounty.name === c.name ? "bold" : "normal",
              }}>{c.name.split(" ")[0]}</button>
            ))}
          </div>
        </div>

        {/* Current Conditions */}
        <div className="current-conditions" style={{ background: paperBg, border: `1px solid ${divider}`, borderRadius: 16, padding: "20px 24px", marginBottom: 16, display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
          {loading ? (
            <div style={{ color: primary, fontSize: 15 }}>{"⏳ Loading conditions for "}{selectedCounty.name}...</div>
          ) : (
            <>
              <div style={{ fontSize: 64, lineHeight: 1 }}>{forecast?.[0] ? getWeatherIcon(forecast[0].shortForecast) : "🌤️"}</div>
              <div style={{ flex: "1 1 180px" }}>
                <div style={{ fontSize: 11, color: primary, textTransform: "uppercase", letterSpacing: 2, marginBottom: 4 }}>Current — {selectedCounty.name}</div>
                <div style={{ fontSize: 48, fontWeight: "bold", color: textColor, lineHeight: 1 }}>{tempF != null ? `${tempF}°F` : "—"}</div>
                <div style={{ fontSize: 14, color: theme.palette.text.secondary, marginTop: 4 }}>{currentObs?.textDescription || forecast?.[0]?.shortForecast || "—"}</div>
              </div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {[
                  { label: "Humidity", value: humidity != null ? `${Math.round(humidity)}%` : "—", icon: "💧" },
                  { label: "Wind", value: windMph != null ? `${windMph} mph` : "—", icon: "💨" },
                  { label: "Visibility", value: visMi != null ? `${visMi} mi` : "—", icon: "👁️" },
                ].map(item => (
                  <div key={item.label} style={{ background: "rgba(100,181,246,0.08)", border: "1px solid #1e3a5f", borderRadius: 10, padding: "10px 14px", textAlign: "center", minWidth: 75 }}>
                    <div style={{ fontSize: 16 }}>{item.icon}</div>
                    <div style={{ fontSize: 16, fontWeight: "bold", color: textColor }}>{item.value}</div>
                    <div style={{ fontSize: 9, color: "#78909c", textTransform: "uppercase", letterSpacing: 1 }}>{item.label}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Tabs */}
        <div className="weather-tabs" style={{ display: "flex", gap: 4, marginBottom: 0 }}>
          {[{ id: "forecast", label: "📅 7-Day Forecast" }, { id: "alerts", label: `🚨 Alerts (${alerts.length})` }, { id: "radar", label: "🗺️ Live Radar" }].map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
              padding: "9px 16px", borderRadius: "8px 8px 0 0", cursor: "pointer", fontSize: 12,
              border: "1px solid #1e3a5f",
              borderBottom: activeTab === tab.id ? "1px solid rgba(13,27,60,0.9)" : "1px solid #1e3a5f",
              background: activeTab === tab.id ? "rgba(100,181,246,0.15)" : "rgba(255,255,255,0.03)",
              color: activeTab === tab.id ? primary : "#607d8b",
              fontWeight: activeTab === tab.id ? "bold" : "normal",
            }}>{tab.label}</button>
          ))}
        </div>

        <div style={{ background: paperBg, border: `1px solid ${divider}`, borderRadius: 12, padding: 18, marginBottom: 16 }}>

          {/* Forecast Tab */}
          {activeTab === "forecast" && (
            loading
              ? <div style={{ textAlign: "center", color: primary, padding: 40 }}>{"⏳ Fetching forecast from National Weather Service..."}</div>
              : forecast?.length
                ? (
                    <Grid container spacing={2}>
                      {forecast.filter((_, i) => i % 2 === 0).slice(0, 7).map((period, i) => (
                        <Grid item xs={12} sm={6} md={4} key={i}>
                          <div style={{ background: i === 0 ? primaryAlpha15 : "rgba(255,255,255,0.03)", border: `1px solid ${i === 0 ? primary : "#1e3a5f"}`, borderRadius: 12, padding: "12px 10px", textAlign: "center" }}>
                            <div style={{ fontSize: 10, color: theme.palette.text.secondary, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>{i === 0 ? "TODAY" : period.name}</div>
                            <div style={{ fontSize: 30, marginBottom: 6 }}>{getWeatherIcon(period.shortForecast)}</div>
                            <div style={{ fontSize: 20, fontWeight: "bold", color: textColor }}>{period.temperature}°{period.temperatureUnit}</div>
                            <div style={{ fontSize: 10, color: theme.palette.text.secondary, marginTop: 6, lineHeight: 1.3 }}>{period.shortForecast}</div>
                          </div>
                        </Grid>
                      ))}
                    </Grid>
                  )
                : <div style={{ textAlign: "center", color: "#ef5350", padding: 40 }}>Unable to load forecast. NWS API may be temporarily unavailable.</div>
          )}

          {/* Alerts Tab */}
          {activeTab === "alerts" && (
            alertsLoading
              ? <div style={{ textAlign: "center", color: primary, padding: 40 }}>{"⏳ Loading Kentucky alerts..."}</div>
              : alerts.length === 0
                ? <div style={{ textAlign: "center", padding: 40 }}>
                    <div style={{ fontSize: 44, marginBottom: 10 }}>{"✅"}</div>
                    <div style={{ color: theme.palette.text.secondary, fontSize: 16 }}>No active weather alerts for Kentucky</div>
                  </div>
                : <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {alerts.map((alert, i) => {
                      const props = alert.properties;
                      const s = getAlertStyle(props.event);
                      // increase font size for flood warnings
                      const eventFontSize = props.event === "Flood Warning" ? 15 : 13;
                      return (
                        <div key={i} style={{ background: `${s.bg}18`, border: `1px solid ${s.bg}`, borderLeft: `4px solid ${s.bg}`, borderRadius: 8, padding: "12px 14px" }}>
                          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                            <span style={{ fontSize: 18 }}>{s.icon}</span>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: "bold", color: s.text, fontSize: eventFontSize }}>{props.event}</div>
                              <div style={{ fontSize: 11, color: "#b0bec5", margin: "4px 0" }}>{props.areaDesc?.split(";").slice(0, 4).join(" • ")}</div>
                              <div style={{ fontSize: 11, color: theme.palette.text.secondary }}>Expires: {props.expires ? new Date(props.expires).toLocaleString() : "Unknown"}</div>
                            </div>
                            <span style={{ background: s.bg, color: s.text, padding: "2px 8px", borderRadius: 10, fontSize: 9, fontWeight: "bold", textTransform: "uppercase", whiteSpace: "nowrap" }}>{props.severity}</span>
                          </div>
                          {props.headline && <div style={{ fontSize: 11, color: "#cfd8dc", marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.1)" }}>{props.headline}</div>}
                        </div>
                      );
                    })}
                  </div>
          )}

          {/* Radar Tab */}
          {activeTab === "radar" && (
            <div>
              <div style={{ fontSize: 12, color: theme.palette.text.secondary, marginBottom: 10 }}>Live Kentucky radar via Windy.com — centered on the Commonwealth</div>
              <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid #1e3a5f" }}>
                <iframe
                  title="KY Radar"
                  width="100%"
                  height="420"
                  src="https://embed.windy.com/embed2.html?lat=37.8&lon=-85.7&zoom=7&level=surface&overlay=rain&product=ecmwf&metricWind=mph&metricTemp=%C2%B0F"
                  frameBorder="0"
                  style={{ display: "block" }}
                />
              </div>
            </div>
          )}
        </div>

        </div>

      {/* article feed */}
      <CategoryFeedPage
        category="weather"
        title=""
        hidePageMessages={true}
        filterPosts={(post) => post.category === "weather" || (post.tags && post.tags.includes("weather"))}
      />

      <style>{`
button:hover { opacity: 0.8; }
* { box-sizing: border-box; }
@media (max-width:600px) {
  .weather-tabs { justify-content: center; }
  .current-conditions { flex-direction: column; align-items: center; text-align: center; }
}
`}</style>
    </div>
  );
}