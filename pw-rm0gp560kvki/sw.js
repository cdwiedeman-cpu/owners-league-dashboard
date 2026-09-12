// Owners League Season Dashboard — service worker.
//
// Its only job: when the app is opened (from the home screen icon or Safari), always go to the
// network for the page itself rather than letting iOS reuse a stale cached copy. Casey, 31 Aug
// 2026: had to delete and re-add the home screen icon to see an update — that's the standard
// fix, but not one he should have to repeat every week. This is the real fix: intercept the
// page's own load and force `cache:'reload'`, which bypasses the HTTP cache outright. If the
// network is unreachable, fall back to whatever's cached so the app doesn't just break offline.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const isPageLoad = req.mode === 'navigate' || req.destination === 'document';
  if (!isPageLoad) return; // everything else (ESPN calls, etc.) behaves normally

  event.respondWith(
    fetch(req, { cache: 'reload' }).catch(() => caches.match(req))
  );
});
