import { d1All, d1First, d1Run } from "./db";
import { normalizeCounty, safeJsonParse } from "../lib/utils";
import { badGateway, badRequest } from "../lib/errors";
import type { Env } from "../types";

const WEATHER_STATES = ["KY"];

let kyZoneCache: { loadedAt: number; zones: Map<string, string> } = {
  loadedAt: 0,
  zones: new Map<string, string>()
};

async function nwsFetchJson(url: string, userAgent: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/geo+json",
      "User-Agent": userAgent
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`NWS request failed (${res.status}): ${body.slice(0, 240)}`);
  }

  return res.json();
}

function getGeometryCentroid(geometry: any): { lon: number; lat: number } | null {
  const points: Array<[number, number]> = [];

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
  for (const [x, y] of valid) {
    lon += Number(x);
    lat += Number(y);
  }

  return { lon: lon / valid.length, lat: lat / valid.length };
}

async function getKyCountyZoneMap(userAgent: string): Promise<Map<string, string>> {
  const now = Date.now();
  if (now - kyZoneCache.loadedAt < 6 * 60 * 60 * 1000 && kyZoneCache.zones.size) {
    return kyZoneCache.zones;
  }

  const zones = new Map<string, string>();
  let nextUrl: string | null = "https://api.weather.gov/zones?type=county&area=KY";
  let guard = 0;

  while (nextUrl && guard < 10) {
    guard += 1;
    const payload = await nwsFetchJson(nextUrl, userAgent);
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

async function fetchCountyForecast(county: string, userAgent: string): Promise<Record<string, unknown>> {
  const countyKey = normalizeCounty(county).toLowerCase();
  if (!countyKey) throw new Error("County is required");

  const zones = await getKyCountyZoneMap(userAgent);
  const countyZoneId = zones.get(countyKey);
  if (!countyZoneId) throw new Error(`No NWS county zone found for ${county}`);

  const countyZone = await nwsFetchJson(`https://api.weather.gov/zones/county/${countyZoneId}`, userAgent);
  const geometry = countyZone?.geometry;
  const centroid = getGeometryCentroid(geometry);
  if (!centroid) throw new Error(`No geometry centroid for county zone ${countyZoneId}`);

  const points = await nwsFetchJson(
    `https://api.weather.gov/points/${centroid.lat.toFixed(4)},${centroid.lon.toFixed(4)}`,
    userAgent
  );

  const forecastUrl = String(points?.properties?.forecast || "");
  if (!forecastUrl) throw new Error(`No forecast URL returned for county zone ${countyZoneId}`);

  const forecastZoneUri = String(points?.properties?.forecastZone || "");
  const forecastZoneId = forecastZoneUri.split("/").filter(Boolean).pop() || countyZoneId;

  const payload = await nwsFetchJson(forecastUrl, userAgent);
  const props = payload?.properties || {};
  const periodsRaw = Array.isArray(props.periods) ? props.periods : [];

  const periods = periodsRaw.slice(0, 14).map((p: any) => ({
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

async function fetchCountyAlerts(stateCode: string, county: string | null, userAgent: string): Promise<any[]> {
  const payload = await nwsFetchJson(`https://api.weather.gov/alerts/active?area=${encodeURIComponent(stateCode)}`, userAgent);
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const countyFilter = county ? normalizeCounty(county).toLowerCase() : null;

  const alerts: any[] = [];
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

export async function getWeatherForecast(
  env: Env,
  input: { state: string; county: string }
): Promise<Record<string, unknown>> {
  const stateCode = input.state.toUpperCase();
  if (!WEATHER_STATES.includes(stateCode)) {
    badRequest("Weather forecast currently supports KY only");
  }

  const county = normalizeCounty(input.county);
  const userAgent = env.NWS_USER_AGENT || "EasternKentuckyNews/1.0 (ops@example.com)";

  const cached = await d1First<{ forecast_json: string; fetched_at: string; expires_at: string }>(
    env.ky_news_db,
    `
    SELECT forecast_json, fetched_at, expires_at
    FROM weather_forecasts
    WHERE state_code=? AND county=?
    ORDER BY fetched_at DESC
    LIMIT 1
    `,
    ["KY", county]
  );

  const now = Date.now();
  const cachedExpiry = cached?.expires_at ? new Date(cached.expires_at).getTime() : 0;
  if (cached && Number.isFinite(cachedExpiry) && cachedExpiry > now) {
    return {
      ...safeJsonParse(cached.forecast_json, {}),
      fetchedAt: cached.fetched_at,
      expiresAt: cached.expires_at,
      cached: true
    };
  }

  try {
    const live = await fetchCountyForecast(county, userAgent);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await d1Run(
      env.ky_news_db,
      "INSERT INTO weather_forecasts (state_code, county, forecast_json, expires_at) VALUES (?, ?, ?, ?)",
      ["KY", county, JSON.stringify(live), expiresAt]
    );

    await d1Run(env.ky_news_db, "DELETE FROM weather_forecasts WHERE fetched_at < datetime('now', '-7 days')");

    return {
      ...live,
      fetchedAt: new Date().toISOString(),
      expiresAt,
      cached: false
    };
  } catch (err) {
    if (cached) {
      return {
        ...safeJsonParse(cached.forecast_json, {}),
        fetchedAt: cached.fetched_at,
        expiresAt: cached.expires_at,
        cached: true,
        stale: true,
        warning: err instanceof Error ? err.message : String(err)
      };
    }

    badGateway(err instanceof Error ? err.message : String(err));
  }
}

export async function getWeatherAlerts(
  env: Env,
  input: { state: string; county?: string }
): Promise<Record<string, unknown>> {
  const stateCode = input.state.toUpperCase();
  const normalizedCounty = input.county ? normalizeCounty(input.county) : "";

  if (!WEATHER_STATES.includes(stateCode)) {
    badRequest("Weather alerts currently support KY only");
  }

  const userAgent = env.NWS_USER_AGENT || "EasternKentuckyNews/1.0 (ops@example.com)";

  try {
    const liveAlerts = await fetchCountyAlerts(stateCode, normalizedCounty || null, userAgent);

    await d1Run(env.ky_news_db, "DELETE FROM weather_alerts WHERE state_code=? AND county=?", [stateCode, normalizedCounty]);

    for (const alert of liveAlerts) {
      await d1Run(
        env.ky_news_db,
        `
        INSERT INTO weather_alerts (
          alert_id, state_code, county, severity, event, headline, starts_at, ends_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          alert.id,
          stateCode,
          normalizedCounty,
          alert.severity,
          alert.event,
          alert.headline,
          alert.starts_at,
          alert.ends_at,
          JSON.stringify(alert)
        ]
      );
    }

    await d1Run(env.ky_news_db, "DELETE FROM weather_alerts WHERE fetched_at < datetime('now', '-48 hours')");

    return {
      state: stateCode,
      county: normalizedCounty || null,
      alerts: liveAlerts,
      fetchedAt: new Date().toISOString(),
      source: "api.weather.gov"
    };
  } catch (err) {
    const rows = await d1All<{ raw_json: string }>(
      env.ky_news_db,
      `
      SELECT raw_json
      FROM weather_alerts
      WHERE state_code=? AND county=?
      ORDER BY fetched_at DESC
      LIMIT 100
      `,
      [stateCode, normalizedCounty]
    );

    if (rows.length) {
      return {
        state: stateCode,
        county: normalizedCounty || null,
        alerts: rows.map((r) => safeJsonParse(r.raw_json, null)).filter(Boolean),
        stale: true,
        warning: err instanceof Error ? err.message : String(err)
      };
    }

    badGateway(err instanceof Error ? err.message : String(err));
  }
}
