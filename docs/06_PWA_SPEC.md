# PWA Specification

## Stack
- Vite + React + `vite-plugin-pwa`
- Service Worker generated via Workbox.

## Installability
- Manifest served at `manifest.webmanifest`.
- Standalone display mode.
- Icons: 192 and 512 PNG.

## Caching Strategy
- API routes (`/api/*`): `NetworkFirst`, 1-hour TTL.
- Images: `StaleWhileRevalidate`, 7-day TTL.
- Static assets precached by Workbox.

## Offline Behavior
- Reader uses local Dexie cache for last-opened items.
- Read and saved state stored locally (no account sync).
- Previously fetched lists/images remain available based on SW cache.

## Update UX
- `registerSW` uses prompt mode.
- App emits `pwa:need-refresh` and `pwa:offline-ready` events.
- UI can present refresh/ready banners.

## Performance Budgets
- Mobile LCP target: < 2.5s
- JS bundle baseline monitored each build.
- API list endpoint target: P95 < 600ms local/network permitting.

## Hardening Checklist
- Add explicit update banner UI.
- Add stale content timestamp in Today/National lists.
- Add cache bust strategy for image corruption edge cases.
- Validate offline-first behavior on iOS Safari and Android Chrome.
