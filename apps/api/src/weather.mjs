import { z } from "zod";
import { ensureSchema } from "./schema.mjs";
import { normalizeCounty, safeJsonParse } from "./search.mjs";

const WEATHER_STATES = ["KY"];
const NWS_USER_AGENT = process.env.NWS_USER_AGENT || "EasternKentuckyNews/1.0 (local-dev@example.com)";
let kyZoneCache = { loadedAt: 0, zones: new Map() };

async function nwsFetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/geo+json",
      "User-Agent": NWS_USER_AGENT
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`NWS request failed (${res.status}): ${body.slice(0, 240)}`);
  }

  return res.json();
}

async function getKyCountyZoneMap() {
  const now = Date.now();
  if (now - kyZoneCache.loadedAt < 6 * 60 * 60 * 1000 && kyZoneCache.zones.size) {
    return kyZoneCache.zones;
  }

  const zones = new Map();
  let nextUrl = "https://api.weather.gov/zones?type=county&area=KY";
  let guard = 0;

  while (nextUrl && guard < 10) {
    guard += 1;
    const payload = await nwsFetchJson(nextUrl);
    const features = Array.isArray(payload?.features) ? payload.features : [];

    for (const feature of features) {
      const props = feature?.properties || {};
      const zoneId = props.id;
      const zoneName = normalizeCounty(props.name || "");
      if (!zoneId || !zoneName) continue;
      zones.set(zoneName.toLowerCase(), zoneId);
    }

    nextUrl = payload?.pagination?.next || null;
  }

  kyZoneCache = { loadedAt: now, zones };
  return zones;
}

async function fetchCountyForecast(county) {
  const countyKey = normalizeCounty(county).toLowerCase();
  if (!countyKey) throw new Error("County is required");

  const zones = await getKyCountyZoneMap();
  const countyZoneId = zones.get(countyKey);
  if (!countyZoneId) throw new Error(`No NWS county zone found for ${county}`);

  const countyZone = await nwsFetchJson(`https://api.weather.gov/zones/county/${countyZoneId}`);
  const geometry = countyZone?.geometry;
  const centroid = getGeometryCentroid(geometry);
  if (!centroid) throw new Error(`No geometry centroid for county zone ${countyZoneId}`);

  const points = await nwsFetchJson(
    `https://api.weather.gov/points/${centroid.lat.toFixed(4)},${centroid.lon.toFixed(4)}`
  );
  const forecastUrl = String(points?.properties?.forecast || "");
  if (!forecastUrl) throw new Error(`No forecast URL returned for county zone ${countyZoneId}`);

  const forecastZoneUri = String(points?.properties?.forecastZone || "");
  const forecastZoneId = forecastZoneUri.split("/").filter(Boolean).pop() || countyZoneId;
  const payload = await nwsFetchJson(forecastUrl);
  const props = payload?.properties || {};
  const periodsRaw = Array.isArray(props.periods) ? props.periods : [];

  const periods = periodsRaw.slice(0, 14).map((p) => ({
    name: p.name,
    startTime: p.startTime,
    endTime: p.endTime,
    temperature: p.temperature,
    temperatureUnit: p.temperatureUnit,
    windSpeed: p.windSpeed,
    windDirection: p.windDirection,
    shortForecast: p.shortForecast,
    detailedForecast: p.detailedForecast,
    icon: p.icon
  }));

  return {
    state: "KY",
    county: normalizeCounty(county),
    zoneId: forecastZoneId,
    countyZoneId,
    updatedAt: props.updated || new Date().toISOString(),
    periods,
    source: "api.weather.gov"
  };
}

function getGeometryCentroid(geometry) {
  const points = [];

  if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) return null;

  if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates) {
      for (const pair of ring) points.push(pair);
    }
  }

  if (geometry.type === "MultiPolygon") {
    for (const polygon of geometry.coordinates) {
      for (const ring of polygon) {
        for (const pair of ring) points.push(pair);
      }
    }
  }

  const valid = points.filter((pair) => Array.isArray(pair) && pair.length >= 2);
  if (!valid.length) return null;

  let lon = 0;
  let lat = 0;
  for (const pair of valid) {
    lon += Number(pair[0]);
    lat += Number(pair[1]);
  }

  return { lon: lon / valid.length, lat: lat / valid.length };
}

async function fetchCountyAlerts(stateCode, county) {
  const payload = await nwsFetchJson(`https://api.weather.gov/alerts/active?area=${encodeURIComponent(stateCode)}`);
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const countyFilter = county ? normalizeCounty(county).toLowerCase() : null;

  const alerts = [];
  for (const feature of features) {
    const props = feature?.properties || {};
    const areaDesc = String(props.areaDesc || "").toLowerCase();
    if (countyFilter && !areaDesc.includes(countyFilter)) continue;

    alerts.push({
      id: String(feature.id || props.id || ""),
      event: props.event || "Unknown",
      severity: props.severity || "Unknown",
      headline: props.headline || props.event || "Alert",
      description: props.description || "",
      instruction: props.instruction || "",
      starts_at: props.onset || props.effective || null,
      ends_at: props.ends || props.expires || null,
      sent_at: props.sent || null,
      status: props.status || null,
      url: props.url || null,
      area_desc: props.areaDesc || ""
    });
  }

  return alerts;
}

export function registerWeatherRoutes(app, openDb) {
  const WeatherForecastQuery = z.object({
    state: z.string().length(2).default("KY"),
    county: z.string().min(2).max(80)
  });

  app.get("/api/weather/forecast", async (req) => {
    const parsed = WeatherForecastQuery.safeParse(req.query ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

    const { state, county } = parsed.data;
    if (!WEATHER_STATES.includes(state.toUpperCase())) {
      return app.httpErrors.badRequest("Weather forecast currently supports KY only");
    }

    const normalizedCounty = normalizeCounty(county);
    const db = openDb();

    try {
      ensureSchema(db);

      const cached = db
        .prepare(
          `
          SELECT forecast_json, fetched_at, expires_at
          FROM weather_forecasts
          WHERE state_code=@stateCode AND county=@county
          ORDER BY fetched_at DESC
          LIMIT 1
        `
        )
        .get({ stateCode: "KY", county: normalizedCounty });

      const nowIso = new Date().toISOString();
      if (cached && cached.expires_at > nowIso) {
        return {
          ...safeJsonParse(cached.forecast_json, {}),
          fetchedAt: cached.fetched_at,
          expiresAt: cached.expires_at,
          cached: true
        };
      }

      const live = await fetchCountyForecast(normalizedCounty);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      db.prepare(
        "INSERT INTO weather_forecasts (state_code, county, forecast_json, expires_at) VALUES (?, ?, ?, ?)"
      ).run("KY", normalizedCounty, JSON.stringify(live), expiresAt);

      db.prepare("DELETE FROM weather_forecasts WHERE fetched_at < datetime('now', '-7 days')").run();

      return {
        ...live,
        fetchedAt: new Date().toISOString(),
        expiresAt,
        cached: false
      };
    } catch (err) {
      const fallback = db
        .prepare(
          `
          SELECT forecast_json, fetched_at, expires_at
          FROM weather_forecasts
          WHERE state_code=@stateCode AND county=@county
          ORDER BY fetched_at DESC
          LIMIT 1
        `
        )
        .get({ stateCode: "KY", county: normalizedCounty });

      if (fallback) {
        return {
          ...safeJsonParse(fallback.forecast_json, {}),
          fetchedAt: fallback.fetched_at,
          expiresAt: fallback.expires_at,
          cached: true,
          stale: true,
          warning: String(err?.message || err)
        };
      }

      throw app.httpErrors.badGateway(String(err?.message || err));
    } finally {
      db.close();
    }
  });

  const WeatherAlertsQuery = z.object({
    state: z.string().length(2).default("KY"),
    county: z.string().min(2).max(80).optional()
  });

  app.get("/api/weather/alerts", async (req) => {
    const parsed = WeatherAlertsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return app.httpErrors.badRequest("Invalid query");

    const { state, county } = parsed.data;
    const stateCode = state.toUpperCase();
    const normalizedCounty = county ? normalizeCounty(county) : "";

    if (!WEATHER_STATES.includes(stateCode)) {
      return app.httpErrors.badRequest("Weather alerts currently support KY only");
    }

    const db = openDb();
    try {
      ensureSchema(db);

      const liveAlerts = await fetchCountyAlerts(stateCode, normalizedCounty || null);

      db.prepare("DELETE FROM weather_alerts WHERE state_code=@stateCode AND county=@county").run({
        stateCode,
        county: normalizedCounty
      });

      const insert = db.prepare(
        `
        INSERT INTO weather_alerts (
          alert_id, state_code, county, severity, event, headline, starts_at, ends_at, raw_json
        ) VALUES (
          @alert_id, @state_code, @county, @severity, @event, @headline, @starts_at, @ends_at, @raw_json
        )
      `
      );

      for (const alert of liveAlerts) {
        insert.run({
          alert_id: alert.id,
          state_code: stateCode,
          county: normalizedCounty,
          severity: alert.severity,
          event: alert.event,
          headline: alert.headline,
          starts_at: alert.starts_at,
          ends_at: alert.ends_at,
          raw_json: JSON.stringify(alert)
        });
      }

      db.prepare("DELETE FROM weather_alerts WHERE fetched_at < datetime('now', '-48 hours')").run();

      return {
        state: stateCode,
        county: normalizedCounty || null,
        alerts: liveAlerts,
        fetchedAt: new Date().toISOString(),
        source: "api.weather.gov"
      };
    } catch (err) {
      const rows = db
        .prepare(
          `
          SELECT raw_json
          FROM weather_alerts
          WHERE state_code=@stateCode AND county=@county
          ORDER BY fetched_at DESC
          LIMIT 100
        `
        )
        .all({ stateCode, county: normalizedCounty });

      if (rows.length) {
        return {
          state: stateCode,
          county: normalizedCounty || null,
          alerts: rows.map((r) => safeJsonParse(r.raw_json, null)).filter(Boolean),
          stale: true,
          warning: String(err?.message || err)
        };
      }

      throw app.httpErrors.badGateway(String(err?.message || err));
    } finally {
      db.close();
    }
  });
}
