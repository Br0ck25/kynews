#!/usr/bin/env node

const workerUrl = String(process.env.WORKER_URL || "https://ky-news-worker.jamesbrock25.workers.dev").replace(/\/+$/, "");
const lookbackHours = Number(process.env.LOOKBACK_HOURS || "168");
const maxFreshnessMinutes = Number(process.env.MAX_FRESHNESS_MINUTES || "240");
const adminToken = process.env.ADMIN_TOKEN || "";

function minutesSince(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - ts) / 60000);
}

async function fetchJson(path, init = {}) {
  const res = await fetch(`${workerUrl}${path}`, init);
  const bodyText = await res.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = { raw: bodyText };
  }

  if (!res.ok) {
    const message = typeof body?.error === "string" ? body.error : `${res.status} ${res.statusText}`;
    const err = new Error(`${path} failed: ${message}`);
    err.details = body;
    throw err;
  }
  return body;
}

function newestPublishedAt(items) {
  if (!Array.isArray(items) || !items.length) return null;
  const sorted = [...items].sort((a, b) => String(b?.published_at || "").localeCompare(String(a?.published_at || "")));
  return sorted[0]?.published_at || null;
}

function printCheck(name, ok, details) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name} - ${details}`);
}

async function run() {
  let failures = 0;

  const health = await fetchJson("/api/health");
  printCheck("Health", Boolean(health?.ok), `ok=${String(Boolean(health?.ok))}`);
  if (!health?.ok) failures += 1;

  const ky = await fetchJson(`/api/items?scope=ky&limit=10&hours=${lookbackHours}`);
  const nat = await fetchJson(`/api/items?scope=national&limit=10&hours=${lookbackHours}`);
  const feeds = await fetchJson("/api/feeds?scope=ky");

  const newestKy = newestPublishedAt(ky.items);
  const newestNat = newestPublishedAt(nat.items);
  const kyMinutes = minutesSince(newestKy);
  const natMinutes = minutesSince(newestNat);

  const kyFresh = Array.isArray(ky.items) && ky.items.length > 0 && kyMinutes <= maxFreshnessMinutes;
  const natFresh = Array.isArray(nat.items) && nat.items.length > 0 && natMinutes <= maxFreshnessMinutes * 3;
  const feedCount = Array.isArray(feeds.feeds) ? feeds.feeds.length : 0;

  printCheck(
    "KY Articles",
    kyFresh,
    `count=${Array.isArray(ky.items) ? ky.items.length : 0}, newest=${newestKy || "none"}, lag=${Number.isFinite(kyMinutes) ? kyMinutes : "n/a"}m`
  );
  if (!kyFresh) failures += 1;

  printCheck(
    "National Articles",
    natFresh,
    `count=${Array.isArray(nat.items) ? nat.items.length : 0}, newest=${newestNat || "none"}, lag=${Number.isFinite(natMinutes) ? natMinutes : "n/a"}m`
  );
  if (!natFresh) failures += 1;

  printCheck("Feed Seed Coverage", feedCount > 0, `enabled_feeds=${feedCount}`);
  if (feedCount <= 0) failures += 1;

  if (adminToken) {
    const headers = { "x-admin-token": adminToken };
    const logs = await fetchJson("/api/admin/ingestion/logs?limit=1", { headers });
    const latest = Array.isArray(logs.logs) ? logs.logs[0] : null;
    const lastRunAt = latest?.finished_at || latest?.started_at || null;
    const runLag = minutesSince(lastRunAt);
    const runHealthy = Boolean(latest) && runLag <= 30;
    printCheck(
      "Scheduler Freshness",
      runHealthy,
      `last_run=${lastRunAt || "none"}, lag=${Number.isFinite(runLag) ? runLag : "n/a"}m, status=${latest?.status || "unknown"}`
    );
    if (!runHealthy) failures += 1;

    const healthRes = await fetchJson("/api/admin/feeds/health?hours=48&limit=500", { headers });
    const list = Array.isArray(healthRes.feeds) ? healthRes.feeds : [];
    const critical = list.filter((f) => f.health_status === "critical");
    const stale = list.filter((f) => Number(f.recent_items || 0) === 0);
    printCheck(
      "Feed Health",
      critical.length === 0,
      `critical=${critical.length}, stale_48h=${stale.length}, checked=${list.length}`
    );
    if (critical.length > 0) failures += 1;
  } else {
    console.log("INFO  Admin checks skipped (set ADMIN_TOKEN env var to enable feed health and scheduler checks).");
  }

  if (failures > 0) {
    console.error(`\nSmoke test failed with ${failures} failing check(s).`);
    process.exit(1);
  }

  console.log("\nSmoke test passed.");
}

run().catch((err) => {
  console.error("Smoke test crashed:", err?.message || err);
  if (err?.details) {
    console.error("Details:", JSON.stringify(err.details));
  }
  process.exit(1);
});
