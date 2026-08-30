# CEMS 중국어 학습 PWA — 작업 규칙

이 저장소는 v8.0~v9.4.4 동안 **전역 함수를 덮어쓰는 방식**으로 확장돼 왔고, 그 결과 같은 함수가 최대 13겹까지 중첩되며 데이터 오염·성능 저하·예측 불가능한 동작을 낳았습니다. v9.5.0 에서 그 방식을 걷어냈습니다. **아래 규칙을 어기면 그 상태로 되돌아갑니다.**

---

## 1. 절대 하지 말 것

### 전역 함수를 덮어쓰지 않는다

```js
// 금지
const prev = window.showPage;
window.showPage = function(){ prev.apply(this, arguments); doMyThing(); };

// 금지 — 함수 프로퍼티 가드는 합성되지 않는다.
// A 가 감싸면 최외곽 함수는 A 의 플래그만 갖고 B 의 플래그는 사라진다.
// B 의 재시도 타이머가 돌면 "아직 안 감쌌다"고 판단해 또 감싼다.
if (!window.foo.__myFlag) { ... window.foo.__myFlag = true; }
```

### 재설치 타이머를 두지 않는다

`[700,1500,3000].forEach(ms => setTimeout(install, ms))` 같은 패턴은 전부 제거됐습니다. 훅 등록은 멱등이므로 반복이 필요 없습니다.

### `eval(name + ' = fn')` 을 쓰지 않는다

전부 제거됐습니다. `window[name] = fn` 으로 충분하고, 향후 CSP 도입을 막습니다.

### 캡처 단계에서 앱의 원래 경로를 죽이지 않는다

`stopImmediatePropagation()` 으로 `onclick` 핸들러를 가로채면, 그 핸들러가 하던 다른 일(카운터 갱신 등)이 조용히 죽습니다. 예외는 `#file-input` 의 `.json` 라우팅 하나뿐입니다(JSON 이 Excel 파서로 가면 안 되므로).

---

## 2. 대신 이렇게 한다

### 훅 레지스트리 — `window.CEMSHooks`

전역 함수의 소유자는 `index.html` 하나입니다. 확장 모듈은 **키로 등록만** 합니다. 같은 키로 다시 등록하면 교체되므로, 등록 코드가 여러 번 실행돼도 훅은 항상 1개입니다.

```js
CEMSHooks.on(channel, key, fn)            // 멱등 등록
CEMSHooks.off(channel, key)
CEMSHooks.has(channel, key)
CEMSHooks.run(channel, ...args)           // 등록순 1회씩, 예외 격리
CEMSHooks.transform(channel, value, ...)  // 값 변환. undefined 반환 시 이전 값 유지
CEMSHooks.runAsync(channel, ...args)      // 순차 실행 후 완료 대기
CEMSHooks.inspect()                       // 진단: 채널별 등록 키 목록
```

**발행 채널** (전부 `index.html` 이 발행):

| 채널 | 인자 | 시점 |
|---|---|---|
| `beforePageShow` | `(pageName, force)` | 이동 확정 후, DOM 전환 전 |
| `afterPageShow` | `(pageName, force)` | `showPage` 본문 끝 |
| `afterTypeSwitch` | `(type)` | `switchGlobalType` 본문 끝 |
| `studySelection` | `(result, filtered, count, type, options)` → result | `selectStudyItems` 반환 직전 (transform) |
| `quizItems` | `(items, all, mode, type)` → items | `startQuiz` 진입 직후 (transform) |
| `afterShowCard` | `(item, fcState)` | `showCard` 끝 |
| `afterShowExprCard` | `(item, exprState)` | `showExprCard` 끝 |
| `afterTypingQuestion` | `(item, typingState)` | `showTypingQ` 끝 |
| `afterBookmarkToggle` | `(item, on, buttonId)` | 북마크 상태 변경 |

새 채널이 필요하면 **`index.html` 의 해당 함수 본문 끝에 `CEMSHooks.run(...)` 한 줄을 추가**하세요. 그 함수를 감싸지 마세요.

### 데이터 렌즈 — `window.CEMS_LENS`

"잠깐만 걸러진 목록이 필요하다"는 곳에서 `getAllWords` / `getAllExpr` / `getAllPV` 를 바꿔치기하지 마세요. 비동기 호출이 겹치면 복원 대상이 어긋나 **전역이 영구 오염**됩니다(실제로 발생했던 버그).

```js
// 작업 동안만 필터를 겹친다. 고유 id 로 등록·해제하므로 동시 호출이 서로를 덮어쓰지 않는다.
await CEMS_LENS.with(
  (rows, kind) => kind === 'expr' ? rows.filter(r => !r.cemsQuarantined) : rows,
  async () => { ...작업... }
);

// 영구 필터
const id = CEMS_LENS.push(fn);   // 해제하려면 CEMS_LENS.pop(id)
```

렌즈 콜백의 두 번째 인자 `kind` 는 `'vocab' | 'expr' | 'phrasal'` 입니다. **반드시 확인하세요** — 확인하지 않으면 의도하지 않은 컬렉션까지 걸러집니다.

렌즈를 타지 않는 원본이 필요하면 `getAllFromStore(storeName)` 을 직접 부르세요.

### 가드는 모듈 스코프 변수로

```js
// 좋음
var state = { patched: false };
function install(){ if (state.patched) return; state.patched = true; ... }
```

---

## 3. 구조

로드 순서 (뒤로 갈수록 나중):

1. `index.html` 인라인 — localStorage 네임스페이스 파사드 → HTML 안전 처리기 → **CEMSHooks 레지스트리** → 본체 + FSRS-6 + v8.0~v8.6 패치층 → v9.1 라우터
2. `learning/` 12개 (동기, 순서 강제)
   `schema → content-schema → exercise-engine → content-studio → progress-engine → scheduler → learning-ui → ux-polish → stable → deck-groups → learning-hub → ui`
3. `v944/` 2개 (`defer`, 가장 마지막)
4. `sw.js` (별도 스레드)

`learning/` 의 하위 모듈은 **로드 시점에** `CEMS_LEAN._modules` 에서 의존성을 캡처합니다. 순서를 바꾸면 조용히 `undefined` 가 됩니다.

### SRS 는 두 개이고, 충돌하지 않습니다

- `index.html:1210~` — **FSRS-6** (주석의 "FSRS-4.5" 는 오기). 레거시 플래시카드 담당.
- `learning/progress-engine.js` — **고정 지연 스케줄** (baseline 0일 / transfer ≥3일 / retention ≥14일). Lean 단원 측정 담당.

IndexedDB 스토어가 완전히 분리돼 있어 쓰기 충돌이 없습니다. 한쪽 로직을 다른 쪽에 섞지 마세요.

### 저장소

- `ChineseVocab_v1` (v4) — `words`(keyPath `Traditional_CH`) / `expressions`(keyPath `Expression`) / `phrasal_verbs` / `sessions` / `learning*` 5개
- `CEMS_Aux_v931_zh` (v1) — `examples` / `settings` / `aiCache` / `audits` / `meta`
- `cemsExternalLibrary942` (v3) — 외부 JSON 라이브러리
- localStorage 는 `cems:zh:` 네임스페이스 파사드를 통과합니다. 접두사를 직접 붙이지 마세요.

---

## 4. Excel / JSON 가져오기 — 공통 코어 규칙

`v944/cems-v9.4.4.js` 와 `v944/cems-v9.4.4-import-worker.js` 의 `CEMS_IMPORT_CORE` 블록은 **바이트 단위로 동일한 사본**입니다. Worker 는 별도 스레드라 import 를 쓸 수 없어 복사해 둔 것입니다.

정규화 · `mergeKey` · 타입 판정 · `sourceId` · 필드 후보 목록이 전부 여기 있습니다. **한쪽만 고치면** 같은 파일을 Worker 경로와 폴백 경로로 넣었을 때 동일 항목이 둘로 갈라집니다. 반드시 양쪽을 같이 고치고 `diff` 로 확인하세요.

---

## 5. 검증 — 고치기 전에 baseline 을 뜬다

`harness/` 에 실제 Chromium 회귀 테스트가 있습니다. **"고쳤다"는 주장은 이 스크립트의 출력으로만 합니다.**

```bash
cd harness && npm install && npx playwright install chromium

node check.mjs        ..                 # 문법 검사 (외부 JS + index.html 인라인)
node asset-check.mjs  ..                 # sw.js 선언 ↔ 실제 파일 ↔ index.html 참조 대조
node probe.mjs        .. before          # 회귀 배터리 (화면 10개 · 학습모드 8종 · 구조 지표)
node sweep.mjs        .. before          # 전수 점검 (모든 버튼 클릭)
node latency.mjs      ..                 # 화면별 렌더 지연

#   ...수정...

node probe.mjs .. after && node sweep.mjs .. after
```

### CSS 를 고칠 때

`!important` 를 지우거나 셀렉터를 바꾼 뒤에는 **JS 는 그대로 두고 CSS 만 원본으로 되돌린 대조군**을 함께 측정해야 합니다. 그래야 "CSS 때문에 달라진 것"과 "앱 상태 때문에 달라진 것"이 구분됩니다. 이 대조군 없이 before/after 만 비교하면 앱 상태 차이를 CSS 회귀로 오진합니다(실제로 370건 중 대부분이 상태 차이였습니다).

```bash
node css-baseline.mjs .. before          # 최초 1회 (~9분)
cp -r . /tmp/ctrl && git -C /tmp/ctrl checkout <원본커밋> -- 'v944/*.css'
node css-recheck.mjs /tmp/ctrl ctrl      # 대조군 (~2분)
node css-recheck.mjs .. after
python3 cdiff.py ctrl after
```

### 브라우저를 여러 개 띄우지 마세요

측정 스크립트를 중단했으면 `pkill -f chrome` 으로 잔여 프로세스를 반드시 정리하세요. 쌓이면 머신이 포화되어 이후 모든 측정이 무의미해집니다.

---

## 6. 릴리스 체크리스트

버전을 올릴 때 함께 바꿔야 하는 곳:

- `VERSION`, `REVISION`
- `manifest.webmanifest` 의 `version`, `name`
- `v944/build-info.json`
- `sw.js` 의 `CACHE_VERSION`
- `index.html` 의 `data-cems-version`, 인라인 `VERSION` 상수
- `learning/learning-ui.js` · `learning/ux-polish.js` 의 `VERSION` 상수 (화면에 표시됨)
- **캐시버스팅 쿼리 `?v=` 6곳** — index.html 5곳 + `v944/cems-v9.4.4.js` 의 `WORKER_URL` 1곳, 그리고 `sw.js` 의 대응 선언

`node harness/asset-check.mjs .` 가 이 불일치를 잡아냅니다. 릴리스 전 반드시 실행하세요.

---

## 7. 남은 과제

### Lean 학습 화면 진입 약 60초 (최우선)

`showPage('lean')` 후 화면이 채워지기까지 실측 **61초**. v9.4.4-final2 에서도 **57.5초**로 동일한 기존 문제입니다.

- `getAllExpr` 자체는 50ms, `getAllWords` 는 2.2초로 정상입니다 → DB 조회가 원인이 아닙니다.
- `scheduler.buildTodayPlan()` 은 캐시가 더워진 뒤 측정하면 693ms 입니다 → 첫 호출의 무언가가 메인 스레드를 수십 초 막습니다.
- 다음 단계: `harness/latency.mjs` 로 재현한 뒤 Chrome DevTools Performance 트레이스를 떠서 블로킹 구간을 특정하세요. `listUnitStates` / `dueBenchmarks` / `renderDashboard` 가 후보입니다.

### 시드 콘텐츠 품질

- 어휘 9,447행 중 **4,782행(50.62%)** 의 `Meaning_KO` 가 번역이 아니라 `병음 · 품사 · 주제` 조립 문자열입니다. 그 결과 절반의 카드에서 **병음 정답이 문제에 노출**됩니다.
- `grammar` 992행 중 469행(47.3%) 의 `Meaning_KO` 가 12종 보일러플레이트입니다.
- `expressions` 686행은 전부 `Meaning_KO === Example1_KO` 입니다.
- `authoring/validate_seed_v941.py` 가 **FAIL 1건**(문법 예문 ↔ 번역 배열 길이 불일치 71행)을 내는 시드가 배포돼 있습니다.
- **빌드 체인이 재현 불가**합니다: `build_seed_v941.py` 의 입력 `content/cems_zh_full_seed_v932.json` 과 `data_catalog_v932.json` 이 참조하는 원본 25건이 저장소에 없습니다. 먼저 이 파일들을 찾으세요.

### 연어 모드

시드에 `Collocation_CHT` 가 **55개(0.58%)**, `Measure_CHT` 가 46개(0.49%) 뿐입니다. 코드가 아니라 콘텐츠 문제입니다.

### 문서 ↔ 데이터 불일치

`authoring/DATA_SCHEMA_v9.4.1_KO.md` 가 선언한 19개 열이 실제 데이터에 0건입니다. 특히 `Structure_CHT`("v9.4.1 신규"로 명시)와 `grammarExamplePinyin`(인덱스 계약 3축 중 1축). `POS` 는 문서 규격 8종과 실제 113종이 **0% 일치**합니다.

---

## 8. 배포

GitHub Pages 정적 호스팅입니다. **커스텀 HTTP 헤더를 설정할 수 없어 CSP 를 헤더로 넣을 수 없습니다.** `<meta http-equiv>` CSP 도 현재 없습니다.

`worker/` 는 별도 Cloudflare Worker (Gemini 채점 프록시)입니다. 배포 전 `wrangler.jsonc` 의 `ALLOWED_ORIGIN` 플레이스홀더를 실제 도메인으로 반드시 교체하세요.
