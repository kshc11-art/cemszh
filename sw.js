/* CEMS v9.5.0 service worker (Chinese)
 * ---------------------------------------------------------------------------
 * v9.3.2 대비 구조
 *  1) 프리캐시를 CRITICAL / SHELL_OPTIONAL / DEFERRED_CONTENT 3단계로 분리했다.
 *     v9.3.2 는 29MB 시드를 포함한 32MB 를 순차 await 로 받으면서
 *     하나라도 실패하면 install 전체가 reject 되어 오프라인 기능이 통째로 죽었다.
 *  2) 선택 자산은 부분 실패를 허용한다(allSettled).
 *  3) 대용량 콘텐츠는 activate 이후 백그라운드로 채운다.
 *  4) 문서(.md) 파일은 프리캐시 대상에서 제외했다.
 *
 * v9.5.0 감사 대응
 *  C-1 지연 콘텐츠가 영구 미완성으로 남던 문제: fetch 이벤트가 기회적으로 재개하고
 *      waitUntil 로 SW 수명을 연장한다(아래 ensureDeferredFill 주석 참고).
 *  C-2 첫 실행 시드 중복 다운로드: in-flight 요청 맵으로 동시 fetch 를 하나로 합친다.
 *  C-3 navigation 이 5xx 를 그대로 내보내던 문제: 캐시된 셸로 폴백한다.
 *  C-4 206 등 비-200 성공 응답을 Cache.put 에 넘겨 요청 자체가 실패하던 문제.
 *  C-5 구버전 캐시 잔류: 'cems' 로 시작하는 현재 버전 외 캐시를 정리한다.
 *  C-6 index.html 이 두 URL 로 중복 프리캐시되던 2.1MB 낭비.
 *  C-7 무제한 캐시 증식: 선언 목록 밖 항목에 상한을 두고 FIFO 로 정리한다.
 *  C-8 복구 파일(v944/cems-v9.4.4-recovery.json)을 지연 캐시 목록에 추가.
 *  C-9 캐시 버전 9.5.0.
 *
 * 동일 오리진 GET 만 다룬다. Gemini Worker 호출과 모든 교차 출처는 항상 네트워크.
 * ==========================================================================*/
'use strict';

const APP_CACHE_PREFIX = 'cems-zh-v9-';
/* C-5: v9.3.2 이전 빌드의 캐시 이름을 알 수 없다(헤더 주석은 32MB 캐시의 존재만 인정한다).
   'cems' 로 시작하는 이 앱 계열 캐시는 현재 버전만 남기고 전부 지운다.
   다른 앱의 캐시를 건드리지 않도록 접두사 자체는 좁게 유지한다. */
const LEGACY_CACHE_PREFIX = 'cems';
const CACHE_VERSION = APP_CACHE_PREFIX + '9.5.0';
const LOG_TAG = '[CEMS SW 9.5.0]';
const BASE_URL = new URL('./', self.location.href).href;
const APP_SHELL = new URL('index.html', BASE_URL).href;

const abs = (path) => new URL(path, BASE_URL).href;

/* C-6: abs('') 와 abs('index.html') 을 둘 다 프리캐시하면 1.07MB 짜리 셸이
   캐시에 2벌 저장된다(2.1MB). 실제로 받는 것은 APP_SHELL 하나뿐이고,
   디렉터리 URL 로 들어온 내비게이션도 navigation() 에서 같은 셸로 귀결된다. */
const SHELL_ALIAS = abs('');

/* 이것이 없으면 앱이 뜨지 않는다. 실패 시 install 중단. */
const CRITICAL = [
  APP_SHELL,
  abs('manifest.webmanifest'),
  abs('learning/cems-9.4.1-schema.js'),
  abs('learning/content-schema.js'),
  abs('learning/exercise-engine.js'),
  abs('learning/content-studio.js'),
  abs('learning/progress-engine.js'),
  abs('learning/scheduler.js'),
  abs('learning/learning-ui.js'),
  abs('learning/ux-polish.js'),
  abs('learning/cems-9.4.1-stable.js'),
  abs('learning/cems-9.4.1-deck-groups.js?v=9.5.0'),
  abs('learning/cems-9.4.1-learning-hub.js'),
  abs('learning/learning.css'),
  abs('learning/ux-polish.css'),
  abs('learning/cems-9.4.1-mobile.css'),
  abs('learning/cems-9.4.1-stable.css'),
  abs('learning/cems-9.4.1-deck-groups.css'),
  abs('learning/cems-9.4.1-learning-hub.css'),
  abs('learning/cems-9.4.1-theme.css'),
  abs('learning/cems-9.4.1-ui.js'),
  abs('v944/cems-v9.4.4.css?v=9.5.0'),
  abs('v944/cems-v9.4.4-final.css?v=9.5.0'),
  abs('v944/cems-v9.4.4.js?v=9.5.0'),
  abs('v944/cems-v9.4.4-final.js?v=9.5.0')
];

/* 있으면 좋지만 없어도 앱은 뜬다. 실패해도 install 은 계속. */
const SHELL_OPTIONAL = [
  abs('VERSION'),
  abs('REVISION'),
  abs('v944/build-info.json'),
  abs('icons/icon-180.png'),
  abs('icons/icon-192.png'),
  abs('icons/icon-512.png'),
  abs('icons/icon-maskable-512.png'),
  abs('v944/cems-v9.4.4-import-worker.js?v=9.5.0'),
  abs('v944/zh-tw-travel-day3.json'),
  abs('content/data_catalog_v932.json'),
  abs('content/lean_unit.json'),
  abs('content/lean_pack.json'),
  abs('content/lean_course.json'),
  abs('content/lean_course_bundle.json')
];

/* 대용량. activate 이후 백그라운드로 천천히 채운다. */
const DEFERRED_CONTENT = [
  abs('content/cems_zh_seed_v940.json'),
  /* C-8: 시드 무결성 검사가 깨진 레코드를 발견하면 v944/cems-v9.4.4.js 의
     RECOVERY_URL 이 이 파일을 받는다. 캐시 목록 어디에도 없어서
     오프라인 첫 실행에서는 복구가 아예 불가능했다. */
  abs('v944/cems-v9.4.4-recovery.json'),
  abs('content/units/01_zh-a2-restaurant-remove-ingredient-lean-001.json'),
  abs('content/units/02_zh-tw-a2-clarify-repeat-lean-002.json'),
  abs('content/units/03_zh-tw-a2-ask-directions-lean-003.json'),
  abs('content/units/04_zh-tw-a2-schedule-change-lean-004.json'),
  abs('content/units/05_zh-tw-a2-report-problem-lean-005.json'),
  abs('content/units/06_zh-tw-a2-compare-choose-lean-006.json'),
  abs('content/units/07_zh-tw-a2-delay-update-lean-007.json'),
  abs('content/units/08_zh-tw-a2-confirm-details-lean-008.json')
];

/* C-7: 선언된 자산 집합. 이 목록 밖의 항목만 상한 관리 대상이다. */
const DECLARED_URLS = new Set([SHELL_ALIAS, ...CRITICAL, ...SHELL_OPTIONAL, ...DEFERRED_CONTENT]);
const RUNTIME_CACHE_LIMIT = 60;

async function fetchWithTimeout(request, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(request, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

/* ---------------------------------------------------------------------------
 * C-2 in-flight 요청 병합
 * 첫 실행에서 앱의 시드 로드(learning/cems-9.4.1-stable.js 의 loadSeed)와
 * fillDeferred 가 같은 14.6MB 파일을 동시에 받아 모바일에서 최대 30MB 를 썼다.
 * cache.match 중복 제거는 이미 받은 것만 거를 뿐 동시 진행은 못 막는다.
 *
 * Response 본문은 한 번만 읽을 수 있으므로 공유 Response 를 그대로 여러 곳에
 * 넘길 수 없다. 그래서 병합 작업이 캐시에 넣는 데까지 책임지고, 호출자는
 * 캐시에서 각자 새 Response 를 꺼내 쓴다. 캐시에 넣지 못한 응답(C-4 의 206 등)만
 * 선착순으로 원본을 넘기고, 그 뒤 호출자는 직접 다시 받는다.
 * ------------------------------------------------------------------------ */
const inFlight = new Map();

function fetchShared(request, timeoutMs) {
  const key = request.url;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = (async () => {
    const response = await fetchWithTimeout(request, timeoutMs);
    /* C-4: 206 Partial Content 는 ok 로 판정되지만 Cache.put 이 TypeError 로 거부한다.
       예전에는 그 예외를 catch 가 삼켜 요청 자체가 Response.error() 로 실패했다.
       200 만 캐시에 넣고, 그 밖의 성공 응답은 캐시 없이 그대로 흘려보낸다. */
    const stored = Boolean(response && response.status === 200);
    if (stored) {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put(request, response.clone());
    }
    return { response, stored, declared: DECLARED_URLS.has(key), claimed: false };
  })();

  inFlight.set(key, task);
  task.then(() => {}, () => {}).then(() => { if (inFlight.get(key) === task) inFlight.delete(key); });
  return task;
}

/* 공유 결과에서 살아 있는 Response 를 한 번만 넘겨준다. */
async function takeResponse(result, request, timeoutMs) {
  if (!result.claimed) { result.claimed = true; return result.response; }
  return fetchWithTimeout(request, timeoutMs);
}

/* C-7: staticAsset 이 동일 오리진 GET 성공 응답을 전부 캐시하므로 쿼리 변형이
   생기면 무한히 누적된다. 선언 목록 밖 항목만 세어 상한을 넘으면 오래된 것부터
   지운다. Cache.keys() 는 삽입 순서를 보장하므로 별도 메타데이터 없이 FIFO 가 된다. */
async function trimRuntimeCache() {
  try {
    const cache = await caches.open(CACHE_VERSION);
    const keys = await cache.keys();
    const extras = keys.filter((request) => !DECLARED_URLS.has(request.url));
    const overflow = extras.length - RUNTIME_CACHE_LIMIT;
    for (let i = 0; i < overflow; i += 1) await cache.delete(extras[i]);
  } catch (error) {
    console.warn(LOG_TAG, '런타임 캐시 정리 실패:', error && error.message);
  }
}

async function precacheOne(cache, url, options) {
  const opts = options || {};
  const reload = opts.reload !== false;
  const timeout = opts.timeout || 8000;
  const request = new Request(url, reload
    ? { cache: 'reload', credentials: 'same-origin' }
    : { credentials: 'same-origin' });
  const result = await fetchShared(request, timeout);
  if (!result.response || !result.response.ok) {
    throw new Error('Precache ' + (result.response && result.response.status) + ': ' + url);
  }
  if (!result.stored) {
    /* 200 이 아니면 캐시에 들어가지 않았다. 프리캐시로서는 실패로 본다. */
    throw new Error('Precache uncacheable ' + result.response.status + ': ' + url);
  }
  return url;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // 필수: 하나라도 실패하면 install 실패로 남겨 재시도를 유도한다.
    for (const url of CRITICAL) await precacheOne(cache, url);
    // 선택: 실패는 기록만 하고 넘어간다.
    const results = await Promise.allSettled(SHELL_OPTIONAL.map(url => precacheOne(cache, url)));
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed) console.warn(LOG_TAG, '선택 자산 ' + failed + '개 캐시 실패. 앱 동작에는 영향 없음.');
    // skipWaiting 호출 안 함: 학습 세션 중 교체를 막는다.
  })());
});

/* ---------------------------------------------------------------------------
 * C-1 지연 콘텐츠 완주 보장
 *
 * 예전 구조는 activate 의 waitUntil 밖에서 fillDeferred() 를 실행했다.
 * activate 의 waitUntil 이 끝나는 순간 SW 는 유휴 종료 대상이 되고 14.6MB
 * 다운로드가 통째로 끊긴다. activate 는 버전당 1회뿐이고, 유일한 재시도 트리거인
 * PREFETCH_CONTENT 메시지를 보내는 클라이언트 코드는 저장소에 한 건도 없었다.
 * 즉 한 번 끊기면 그 버전에서는 영원히 미완성이었다.
 *
 * 주의: activate 의 waitUntil 이 걸려 있는 동안 SW 상태는 'activating' 이고,
 * 명세상 fetch 이벤트는 'activated' 가 될 때까지 대기한다. 그러므로 15MB
 * 다운로드를 activate 의 waitUntil 에 직접 매달면 셸 활성화가 아니라 앱 전체가
 * 그 시간만큼 멈춘다(업데이트 설치 후 첫 실행에서 특히 치명적이다).
 * 그래서 수명 연장은 activate 가 아니라 fetch/message 이벤트의 waitUntil 로 건다.
 * fetch 이벤트는 respondWith 와 독립적이라 응답을 지연시키지 않으면서
 * SW 가 살아 있도록 유지해 준다.
 * ------------------------------------------------------------------------ */
let deferredFill = null;        // 진행 중인 fillDeferred 프로미스
let deferredComplete = false;   // 이번 SW 수명에서 전부 채웠는가
let deferredNextAttemptAt = 0;  // 실패 후 재시도 간격(폭주 방지)
const DEFERRED_RETRY_MS = 30000;

async function fillDeferred() {
  const cache = await caches.open(CACHE_VERSION);
  let missing = 0;
  for (const url of DEFERRED_CONTENT) {
    try {
      if (await cache.match(url)) continue;
      await precacheOne(cache, url, { reload: false, timeout: 120000 });
    } catch (error) {
      missing += 1;
      console.warn(LOG_TAG, '지연 캐시 보류:', url, error && error.message);
    }
  }
  deferredComplete = missing === 0;
  if (!deferredComplete) deferredNextAttemptAt = Date.now() + DEFERRED_RETRY_MS;
  return deferredComplete;
}

/* 중복 실행을 막으면서 필요할 때만 재개한다. 이미 돌고 있으면 그 프로미스를 돌려주므로
   호출자는 event.waitUntil(ensureDeferredFill()) 로 SW 수명을 연장할 수 있다. */
function ensureDeferredFill(force) {
  if (deferredFill) return deferredFill;
  if (!force) {
    if (deferredComplete) return null;
    if (Date.now() < deferredNextAttemptAt) return null;
  }
  deferredFill = fillDeferred()
    .catch((error) => { console.warn(LOG_TAG, '지연 캐시 실패:', error && error.message); return false; })
    .then((done) => { deferredFill = null; return done; });
  return deferredFill;
}

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) {}
    }
    for (const key of await caches.keys()) {
      // C-5: 'cems' 계열 중 현재 버전이 아닌 캐시를 모두 정리한다.
      if (key.startsWith(LEGACY_CACHE_PREFIX) && key !== CACHE_VERSION) await caches.delete(key);
    }
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: 'SW_ACTIVATED', version: CACHE_VERSION });
    /* 셸 준비가 끝난 뒤 지연 채우기를 시작한다. 여기서 await 하지 않는 이유는
       위 C-1 주석 참고(activating 상태가 길어지면 fetch 가 전부 대기한다).
       실제 완주는 아래 fetch 핸들러의 waitUntil 이 이어받는다. */
    ensureDeferredFill(true);
  })());
});

self.addEventListener('message', event => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (type === 'PREFETCH_CONTENT') { event.waitUntil(ensureDeferredFill(true) || Promise.resolve()); return; }
  if (type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: CACHE_VERSION });
    return;
  }
  if (type === 'CACHE_STATUS' && event.ports && event.ports[0]) {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_VERSION);
      let cached = 0;
      for (const url of DEFERRED_CONTENT) if (await cache.match(url)) cached++;
      event.ports[0].postMessage({ version: CACHE_VERSION, deferred: DEFERRED_CONTENT.length, cached: cached });
    })());
    return;
  }
  if (type === 'CACHE_URLS') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_VERSION);
      for (const raw of (event.data.urls || [])) {
        try {
          const url = new URL(raw, BASE_URL);
          if (url.origin !== self.location.origin) continue;
          await precacheOne(cache, url.href, { reload: false, timeout: 15000 });
        } catch (_) {}
      }
      await trimRuntimeCache();
    })());
  }
});

async function navigation(event) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const preload = await event.preloadResponse;
    const response = preload || await fetchWithTimeout(event.request, 6000);
    if (response && response.ok) {
      // C-4: 200 만 캐시에 넣는다.
      if (response.status === 200) await cache.put(APP_SHELL, response.clone());
      return response;
    }
    /* C-3: 예전에는 !ok 응답을 그대로 반환해서, 호스트가 5xx 를 주면
       캐시된 셸이 멀쩡히 있어도 사용자에게 오류 페이지가 떴다. */
    const shell = await cache.match(APP_SHELL);
    if (shell) return shell;
    return response || Response.error();
  } catch (_) {
    return (await cache.match(APP_SHELL)) || Response.error();
  }
}

/* 대용량 시드는 stale-while-revalidate 의 재검증 대상에서 뺀다.
   14MB 를 매번 다시 받으면 모바일 데이터가 그대로 소모된다. */
const NO_REVALIDATE = /\/content\/(cems_zh_seed_v940\.json)$|\/v944\/cems-v9\.4\.4-recovery\.json$/;

async function staticAsset(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached && NO_REVALIDATE.test(new URL(request.url).pathname)) return cached;

  if (cached) {
    // stale-while-revalidate: 응답은 즉시 돌려주고 갱신만 뒤로 넘긴다.
    event.waitUntil(fetchShared(request, 8000).then(async (result) => {
      if (result.stored && !result.declared) await trimRuntimeCache();
    }).catch(() => {}));
    return cached;
  }

  try {
    const result = await fetchShared(request, 8000);
    if (result.stored) {
      if (!result.declared) event.waitUntil(trimRuntimeCache());
      const fresh = await cache.match(request, { ignoreSearch: false });
      if (fresh) return fresh;
    }
    return (await takeResponse(result, request, 8000)) || Response.error();
  } catch (_) {
    return Response.error();
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  /* 9.5.1: 같은 오리진 GET 을 전부 stale-while-revalidate 로 캐시하면,
     호출부가 cache:'no-store' 로 명시한 요청까지 캐시된 응답이 돌아간다.
     상태 조회처럼 최신값이 목적인 요청은 오래된 값을 진짜로 착각하게 만든다
     (모의 Worker 의 /health 로 실측: 두 번째 응답이 달라졌는데 첫 응답이 나왔다).
     내비게이션은 오프라인 셸 폴백이 필요하므로 그대로 둔다. */
  if (request.mode !== 'navigate' && (request.cache === 'no-store' || request.cache === 'reload')) return;

  /* C-1: 지연 캐시가 비어 있으면 기회적으로 재개한다.
     respondWith 와 별개인 waitUntil 이라 이 요청의 응답을 늦추지 않으며,
     동시에 SW 가 유휴 종료되지 않도록 수명을 붙잡아 준다. */
  if (!deferredComplete) {
    const pending = ensureDeferredFill(false);
    if (pending) event.waitUntil(pending);
  }

  if (request.mode === 'navigate') { event.respondWith(navigation(event)); return; }
  event.respondWith(staticAsset(event));
});
