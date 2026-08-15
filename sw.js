/* ============================================================================
 * CEMS v9.2.7 Learning-first Service Worker  —  中文學習 · v9.2.7 Learning-first
 * ----------------------------------------------------------------------------
 * 설계 근거
 *   v8.6 영어판 SW 는 install 단계에서 곧바로 skipWaiting() 을 호출해, 배포
 *   직후 학습 중인 세션이 끊길 수 있었다. 중국어판(코더B)은 이를 사용자
 *   승인형으로 바꾸고 navigationPreload, SheetJS 사전 캐시, 타임아웃 fetch 를
 *   도입했다. v9 는 그 설계를 양쪽에 통일 적용한다.
 *
 * 캐시 전략
 *   navigate  : navigationPreload → network(타임아웃) → 캐시된 앱 셸
 *   정적 자산 : stale-while-revalidate
 *   선택 자산 : SheetJS, ts-fsrs 는 실제 기능을 처음 사용할 때만 요청
 * ==========================================================================*/
'use strict';

const APP_CACHE_PREFIX = 'cems-zh-v9-';
const CACHE_VERSION    = 'cems-zh-v9-' + '9.2.7-learning-first-r1';
const BASE_URL   = new URL('./', self.location.href).href;
const APP_SHELL  = new URL('index.html', BASE_URL).href;

const CORE = [
  BASE_URL,
  APP_SHELL,
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
  new URL('learning/learning.css', BASE_URL).href,
  new URL('learning/ux-polish.css', BASE_URL).href,
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
  new URL('content/units/08_zh-tw-a2-confirm-details-lean-008.json', BASE_URL).href
];

/* 선택 의존성은 최초 온라인 실행 때 캐시를 시도한다. 실패하거나 시간이 초과돼도
   앱 셸 설치는 완료하며, 그 경우 엑셀 가져오기·공식 FSRS 대신 제한/폴백 경로를 쓴다. */
const OPTIONAL = []; // 선택 의존성은 실제 사용 시에만 지연 로드한다.

/*
 * 결함 수정 (v9.1.1)
 *   초판은 CORS 요청이 실패하면 no-cors 로 재시도해 opaque 응답을 캐시했다.
 *   opaque 응답은 ES module import 에 사용할 수 없으므로, ts-fsrs 를 그렇게
 *   캐시하면 이후 오프라인에서 공식 FSRS 로드가 항상 실패한다(내장 폴백으로
 *   내려간다). 모듈 자산은 CORS 성공 시에만 캐시한다.
 */
const MODULE_ASSETS = new Set([
  'https://cdn.jsdelivr.net/npm/ts-fsrs@5.4.1/+esm'
]);

async function putSafe(cache, request, response) {
  if (!response) return response;
  const isModule = MODULE_ASSETS.has(request.url);
  const storable = isModule ? response.ok : (response.ok || response.type === 'opaque');
  if (storable) {
    try { await cache.put(request, response.clone()); } catch (_) {}
  }
  return response;
}

async function fetchCore(cache, url) {
  const request = new Request(url, { cache: 'reload' });
  const response = await fetch(request);
  if (!response.ok) throw new Error('Precache failed ' + response.status + ': ' + url);
  await cache.put(url, response.clone());
}

async function fetchOptional(cache, url) {
  try {
    const request = new Request(url, { mode: 'cors', cache: 'reload' });
    const response = await fetchWithTimeout(request, 1800);
    if (!response.ok) throw new Error(String(response.status));
    await cache.put(request, response.clone());
    return;
  } catch (_) { /* 아래에서 판단 */ }

  if (MODULE_ASSETS.has(url)) return;   // opaque 모듈 캐시 금지
  try {
    const request = new Request(url, { mode: 'no-cors', cache: 'reload' });
    const response = await fetchWithTimeout(request, 1800);
    await cache.put(request, response.clone());
  } catch (__) { /* 오프라인 최초 실행/시간 초과: 무시 */ }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.all(CORE.map(url => fetchCore(cache, url)));
    await Promise.all(OPTIONAL.map(url => fetchOptional(cache, url)));
    /* 여기서 즉시 활성화를 강제하지 않는다.
       진행 중인 학습 세션을 보호하기 위해, 앱의 '지금 적용' 버튼이 보내는
       SKIP_WAITING 메시지를 받을 때까지 대기 상태로 남는다. */
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) {}
    }
    /* 같은 오리진의 다른 앱 캐시는 건드리지 않는다 (영어/중국어 공존 대비) */
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
  if (type === 'GET_VERSION') {
    if (event.ports && event.ports[0]) event.ports[0].postMessage({ version: CACHE_VERSION });
    return;
  }
  if (type === 'CACHE_URLS') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_VERSION);
      for (const url of (event.data.urls || [])) {
        try {
          const request = new Request(url);
          await putSafe(cache, request, await fetchWithTimeout(request, 4000));
        } catch (_) {}
      }
    })());
  }
});

async function fetchWithTimeout(request, ms = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(request, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function navigation(event) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const preload = await event.preloadResponse;
    const response = preload || await fetchWithTimeout(event.request);
    if (response && response.ok) await cache.put(APP_SHELL, response.clone());
    return response;
  } catch (_) {
    const shell = await cache.match(APP_SHELL);
    return shell || Response.error();
  }
}

async function staticAsset(event) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(event.request, { ignoreSearch: false });
  const update = (async () => {
    try { return await putSafe(cache, event.request, await fetchWithTimeout(event.request, 4000)); }
    catch (_) { return null; }
  })();
  if (cached) { event.waitUntil(update); return cached; }
  return (await update) || Response.error();
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (request.mode === 'navigate') { event.respondWith(navigation(event)); return; }
  if (url.origin === self.location.origin || OPTIONAL.some(u => request.url.startsWith(u.split('@')[0]))) {
    event.respondWith(staticAsset(event));
  }
});
