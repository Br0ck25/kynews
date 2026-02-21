# Kentucky + National FeedReader PWA Completion Plan (Feedly-Style, No Accounts)

## Summary
Goal: finish a production-ready PWA that feels like Feedly, focuses on Kentucky county-level news plus a separate national lane, adds weather and moderated lost-and-found, and migrates from local Node/SQLite to Cloudflare Pages + Workers + D1/R2.  
Success: stable ingest, fast mobile UX, accurate county sorting for Kentucky, working weather hub, safe user submissions, and cloud deployment with admin controls.

## Locked Product Decisions
1. Launch sequence: Kentucky depth first, then national lane.
2. National model: separate National section, not mixed into county navigation.
3. Weather v1: NOAA/NWS forecasts + alerts.
4. Lost & Found moderation: pre-approval required before publish.
5. Lost & Found contact policy: email collected; hidden until approved/public choice.
6. Admin access: Cloudflare Access-protected `/admin`.
7. Delivery pace: single developer, staged MVP increments.

## Documentation Package To Create
1. `docs/00_PROJECT_OVERVIEW.md`: mission, audience, north-star metrics, out-of-scope.
2. `docs/01_PRODUCT_REQUIREMENTS.md`: detailed UX requirements for Home, County, National, Weather, Search, Reader, Lost & Found.
3. `docs/02_INFORMATION_ARCHITECTURE.md`: route map, navigation model, taxonomy (KY county vs national scope).
4. `docs/03_DATA_MODEL.md`: ERD, table schemas, indexes, retention policies.
5. `docs/04_API_SPEC.md`: endpoint contracts, request/response examples, error model, auth model for admin.
6. `docs/05_INGESTION_PIPELINE.md`: feed sourcing, dedupe, tagging, retries, failure handling.
7. `docs/06_PWA_SPEC.md`: offline behavior, cache policies, install/update UX, performance budgets.
8. `docs/07_WEATHER_SPEC.md`: NWS integration, county mapping, alert severity logic, refresh cadence.
9. `docs/08_LOST_FOUND_SPEC.md`: submission workflow, moderation workflow, media handling, safety and abuse controls.
10. `docs/09_CLOUDFLARE_DEPLOYMENT.md`: Pages, Workers, D1, R2, Access, secrets, environments, rollout checklist.
11. `docs/10_ROADMAP.md`: milestone timeline, deliverables, acceptance gates, launch checklist.
12. `docs/11_OPERATIONS_RUNBOOK.md`: monitoring, incident response, feed failures, moderation SOPs.

## Product Scope (Decision Complete)
1. Primary sections: `Today`, `Kentucky`, `My County`, `National`, `Weather`, `Read Later`, `Search`, `Lost & Found`.
2. Feed model: curated feeds only; no user-provided RSS; no end-user accounts.
3. Personalization: device-local preferences only (`My County`, read/saved state, optional push subscription later).
4. Kentucky navigation: state view + all 120 counties.
5. National navigation: one dedicated lane with source/category filters, no county drilldown.
6. Reader behavior: in-app clean read view + open original.
7. Lost & Found behavior: anonymous submission with required email + photo(s), admin review before public listing.

## Target Technical Architecture
1. Frontend: `apps/web` React + TypeScript + Vite PWA kept as canonical client.
2. Local development backend: keep current Fastify API + Node ingester until cloud parity.
3. Cloud production backend: Worker API service + Worker scheduled ingester service.
4. Datastores: D1 for structured data, R2 for lost-and-found images, local Dexie for client read/saved/cache state.
5. Security controls: Turnstile on public submissions, Cloudflare Access for admin, server-side rate limits.
6. Deployment: Pages for web, Workers for API/ingester, separate `dev` and `prod` environments.
7. Repository cleanup: retire root scaffold app (`src/*`, root `index.html`) after migration to avoid dual frontends.

## Public APIs / Interfaces / Types (Additions and Changes)
1. `GET /api/feeds`: add `region_scope` in response (`ky` | `national`).
2. `GET /api/items`: add query `scope=ky|national|all` default `ky`.
3. `GET /api/items`: preserve `state`/`county` filters for KY scope only.
4. `GET /api/weather/forecast?state=KY&county=<name>`: county forecast summary + periods.
5. `GET /api/weather/alerts?state=KY&county=<name>`: active alerts relevant to county.
6. `GET /api/lost-found?type=lost|found&county=&status=published`: public board listing.
7. `POST /api/lost-found/submissions`: create pending submission with metadata and contact email.
8. `POST /api/uploads/lost-found-url`: issue signed upload URL for R2 object key.
9. `GET /api/admin/lost-found?status=pending|approved|rejected`: moderation queue (Access protected).
10. `POST /api/admin/lost-found/:id/approve`: publish pending submission.
11. `POST /api/admin/lost-found/:id/reject`: reject submission with reason.
12. `POST /api/admin/feeds/reload`: force feed reload and ingest health check.
13. New shared TypeScript contracts: `NewsScope`, `LocationTag`, `WeatherForecast`, `WeatherAlert`, `LostFoundSubmission`, `LostFoundPost`, `ModerationDecision`.

## Data Model Changes
1. `feeds`: add `region_scope TEXT NOT NULL DEFAULT 'ky'`.
2. `items`: add `region_scope TEXT NOT NULL DEFAULT 'ky'`.
3. `weather_forecasts`: county, forecast JSON, fetched_at, expires_at.
4. `weather_alerts`: alert_id, county, severity, event, headline, starts_at, ends_at, raw JSON.
5. `lost_found_posts`: id, type, title, description, county, state_code, contact_email_encrypted, status, submitted_at, approved_at, expires_at.
6. `lost_found_images`: id, post_id, r2_key, width, height, created_at.
7. `lost_found_reports`: id, post_id, reason, reporter_ip_hash, created_at.
8. `admin_audit_log`: id, actor_email, action, entity_type, entity_id, payload_json, created_at.
9. Indexes: county + status indexes for weather and lost/found; recency indexes for feeds/items queries.
10. Retention defaults: weather forecasts 7 days, alerts until 48h after end, lost/found auto-expire after 30 days unless renewed.

## Delivery Roadmap (Single-Dev, Staged)
| Milestone | Target | Build Scope | Documentation Output | Exit Criteria |
|---|---|---|---|---|
| M0 Baseline | Week 1 | Canonicalize `apps/web`, inventory feeds, remove duplicate frontend risk, add env matrix | `00`, `09`, `10` first drafts | Local stack stable with one canonical frontend path |
| M1 Kentucky Core Finish | Weeks 2-3 | Feedly-like UI polish, county-first navigation polish, performance pass, API hardening | `01`, `02`, `06` | KY browsing/search/reader/read-later fully reliable on mobile |
| M2 National Lane | Week 4 | Add curated national feeds, `scope` support, National section UI | `01`, `04`, `05` updates | National stories visible in separate lane without breaking KY flows |
| M3 Weather Hub | Week 5 | NWS county forecasts and alerts, Weather section, severe-alert banner on Today/KY | `07`, `04` updates | Weather data refreshes automatically and county weather pages work |
| M4 Lost & Found MVP | Weeks 6-7 | Submission form, image upload, pending moderation queue, approved board pages | `08`, `04`, `11` updates | End-to-end submit → approve → publish flow works safely |
| M5 PWA Hardening | Week 8 | Offline strategy tuning, cache invalidation, install/update UX, Lighthouse fixes | `06`, `11` updates | PWA installable, key screens usable offline, update flow predictable |
| M6 Cloudflare Migration | Weeks 9-10 | Worker API + ingester parity, D1 migration scripts, R2 wiring, Access admin | `09`, `03`, `05` updates | Production stack running on Pages/Workers/D1/R2 with parity |
| M7 Launch Readiness | Week 11 | Ops dashboards, moderation SOP, incident runbooks, content QA | `10`, `11` finalized | Soft launch ready with monitored ingestion and moderation workflows |

## Feature Additions Beyond Request (Planned)
1. Breaking weather banner on `Today` and `Kentucky` when severe alerts exist.
2. County watch shortcut in drawer for one-tap local updates.
3. Source transparency badges (`source`, `published`, `updated`, `region_scope`).
4. Feed health diagnostics in admin (`last_checked_at`, `error streak`, `last success`).
5. Optional post-launch: web push alerts for weather emergencies and major KY headlines.

## Testing and Acceptance Scenarios
1. Ingest dedupe: same article from repeated feed polls does not create duplicate item IDs.
2. KY county tagging: known county and city mentions map correctly to counties.
3. National isolation: `scope=national` results never pollute county-only views.
4. Pagination correctness: cursor-based paging returns stable, non-overlapping sequences.
5. Search correctness: quotes, `AND`, `OR`, and `-exclude` return expected article sets.
6. Weather refresh: forecast and alerts refresh on schedule and honor county filter.
7. Lost submission validation: missing email, invalid image type, or oversized files are rejected.
8. Moderation gate: pending posts are never visible on public endpoints.
9. PWA offline: previously opened Reader pages and last fetched Today list work offline.
10. PWA update: app displays refresh prompt and safely reloads to new service worker.
11. Admin security: `/admin` endpoints blocked without Cloudflare Access identity.
12. Rate-limit behavior: repeated submission attempts from same IP are throttled.
13. Cloud migration parity: Worker endpoints match local API response shapes for core routes.
14. Cross-device smoke: iOS Safari, Android Chrome, desktop Chrome baseline flows pass.

## Rollout and Operations Plan
1. Environments: `local`, `staging`, `production` with separate D1 DBs and R2 buckets.
2. Deployment flow: Pages preview on PR-equivalent branch, promote to production after smoke suite.
3. Scheduled jobs: feed ingest every 15 minutes; weather refresh every 10 minutes.
4. Monitoring metrics: ingest success rate, median API latency, county-tag coverage, moderation queue age.
5. Alerts: notify on ingest failure streaks, zero-new-items anomalies, weather job failures.
6. Manual fallback: admin endpoint to trigger on-demand ingest/weather refresh.
7. Content governance: moderation SLA target under 2 hours daytime for lost-and-found queue.

## Explicit Assumptions and Defaults
1. Existing markdown docs shown in IDE are not present in this workspace and will be recreated under `docs/`.
2. Curated feed sourcing is editorially controlled by admins; no public source submission in MVP.
3. Weather source remains NOAA/NWS only in MVP to avoid paid API dependencies.
4. Lost-and-found submission is anonymous (no user account), with required email and pre-moderation.
5. Admin authentication is handled exclusively by Cloudflare Access, not in-app login.
6. Kentucky remains the only county-level geography in MVP; national has its own non-county lane.
7. Local Node services remain until Worker/D1 parity is verified; then local stack is kept for dev fallback.
8. Initial launch is US English only and mobile-first.
9. Performance targets: LCP under 2.5s on mobile 4G, API P95 under 600ms for list endpoints.
10. Compliance baseline includes Terms, Privacy, moderation policy, and takedown contact pages before launch.
