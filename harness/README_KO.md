# CEMS 회귀 테스트 하네스

실제 Chromium 으로 앱을 띄워 동작을 확인합니다. **수정 전후를 같은 스크립트로 돌려 비교하는 것**이 목적입니다.

## 설치

```bash
cd harness
npm install
npx playwright install chromium
```

## 사용

전부 첫 인자로 앱 디렉터리를 받으며, 생략하면 상위 디렉터리(`..`)를 씁니다.

```bash
node check.mjs        ..            # 외부 JS + index.html 인라인 스크립트 문법 검사
node asset-check.mjs  ..            # sw.js 선언 자산 ↔ 실제 파일 ↔ index.html 참조 대조
                                    #  + CEMS_IMPORT_CORE 두 사본 바이트 대조
node probe.mjs        .. before     # 회귀 배터리 (화면 10개 · 학습모드 8종 · 구조 지표
                                    #  · 빈 답 채점 · 탭 복귀 타이머 · 렌즈 격리
                                    #  · 강제 종료 세션 종류 · DB versionchange 복구)
node modals.mjs       .. before     # 확인 대화상자 · 학습 종료 전 경로 (실제 DOM 클릭)
node version.mjs      ..            # 화면에 보이는 버전이 VERSION 과 같은지
node ai-grader.mjs    .. before     # AI 문장 채점 전 경로 (모의 Worker, 키 불필요)
node sanitizer.mjs                  # 저장 정규화(plainText) 동치성
node sweep.mjs        .. before     # 전수 점검 (모든 화면의 버튼을 눌러본다)
node latency.mjs      ..            # 화면별 렌더 지연 측정
```

전부 한 번에: `npm run all`

미리 설치된 Chromium 을 쓰려면 `CEMS_CHROMIUM_PATH` 를 지정합니다
(`npx playwright install` 을 못 쓰는 환경용).

```bash
CEMS_CHROMIUM_PATH=/opt/pw-browsers/chromium node probe.mjs .. before
```

## 각 스크립트가 무엇을 지키는가

- **modals.mjs** — `probe`/`sweep` 은 학습 세션 화면에 들어가지 않고 함수만 직접 부른다.
  그래서 "확인 대화상자를 여는 순간 앱이 멈춘다"(9.5.0) 를 한 건도 잡지 못했다.
  이 스크립트는 실제 DOM 클릭으로 그 경로만 본다. 핵심 장치는 **모든 `page.evaluate`
  에 타임아웃을 거는 것** — 메인 스레드가 멈추면 evaluate 는 영원히 resolve 되지
  않으므로, 타임아웃 = 앱 정지 = FAIL 이다.
- **play.mjs** — `probe` 는 화면이 뜨는지, `sweep` 은 버튼이 눌리는지, `modals` 는 종료
  경로를 본다. 그 사이에 비어 있던 것 — **실제로 문제를 풀 수 있는가** — 를 본다.
  모드마다 정답/오답을 번갈아 내고, 문항이 실제로 넘어가는지와 미처리 예외가 없는지를 본다.
- **version.mjs** — 화면 문구를 쓰는 모듈이 여섯이었고 각자 자기 상수를 썼다.
  9.5.0 빌드가 사용자에게 "v9.4.4" 로 보이던 문제를 잡는다.
- **ai-grader.mjs** — `worker/CONTRACT.md` 를 지키는 모의 Worker 를 띄운다.
  Gemini 키 없이도 요청 계약 · verdict 처리 · 사용량 카운터 · "연결 확인" 의
  판정까지 전 경로를 확인한다.
- **sanitizer.mjs** — 저장 경로의 `plainText` 빠른 경로가 기존 파서 구현과
  같은 결과를 내는지 실제 시드 전 필드로 대조한다.

결과는 `out/<라벨>/` 아래에 JSON 과 스크린샷으로 남습니다.

수정한 뒤 같은 라벨만 바꿔 다시 돌리고 비교하세요.

```bash
node probe.mjs .. after && node sweep.mjs .. after
```

## CSS 를 고쳤을 때

`!important` 를 지우거나 셀렉터를 바꿨다면, **JS 는 그대로 두고 CSS 만 원본으로 되돌린 대조군**을 함께 재야 합니다. 그래야 "CSS 때문에 달라진 것"과 "앱 상태 때문에 달라진 것"이 구분됩니다. 대조군 없이 before/after 만 비교하면 상태 차이를 CSS 회귀로 오진합니다.

```bash
node css-baseline.mjs .. before          # 최초 1회, 느립니다 (~9분)

cp -r .. /tmp/ctrl
git -C /tmp/ctrl checkout <원본커밋> -- 'v944/*.css'
node css-recheck.mjs /tmp/ctrl ctrl      # 대조군 (~2분)
node css-recheck.mjs .. after
python3 cdiff.py ctrl after              # 차이 0 이면 겉모습 무변경
```

## 주의

- 브라우저가 무겁습니다. 여러 개를 동시에 띄우지 마세요.
- 스크립트를 중단했으면 **반드시** `pkill -f chrome` 으로 잔여 프로세스를 정리하세요. 쌓이면 머신이 포화되어 이후 측정이 전부 무의미해집니다.
- `probe.mjs` 는 시드 로드까지 최대 90초를 기다립니다. 전체 1회에 3~5분 걸립니다.
