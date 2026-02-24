/**
 * Minimal service worker that immediately self-unregisters.
 *
 * This file replaces the legacy CRA-generated service worker that used the
 * deprecated `StorageType.persistent` API (via workbox-expiration v5).
 * Existing visitors whose browsers had the old service worker cached will
 * receive this file on the next update check (≤4 h cadence), at which point
 * the worker activates, cleans up all caches, and removes itself.
 *
 * The main app (`index.js`) already calls `serviceWorkerRegistration.unregister()`
 * so no new registrations happen from the React side.
 */

// Activate immediately so we don't wait for tabs to close.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', async () => {
  // Delete all workbox/app caches from the old service worker.
  const cacheNames = await caches.keys();
  await Promise.all(cacheNames.map((name) => caches.delete(name)));

  // Unregister this service worker so it stops intercepting fetches.
  // Uses navigator.storage (standardised) instead of the deprecated
  // StorageType.persistent / webkitStorageInfo APIs.
  await self.registration.unregister();
});
