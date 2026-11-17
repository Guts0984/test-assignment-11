/* Courier service worker: opens the app shell without a network, from the FIRST visit.
 * - install: fetch and keep /courier right away (the worker is installed by the signed-in courier page, so the request
 *   carries the session cookie). Without this, the page is only cached after a second, online navigation.
 * - the page also sends the /_next/static files it already loaded ("precache" message): those were fetched before this
 *   worker controlled the page, so it never saw them.
 * - /_next/static/*, icons, manifest: cache-first (content-hashed, safe to keep)
 * - navigations to /courier: network-first, falling back to the last copy
 * - navigations to /login: network, falling back to the copy kept at install (offline sign-out)
 * API calls go to another origin and are never touched here: offline actions live in IndexedDB, not in this cache. */
const CACHE = 'courier-shell-v3';
const SHELL = '/courier';
const LOGIN = '/login';

async function keepShell(cache) {
  try {
    const res = await fetch(SHELL, { credentials: 'same-origin', redirect: 'manual' });
    // a redirect (e.g. to /login when signed out) is not the app: never keep it
    if (res.ok && res.type !== 'opaqueredirect') await cache.put(SHELL, res);
  } catch {
    /* offline during install: the next online visit keeps it */
  }
  // The sign-in page is public. Fetched WITHOUT the session cookie, so it is the real page and not a redirect into the
  // app. Signing out while offline lands here instead of on the browser's "no internet" page.
  try {
    const res = await fetch(LOGIN, { credentials: 'omit', redirect: 'manual' });
    if (res.ok && res.type !== 'opaqueredirect') await cache.put(LOGIN, res);
  } catch {
    /* kept on the next online visit */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(keepShell)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'precache') return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await keepShell(cache);
      const urls = (Array.isArray(data.urls) ? data.urls : [])
        .map((u) => {
          try {
            return new URL(u, self.location.origin);
          } catch {
            return null;
          }
        })
        .filter(
          (u) => u && u.origin === self.location.origin && u.pathname.startsWith('/_next/static/'),
        );
      await Promise.all(
        urls.map(async (u) => {
          if (await cache.match(u.href)) return;
          try {
            const res = await fetch(u.href);
            if (res.ok) await cache.put(u.href, res);
          } catch {
            /* retried on the next visit */
          }
        }),
      );
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isAsset =
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest';
  if (isAsset) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  if (req.mode === 'navigate' && url.pathname === LOGIN) {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          return (
            (await (await caches.open(CACHE)).match(LOGIN)) ||
            new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
          );
        }
      })(),
    );
    return;
  }

  if (req.mode === 'navigate' && url.pathname.startsWith(SHELL)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(SHELL, res.clone());
          return res;
        } catch {
          return (
            (await cache.match(SHELL)) ||
            new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
          );
        }
      })(),
    );
  }
});
