self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
    await self.registration.unregister();

    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    await Promise.all(
      clients.map((client) => {
        if ('navigate' in client) {
          return client.navigate(client.url);
        }
        return Promise.resolve();
      }),
    );
  })());
});

self.addEventListener('fetch', () => {
  // This cleanup worker never serves cached content.
});
