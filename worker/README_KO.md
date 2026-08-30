# Cloudflare Worker 배포 (v9.5.0)

계약(요청·응답 스키마, verdict 열거값, 에러 코드 전체)은 `CONTRACT.md` 가 정본입니다.

## 1. 배포 절차

1. **`wrangler.jsonc` 의 `ALLOWED_ORIGIN` 을 실제 PWA 오리진으로 교체합니다.**
   기본값 `https://YOUR-PWA-ORIGIN.example` 는 플레이스홀더이며, 그대로 배포하면
   어떤 브라우저 오리진도 CORS 를 통과하지 못해 채점이 전부 실패합니다.
   경로·끝 슬래시 없이 스킴+호스트만 적습니다(예: `https://myname.github.io`).
   여러 오리진은 콤마로 구분합니다. `GEMINI_MODEL` 도 함께 확인합니다.
2. `wrangler secret put GEMINI_API_KEY` 와 `wrangler secret put CEMS_ACCESS_TOKEN`
   으로 비밀값을 등록합니다.
3. 로컬 테스트에서는 `.dev.vars.example` 을 `.dev.vars` 로 복사한 뒤 실제 값을 넣습니다.
   `.dev.vars` 는 배포 ZIP 에 넣지 않습니다.
4. `wrangler dev` 에서 `/health`, `/grade-answer` 계약을 확인하고 `wrangler deploy` 로 배포합니다.
5. 아래 2절대로 커스텀 도메인을 연결합니다.
6. PWA 설정에는 Worker URL 과 `CEMS_ACCESS_TOKEN` 에 대응하는 접근 토큰만 입력합니다.
   Google API 키는 PWA 에 입력하지 않습니다.

기본 모델 값은 기존 9.4.3 동작을 보존하기 위한 호환 기본값입니다. 운영 배포 전
Google AI Studio 에서 사용할 모델 ID 와 키 상태를 확인한 뒤 환경 변수로 지정하십시오.

## 2. 커스텀 도메인 (필수)

`wrangler.jsonc` 에 `"workers_dev": false` 가 들어 있어 공개 `*.workers.dev` URL 이
생성되지 않습니다. 그 URL 이 열려 있으면 `ALLOWED_ORIGIN` 과 무관하게 누구나
접근 토큰 추측을 시도할 수 있고, 성공하면 Gemini 크레딧이 그대로 소모됩니다.

연결 방법 (둘 중 하나):

- **대시보드**: Workers & Pages → 해당 Worker → Settings → Domains & Routes →
  Add → Custom Domain → 예 `grader.example.com`.
- **설정 파일**: `wrangler.jsonc` 의 `routes` 주석을 풀고 실제 값을 채운 뒤 재배포.

  ```jsonc
  "routes": [
    { "pattern": "grader.example.com", "custom_domain": true }
  ],
  ```

연결한 주소를 PWA 설정의 "Worker 주소" 에 입력합니다(끝 슬래시 없이).

## 3. 레이트리밋 설정

`wrangler.jsonc` 의 `ratelimits` 블록이 `env.GRADE_RATE_LIMITER` 바인딩을 만듭니다.
Worker 는 인증보다 **먼저** `CF-Connecting-IP` 기준으로 이 제한을 평가합니다.

```jsonc
"ratelimits": [
  {
    "name": "GRADE_RATE_LIMITER",   // 코드의 env.GRADE_RATE_LIMITER 와 일치해야 한다
    "namespace_id": "1001",         // 계정/Worker 안에서만 유일하면 되는 임의 숫자 문자열
    "simple": { "limit": 30, "period": 60 }   // period 는 10 또는 60 만 허용
  }
]
```

- 기본값은 IP 당 60초에 30회입니다. 학습 1세션에서 문장 판독이 수십 회를 넘지 않으므로
  실사용에는 여유가 있고, 자동화된 남용은 걸립니다. 필요하면 `limit` 만 조정합니다.
- 초과 시 `429 rate_limited` 를 반환합니다(업스트림 할당량 초과인 `429 gemini_rate_limited`
  와는 다른 코드입니다).
- **바인딩이 없어도 Worker 는 정상 동작합니다.** 이 경우 제한 없이 통과시키고
  `console.warn` 만 남깁니다. `wrangler dev` 로컬 개발 호환을 위한 것이며,
  운영 배포에서 이 경고가 보이면 선언이 누락된 것입니다.
- 적용 여부는 `GET /health` 응답의 `rateLimiter` 필드(boolean)로 확인합니다.

레이트리밋만으로는 부족한 경우, Cloudflare 대시보드의 WAF 규칙으로 지역·ASN·
User-Agent 기준 차단을 추가할 수 있습니다.

## 4. 배포 후 확인

```bash
curl -sS https://<worker-도메인>/health -H "Authorization: Bearer <CEMS_ACCESS_TOKEN>" | jq
```

확인할 것:

- `warnings` 가 **빈 배열**이어야 합니다. 비어 있지 않으면 그 내용이 곧 미완료 설정입니다.
- `configured: true` — `GEMINI_API_KEY` 시크릿이 등록됨.
- `rateLimiter: true` — 레이트리밋 바인딩이 붙음.
- `graderVersion` 이 `learning/cems-9.4.1-stable.js` 의 `GRADER_VERSION` 과 같아야 합니다.
  다르면 모든 채점 요청이 `409 grader_version_mismatch` 로 거절됩니다.

토큰 없이 호출하면 `401 invalid_access_token`, 잘못된 경로는 `404 not_found` 입니다.

## 5. 로그·남용 탐지

`wrangler.jsonc` 의 `observability.enabled: true` 로 로그가 켜져 있습니다.

- 실시간: `wrangler tail`
- 대시보드: Workers & Pages → 해당 Worker → Logs

Worker 는 5xx 급 채점 실패와 레이트리밋 바인딩 누락을 `console.warn` 으로 남깁니다.
접근 토큰이나 Gemini 키는 로그에 남기지 않습니다.

## 6. 비용 방어선 요약

| 계층 | 내용 |
| --- | --- |
| 노출 | `workers_dev: false` + 커스텀 도메인 |
| CORS | `ALLOWED_ORIGIN` 허용 목록 밖에는 CORS 헤더 미부착 |
| 인증 | `CEMS_ACCESS_TOKEN`, SHA-256 고정 길이 비교 |
| 레이트리밋 | IP 당 60초 30회 (인증 이전에 평가) |
| 페이로드 | 본문 32KB, `acceptedAnswers` 20개·각 400자·합계 4,000자, 그 외 필드별 상한 |
| 업스트림 | 타임아웃 재시도 금지, 네트워크·5xx 는 1회만 재시도 (요청당 Gemini 호출 최대 2회) |
| CPU | `limits.cpu_ms: 10000` |
| 클라이언트 | 30일 결과 캐시, 기기별 일일 소프트 한도(성공 요청만 차감), 서킷 브레이커 |
