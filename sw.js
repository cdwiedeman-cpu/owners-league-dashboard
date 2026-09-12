/* THIS WORKER RETIRES ITSELF.
 *
 * Casey's own dashboard used to live at the root of this site, and this file was its offline
 * cache. The page moved on 12 Sep 2026, because anybody handed the league address could delete
 * "league" from the end of it and land on his projections.
 *
 * A worker outlives the page that installed it. Left as it was, a browser that had opened the old
 * root page could keep serving that CACHED COPY from this address for weeks. So this version
 * throws away everything it cached and unregisters itself the moment it runs. Deleting the file
 * would not do the job: a browser with the old worker already installed would never fetch a
 * replacement it could act on.
 */
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.registration.unregister(); })
      .then(function () { return self.clients.matchAll({type: 'window'}); })
      .then(function (cs) { cs.forEach(function (c) { c.navigate(c.url); }); })
  );
});
