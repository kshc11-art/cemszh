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

### 관찰자(MutationObserver)의 콜백에서 그 관찰 대상을 다시 쓰지 않는다

```js
// 금지 — 무한 마이크로태스크 루프. 앱 전체가 영구 정지한다.
mo = new MutationObserver(relabel);
mo.observe(overlay, {attributes:true, attributeFilter:['class']});
function relabel(){ ... overlay.classList.add('x'); }   // ← 관찰 중인 class 를 다시 씀
```

**Chromium 은 이미 있는 토큰을 `classList.add` 해도, 같은 값으로 `setAttribute` 해도
MutationRecord 를 쌓는다**(하네스로 실측 확인). 마이크로태스크 체크포인트는 큐가 빌 때까지
태스크 루프로 돌아가지 않으므로, 콜백이 자기 관찰 대상을 건드리면 그 자리에서 앱이 멈춘다.
v9.5.0 의 "확인 대화상자를 여는 순간 앱 정지"가 정확히 이것이었다.

세 가지를 같이 지킨다.

1. 값이 실제로 달라질 때만 쓴다 — `if(!el.classList.contains(x)) el.classList.add(x)`
2. 콜백에 재진입 가드를 둔다 (모듈 스코프 변수)
3. 콜백 끝에서 `observer.takeRecords()` 로 **자기가 만든 레코드를 버린다**

`harness/modals.mjs` 가 이 계열을 잡는다. 핵심은 모든 `page.evaluate` 에 타임아웃을 거는 것이다
— 멈춘 페이지의 evaluate 는 resolve 도 reject 도 하지 않으므로, 타임아웃이 곧 "앱 정지" 신호다.

### 잠금을 얻었으면 모든 조기 반환에서 푼다

`phase3BeginSubmit(state)` 를 통과했으면 그 함수의 **모든** 경로가 `phase3EndSubmit(state)`
로 끝나야 한다. `commitAnswer` 는 예외만 던지는 게 아니라 `{ok:false}` 로도 돌아온다
(`missing-card` · `no-pending-rating` · 이미 커밋된 토큰). 그때 잠금을 남기면 그 학습 모드의
확인·평가 버튼이 조용히 전부 먹통이 된다.

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

실제로 났던 일: 데이터 화면의 "최근 7일" 필터가 `kind` 를 보지 않아, 렌즈가 걸려 있는
약 2초 동안 앱 어디서 부르든 `getAllExpr` 이 어휘용 날짜 규칙으로 걸러진 결과를 돌려줬다
(표현 1678 → 1278). **시드를 방금 넣은 프로필에서는 보이지 않는다** — 모든 행의
`addedDate` 가 오늘이라 필터가 아무것도 걸러내지 않기 때문이다. 재현하려면 일부 행의
추가일을 과거로 돌려야 한다(`harness/probe.mjs` 의 `데이터 필터 렌즈 격리` 가 그렇게 한다).

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
#  브라우저를 새로 못 받는 환경이면: export CEMS_CHROMIUM_PATH=/경로/chromium

npm run all                              # 아래 전부

node check.mjs        ..                 # 문법 검사 (외부 JS + index.html 인라인)
node asset-check.mjs  ..                 # sw.js 선언 ↔ 실제 파일 ↔ index.html 참조 대조
                                         #  + CEMS_IMPORT_CORE 두 사본 바이트 대조
node probe.mjs        .. before          # 회귀 배터리 (화면·학습모드·구조 지표 + 아래 4종)
                                         #  빈 답 채점 · 탭 복귀 타이머 · 렌즈 격리
                                         #  · 강제 종료 세션 종류 · DB versionchange 복구
node modals.mjs       .. before          # 확인 대화상자 · 학습 종료 전 경로 (실제 DOM 클릭)
node version.mjs      ..                 # 화면 버전 문구 ↔ VERSION
node ai-grader.mjs    .. before          # AI 채점 전 경로 (모의 Worker, 키 불필요)
node sanitizer.mjs                       # 저장 정규화 동치성
node sweep.mjs        .. before          # 전수 점검 (모든 버튼 클릭)
node latency.mjs      ..                 # 화면별 렌더 지연

#   ...수정...

node probe.mjs .. after && node sweep.mjs .. after
```

### 대조군을 함께 재세요

"고쳤다" 를 증명하는 가장 확실한 방법은 **수정 전 트리에서 같은 검사를 돌려 FAIL 이 나는 것을
보이는 것**입니다. 검사가 수정 후에만 통과하는지, 원래부터 통과했는지는 그렇게만 갈립니다.

```bash
git archive <수정전커밋> | (mkdir -p /tmp/ctrl && tar -x -C /tmp/ctrl)
node probe.mjs /tmp/ctrl ctrl && node probe.mjs .. after
```

### probe / sweep 이 못 보는 곳

`probe.mjs` 와 `sweep.mjs` 는 학습 **세션 화면**(page-flashcard 등)에 들어가지 않고
함수를 직접 부릅니다. v9.5.0 의 "확인 대화상자를 여는 순간 앱 정지"를 둘 다 놓친 이유입니다.
그 경로는 `modals.mjs` 가 실제 DOM 클릭으로 봅니다.

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

**화면에 보이는 버전의 출처는 `index.html` 의 `<html data-cems-version>` 하나입니다.**
`learning/ux-polish.js` · `learning/learning-ui.js` · `learning/cems-9.4.1-stable.js` ·
`v944/cems-v9.4.4.js` 는 전부 그 값을 읽기만 합니다. 각자 자기 상수를 쓰던 v9.5.0 에서는
9.5.0 빌드가 사용자에게 "v9.4.4" 로 보였고, 여섯 모듈이 같은 속성을 서로 다른 값으로 써서
`data-cems-version` 이 계속 되돌려 쓰였습니다(측정 63회). 그 구조를 다시 만들지 마세요.

버전을 올릴 때 바꿀 곳:

- `VERSION`, `REVISION`
- `manifest.webmanifest` 의 `version`, `name`
- `v944/build-info.json` 의 `version` · `revision` · `build` · `cacheVersion`
- `sw.js` 의 `CACHE_VERSION` (과 `LOG_TAG`)
- `index.html` 의 `data-cems-version`, 인라인 `VERSION` 상수, `<title>`, `.splash-sub`
- **캐시버스팅 쿼리 `?v=` 6곳** — index.html 5곳 + `v944/cems-v9.4.4.js` 의 `WORKER_URL` 1곳, 그리고 `sw.js` 의 대응 선언
- 각 레이어의 `dataset.cemsVersion || '<폴백>'` 폴백 문자열 3곳 (dataset 이 없을 때만 쓰임)

`node harness/asset-check.mjs .` 가 선언 자산·쿼리 불일치를 잡고,
`node harness/version.mjs ..` 가 **실제 브라우저에서 화면 문구가 `VERSION` 과 같은지** 확인합니다.
둘 다 릴리스 전에 돌리세요.

### 버전을 안 올리면 수정이 사용자에게 가지 않습니다

`sw.js` 의 `CACHE_VERSION` 이 그대로면 서비스워커가 기존 캐시를 계속 씁니다.
코드를 고쳤는데 버전을 안 올리면 배포해도 구 자산이 그대로 서빙됩니다.

---

## 7. 남은 과제

### Lean 학습 화면 진입 — 해결됨 (v9.5.1)

원인은 DB 조회도, `buildTodayPlan` 도 아니었습니다. `phase7UpdateA11yState()` 가
문서 전체를 훑는데 **DOM 노드가 하나 늘어날 때마다** 불렸습니다
(`phase7EnhanceControls` 본문 끝 + `childObserver` 가 추가 노드마다 그것을 호출).

실측(진입 1회): 24,638회 실행 · `document.querySelectorAll` 98,792회 ·
`setAttribute` 12,606,531회 · `inert` 설정 542,036회. CPU 프로파일 기준 지연의 87%.

수정: 프레임당 1회로 합치고(rAF + 배경 탭용 200ms 백업), 값이 달라질 때만 씁니다.
`harness/latency.mjs` 기준 **39,761ms → 5,338ms**.

교훈: "문서 전체를 훑는 함수"를 노드 단위 훅에서 부르지 마세요. 재측정은
`node harness/latency.mjs ..` 로 합니다. 프로파일이 필요하면 CDP `Profiler` 로 뜹니다
(DevTools UI 없이도 됩니다).

### 화면 전환 1회당 전체 스토어 재조회 20회 이상

`getAllFromStore` 에 캐시가 없어 홈·통계·Lean 갱신이 각자 같은 스토어를 다시 읽습니다
(updateHomeStats · stable-home · lean legacyDueSummary · ux-polish countCardData).
시드 기준 `getAllWords()` 1회가 약 2.2초입니다.

고칠 방향은 나와 있습니다 — 쓰기에서 무효화되는 버전 태그 캐시를 `getAllFromStore` 에
두고, 사본을 돌려주고, 동시 호출을 하나로 합칩니다. **다만 앱의 모든 조회 밑에 깔리는
변경이라 무효화를 한 군데라도 놓치면 낡은 데이터가 화면에 남습니다.** 쓰기 경로가
`phase1Put` 과 v9.1 이 감싼 `IDBObjectStore.put/add` 두 갈래인 것부터 확인하세요.
독립된 변경으로, before/after 를 따로 재서 하세요.

### 감사 34건 중 검증을 못 끝낸 것

14방향 다중 에이전트 감사가 34건에 판정을 냈습니다(확정 10 · 반증 23 · 불확실 1).
확정 10건은 v9.5.1 에 전부 반영했습니다. 검증 단계에서 사용량 한도로 61건이 실행되지
못했고, 그 항목들은 아직 **"확인되지 않은 제보"** 입니다. 반증 23건이 말해 주듯 제보의
상당수는 실제로는 결함이 아니므로, 고치기 전에 먼저 재현하세요.

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
