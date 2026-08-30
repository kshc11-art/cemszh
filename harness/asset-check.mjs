/**
 * CEMS 자산 선언 대조 검사
 * ---------------------------------------------------------------------------
 * 사용법: node asset-check.mjs [앱디렉터리]        (기본값: 상위 디렉터리)
 *
 * 확인하는 것
 *   1. sw.js 가 선언한 모든 자산이 디스크에 실제로 존재하는가
 *   2. index.html 이 참조하는 동일 오리진 자산이 sw.js 에 선언되어 있는가
 *      (선언이 빠지면 오프라인에서 그 자산만 404 가 된다)
 *   3. ?v= 캐시버스팅 쿼리가 index.html 과 sw.js 사이에서 일치하는가
 *      (index.html 만 ?v=9.5.0 으로 올리면 sw.js 는 옛 URL 을 캐시해
 *       프리캐시가 전부 헛돌고 오프라인 셸이 깨진다)
 *   4. JS 에서 동적으로 부르는 자산(SEED_URL, RECOVERY_URL, WORKER_URL 등)이
 *      sw.js 에 선언되어 있는가
 *   5. manifest.webmanifest 의 아이콘·start_url·shortcuts 대상이 존재하는가
 *
 * 불일치가 하나라도 있으면 exit 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const APP_DIR = path.resolve(process.argv[2] || path.resolve('..'));
const FAKE_ORIGIN = 'https://cems.test';
const FAKE_BASE = `${FAKE_ORIGIN}/app/`;

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

/* --- sw.js 를 샌드박스에서 평가해 선언 목록을 그대로 얻는다 --------------- */
function loadServiceWorker(file) {
  const src = fs.readFileSync(file, 'utf8');
  const epilogue = `
;globalThis.__SW__ = {
  CACHE_VERSION,
  APP_SHELL,
  BASE_URL,
  SHELL_ALIAS: typeof SHELL_ALIAS === 'string' ? SHELL_ALIAS : null,
  CRITICAL,
  SHELL_OPTIONAL,
  DEFERRED_CONTENT
};`;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout() { return 0; },
    clearTimeout() {},
    URL,
    URLSearchParams,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    Request: class { constructor(url) { this.url = String(url); } },
    Response: class {},
    caches: { open: async () => ({}), keys: async () => [], delete: async () => false },
    self: {
      location: { href: `${FAKE_BASE}sw.js`, origin: FAKE_ORIGIN },
      addEventListener() {},
      registration: { navigationPreload: null },
      clients: { claim: async () => {}, matchAll: async () => [] },
      skipWaiting() {},
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(src + epilogue, { filename: file }).runInContext(sandbox);
  return sandbox.__SW__;
}

/* --- 경로 유틸 ------------------------------------------------------------ */
const isLocalRef = (ref) =>
  ref &&
  !ref.includes('${') &&
  !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);

function toAbs(ref) {
  try { return new URL(ref, FAKE_BASE).href; } catch { return null; }
}

/** 절대 URL -> 앱 디렉터리 기준 상대 파일 경로 (쿼리·해시 제거) */
function toFilePath(absUrl) {
  const u = new URL(absUrl);
  if (u.origin !== FAKE_ORIGIN) return null;
  let rel = u.pathname.replace(/^\/app\/?/, '');
  if (rel === '') rel = 'index.html';
  return rel;
}

const stripQuery = (absUrl) => absUrl.split('?')[0].split('#')[0];
const queryOf = (absUrl) => { const i = absUrl.indexOf('?'); return i === -1 ? '' : absUrl.slice(i); };

/* --- JS 주석 제거 (문자열·정규식 리터럴 보존) -----------------------------
 * 정규식 리터럴을 건너뛰지 않으면 /['"]/ 같은 패턴이 문자열 시작으로 오인되어
 * 그 뒤 주석이 통째로 살아남고, 주석 안의 사문화된 경로가 참조로 잡힌다. */
function stripComments(src) {
  let out = '';
  let i = 0;
  let lastSignificant = '';
  const regexAllowedBefore = /[=(,:[!&|?{};+\-*%~^<>]/;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c; i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      lastSignificant = quote;
      continue;
    }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === '/' && (lastSignificant === '' || regexAllowedBefore.test(lastSignificant))) {
      // 정규식 리터럴: 문자 클래스 안의 / 와 이스케이프를 존중하며 건너뛴다.
      let inClass = false;
      out += c; i += 1;
      while (i < src.length) {
        const r = src[i];
        if (r === '\\') { out += r + (src[i + 1] ?? ''); i += 2; continue; }
        if (r === '\n') break;                       // 정규식이 아니었다 — 포기
        out += r; i += 1;
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
      }
      lastSignificant = '/';
      continue;
    }
    out += c; i += 1;
    if (!/\s/.test(c)) lastSignificant = c;
  }
  return out;
}

/* --- 실행 ----------------------------------------------------------------- */
const swFile = path.join(APP_DIR, 'sw.js');
const htmlFile = path.join(APP_DIR, 'index.html');
const manifestFile = path.join(APP_DIR, 'manifest.webmanifest');

for (const f of [swFile, htmlFile, manifestFile]) {
  if (!fs.existsSync(f)) { console.error(`없음: ${f}`); process.exit(1); }
}

let sw;
try { sw = loadServiceWorker(swFile); }
catch (e) { console.error(`sw.js 평가 실패: ${e.message}`); process.exit(1); }

const declared = [...sw.CRITICAL, ...sw.SHELL_OPTIONAL, ...sw.DEFERRED_CONTENT];
const declaredSet = new Set(declared);
/** 쿼리를 제외한 경로 -> 선언된 전체 URL (캐시버스팅 대조용) */
const declaredByPath = new Map();
for (const url of declared) {
  const key = stripQuery(url);
  if (declaredByPath.has(key)) fail(`sw.js 중복 선언: ${toFilePath(url)} (${declaredByPath.get(key)} / ${url})`);
  else declaredByPath.set(key, url);
}

/* 1. 선언한 자산이 디스크에 존재하는가 */
for (const url of declared) {
  const rel = toFilePath(url);
  if (!rel) { fail(`sw.js 선언이 동일 오리진이 아님: ${url}`); continue; }
  if (!fs.existsSync(path.join(APP_DIR, rel))) fail(`sw.js 선언 자산 없음: ${rel}`);
}
/* SHELL_ALIAS(디렉터리 URL)는 index.html 과 같은 실체다 — 중복 프리캐시 감시 (C-6) */
if (sw.SHELL_ALIAS && declaredSet.has(sw.SHELL_ALIAS) && declaredSet.has(sw.APP_SHELL)) {
  fail('sw.js 가 디렉터리 URL 과 index.html 을 모두 프리캐시한다 (셸 2중 저장, C-6 회귀)');
}

/* 2·3. index.html 참조 대조 */
const html = fs.readFileSync(htmlFile, 'utf8');
const htmlRefs = new Set();
for (const m of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)) {
  if (isLocalRef(m[1])) htmlRefs.add(m[1]);
}
/** index.html 이 참조하는 경로(쿼리 제외). JS 자기참조 리터럴 판별에 쓴다. */
const htmlBarePaths = new Set([...htmlRefs].map((r) => { const a = toAbs(r); return a && stripQuery(a); }).filter(Boolean));
for (const ref of htmlRefs) {
  const absUrl = toAbs(ref);
  if (!absUrl) { fail(`index.html 참조를 해석할 수 없음: ${ref}`); continue; }
  const rel = toFilePath(absUrl);
  if (!rel) continue;
  if (!fs.existsSync(path.join(APP_DIR, rel))) { fail(`index.html 참조 파일 없음: ${ref}`); continue; }
  if (declaredSet.has(absUrl)) continue;

  const bare = stripQuery(absUrl);
  const alt = declaredByPath.get(bare);
  if (alt) {
    fail(`캐시버스팅 불일치: ${rel}\n     index.html "${queryOf(absUrl) || '(쿼리 없음)'}"  vs  sw.js "${queryOf(alt) || '(쿼리 없음)'}"`);
  } else if (bare === stripQuery(sw.APP_SHELL) || (sw.SHELL_ALIAS && bare === stripQuery(sw.SHELL_ALIAS))) {
    // 셸 자기 참조는 무시
  } else {
    fail(`index.html 이 참조하지만 sw.js 에 선언되지 않음(오프라인 404): ${ref}`);
  }
}

/* 4. JS 동적 참조 대조 */
const jsFiles = [];
for (const dir of ['learning', 'v944']) {
  const d = path.join(APP_DIR, dir);
  if (!fs.existsSync(d)) continue;
  for (const name of fs.readdirSync(d)) if (name.endsWith('.js')) jsFiles.push(path.join(d, name));
}
/* 디렉터리 접두사가 있는 참조(./content/x.json)와, ASSET_BASE 기준 맨 파일명
   참조(new URL('cems-v9.4.4-import-worker.js?v=...', ASSET_BASE)) 를 모두 잡는다.
   후자를 빠뜨리면 import-worker 의 ?v= 드리프트를 놓친다. */
const DIR_REF_RE = /['"](\.{0,2}\/?(?:content|v944|learning|icons)\/[A-Za-z0-9_./-]+\.(?:json|js|css|png)(?:\?v=[A-Za-z0-9._-]+)?)['"]/g;
const BARE_REF_RE = /['"]([A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:json|js|css|png)(?:\?v=[A-Za-z0-9._-]+)?)['"]/g;
for (const file of jsFiles) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const seen = new Set();
  const refs = [];
  for (const m of src.matchAll(DIR_REF_RE)) refs.push({ ref: m[1], dirScoped: true });
  for (const m of src.matchAll(BARE_REF_RE)) refs.push({ ref: m[1], dirScoped: false });
  for (const { ref, dirScoped } of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    /* v944/*.js 는 자기 디렉터리를 ASSET_BASE 로 삼는 상대 참조를 쓴다. */
    const candidates = [toAbs(ref)];
    if (!ref.startsWith('.') && !ref.startsWith('/')) candidates.push(toAbs(`${path.basename(path.dirname(file))}/${ref}`));
    if (candidates.some((c) => c && declaredSet.has(c))) continue;
    const existing = candidates.find((c) => { const r = c && toFilePath(c); return r && fs.existsSync(path.join(APP_DIR, r)); });
    if (!existing) {
      /* 맨 파일명은 자산이 아닌 문자열(다운로드 파일명 등)일 수 있어 조용히 넘긴다. */
      if (dirScoped) warn(`${path.relative(APP_DIR, file)}: 참조 "${ref}" 는 디스크에 없음(사문화된 경로로 보임)`);
      continue;
    }
    const bare = stripQuery(existing);
    const alt = declaredByPath.get(bare);
    if (!alt) { fail(`${path.relative(APP_DIR, file)} 이 참조하지만 sw.js 에 선언되지 않음(오프라인 404): ${ref}`); continue; }
    /* index.html 이 같은 경로를 참조한다면 그쪽이 정본이고 위에서 이미 대조했다.
       이런 JS 리터럴은 대개 document.currentScript 폴백 같은 base URL 유도용이지
       실제 fetch 대상이 아니므로 쿼리 차이를 불일치로 보지 않는다. */
    if (htmlBarePaths.has(bare)) continue;
    fail(`캐시버스팅 불일치: ${toFilePath(existing)}\n     ${path.relative(APP_DIR, file)} "${queryOf(existing) || '(쿼리 없음)'}"  vs  sw.js "${queryOf(alt) || '(쿼리 없음)'}"`);
  }
}

/* 5. manifest 대상 존재 확인 */
let manifest;
try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); }
catch (e) { fail(`manifest.webmanifest 파싱 실패: ${e.message}`); }
if (manifest) {
  const manifestRefs = [];
  for (const icon of manifest.icons || []) manifestRefs.push(['icons[]', icon.src]);
  for (const s of manifest.shortcuts || []) {
    manifestRefs.push(['shortcuts[].url', s.url]);
    for (const icon of s.icons || []) manifestRefs.push(['shortcuts[].icons[]', icon.src]);
  }
  if (manifest.start_url) manifestRefs.push(['start_url', manifest.start_url]);
  for (const [field, ref] of manifestRefs) {
    if (!isLocalRef(ref)) continue;
    const absUrl = toAbs(ref);
    const rel = absUrl && toFilePath(absUrl);
    if (!rel) { fail(`manifest ${field} 를 해석할 수 없음: ${ref}`); continue; }
    if (!fs.existsSync(path.join(APP_DIR, rel))) fail(`manifest ${field} 대상 없음: ${ref}`);
  }
  const scopeAbs = toAbs(manifest.scope || './');
  if (manifest.start_url && !toAbs(manifest.start_url).startsWith(scopeAbs)) {
    fail(`manifest start_url 이 scope 밖: ${manifest.start_url} (scope ${manifest.scope})`);
  }
  if (!Array.isArray(manifest.screenshots) || manifest.screenshots.length === 0) {
    warn('manifest 에 screenshots 가 없어 Chrome 리치 설치 UI 가 적용되지 않는다(이미지 파일 자체가 없음).');
  }
}

/* --- CEMS_IMPORT_CORE 사본 대조 -------------------------------------------
   v944/cems-v9.4.4.js 와 v944/cems-v9.4.4-import-worker.js 의 공통 코어는
   바이트 단위로 같아야 한다. Worker 는 별도 스레드라 import 를 쓸 수 없어
   복사해 둔 것이고, 한쪽만 고치면 같은 파일을 Worker 경로와 폴백 경로로 넣었을 때
   정규화·mergeKey 가 갈려 동일 항목이 둘로 나뉜다. 사람 눈에 안 보이는 종류의
   결함이라 여기서 기계로 본다. */
{
  const CORE_HEAD = '* CEMS 9.4.4 — JSON 가져오기 공통 정규화 코어 (CEMS_IMPORT_CORE)';
  const CORE_TAIL = '/* ===================== 공통 정규화 코어 끝 (CEMS_IMPORT_CORE) ============= */';
  const extract = (rel) => {
    const abs = path.join(APP_DIR, rel);
    if (!fs.existsSync(abs)) { fail(`CEMS_IMPORT_CORE: 파일 없음 ${rel}`); return null; }
    const src = fs.readFileSync(abs, 'utf8');
    const a = src.indexOf(CORE_HEAD), b = src.indexOf(CORE_TAIL);
    if (a < 0 || b < 0 || b <= a) { fail(`CEMS_IMPORT_CORE 블록을 ${rel} 에서 찾지 못했다`); return null; }
    return src.slice(a, b);
  };
  const a = extract('v944/cems-v9.4.4.js');
  const b = extract('v944/cems-v9.4.4-import-worker.js');
  if (a !== null && b !== null) {
    if (a === b) {
      console.log(`CEMS_IMPORT_CORE : 두 사본 일치 (${a.split('\n').length}줄)`);
    } else {
      const la = a.split('\n'), lb = b.split('\n');
      let firstDiff = -1;
      for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) { firstDiff = i; break; }
      fail(`CEMS_IMPORT_CORE 두 사본이 다르다 (블록 내 ${firstDiff + 1}번째 줄부터). `
        + `main="${(la[firstDiff] || '(없음)').trim().slice(0, 70)}" worker="${(lb[firstDiff] || '(없음)').trim().slice(0, 70)}"`);
    }
  }
}

/* --- 보고 ----------------------------------------------------------------- */
const versionQueries = new Set(declared.map(queryOf).filter(Boolean));
console.log(`앱 디렉터리      : ${APP_DIR}`);
console.log(`sw.js 캐시 버전  : ${sw.CACHE_VERSION}`);
console.log(`선언 자산        : ${declared.length}개 (필수 ${sw.CRITICAL.length} / 선택 ${sw.SHELL_OPTIONAL.length} / 지연 ${sw.DEFERRED_CONTENT.length})`);
console.log(`캐시버스팅 쿼리  : ${[...versionQueries].join(', ') || '(없음)'}`);
console.log(`index.html 참조  : ${htmlRefs.size}개`);

if (warnings.length) {
  console.log(`\n경고 ${warnings.length}건`);
  for (const w of warnings) console.log(`  - ${w}`);
}
if (errors.length) {
  console.log(`\n불일치 ${errors.length}건`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  console.log('\n자산 대조: 실패');
  process.exit(1);
}
console.log('\n자산 대조: 통과');
