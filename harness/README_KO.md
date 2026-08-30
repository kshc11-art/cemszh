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
node probe.mjs        .. before     # 회귀 배터리 (화면 10개 · 학습모드 8종 · 구조 지표)
node sweep.mjs        .. before     # 전수 점검 (모든 화면의 버튼을 눌러본다)
node latency.mjs      ..            # 화면별 렌더 지연 측정
```

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
