/**
 * Live Weather Alerts Worker
 * Runs every 60 seconds via cron. Fetches ALL active NWS weather alerts
 * nationwide, determines which are new/updated/cancelled, and posts them
 * to the "Live Weather Alerts" Facebook page.
 *
 * KV key schema
 *   alert:{UGC}:{eventSlug}      → {fbPostId, expires, headline, nwsId, updatedAt}
 *   seen:{nwsAlertId}:{ugcCode}  → "1"  (dedup: this exact NWS id+ugc was already handled)
 *   pending:{UGC}:{eventSlug}    → {reason, caption, retryCount, firstFailedAt, ...}
 *   config:autopost              → {warnings: bool, watches: bool, others: bool}
 *   system:last_sweep            → ISO timestamp
 */

const NWS_BASE = "https://api.weather.gov";
const NWS_USER_AGENT = "(LiveWeatherAlerts, contact@localkynews.com)";
const NWS_ALL_URL = `${NWS_BASE}/alerts/active?status=actual`;
const FB_API = "https://graph.facebook.com/v19.0";
const SITE_URL = "https://localkynews.com/live-weather-alerts";

// Alert types that map to "warnings"
const WARNING_TYPES = new Set([
  "Tornado Warning",
  "Flash Flood Warning",
  "Winter Storm Warning",
  "Ice Storm Warning",
  "Blizzard Warning",
  "Severe Thunderstorm Warning",
  "Flood Warning",
  "River Flood Warning",
  "Extreme Wind Warning",
  "High Wind Warning",
  "Winter Weather Advisory",
  "Freeze Warning",
  "Freeze Watch",
  "Hard Freeze Warning",
  "Dense Fog Advisory",
  "Dust Storm Warning",
  "Fire Weather Watch",
  "Red Flag Warning",
  "Tsunami Warning",
  "Earthquake Warning",
  "Volcano Warning",
  "Hurricane Warning",
  "Tropical Storm Warning",
  "Storm Surge Warning",
  "Coastal Flood Warning",
  "Avalanche Warning",
  "Excessive Heat Warning",
  "Heat Advisory",
  "Wind Chill Warning",
  "Lake Effect Snow Warning",
  "Snow Squall Warning",
]);

// Alert types that map to "watches"
const WATCH_TYPES = new Set([
  "Tornado Watch",
  "Flash Flood Watch",
  "Winter Storm Watch",
  "Severe Thunderstorm Watch",
  "Flood Watch",
  "River Flood Watch",
  "High Wind Watch",
  "Blizzard Watch",
  "Ice Storm Watch",
  "Hurricane Watch",
  "Tropical Storm Watch",
  "Storm Surge Watch",
  "Coastal Flood Watch",
  "Avalanche Watch",
  "Excessive Heat Watch",
  "Wind Chill Watch",
  "Lake Effect Snow Watch",
]);

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── Auto-post config ────────────────────────────────────────────────────────

interface AutopostConfig {
  warnings: boolean;
  watches: boolean;
  others: boolean;
}

const DEFAULT_CONFIG: AutopostConfig = { warnings: true, watches: true, others: false };

async function getConfig(kv: KVNamespace): Promise<AutopostConfig> {
  try {
    const raw = await kv.get("config:autopost", "json");
    if (raw && typeof raw === "object") {
      const c = raw as Partial<AutopostConfig>;
      return {
        warnings: c.warnings ?? DEFAULT_CONFIG.warnings,
        watches: c.watches ?? DEFAULT_CONFIG.watches,
        others: c.others ?? DEFAULT_CONFIG.others,
      };
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_CONFIG };
}

function alertCategory(eventType: string): "warning" | "watch" | "other" {
  if (WARNING_TYPES.has(eventType)) return "warning";
  if (WATCH_TYPES.has(eventType)) return "watch";
  return "other";
}

function shouldPost(eventType: string, config: AutopostConfig): boolean {
  const cat = alertCategory(eventType);
  if (cat === "warning") return config.warnings;
  if (cat === "watch") return config.watches;
  return config.others;
}

// ─── NWS helpers ────────────────────────────────────────────────────────────

interface NWSFeature {
  id: string;
  properties: {
    id: string;
    event: string;
    headline: string | null;
    description: string;
    areaDesc: string;
    expires: string;
    effective: string;
    onset: string | null;
    severity: string;
    urgency: string;
    certainty: string;
    messageType: string;
    status: string;
    geocode?: { UGC?: string[] };
    references?: Array<{ identifier: string }>;
  };
}

interface NWSResponse {
  type: string;
  features: NWSFeature[];
  pagination?: { next?: string };
}

async function fetchAllAlerts(): Promise<NWSFeature[]> {
  const features: NWSFeature[] = [];
  let url: string | undefined = NWS_ALL_URL;
  let page = 0;

  while (url) {
    page++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let data: NWSResponse;

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": NWS_USER_AGENT,
          Accept: "application/geo+json",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      console.log(`[NWS] page ${page} — HTTP ${res.status}`);

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[NWS] non-OK response: ${errText.slice(0, 500)}`);
        break;
      }

      data = (await res.json()) as NWSResponse;
    } catch (err) {
      clearTimeout(timer);
      console.error(`[NWS] fetch/parse error on page ${page}:`, String(err));
      break;
    }

    const pageCount = Array.isArray(data.features) ? data.features.length : 0;
    console.log(`[NWS] page ${page}: ${pageCount} feature(s) | next: ${data.pagination?.next ?? "none"}`);

    if (Array.isArray(data.features)) features.push(...data.features);
    url = data.pagination?.next;

    // Safety cap to avoid infinite loops if NWS pagination misbehaves
    if (page >= 50) {
      console.log(`[NWS] hit page cap (50), stopping`);
      break;
    }
  }

  console.log(`[NWS] total alerts fetched nationwide: ${features.length}`);
  return features;
}

// ─── Facebook helpers ─────────────────────────────────────────────────────────

async function fbPost(
  pageId: string,
  pageToken: string,
  message: string
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${FB_API}/${pageId}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, access_token: pageToken }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = (await res.json()) as { id?: string; error?: { message: string } };
    if (!res.ok || json.error) {
      throw new Error(json.error?.message ?? `FB HTTP ${res.status}`);
    }
    console.log(`[FB] posted successfully — post id: ${json.id}`);
    return json.id ?? "";
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fbComment(
  postId: string,
  pageToken: string,
  message: string
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${FB_API}/${postId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, access_token: pageToken }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = (await res.json()) as { id?: string; error?: { message: string } };
    if (!res.ok || json.error) {
      throw new Error(json.error?.message ?? `FB comment HTTP ${res.status}`);
    }
    return json.id ?? "";
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Caption builder ──────────────────────────────────────────────────────────

function cleanNwsDescription(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const blocks = normalized.split(/\n{2,}/);
  const result = blocks.map((block) => {
    const lines = block.split("\n");
    const items: string[] = [];
    let current = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\* /.test(trimmed) || /^- /.test(trimmed)) {
        if (current) items.push(current);
        current = trimmed;
      } else if (current) {
        current += " " + trimmed;
      } else {
        current = trimmed;
      }
    }
    if (current) items.push(current);
    return items
      .map((item) => {
        item = item.replace(/^\* ([A-Z ]+)\.\.\./, "$1: ");
        item = item.replace(/^\* ([A-Z ]+)\.\.\.$/, "$1:");
        item = item.replace(/^\.\.\./, "");
        item = item.replace(/\.\.\.$/, "");
        item = item.replace(/^(- [A-Za-z ]+)\.\.\./, "$1: ");
        return item.trim();
      })
      .filter((s) => s.length > 0)
      .join("\n");
  });
  return result.filter((s) => s.length > 0).join("\n\n");
}

function formatExpires(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function buildCaption(feature: NWSFeature): string {
  const p = feature.properties;
  const lines: string[] = [
    (p.event || "WEATHER ALERT").toUpperCase(),
    "",
    `📍 Area: ${p.areaDesc}`,
  ];
  if (p.expires) lines.push(`⏰ Expires: ${formatExpires(p.expires)}`);
  lines.push(`⚠️ Severity: ${p.severity ?? "Unknown"}`);
  lines.push("");
  if (p.headline) lines.push(p.headline);
  lines.push("");
  lines.push(cleanNwsDescription((p.description ?? "").trim()));
  lines.push("");
  lines.push(SITE_URL);
  lines.push("");
  lines.push("#weatheralert #weather #LiveWeatherAlerts");
  return lines.join("\n");
}

function buildUpdateComment(feature: NWSFeature): string {
  const p = feature.properties;
  return [
    "🔄 UPDATE",
    "",
    p.headline ?? p.event,
    "",
    cleanNwsDescription((p.description ?? "").trim()),
    "",
    `⏰ Now expires: ${p.expires ? formatExpires(p.expires) : "Unknown"}`,
  ].join("\n");
}

function buildCancelComment(feature: NWSFeature): string {
  const p = feature.properties;
  return `✅ CANCELLED / EXPIRED\n\n${p.headline ?? p.event}\n\nThis alert has been cancelled or has expired.`;
}

// ─── KV record types ──────────────────────────────────────────────────────────

interface ActiveRecord {
  fbPostId: string;
  expires: string;
  headline: string | null;
  nwsId: string;
  updatedAt: string;
}

interface PendingRecord {
  reason: string;
  caption: string;
  retryCount: number;
  firstFailedAt: string;
  ugcCode: string;
  eventSlug: string;
  feature: NWSFeature;
}

// ─── Main scheduled handler ───────────────────────────────────────────────────

async function runSweep(env: Env, ctx: ExecutionContext): Promise<void> {
  console.log("[sweep] starting");
  const config = await getConfig(env.WEATHER_KV);
  console.log("[sweep] config:", JSON.stringify(config));

  const pageId = env.LIVE_WEATHER_ALERTS_FB_PAGE_ID;
  const pageToken = env.LIVE_WEATHER_ALERTS_FB_PAGE_TOKEN;

  if (!pageId || !pageToken) {
    console.error("[sweep] FATAL: Missing FB_PAGE_ID or FB_PAGE_TOKEN — aborting");
    return;
  }

  // 1. Fetch all active alerts nationwide
  const features = await fetchAllAlerts();
  console.log(`[sweep] features to process: ${features.length}`);

  const now = new Date().toISOString();
  await env.WEATHER_KV.put("system:last_sweep", now);

  const activeKeys = new Set<string>();

  for (const feature of features) {
    const p = feature.properties;

    // NWS returns lowercase status: "actual", "exercise", "test", "draft", "system"
    if (p.status?.toLowerCase() !== "actual") {
      continue;
    }

    const ugcCodes: string[] = p.geocode?.UGC ?? [];
    if (ugcCodes.length === 0) {
      // Some alerts don't have UGC codes — use the NWS alert id as the key
      // so we still track and post it once.
      ugcCodes.push(`nws:${p.id}`);
    }

    const eventSlug = slugify(p.event);

    for (const ugcCode of ugcCodes) {
      const alertKey = `alert:${ugcCode}:${eventSlug}`;
      const seenKey = `seen:${p.id}:${ugcCode}`;
      activeKeys.add(alertKey);

      const existingRaw = await env.WEATHER_KV.get(alertKey, "json") as ActiveRecord | null;
      const alreadySeen = await env.WEATHER_KV.get(seenKey);

      if (!existingRaw) {
        // ── New alert ─────────────────────────────────────────────────────
        if (!shouldPost(p.event, config)) {
          await env.WEATHER_KV.put(seenKey, "1", { expirationTtl: 7 * 86400 });
          continue;
        }

        console.log(`[sweep] NEW: "${p.event}" — ${p.areaDesc} [${ugcCode}]`);
        const caption = buildCaption(feature);
        try {
          const fbPostId = await fbPost(pageId, pageToken, caption);
          const record: ActiveRecord = {
            fbPostId,
            expires: p.expires,
            headline: p.headline,
            nwsId: p.id,
            updatedAt: now,
          };
          await env.WEATHER_KV.put(alertKey, JSON.stringify(record), { expirationTtl: 7 * 86400 });
          await env.WEATHER_KV.put(seenKey, "1", { expirationTtl: 7 * 86400 });
          await env.WEATHER_KV.delete(`pending:${ugcCode}:${eventSlug}`);
        } catch (err) {
          console.error(`[FB] post failed for ${alertKey}:`, String(err));
          const pending: PendingRecord = {
            reason: String(err),
            caption,
            retryCount: 1,
            firstFailedAt: now,
            ugcCode,
            eventSlug,
            feature,
          };
          await env.WEATHER_KV.put(
            `pending:${ugcCode}:${eventSlug}`,
            JSON.stringify(pending),
            { expirationTtl: 7 * 86400 }
          );
        }
      } else if (!alreadySeen) {
        // ── Same UGC+event exists but new NWS id = update ─────────────────
        console.log(`[sweep] UPDATE: "${p.event}" — ${p.areaDesc} [${ugcCode}]`);
        const comment = buildUpdateComment(feature);
        try {
          await fbComment(existingRaw.fbPostId, pageToken, comment);
          const updated: ActiveRecord = {
            ...existingRaw,
            expires: p.expires,
            headline: p.headline,
            nwsId: p.id,
            updatedAt: now,
          };
          await env.WEATHER_KV.put(alertKey, JSON.stringify(updated), { expirationTtl: 7 * 86400 });
          await env.WEATHER_KV.put(seenKey, "1", { expirationTtl: 7 * 86400 });
        } catch (err) {
          console.error(`[FB] update comment failed for ${alertKey}:`, String(err));
          await env.WEATHER_KV.put(seenKey, "1", { expirationTtl: 7 * 86400 });
        }
      }
      // else: already seen this exact NWS id+UGC — no action needed
    }
  }

  // 2. Retry any failed pending posts
  const { keys: pendingKeys } = await env.WEATHER_KV.list({ prefix: "pending:" });
  if (pendingKeys.length > 0) {
    console.log(`[sweep] retrying ${pendingKeys.length} pending post(s)`);
  }

  for (const kvKey of pendingKeys) {
    try {
      const raw = await env.WEATHER_KV.get(kvKey.name, "json") as PendingRecord | null;
      if (!raw) continue;
      const { ugcCode, eventSlug, caption, retryCount, firstFailedAt, feature } = raw;

      const age = Date.now() - new Date(firstFailedAt).getTime();
      if (retryCount >= 5 || age > 2 * 3600 * 1000) {
        console.log(`[sweep] giving up on ${kvKey.name} after ${retryCount} retries`);
        await env.WEATHER_KV.delete(kvKey.name);
        continue;
      }
      if (!shouldPost(feature.properties.event, config)) {
        await env.WEATHER_KV.delete(kvKey.name);
        continue;
      }

      console.log(`[sweep] retrying ${kvKey.name} (attempt ${retryCount + 1})`);
      const fbPostId = await fbPost(pageId, pageToken, caption);
      const record: ActiveRecord = {
        fbPostId,
        expires: feature.properties.expires,
        headline: feature.properties.headline,
        nwsId: feature.properties.id,
        updatedAt: now,
      };
      await env.WEATHER_KV.put(`alert:${ugcCode}:${eventSlug}`, JSON.stringify(record), { expirationTtl: 7 * 86400 });
      await env.WEATHER_KV.delete(kvKey.name);
    } catch (err) {
      console.error(`[sweep] retry failed for ${kvKey.name}:`, String(err));
      try {
        const raw = await env.WEATHER_KV.get(kvKey.name, "json") as PendingRecord | null;
        if (raw) {
          await env.WEATHER_KV.put(
            kvKey.name,
            JSON.stringify({ ...raw, retryCount: (raw.retryCount ?? 0) + 1 }),
            { expirationTtl: 7 * 86400 }
          );
        }
      } catch { /* ignore */ }
    }
  }

  // 3. Sweep for expired/cancelled alerts no longer in the active set
  const { keys: alertKeys } = await env.WEATHER_KV.list({ prefix: "alert:" });
  for (const kvKey of alertKeys) {
    if (activeKeys.has(kvKey.name)) continue;

    console.log(`[sweep] expired/cancelled: ${kvKey.name}`);
    try {
      const raw = await env.WEATHER_KV.get(kvKey.name, "json") as ActiveRecord | null;
      if (!raw) continue;

      const cancelFeature = features.find(
        (f) =>
          f.properties.messageType === "Cancel" &&
          f.properties.references?.some((r) => r.identifier === raw.nwsId)
      );
      if (cancelFeature) {
        try {
          await fbComment(raw.fbPostId, pageToken, buildCancelComment(cancelFeature));
        } catch (err) {
          console.error(`[FB] cancel comment failed for ${kvKey.name}:`, String(err));
        }
      }

      await env.WEATHER_KV.delete(kvKey.name);
    } catch (err) {
      console.error(`[KV] sweep delete failed for ${kvKey.name}:`, String(err));
    }
  }

  console.log(`[sweep] done — active alert keys this sweep: ${activeKeys.size}`);
}

// ─── HTTP handler (admin settings API) ───────────────────────────────────────

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "https://localkynews.com",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const adminKey = request.headers.get("X-Admin-Key") ?? "";
  if (!adminKey || adminKey !== env.ADMIN_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (request.method === "GET" && url.pathname === "/fb-debug") {
    const pageId = env.LIVE_WEATHER_ALERTS_FB_PAGE_ID;
    const pageToken = env.LIVE_WEATHER_ALERTS_FB_PAGE_TOKEN;
    const r = await fetch(
      `https://graph.facebook.com/v25.0/${pageId}?fields=id,name&access_token=${encodeURIComponent(pageToken)}`
    );
    const data = await r.json() as unknown;
    return json({
      ok: r.ok,
      pageIdConfigured: pageId,
      tokenPresent: !!pageToken,
      graphResponse: data,
    }, r.ok ? 200 : 500);
  }

  if (request.method === "GET" && url.pathname === "/config") {
    const config = await getConfig(env.WEATHER_KV);
    const lastSweep = await env.WEATHER_KV.get("system:last_sweep");
    return json({ ok: true, config, lastSweep });
  }

  if (request.method === "POST" && url.pathname === "/config") {
    let body: Partial<AutopostConfig>;
    try {
      body = (await request.json()) as Partial<AutopostConfig>;
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }
    const current = await getConfig(env.WEATHER_KV);
    const updated: AutopostConfig = {
      warnings: body.warnings ?? current.warnings,
      watches: body.watches ?? current.watches,
      others: body.others ?? current.others,
    };
    await env.WEATHER_KV.put("config:autopost", JSON.stringify(updated));
    return json({ ok: true, config: updated });
  }

  if (request.method === "POST" && url.pathname === "/exchange-token") {
    let body: { shortLivedToken?: string };
    try {
      body = (await request.json()) as { shortLivedToken?: string };
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    const shortLivedToken = (body.shortLivedToken ?? "").trim();
    if (!shortLivedToken) return json({ ok: false, error: "shortLivedToken is required" }, 400);

    const appId = env.LIVE_WEATHER_ALERTS_FB_APP_ID;
    const appSecret = env.LIVE_WEATHER_ALERTS_FB_APP_SECRET;
    if (!appId || !appSecret) {
      return json({ ok: false, error: "FB app credentials not configured" }, 500);
    }

    const exchangeUrl =
      `${FB_API}/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(appId)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&fb_exchange_token=${encodeURIComponent(shortLivedToken)}`;

    const exchangeRes = await fetch(exchangeUrl);
    const exchangeJson = (await exchangeRes.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: { message: string };
    };
    if (!exchangeRes.ok || exchangeJson.error) {
      return json({ ok: false, error: exchangeJson.error?.message ?? `FB exchange HTTP ${exchangeRes.status}` }, 400);
    }

    const longLivedUserToken = exchangeJson.access_token ?? "";
    if (!longLivedUserToken) return json({ ok: false, error: "No access_token in FB exchange response" }, 500);

    const accountsRes = await fetch(
      `${FB_API}/me/accounts?access_token=${encodeURIComponent(longLivedUserToken)}`
    );
    const accountsJson = (await accountsRes.json()) as {
      data?: Array<{ id: string; name: string; access_token: string }>;
      error?: { message: string };
    };
    if (!accountsRes.ok || accountsJson.error) {
      return json({ ok: false, error: accountsJson.error?.message ?? `FB accounts HTTP ${accountsRes.status}`, longLivedUserToken }, 400);
    }

    const pages = accountsJson.data ?? [];
    const configuredPageId = env.LIVE_WEATHER_ALERTS_FB_PAGE_ID;
    const targetPage = configuredPageId ? pages.find((p) => p.id === configuredPageId) : pages[0];

    return json({
      ok: true,
      longLivedUserToken,
      expiresInDays: Math.floor((exchangeJson.expires_in ?? 0) / 86400),
      pages,
      targetPageToken: targetPage?.access_token ?? null,
      targetPageName: targetPage?.name ?? null,
      targetPageId: targetPage?.id ?? null,
    });
  }

  return json({ ok: false, error: "Not found" }, 404);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runSweep(env, ctx));
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env);
  },
} satisfies ExportedHandler<Env>;
