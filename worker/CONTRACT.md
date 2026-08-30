# CEMS Gemini Worker 계약 (v9.5.0)

이 문서가 Worker ↔ PWA 계약의 정본입니다. `worker/src/index.mjs` 와
`learning/cems-9.4.1-stable.js` 의 채점 클라이언트는 이 문서를 따릅니다.

## 1. 인증

모든 엔드포인트가 인증을 요구합니다. 다음 헤더 중 하나로 접근 토큰을 보냅니다.

| 헤더 | 예 |
| --- | --- |
| `Authorization` | `Bearer <CEMS_ACCESS_TOKEN>` (PWA 가 실제로 쓰는 방식) |
| `X-CEMS-Token` | `<CEMS_ACCESS_TOKEN>` |
| `X-Proxy-Token` | `<CEMS_ACCESS_TOKEN>` |

토큰 비교는 길이 오라클이 없도록 양쪽을 SHA-256 한 뒤 고정 32바이트끼리 비교합니다.
실제 토큰과 Gemini 키는 Worker Secret 으로만 등록하며 ZIP·PWA 소스에 넣지 않습니다.

## 2. 계약 버전

```
graderVersion = "sentence-grader-v3"
```

클라이언트가 `graderVersion` 을 보내면 Worker 값과 정확히 일치해야 합니다.
불일치하면 **409 `grader_version_mismatch`** 로 거절하며 응답에 `expected` 가 들어갑니다.
필드를 생략하면 검사하지 않습니다. 양쪽 상수는 반드시 함께 올려야 합니다.

- Worker: `worker/src/index.mjs` 의 `GRADER_VERSION`
- 클라이언트: `learning/cems-9.4.1-stable.js` 의 `GRADER_VERSION`

## 3. CORS

`ALLOWED_ORIGIN`(콤마 구분) 에 있는 오리진에만 `Access-Control-Allow-Origin` 을 붙입니다.
허용되지 않은 오리진에는 CORS 헤더를 아예 붙이지 않습니다(브라우저가 차단).
`Origin` 헤더가 없는 비브라우저 호출(curl, 모니터링)은 CORS 대상이 아니므로 영향받지 않습니다.
설정이 비어 있거나 플레이스홀더면 `GET /health` 의 `warnings` 에 나타납니다.

## 4. 레이트리밋

Cloudflare Rate Limiting 바인딩 `GRADE_RATE_LIMITER` 로 `CF-Connecting-IP` 당 제한합니다
(기본 60초에 30회, `wrangler.jsonc` 에서 조정). 인증보다 **먼저** 평가합니다.
초과 시 **429 `rate_limited`**. 바인딩이 없으면 통과시키고 `console.warn` 만 남깁니다
(로컬 `wrangler dev` 호환). 바인딩 유무는 `/health` 의 `rateLimiter` 로 확인합니다.

## 5. `GET /health`

성공 시 200.

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `ok` | boolean | 항상 `true` |
| `serviceVersion` | string | Worker 빌드 버전 (예: `"9.5.0"`) |
| `graderVersion` | string | 계약 버전. 항상 `"sentence-grader-v3"` |
| `model` | string | 요청에 사용할 Gemini 모델 ID |
| `apiVersion` | string | Google API 버전 (예: `"v1beta"`) |
| `configured` | boolean | `GEMINI_API_KEY` 시크릿 존재 여부 |
| `rateLimiter` | boolean | `GRADE_RATE_LIMITER` 바인딩 존재 여부 |
| `verdicts` | string[] | Worker 가 낼 수 있는 verdict 열거값 전체 |
| `warnings` | string[] | 설정 누락 경고. **비어 있어야 정상** |

Google API 키 자체는 어떤 경로로도 반환하지 않습니다.

## 6. `POST /grade-answer`

### 6.1 요청 본문

`Content-Type: application/json`. 본문 전체는 **32KB** 를 넘을 수 없습니다
(`Content-Length` 로 1차, 파싱 전 실제 바이트 수로 2차 확인).
아래 목록에 없는 필드는 무시하고 버립니다.

| 필드 | 필수 | 타입 | 상한 | 설명 |
| --- | --- | --- | --- | --- |
| `requestId` | ● | string | 120자 | 없으면 Worker 가 UUID 생성. 응답에 그대로 반향 |
| `targetAnswer` | ● | string | 1,200자 | 기준 정답 |
| `learnerAnswer` | ● | string | 1,200자 | 학습자 입력 |
| `acceptedAnswers` | | string[] | 20개 / 각 400자 / 합계 4,000자 | 허용 변형 |
| `graderVersion` | | string | 64자 | 2절 참고 |
| `language` | | string | 32자 | 프롬프트에 쓰지 않음(크기만 검증) |
| `promptKo` | | string | 1,200자 | 프롬프트에 쓰지 않음(크기만 검증) |
| `rubric` | | object | JSON 2,000자 | 프롬프트에 쓰지 않음(크기만 검증) |

`requestId`·`targetAnswer`·`learnerAnswer` 는 별칭을 허용합니다
(`id`, `correctAnswer`/`expectedAnswer`/`referenceAnswer`/`answer`,
`userAnswer`/`submittedAnswer`/`candidateAnswer`/`input`,
`acceptedAnswers` 는 `accepted`/`alternatives`/`validAnswers`).

**채점 규칙(프롬프트)은 Worker 가 소유합니다.** 클라이언트가 보낸 임의 프롬프트는
사용하지 않으며, `rubric`·`promptKo`·`language` 는 현재 프롬프트에 반영되지 않습니다.
Gemini 에 전달되는 것은 `targetAnswer`, `acceptedAnswers`, `learnerAnswer` 뿐입니다.

### 6.2 성공 응답 (200)

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `ok` | boolean | 항상 `true` |
| `requestId` | string | 요청의 `requestId` 를 그대로 반향 |
| `graderVersion` | string | `"sentence-grader-v3"` |
| `verdict` | string | 6.3 의 열거값 중 하나 |
| `confidence` | number | `0` 이상 `1` 이하 |
| `feedbackKo` | string | 한국어 피드백. 최대 500자로 잘림 |
| `correctedAnswer` | string | 교정 문장. 최대 500자로 잘림. 없으면 빈 문자열 |
| `modelUsed` | string | 실제 호출한 모델 ID |

### 6.3 `verdict` 열거값 (정본)

Worker 는 **정확히 이 세 값만** 반환합니다. Gemini responseSchema 로도 강제합니다.

| 값 | 의미 | 클라이언트 처리 |
| --- | --- | --- |
| `correct` | 기준 정답과 동등 | 그대로 `correct` |
| `partial` | 의미는 통하나 완전 일치는 아님 | `acceptable` 로 정규화 |
| `incorrect` | 의미·문법이 어긋남 | 그대로 `incorrect` |

클라이언트 내부 열거값은 `correct | acceptable | incorrect | uncertain` 입니다.
`uncertain` 은 **로컬 판정·저신뢰도·오류 상황에서 클라이언트가 스스로 붙이는 값**이며
Worker 는 절대 반환하지 않습니다. Worker 의 `partial` ↔ 클라이언트의 `acceptable` 대응은
`learning/cems-9.4.1-stable.js` 에서 처리합니다. 어느 한쪽 열거값을 바꾸면
`GRADER_VERSION` 을 함께 올려야 합니다.

### 6.4 오류 응답

모든 오류는 `{ "ok": false, "error": "<코드>" }` 형태이며,
`grader_version_mismatch` 에는 `expected` 가 추가됩니다.

| HTTP | `error` | 원인 |
| --- | --- | --- |
| 400 | `invalid_json_body` | 본문이 JSON 이 아니거나 객체가 아님 |
| 400 | `invalid_requestId` | 문자열이 아니거나 공백뿐 |
| 400 | `invalid_targetAnswer` | 문자열이 아니거나 공백뿐 |
| 400 | `invalid_learnerAnswer` | 문자열이 아니거나 공백뿐 |
| 400 | `invalid_acceptedAnswers` | 배열이 아님, 20개 초과, 또는 문자열 아닌 요소 포함 |
| 400 | `invalid_rubric` | `rubric` 이 객체가 아니거나 직렬화 불가 |
| 401 | `invalid_access_token` | **클라이언트** 접근 토큰 불일치 |
| 404 | `not_found` | 알 수 없는 메서드·경로 |
| 409 | `grader_version_mismatch` | 2절 계약 버전 불일치. `expected` 동봉 |
| 413 | `payload_too_large` | 본문 32KB 초과, 또는 개별 필드 상한 초과 |
| 413 | `accepted_answer_too_long` | `acceptedAnswers` 의 한 요소가 400자 초과 |
| 413 | `accepted_answers_too_large` | `acceptedAnswers` 길이 합계가 4,000자 초과 |
| 429 | `rate_limited` | Worker 레이트리밋 초과 |
| 429 | `gemini_rate_limited` | **업스트림** Gemini 할당량 초과 |
| 502 | `gemini_auth_failed` | 업스트림이 401/403. **Gemini 키 문제이며 클라이언트 토큰 문제가 아님** |
| 502 | `gemini_http_<status>` | 그 밖의 업스트림 오류 응답 |
| 502 | `gemini_invalid_json` | 업스트림 응답이 JSON 파싱 불가 |
| 502 | `gemini_schema_mismatch` | verdict 열거 이탈 또는 `confidence` 범위 이탈 |
| 503 | `worker_token_not_configured` | `CEMS_ACCESS_TOKEN` 시크릿 미등록 |
| 503 | `gemini_key_not_configured` | `GEMINI_API_KEY` 시크릿 미등록 |
| 504 | `gemini_timeout` | 업스트림이 `GEMINI_TIMEOUT_MS`(기본 8초) 안에 응답하지 않음 |
| 504 | `gemini_network_error` | 업스트림 연결 실패(타임아웃 아님). 1회 재시도 후 |
| 500 | `worker_error` | 분류되지 않은 내부 오류 |

**401 의 의미는 하나뿐입니다**: 클라이언트 접근 토큰 불일치.
Gemini 키가 잘못된 경우는 502 `gemini_auth_failed` 로 나오므로 사용자에게
"접근 토큰 오류" 로 안내하면 안 됩니다.

### 6.5 재시도 규약

- **타임아웃은 재시도하지 않습니다.** 클라이언트가 8초에 끊는데 Worker 가 재시도하면
  사용자에게는 실패로 보이면서 Gemini 호출만 중복 과금됩니다.
- 네트워크 오류(타임아웃 아님)와 업스트림 429/5xx 는 **1회만** 재시도합니다.
- 따라서 한 요청의 Gemini 호출은 최대 2회, 총 대기는 `GEMINI_TIMEOUT_MS` + 약간입니다.

클라이언트도 자체 방어선을 둡니다: 8초 타임아웃, 요청 직렬화, 30일 결과 캐시,
기기별 일일 소프트 한도, 1분 내 3회 실패 시 2분 서킷 브레이커.
일일 한도는 **성공한 요청만** 차감합니다.
