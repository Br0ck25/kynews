export type NewsScope = "ky" | "national" | "all";

export type Feed = {
  id: string;
  name: string;
  category: string;
  url: string;
  state_code?: string;
  region_scope?: NewsScope;
  enabled: number;
};

export type Item = {
  id: string;
  title: string;
  url: string;
  author?: string | null;
  region_scope?: "ky" | "national";
  published_at?: string | null;
  summary?: string | null;
  content?: string | null;
  image_url?: string | null;
  states?: string[];
  counties?: string[];
};

export type CountyCount = { county: string; count: number };

export type WeatherForecastPeriod = {
  name: string;
  startTime: string;
  endTime: string;
  temperature: number;
  temperatureUnit: string;
  shortForecast: string;
  detailedForecast: string;
  windSpeed?: string;
  windDirection?: string;
  icon?: string;
};

export type WeatherForecast = {
  state: string;
  county: string;
  zoneId: string;
  updatedAt: string;
  periods: WeatherForecastPeriod[];
  source: string;
  fetchedAt?: string;
  expiresAt?: string;
  cached?: boolean;
  stale?: boolean;
  warning?: string;
};

export type WeatherAlert = {
  id: string;
  event: string;
  severity: string;
  headline: string;
  description: string;
  instruction: string;
  starts_at?: string | null;
  ends_at?: string | null;
  sent_at?: string | null;
  status?: string | null;
  url?: string | null;
  area_desc?: string;
};

export type LostFoundType = "lost" | "found";

export type LostFoundPost = {
  id: string;
  type: LostFoundType;
  title: string;
  description: string;
  county: string;
  state_code: string;
  status: "pending" | "approved" | "rejected";
  is_resolved?: boolean;
  show_contact: boolean;
  contact_email?: string | null;
  submitted_at: string;
  approved_at?: string | null;
  rejected_at?: string | null;
  resolved_at?: string | null;
  resolved_note?: string | null;
  expires_at: string;
  moderation_note?: string | null;
  images: string[];
};

export type AdminIngestionLog = {
  id: number;
  started_at: string;
  finished_at?: string | null;
  status: string;
  source?: string | null;
  feed_errors: number;
  details?: {
    feedsProcessed?: number;
    feedsUpdated?: number;
    itemsSeen?: number;
    itemsUpserted?: number;
    summariesGenerated?: number;
    imagesMirrored?: number;
    errors?: number;
  } | null;
};

export type AdminFeedHealth = {
  id: string;
  name: string;
  url: string;
  category: string;
  region_scope?: string | null;
  enabled: boolean;
  last_checked_at?: string | null;
  last_metric_at?: string | null;
  last_status?: string | null;
  last_duration_ms: number;
  last_items_upserted: number;
  recent_items: number;
  checks_window: number;
  errors_window: number;
  error_rate: number;
  health_status: "healthy" | "degraded" | "critical" | "unknown";
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        const parsed = JSON.parse(text);
        const msg = parsed?.message || parsed?.error || text;
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      } catch {
        throw new Error(text || `Request failed: ${res.status}`);
      }
    }
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getFeeds(opts: { scope?: NewsScope } = {}): Promise<Feed[]> {
  const params = new URLSearchParams();
  if (opts.scope) params.set("scope", opts.scope);
  const qs = params.toString();
  const data = await fetchJson<{ feeds: Feed[] }>(`/api/feeds${qs ? `?${qs}` : ""}`);
  return data.feeds;
}

export async function getItems(
  opts: {
    feedId?: string;
    category?: string;
    scope?: NewsScope;
    state?: string;
    county?: string;
    counties?: string[];
    hours?: number;
    cursor?: string | null;
    limit?: number;
  } = {}
) {
  const params = new URLSearchParams();
  if (opts.feedId) params.set("feedId", opts.feedId);
  if (opts.category) params.set("category", opts.category);
  if (opts.scope) params.set("scope", opts.scope);
  if (opts.state) params.set("state", opts.state);
  if (opts.county) params.set("county", opts.county);
  if (opts.counties?.length) {
    for (const county of opts.counties) params.append("counties", county);
  }
  if (opts.hours != null) params.set("hours", String(opts.hours));
  if (opts.cursor) params.set("cursor", opts.cursor);
  params.set("limit", String(opts.limit ?? 30));
  return fetchJson<{ items: (Item & { sort_ts?: string })[]; nextCursor: string | null }>(`/api/items?${params.toString()}`);
}

export async function searchItems(
  q: string,
  opts: {
    scope?: NewsScope;
    state?: string;
    county?: string;
    counties?: string[];
    hours?: number;
    cursor?: string | null;
    limit?: number;
  } = {}
) {
  const params = new URLSearchParams();
  params.set("q", q);
  if (opts.scope) params.set("scope", opts.scope);
  if (opts.state) params.set("state", opts.state);
  if (opts.county) params.set("county", opts.county);
  if (opts.counties?.length) {
    for (const county of opts.counties) params.append("counties", county);
  }
  if (opts.hours != null) params.set("hours", String(opts.hours));
  if (opts.cursor) params.set("cursor", opts.cursor);
  params.set("limit", String(opts.limit ?? 30));
  return fetchJson<{ items: (Item & { sort_ts?: string })[]; nextCursor: string | null }>(`/api/search?${params.toString()}`);
}

export async function getItem(id: string): Promise<Item> {
  const data = await fetchJson<{ item: Item }>(`/api/items/${encodeURIComponent(id)}`);
  return data.item;
}

export async function getCounties(opts: { state?: string; hours?: number } = {}) {
  const params = new URLSearchParams();
  params.set("state", (opts.state ?? "KY").toUpperCase());
  if (opts.hours != null) params.set("hours", String(opts.hours));
  return fetchJson<{ state: string; hours: number; counties: CountyCount[] }>(`/api/counties?${params.toString()}`);
}

export async function getWeatherForecast(county: string, state = "KY") {
  const params = new URLSearchParams();
  params.set("state", state.toUpperCase());
  params.set("county", county);
  return fetchJson<WeatherForecast>(`/api/weather/forecast?${params.toString()}`);
}

export async function getWeatherAlerts(opts: { county?: string; state?: string } = {}) {
  const params = new URLSearchParams();
  params.set("state", (opts.state ?? "KY").toUpperCase());
  if (opts.county) params.set("county", opts.county);
  return fetchJson<{ state: string; county?: string | null; alerts: WeatherAlert[]; stale?: boolean; warning?: string }>(
    `/api/weather/alerts?${params.toString()}`
  );
}

export async function listLostFound(opts: { type?: LostFoundType; county?: string; status?: "published" | "pending" | "approved" | "rejected" | "resolved"; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.county) params.set("county", opts.county);
  if (opts.status) params.set("status", opts.status);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  return fetchJson<{ posts: LostFoundPost[]; status: string; county?: string | null }>(`/api/lost-found?${params.toString()}`);
}

function adminHeaders(token?: string): HeadersInit {
  const headers: Record<string, string> = {};
  if (token?.trim()) headers["x-admin-token"] = token.trim();
  return headers;
}

export async function getLostFoundUploadUrl(filename: string, mimeType: string) {
  return fetchJson<{ objectKey: string; uploadUrl: string; method: "PUT"; headers: Record<string, string>; maxBytes: number }>(
    "/api/uploads/lost-found-url",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename, mimeType })
    }
  );
}

export async function uploadLostFoundImage(uploadUrl: string, file: File, headers: Record<string, string>) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers,
    body: file
  });
  if (!res.ok) throw new Error("Image upload failed");
  return res.json() as Promise<{ ok: boolean; objectKey: string; bytes: number }>;
}

export async function submitLostFound(input: {
  type: LostFoundType;
  title: string;
  description: string;
  county: string;
  state?: string;
  contactEmail: string;
  showContact?: boolean;
  imageKeys?: string[];
}) {
  return fetchJson<{ ok: boolean; id: string; status: string }>("/api/lost-found/submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...input,
      state: (input.state ?? "KY").toUpperCase(),
      showContact: input.showContact ?? false,
      imageKeys: input.imageKeys ?? []
    })
  });
}

export async function markLostFoundAsFound(input: {
  id: string;
  contactEmail: string;
  note?: string;
}) {
  return fetchJson<{ ok: boolean; id: string; status: string }>(`/api/lost-found/${encodeURIComponent(input.id)}/mark-found`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contactEmail: input.contactEmail,
      note: input.note?.trim() || undefined
    })
  });
}

export async function listAdminLostFound(input: {
  token?: string;
  status?: "pending" | "approved" | "rejected" | "resolved" | "all";
  limit?: number;
} = {}) {
  const params = new URLSearchParams();
  params.set("status", input.status || "all");
  params.set("limit", String(input.limit ?? 120));
  return fetchJson<{ admin: string; posts: LostFoundPost[] }>(`/api/admin/lost-found?${params.toString()}`, {
    headers: adminHeaders(input.token)
  });
}

export async function deleteAdminLostFound(input: { token?: string; id: string }) {
  return fetchJson<{ ok: boolean; id: string; deletedImages: number }>(`/api/admin/lost-found/${encodeURIComponent(input.id)}`, {
    method: "DELETE",
    headers: adminHeaders(input.token)
  });
}

export async function approveAdminLostFound(input: {
  token?: string;
  id: string;
  showContact?: boolean;
  note?: string;
}) {
  return fetchJson<{ ok: boolean; id: string; status: string }>(
    `/api/admin/lost-found/${encodeURIComponent(input.id)}/approve`,
    {
      method: "POST",
      headers: {
        ...adminHeaders(input.token),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        showContact: input.showContact,
        note: input.note?.trim() || undefined
      })
    }
  );
}

export async function rejectAdminLostFound(input: {
  token?: string;
  id: string;
  reason: string;
}) {
  return fetchJson<{ ok: boolean; id: string; status: string }>(
    `/api/admin/lost-found/${encodeURIComponent(input.id)}/reject`,
    {
      method: "POST",
      headers: {
        ...adminHeaders(input.token),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        reason: input.reason
      })
    }
  );
}

export async function getAdminIngestionLogs(input: {
  token?: string;
  limit?: number;
  cursor?: number;
} = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit ?? 20));
  if (input.cursor) params.set("cursor", String(input.cursor));
  return fetchJson<{ logs: AdminIngestionLog[]; nextCursor: number | null }>(`/api/admin/ingestion/logs?${params.toString()}`, {
    headers: adminHeaders(input.token)
  });
}

export async function getAdminFeedHealth(input: {
  token?: string;
  hours?: number;
  limit?: number;
} = {}) {
  const params = new URLSearchParams();
  params.set("hours", String(input.hours ?? 48));
  params.set("limit", String(input.limit ?? 300));
  return fetchJson<{ hours: number; feeds: AdminFeedHealth[] }>(`/api/admin/feeds/health?${params.toString()}`, {
    headers: adminHeaders(input.token)
  });
}

export async function runAdminFeedReload(input: { token?: string } = {}) {
  return fetchJson<{ ok: boolean; code: number; stdout: string; stderr: string }>("/api/admin/feeds/reload", {
    method: "POST",
    headers: adminHeaders(input.token)
  });
}

export async function getOpenProxy(url: string) {
  const params = new URLSearchParams();
  params.set("url", url);
  return fetchJson<{ url: string; finalUrl: string; title: string; html: string }>(`/api/open-proxy?${params.toString()}`);
}
