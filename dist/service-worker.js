/**
 * Minimal "cleanup" service worker.
 *
 * Replaces the legacy CRA/Workbox service worker that used the deprecated
 * `StorageType.persistent` API (via workbox-expiration v5 IDBKeyRange quota
 * tracking). Any browser that still has the old SW cached will receive this
 * file on the next update check, skip-wait to activate immediately, delete
 * all caches AND all Workbox IndexedDB databases, then unregister itself.
 *
 * The main app (index.js) already calls serviceWorkerRegistration.unregister()
 * so no new SW registrations happen from the React bundle.
 */

// Activate immediately without waiting for existing tabs to close.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', async () => {
  // 1. Delete all Cache Storage entries from the old Workbox service worker.
  try {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map((name) => caches.delete(name)));
  } catch (_) {
    // best-effort
  }

  // 2. Delete Workbox IndexedDB databases.
  // workbox-expiration v5 creates IDBs named "workbox-expiration" (and
  // others) that called the deprecated StorageType.persistent quota API.
  // Deleting them removes the deprecation warning from Lighthouse.
  if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
    try {
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs
          .filter((db) => db.name && (
            db.name.startsWith('workbox') ||
            db.name.startsWith('firebase') ||
            db.name === 'keyval-store'
          ))
          .map((db) => indexedDB.deleteDatabase(db.name))
      );
    } catch (_) {
      // best-effort; indexedDB.databases() may not be available in all browsers
    }
  }

  // 3. Unregister self so this SW stops intercepting any future fetches.
  try {
    await self.registration.unregister();
  } catch (_) {
    // best-effort
  }
});
