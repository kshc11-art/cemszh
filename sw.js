/* CEMS v9.3.1 Stable recovery service worker (Chinese)
 * Same-origin app shell only. Cross-origin requests and all non-GET requests
 * (including Gemini Worker calls) always bypass the cache.
 */
'use strict';

const APP_CACHE_PREFIX = 'cems-zh-v9-';
const CACHE_VERSION = APP_CACHE_PREFIX + '9.3.1-stable-recovery-r1';
const BASE_URL = new URL('./', self.location.href).href;
const APP_SHELL = new URL('index.html', BASE_URL).href;
const CORE = [
  new URL('', BASE_URL).href,
  new URL('index.html', BASE_URL).href,
  new URL('manifest.webmanifest', BASE_URL).href,
  new URL('icons/icon-180.png', BASE_URL).href,
  new URL('icons/icon-192.png', BASE_URL).href,
  new URL('icons/icon-512.png', BASE_URL).href,
  new URL('icons/icon-maskable-512.png', BASE_URL).href,
  new URL('learning/content-schema.js', BASE_URL).href,
  new URL('learning/exercise-engine.js', BASE_URL).href,
  new URL('learning/content-studio.js', BASE_URL).href,
  new URL('learning/progress-engine.js', BASE_URL).href,
  new URL('learning/scheduler.js', BASE_URL).href,
  new URL('learning/learning-ui.js', BASE_URL).href,
  new URL('learning/ux-polish.js', BASE_URL).href,
  new URL('learning/cems-9.3.1-stable.js', BASE_URL).href,
  new URL('learning/learning.css', BASE_URL).href,
  new URL('learning/ux-polish.css', BASE_URL).href,
  new URL('learning/cems-9.2.8-mobile.css', BASE_URL).href,
  new URL('learning/cems-9.3.1-stable.css', BASE_URL).href,
  new URL('authoring/CEMS_CONTENT_ADDITION_GUIDE_v4.md', BASE_URL).href,
  new URL('content/lean_unit.json', BASE_URL).href,
  new URL('content/lean_pack.json', BASE_URL).href,
  new URL('content/lean_course.json', BASE_URL).href,
  new URL('content/lean_course_bundle.json', BASE_URL).href,
  new URL('content/units/01_zh-a2-restaurant-remove-ingredient-lean-001.json', BASE_URL).href,
  new URL('content/units/02_zh-tw-a2-clarify-repeat-lean-002.json', BASE_URL).href,
  new URL('content/units/03_zh-tw-a2-ask-directions-lean-003.json', BASE_URL).href,
  new URL('content/units/04_zh-tw-a2-schedule-change-lean-004.json', BASE_URL).href,
  new URL('content/units/05_zh-tw-a2-report-problem-lean-005.json', BASE_URL).href,
  new URL('content/units/06_zh-tw-a2-compare-choose-lean-006.json', BASE_URL).href,
  new URL('content/units/07_zh-tw-a2-delay-update-lean-007.json', BASE_URL).href,
  new URL('content/units/08_zh-tw-a2-confirm-details-lean-008.json', BASE_URL).href,
  new URL('content/acc1_seed_v931.json', BASE_URL).href
];

async function fetchWithTimeout(request, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(request, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function fetchCore(cache, url) {
  const request = new Request(url, { cache: 'reload', credentials: 'same-origin' });
  const response = await fetch(request);
  if (!response.ok) throw new Error(`Precache failed ${response.status}: ${url}`);
  await cache.put(request, response.clone());
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    for (const url of CORE) await fetchCore(cache, url);
    // Do not call skipWaiting here: a running learning session should not be replaced silently.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) {}
    }
    for (const key of await caches.keys()) {
      if (key.startsWith(APP_CACHE_PREFIX) && key !== CACHE_VERSION) await caches.delete(key);
    }
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: 'SW_ACTIVATED', version: CACHE_VERSION });
  })());
});

self.addEventListener('message', event => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: CACHE_VERSION });
    return;
  }
  if (type === 'CACHE_URLS') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_VERSION);
      for (const raw of (event.data.urls || [])) {
        try {
          const url = new URL(raw, BASE_URL);
          if (url.origin !== self.location.origin) continue;
          const request = new Request(url.href, { method: 'GET', credentials: 'same-origin' });
          const response = await fetchWithTimeout(request, 5000);
          if (response.ok) await cache.put(request, response.clone());
        } catch (_) {}
      }
    })());
  }
});

async function navigation(event) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const preload = await event.preloadResponse;
    const response = preload || await fetchWithTimeout(event.request, 5000);
    if (response && response.ok) await cache.put(APP_SHELL, response.clone());
    return response;
  } catch (_) {
    return (await cache.match(APP_SHELL)) || Response.error();
  }
}

async function staticAsset(event) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(event.request, { ignoreSearch: false });
  const update = (async () => {
    try {
      const response = await fetchWithTimeout(event.request, 5000);
      if (response && response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch (_) { return null; }
  })();
  if (cached) { event.waitUntil(update); return cached; }
  return (await update) || Response.error();
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // Gemini proxy, CDN fallbacks, POST bodies and all cross-origin traffic remain network-only.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') { event.respondWith(navigation(event)); return; }
  event.respondWith(staticAsset(event));
});
