# GitHub 로 옮기기

## 1. 저장소 올리기

받으신 `cems-history.bundle` 에 원본 → v9.5.0 이력이 들어 있습니다. 이력을 살려서 올리는 쪽을 권합니다.

```bash
git clone cems-history.bundle cems
cd cems
git remote remove origin
git remote add origin https://github.com/<계정>/<저장소>.git
git push -u origin main        # 브랜치 이름이 다르면 git branch -M main 먼저
```

이력이 필요 없으면 zip 을 풀고 `git init && git add -A && git commit` 해도 됩니다.

### 공개 / 비공개

- **공개**: GitHub Actions 분(minutes) 무제한. GitHub Pages 도 무료.
- **비공개**: Actions 가 월 2,000분 한도(Pro 기준). 아래 `verify` 워크플로는 1회에 5~10분쯤 쓰므로 하루 몇 번은 괜찮지만, 매 push 마다 돌리면 금방 찹니다. 그럴 땐 `on:` 에서 `push` 를 빼고 `pull_request` 와 `workflow_dispatch` 만 남기세요.

### 올리기 전 확인

- `worker/.dev.vars` (실제 Gemini 키 · 접근 토큰) 는 `.gitignore` 에 넣어 뒀습니다. **저장소에 올라가면 안 됩니다.** `.dev.vars.example` 만 올라갑니다.
- `content/cems_zh_seed_v940.json` 이 15MB 입니다. GitHub 파일 상한(100MB) 안이라 그냥 올라가지만, 클론이 무거워지고 diff 가 지저분합니다. 시드를 자주 바꿀 계획이면 나중에 Git LFS 를 고려하세요.

## 2. 검증 워크플로

`.github/workflows/verify.yml` 이 들어 있습니다. push / PR 마다 자동으로 돌아갑니다.

- **정적 검사**: 문법 · 자산 대조 · 시드 검증
- **브라우저 회귀**: 실제 Chromium 으로 화면 10개 · 학습모드 8종 · 모든 버튼 클릭. 미처리 예외나 콘솔 오류가 1건이라도 나면 **실패 처리**합니다.
- 측정 결과(JSON · 스크린샷)는 Actions 아티팩트로 14일 보관됩니다.

별도 설정 없이 바로 동작합니다. Anthropic 시크릿이 필요 없습니다 — 이건 순수 테스트 워크플로입니다.

## 3. Claude 를 GitHub 에 붙이기

두 가지가 있고 성격이 다릅니다.

### Claude Code on the web (claude.ai/code) — 주 작업 공간

브라우저에서 저장소를 열면 Anthropic 클라우드 VM 에서 작업합니다. **대화형**이라 진행을 보면서 방향을 바꿀 수 있고, 여러 세션을 병렬로 돌릴 수 있습니다. 결과는 브랜치로 푸시되고 PR 로 넘어갑니다.

- Pro / Max / Team / Enterprise 구독에 포함 (Free 불가)
- 시작: claude.ai/code 에서 GitHub 로그인 → Claude GitHub App 권한 부여 → 저장소 선택
- 저장소 크기: GitHub 에서 클론하는 경우 제한 없음 (로컬 번들 업로드일 때만 100MB)

### GitHub Actions (`@claude` 멘션) — 보조

이슈·PR 댓글에 `@claude` 를 달면 워크플로가 돌면서 작업합니다. **비대화형**이라 한 번 던지고 결과를 받는 방식입니다. 정해진 절차를 반복하는 데 좋습니다.

- 설치: 로컬 Claude Code 에서 `/install-github-app` 실행하면 App 설치 · 시크릿 · 워크플로 PR 까지 자동
- 시크릿: `CLAUDE_CODE_OAUTH_TOKEN` (구독 사용, `claude setup-token` 으로 생성) 또는 `ANTHROPIC_API_KEY` (API 직접 과금)
- 프라이빗 저장소도 지원

## 4. 남은 작업별 권장

| 작업 | 권장 | 이유 |
|---|---|---|
| Lean 화면 60초 원인 찾기 | 웹 세션 | 측정 → 결과 보고 → 다음 지점 지시, 반복이 필요합니다. 비대화형으론 왕복이 너무 깁니다. |
| 시드 재생성 | 어디서든 — 단 **입력 파일부터** | `content/cems_zh_full_seed_v932.json` 과 catalog 가 참조하는 원본 25건이 저장소에 없습니다. 이걸 먼저 찾아 올려야 시작됩니다. |
| 회귀 테스트 반복 | GitHub Actions | 이미 워크플로가 있습니다. 사람이 시키지 않아도 매번 돕니다. |

## 5. 알아둘 제약

- **웹 세션에서 Playwright 가 되는지는 공식 문서에 명시돼 있지 않습니다.** 일반적인 리눅스 샌드박스면 되지만, 처음 세션에서 `cd harness && npm install && npx playwright install chromium && node probe.mjs ..` 를 한 번 돌려 확인하세요. 안 되면 브라우저 검증은 Actions 에 맡기고 웹 세션은 코드 작업만 시키면 됩니다.
- 웹 세션은 일정 시간 놀면 VM 이 회수됩니다. 긴 작업은 중간 결과를 커밋해 두세요.
- **DevTools Performance 트레이스는 어느 쪽에서도 눈으로 못 봅니다.** Lean 60초의 정확한 블로킹 구간을 보려면 결국 로컬 브라우저가 한 번은 필요할 수 있습니다. 다만 `performance.mark` / `console.time` 을 코드에 심어 로그로 뽑는 방식이면 클라우드에서도 충분히 좁힐 수 있습니다.
