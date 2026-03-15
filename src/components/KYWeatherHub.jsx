import React, { useState, useEffect, useCallback } from "react";
import { useTheme, fade } from "@material-ui/core/styles";
import { Typography, Grid, useMediaQuery } from "@material-ui/core";
import CategoryFeedPage from "../pages/category-feed-page";
import SiteService from "../services/siteService";

const KY_COUNTIES = [
  { name: "Eastern Kentucky (Jackson / Carroll Airport KJKL)", lat: 37.59, lon: -83.31 },
  { name: "Central Kentucky (Louisville / Bowman Field KLOU)", lat: 38.23, lon: -85.66 },
  { name: "Western Kentucky (Paducah / Barkley Regional KPAH)", lat: 37.06, lon: -88.77 },
];

const ALERT_COLORS = {
  "Tornado Warning": { bg: "#FF0000", text: "#fff", icon: "🌪️" },
  "Tornado Watch": { bg: "#FF6600", text: "#fff", icon: "🌪️" },
  "Flash Flood Warning": { bg: "#8B0000", text: "#fff", icon: "🌊" },
  "Flash Flood Watch": { bg: "#2E8B57", text: "#fff", icon: "🌊" },
  "Winter Storm Warning": { bg: "#FF69B4", text: "#fff", icon: "❄️" },
  "Winter Storm Watch": { bg: "#4169E1", text: "#fff", icon: "❄️" },
  "Severe Thunderstorm Warning": { bg: "#FFA500", text: "#000", icon: "⛈️" },
  "Flood Warning": { bg: "#00FF00", text: "#000", icon: "💧" },
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
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
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
  const [selectedCounty, setSelectedCounty] = useState(() => {
    try {
      const stored = localStorage.getItem("kyWeather.selectedCounty");
      if (stored) return JSON.parse(stored);
    } catch {
      // ignore
    }
    return KY_COUNTIES[0];
  });
  const [loading, setLoading] = useState(true);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [time, setTime] = useState(new Date());
  const [activeTab, setActiveTab] = useState("forecast");
  const [outlooks, setOutlooks] = useState([]);
  const [outlooksLoading, setOutlooksLoading] = useState(true);
  const [nwsOffices, setNwsOffices] = useState([]);
  const [nwsLoading, setNwsLoading] = useState(true);
  const [lightboxImg, setLightboxImg] = useState(null);

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!lightboxImg) return;
    const onKey = (e) => { if (e.key === "Escape") setLightboxImg(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxImg]);

  useEffect(() => {
    try {
      localStorage.setItem("kyWeather.selectedCounty", JSON.stringify(selectedCounty));
    } catch {
      // ignore
    }
  }, [selectedCounty]);

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
      const res = await fetch(`/api/weather?lat=${county.lat}&lon=${county.lon}`);
      const data = await res.json();
      setForecast(data.forecast || []);
      setCurrentObs(data.observation || null);
    } catch {
      setForecast([]);
      setCurrentObs(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAlerts(); }, [fetchAlerts]);
  useEffect(() => { fetchWeather(selectedCounty); }, [selectedCounty, fetchWeather]);

  useEffect(() => {
    const svc = new SiteService();
    svc.getSpcOutlooks().then((data) => {
      setOutlooks(data);
      setOutlooksLoading(false);
    }).catch(() => setOutlooksLoading(false));
  }, []);

  useEffect(() => {
    const svc = new SiteService();
    svc.getNwsStories().then((data) => {
      setNwsOffices(data);
      setNwsLoading(false);
    }).catch(() => setNwsLoading(false));
  }, []);

  const tempC = currentObs?.temperature?.value;
  const tempF = tempC != null ? Math.round(tempC * 9 / 5 + 32) : null;
  const windMs = currentObs?.windSpeed?.value;
  const windMph = windMs != null ? Math.round(windMs * 2.237) : null;
  const humidity = currentObs?.relativeHumidity?.value;
  const visM = currentObs?.visibility?.value;
  const visMi = visM != null ? (visM / 1609).toFixed(1) : null;
  const activeAlerts = alerts;

  return (
    <div style={{ fontFamily: "Georgia, serif", background: bgDefault, color: textColor }}>

      {/* Lightbox overlay */}
      {lightboxImg && (
        <div
          onClick={() => setLightboxImg(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Enlarged forecast image"
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.88)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "zoom-out", padding: 16,
          }}
        >
          <img
            src={lightboxImg.src}
            alt={lightboxImg.alt}
            style={{ maxWidth: "95vw", maxHeight: "90vh", objectFit: "contain", borderRadius: 8, boxShadow: "0 8px 40px rgba(0,0,0,0.8)" }}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setLightboxImg(null)}
            aria-label="Close"
            style={{
              position: "fixed", top: 16, right: 20,
              background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.4)",
              color: "#fff", borderRadius: "50%", width: 36, height: 36,
              fontSize: 20, lineHeight: "1", cursor: "pointer", display: "flex",
              alignItems: "center", justifyContent: "center",
            }}
          >×</button>
        </div>
      )}


      {/* page title above banner */}
      <Typography variant="h5" component="h1" gutterBottom align="left">
        Kentucky Weather
      </Typography>

      {/* Alert Banner */}
      {!alertsLoading && activeAlerts.length > 0 && (
        <div style={{ background: "linear-gradient(90deg,#7b0000,#c62828,#7b0000)", padding: "10px 20px", display: "flex", alignItems: "center", gap: 10, borderBottom: "2px solid #ef9a9a", borderRadius: 8 }}>
          <span style={{ fontSize: 18 }}>{"🚨"}</span>
          <div style={{ flex: 1 }}>
            <span style={{ fontWeight: "bold", fontSize: 12, color: textColor, letterSpacing: 1, textTransform: "uppercase" }}>
              {activeAlerts.length} ACTIVE ALERT{activeAlerts.length > 1 ? "S" : ""} FOR KENTUCKY: &nbsp;
            </span>
            <span style={{ fontSize: 12, color: theme.palette.text.secondary }}>
              {activeAlerts.slice(0, 3).map(a => a.properties?.event).join(" • ")}
              {activeAlerts.length > 3 && ` • +${activeAlerts.length - 3} more`}
            </span>
          </div>
          <button onClick={fetchAlerts} style={{ background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.3)", color: textColor, borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 11 }}>Refresh</button>
        </div>
      )}
      {!alertsLoading && activeAlerts.length === 0 && (
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
        <div className="weather-tabs" style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", alignItems: "center", padding: "10px 0", marginBottom: 16 }}>
          {[{ id: "forecast", label: "📅 7-Day Forecast" }, { id: "outlooks", label: "🌩️ SPC Outlooks" }, { id: "nws", label: "📡 NWS Briefings" }, { id: "alerts", label: `🚨 Alerts (${alerts.length})` }, { id: "radar", label: "🗺️ Live Radar" }].map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
              flex: isMobile ? "0 0 calc(33.333% - 12px)" : "initial",
              padding: "8px 16px", borderRadius: 999, cursor: "pointer", fontSize: 12,
              border: "1px solid #1e3a5f",
              background: activeTab === tab.id ? "rgba(100,181,246,0.18)" : "rgba(255,255,255,0.03)",
              color: activeTab === tab.id ? primary : "#607d8b",
              fontWeight: activeTab === tab.id ? "bold" : "normal",
              boxShadow: activeTab === tab.id ? `0 0 0 2px ${fade(primary, 0.25)}` : "none",
              minWidth: isMobile ? 110 : "auto",
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
                      {forecast.slice(0, 14).map((period, i) => (
                        <Grid item xs={12} sm={6} md={4} key={i}>
                          <div style={{ background: i === 0 ? primaryAlpha15 : "rgba(255,255,255,0.03)", border: `1px solid ${i === 0 ? primary : "#1e3a5f"}`, borderRadius: 12, padding: "12px 10px", textAlign: "center" }}>
                            <div style={{ fontSize: 13, color: theme.palette.text.secondary, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>{period.name}</div>
                            <div style={{ fontSize: 38, marginBottom: 6 }}>{getWeatherIcon(period.shortForecast)}</div>
                            <div style={{ fontSize: 25, fontWeight: "bold", color: textColor }}>{period.temperature}°{period.temperatureUnit}</div>
                            <div style={{ fontSize: 13, color: theme.palette.text.secondary, marginTop: 6, lineHeight: 1.3 }}>{period.detailedForecast}</div>
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
                      return (
                        <div key={i} style={{ background: `${s.bg}33`, border: `1px solid ${s.bg}`, borderLeft: `4px solid ${s.bg}`, borderRadius: 8, padding: "12px 14px" }}>
                          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                            <span style={{ fontSize: 18 }}>{s.icon}</span>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: "bold", color: "#000", fontSize: 13 }}>{props.event}</div>
                              <div style={{ fontSize: 11, color: "#222", margin: "4px 0" }}>{props.areaDesc?.split(";").slice(0, 4).join(" • ")}</div>
                              <div style={{ fontSize: 11, color: "#333" }}>Expires: {props.expires ? new Date(props.expires).toLocaleString() : "Unknown"}</div>
                            </div>
                            <span style={{ background: s.bg, color: s.text, padding: "2px 8px", borderRadius: 10, fontSize: 9, fontWeight: "bold", textTransform: "uppercase", whiteSpace: "nowrap" }}>{props.severity}</span>
                          </div>
                          {props.headline && <div style={{ fontSize: 11, color: "#222", marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(0,0,0,0.12)" }}>{props.headline}</div>}
                        </div>
                      );
                    })}
                  </div>
          )}

          {/* SPC Outlooks Tab */}
          {activeTab === "outlooks" && (
            outlooksLoading
              ? <div style={{ textAlign: "center", color: primary, padding: 40 }}>⏳ Loading SPC outlooks...</div>
              : outlooks.length === 0
                ? <div style={{ textAlign: "center", padding: 40, color: theme.palette.text.secondary }}>SPC outlook data is currently unavailable. Check back shortly.</div>
                : <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
                    <div style={{ fontSize: 12, color: theme.palette.text.secondary, marginBottom: 4 }}>
                      Storm Prediction Center convective outlooks for the United States, including Kentucky. Issued daily by NOAA/SPC.
                    </div>
                    {outlooks.map((outlook) => (
                      <div key={`${outlook.day}-${outlook.link}`} style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${divider}`, borderRadius: 14, overflow: "hidden" }}>
                        {/* Article header */}
                        <div style={{ padding: "14px 18px 10px", borderBottom: `1px solid ${divider}` }}>
                          <span style={{ display: "inline-block", background: "#1565c0", color: "#fff", fontSize: 10, fontWeight: "bold", letterSpacing: 1, textTransform: "uppercase", padding: "2px 9px", borderRadius: 10, marginBottom: 8 }}>
                            Day {outlook.day} Outlook
                          </span>
                          <div style={{ fontSize: 17, fontWeight: "bold", color: textColor, lineHeight: 1.3, fontFamily: "Georgia, serif" }}>
                            {outlook.title}
                          </div>
                          <div style={{ fontSize: 11, color: theme.palette.text.secondary, marginTop: 4 }}>
                            Storm Prediction Center · {new Date(outlook.publishedAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                          </div>
                        </div>
                        {/* Outlook map image */}
                        {outlook.imageUrl && (
                          <div style={{ background: "#fff", textAlign: "center" }}>
                            <img
                              src={outlook.imageUrl}
                              alt={`SPC Day ${outlook.day} Convective Outlook map`}
                              style={{ maxWidth: "100%", maxHeight: 340, objectFit: "contain", display: "block", margin: "0 auto", cursor: "zoom-in" }}
                              onClick={() => setLightboxImg({ src: outlook.imageUrl, alt: `SPC Day ${outlook.day} Convective Outlook map` })}
                              onError={(e) => { e.target.style.display = "none"; }}
                            />
                            <div style={{ fontSize: 11, color: "#aaa", padding: "4px 0 6px", fontStyle: "italic" }}>— click to enlarge</div>
                          </div>
                        )}
                        {/* Article body */}
                        <div style={{ padding: "14px 18px 18px" }}>
                          {(outlook.segments || []).map((seg, i) => {
                            if (seg.type === "callout") return (
                              <div key={i} style={{ background: "rgba(255,152,0,0.12)", border: "1px solid #e65100", borderLeft: "4px solid #e65100", borderRadius: 6, padding: "10px 14px", margin: "4px 0 14px", fontSize: 14, fontWeight: "bold", color: textColor, lineHeight: 1.5 }}>
                                ⚠️ {seg.text}
                              </div>
                            );
                            if (seg.type === "heading") return (
                              <div key={i} style={{ fontWeight: "bold", fontSize: 15, color: textColor, margin: "18px 0 4px", fontFamily: "Georgia, serif", borderBottom: `1px solid ${divider}`, paddingBottom: 4 }}>
                                {seg.text}
                              </div>
                            );
                            return <p key={i} style={{ margin: "0 0 12px", fontSize: 14, color: textColor, lineHeight: 1.7 }}>{seg.text}</p>;
                          })}
                          <a
                            href={outlook.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ display: "inline-block", marginTop: 4, fontSize: 12, color: primary, textDecoration: "none", border: `1px solid ${primary}`, borderRadius: 6, padding: "5px 14px" }}
                          >
                            Read Full Outlook on SPC →
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
          )}

          {/* NWS Briefings Tab */}
          {activeTab === "nws" && (() => {
            // Round to the nearest 15-minute window so the browser re-fetches
            // after each forecast update cycle without hammering NWS on every render.
            const imgTs = Math.floor(Date.now() / (15 * 60 * 1000));
            return nwsLoading
              ? <div style={{ textAlign: "center", color: primary, padding: 40 }}>⏳ Loading NWS briefings...</div>
              : nwsOffices.length === 0
                ? <div style={{ textAlign: "center", padding: 40, color: theme.palette.text.secondary }}>NWS briefing data is currently unavailable. Check back shortly.</div>
                : <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
                    <div style={{ fontSize: 12, color: theme.palette.text.secondary, marginBottom: 4 }}>
                      Weather briefings and forecast graphics directly from the National Weather Service offices serving Kentucky.
                    </div>
                    {nwsOffices.map((office) => (
                      <div key={office.officeId} style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${divider}`, borderRadius: 14, overflow: "hidden" }}>
                        {/* Office header */}
                        <div style={{ padding: "14px 18px 12px", borderBottom: `1px solid ${divider}`, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                          <span style={{ display: "inline-block", background: "#0d47a1", color: "#fff", fontSize: 10, fontWeight: "bold", letterSpacing: 1, textTransform: "uppercase", padding: "2px 9px", borderRadius: 10 }}>NWS</span>
                          <div style={{ fontSize: 17, fontWeight: "bold", color: textColor, fontFamily: "Georgia, serif" }}>{office.officeName}</div>
                          <div style={{ fontSize: 12, color: theme.palette.text.secondary }}>{office.officeArea}</div>
                        </div>

                        {/* Forecast graphics — scrollable row */}
                        {office.images && office.images.length > 0 && (
                          <div style={{ padding: "14px 18px", display: "flex", gap: 12, flexWrap: "wrap" }}>
                            {office.images.map((img, i) => (
                              <div key={i} style={{ flex: "1 1 220px", maxWidth: 440 }}>
                                <img
                                  src={`${img.url}?t=${imgTs}`}
                                  alt={img.alt}
                                  style={{ width: "100%", borderRadius: 8, border: `1px solid ${divider}`, display: "block", cursor: "zoom-in" }}
                                  onClick={() => setLightboxImg({ src: `${img.url}?t=${imgTs}`, alt: img.alt })}
                                  onError={(e) => { e.target.parentElement.style.display = "none"; }}
                                />
                                <div style={{ fontSize: 10, color: theme.palette.text.secondary, marginTop: 4, textAlign: "center" }}>{img.alt} <span style={{ opacity: 0.5 }}>— click to enlarge</span></div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Stories */}
                        {office.stories && office.stories.length > 0 && (
                          <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
                            {office.stories.map((story, i) => (
                              <div key={i} style={{ borderTop: `1px solid ${divider}`, paddingTop: 14 }}>
                                <div style={{ fontSize: 15, fontWeight: "bold", color: textColor, marginBottom: 4, fontFamily: "Georgia, serif" }}>
                                  {story.title}
                                </div>
                                <div style={{ fontSize: 11, color: theme.palette.text.secondary, marginBottom: 8 }}>
                                  {new Date(story.publishedAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}
                                </div>
                                {story.description && story.description.split("\n\n").slice(0, 4).map((para, j) => (
                                  <p key={j} style={{ margin: "0 0 10px", fontSize: 13, color: textColor, lineHeight: 1.7 }}>{para.replace(/\n/g, " ")}</p>
                                ))}
                                {story.link && (
                                  <a
                                    href={story.link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ display: "inline-block", fontSize: 12, color: primary, textDecoration: "none", border: `1px solid ${primary}`, borderRadius: 6, padding: "4px 12px" }}
                                  >
                                    Read full briefing on weather.gov →
                                  </a>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>;
          })()}

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