/* CEMS Gemini 채점 프록시 Worker
 * ---------------------------------------------------------------------------
 * v9.5.0 감사 대응
 *  A-3 abort 사유 오분류 수정: 타임아웃은 재시도하지 않고 즉시 gemini_timeout.
 *  A-4 남용 방어: 본문 크기·필드 길이 상한 + Rate Limiting 바인딩.
 *  A-5 업스트림 401/403 을 502 gemini_auth_failed 로 변환(클라이언트 401 과 분리).
 *  A-6 secureEqual 을 고정 길이 SHA-256 비교로 교체(길이 오라클 제거).
 *  A-7 허용되지 않은 오리진에는 CORS 헤더를 붙이지 않는다.
 * 계약 문서는 worker/CONTRACT.md 이며, 응답 스키마·에러 코드는 그쪽이 정본이다.
 * ==========================================================================*/

const SERVICE_VERSION = '9.5.0';
const GRADER_VERSION = 'sentence-grader-v3';
const API_VERSION = 'v1beta';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const VERDICTS = new Set(['correct', 'partial', 'incorrect']);

/* A-4: 페이로드 상한. 프롬프트에 들어가지 않는 필드도 전부 막는다. */
const LIMITS = {
  bodyBytes: 32 * 1024,
  requestId: 120,
  targetAnswer: 1200,
  learnerAnswer: 1200,
  acceptedItem: 400,
  acceptedTotal: 4000,
  acceptedCount: 20,
  promptKo: 1200,
  language: 32,
  graderVersion: 64,
  rubricJson: 2000,
};

/* wrangler.jsonc 의 플레이스홀더. 이 값이 남아 있으면 배포 설정이 끝나지 않은 것이다. */
const ORIGIN_PLACEHOLDER = 'https://YOUR-PWA-ORIGIN.example';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function parseAllowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/* A-7: 예전 구현은 허용 목록에 없는 오리진에 allowed[0] 을 돌려줘서
   "설정이 되어 있는 것처럼 보이지만 실제로는 아무 브라우저도 통과 못 하는" 상태를
   만들었고, ALLOWED_ORIGIN 미설정 시에는 빈 문자열 ACAO 를 내보냈다.
   이제 허용된 오리진에만 헤더를 붙이고, 나머지는 CORS 헤더 없이 응답한다.
   (Origin 헤더가 없는 비브라우저 호출은 CORS 대상이 아니므로 영향 없다.) */
function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = parseAllowedOrigins(env);
  const base = {
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-cems-token,x-proxy-token,authorization',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
  if (allowed.includes('*')) return { ...base, 'access-control-allow-origin': '*' };
  if (origin && allowed.includes(origin)) return { ...base, 'access-control-allow-origin': origin };
  return { vary: 'Origin' };
}

/* A-6: 길이를 먼저 비교하면 길이 오라클이 남는다.
   양쪽을 SHA-256 한 뒤 고정 32바이트끼리 비교하면 입력 길이와 무관해진다. */
async function secureEqual(a, b) {
  const encoder = new TextEncoder();
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (!left || !right) return false;
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const lb = new Uint8Array(x);
  const rb = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < lb.length; i += 1) diff |= lb[i] ^ rb[i];
  return diff === 0;
}

async function authenticate(request, env) {
  const expected = env.CEMS_ACCESS_TOKEN;
  if (!expected) return { ok: false, status: 503, error: 'worker_token_not_configured' };
  const authorization = request.headers.get('authorization') || '';
  const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  const supplied = request.headers.get('x-cems-token') || request.headers.get('x-proxy-token') || bearer || '';
  if (!(await secureEqual(supplied, expected))) return { ok: false, status: 401, error: 'invalid_access_token' };
  return { ok: true };
}

/* A-4: Cloudflare Rate Limiting 바인딩(wrangler.jsonc 의 ratelimits[].name).
   바인딩이 없으면(로컬 wrangler dev, 미설정 배포) 조용히 통과시키되 경고를 남긴다. */
let rateLimitWarned = false;
async function enforceRateLimit(request, env) {
  const limiter = env.GRADE_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') {
    if (!rateLimitWarned) {
      rateLimitWarned = true;
      console.warn('[CEMS Worker] GRADE_RATE_LIMITER 바인딩이 없어 레이트리밋을 건너뜁니다. 운영 배포에서는 wrangler.jsonc 의 ratelimits 선언을 확인하십시오.');
    }
    return { ok: true };
  }
  const key = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  try {
    const { success } = await limiter.limit({ key });
    if (!success) return { ok: false, status: 429, error: 'rate_limited' };
    return { ok: true };
  } catch (error) {
    console.warn('[CEMS Worker] 레이트리밋 평가 실패, 통과시킵니다:', error && error.message);
    return { ok: true };
  }
}

/* A-4: 예전 구현은 `...body` 로 클라이언트가 보낸 모든 필드를 그대로 들고 다녔다.
   명시 허용 목록으로 바꿔 알 수 없는 필드는 아예 버린다. */
function normalizeGradeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const accepted = body.acceptedAnswers ?? body.accepted ?? body.alternatives ?? body.validAnswers ?? [];
  return {
    requestId: String(body.requestId || body.id || crypto.randomUUID()),
    graderVersion: body.graderVersion === undefined || body.graderVersion === null ? '' : String(body.graderVersion),
    language: body.language === undefined || body.language === null ? '' : String(body.language),
    promptKo: body.promptKo === undefined || body.promptKo === null ? '' : String(body.promptKo),
    rubric: body.rubric ?? null,
    targetAnswer: String(body.targetAnswer ?? body.correctAnswer ?? body.expectedAnswer ?? body.referenceAnswer ?? body.answer ?? ''),
    learnerAnswer: String(body.learnerAnswer ?? body.userAnswer ?? body.submittedAnswer ?? body.candidateAnswer ?? body.input ?? ''),
    acceptedAnswers: Array.isArray(accepted) ? accepted : [],
  };
}

function validateGradeRequest(body) {
  if (!body || typeof body !== 'object') return 'invalid_json_body';
  const required = ['requestId', 'targetAnswer', 'learnerAnswer'];
  for (const key of required) if (typeof body[key] !== 'string' || !body[key].trim()) return `invalid_${key}`;
  if (body.requestId.length > LIMITS.requestId
    || body.targetAnswer.length > LIMITS.targetAnswer
    || body.learnerAnswer.length > LIMITS.learnerAnswer) return 'payload_too_large';

  /* A-4: 개수만 막고 각 요소 길이를 열어두면 요청 1회로 수십 MB 를
     Gemini 프롬프트에 밀어 넣어 비용을 수천 배로 증폭할 수 있다. */
  if (!Array.isArray(body.acceptedAnswers) || body.acceptedAnswers.length > LIMITS.acceptedCount) return 'invalid_acceptedAnswers';
  let acceptedTotal = 0;
  for (const item of body.acceptedAnswers) {
    if (typeof item !== 'string') return 'invalid_acceptedAnswers';
    if (item.length > LIMITS.acceptedItem) return 'accepted_answer_too_long';
    acceptedTotal += item.length;
  }
  if (acceptedTotal > LIMITS.acceptedTotal) return 'accepted_answers_too_large';

  /* 프롬프트에 쓰이지 않는 필드도 페이로드 크기 방어 차원에서 상한을 건다. */
  if (body.graderVersion.length > LIMITS.graderVersion) return 'payload_too_large';
  if (body.language.length > LIMITS.language) return 'payload_too_large';
  if (body.promptKo.length > LIMITS.promptKo) return 'payload_too_large';
  if (body.rubric !== null && body.rubric !== undefined) {
    if (typeof body.rubric !== 'object' || Array.isArray(body.rubric)) return 'invalid_rubric';
    let rubricJson;
    try { rubricJson = JSON.stringify(body.rubric); } catch { return 'invalid_rubric'; }
    if (typeof rubricJson !== 'string' || rubricJson.length > LIMITS.rubricJson) return 'payload_too_large';
  }
  return null;
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdict: { type: 'STRING', enum: ['correct', 'partial', 'incorrect'] },
    confidence: { type: 'NUMBER', minimum: 0, maximum: 1 },
    feedbackKo: { type: 'STRING' },
    correctedAnswer: { type: 'STRING' },
  },
  required: ['verdict', 'confidence', 'feedbackKo', 'correctedAnswer'],
};

function fixedPrompt(input) {
  const accepted = Array.isArray(input.acceptedAnswers)
    ? input.acceptedAnswers.filter((x) => typeof x === 'string').slice(0, LIMITS.acceptedCount)
    : [];
  return [
    'You are a strict but fair Chinese-learning answer grader.',
    'Judge semantic and grammatical equivalence. Reject changed negation, number, person, time, place, aspect, or required grammar.',
    'Allow simplified/traditional variants, harmless punctuation, and natural word-order variants only when meaning is unchanged.',
    'Return only the JSON object required by the response schema. Feedback must be concise Korean.',
    `Target answer: ${input.targetAnswer}`,
    `Accepted variants: ${JSON.stringify(accepted)}`,
    `Learner answer: ${input.learnerAnswer}`,
  ].join('\n');
}

/* A-3: controller.abort('timeout') 은 문자열을 거부 사유로 던져 error.name 이
   undefined 가 된다. 그래서 호출부의 `error.name !== 'AbortError'` 재시도 조건이
   타임아웃에서도 참이 되어, 8초 타임아웃이 두 번 돌아 총 16초까지 늘어났다.
   클라이언트는 8초에 끊으므로 사용자에겐 실패로 보이지만 Worker 는 Gemini 를
   계속 호출해 중복 과금이 났고, 최종 에러도 gemini_network_error 로 잘못 나갔다.
   이제 플래그로 타임아웃을 명확히 식별해 timeout:true 를 달아 던진다. */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Gemini request timed out', 'TimeoutError'));
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw Object.assign(new Error('gemini_timeout'), { status: 504, timeout: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* A-5: 업스트림 상태 코드를 그대로 흘리면 Gemini 키 오류(401)가 클라이언트에
   "접근 토큰 오류"로 보인다. 호출자 인증 실패와 반드시 구분되어야 한다. */
function mapUpstreamStatus(status) {
  if (status === 401 || status === 403) return { status: 502, error: 'gemini_auth_failed' };
  if (status === 429) return { status: 429, error: 'gemini_rate_limited' };
  return { status: 502, error: `gemini_http_${status}` };
}

async function callGemini(env, input) {
  if (!env.GEMINI_API_KEY) throw Object.assign(new Error('gemini_key_not_configured'), { status: 503 });
  const model = String(env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const endpoint = `https://generativelanguage.googleapis.com/${API_VERSION}/models/${encodeURIComponent(model)}:generateContent`;
  const payload = {
    contents: [{ role: 'user', parts: [{ text: fixedPrompt(input) }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 350,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify(payload),
  };
  const timeoutMs = Number(env.GEMINI_TIMEOUT_MS || 8000);

  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetchWithTimeout(endpoint, init, timeoutMs);
    } catch (error) {
      /* 타임아웃은 재시도하지 않는다. 클라이언트가 이미 8초에 끊었고,
         재시도는 사용자에게 보이지 않는 중복 과금만 남긴다. */
      if (error && error.timeout) throw Object.assign(new Error('gemini_timeout'), { status: 504 });
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      throw Object.assign(new Error('gemini_network_error'), { status: 504 });
    }
    if (!(response.status === 429 || response.status >= 500) || attempt === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }

  if (!response.ok) {
    const text = (await response.text()).slice(0, 600);
    const mapped = mapUpstreamStatus(response.status);
    const error = new Error(mapped.error);
    error.status = mapped.status;
    error.upstreamStatus = response.status;
    error.upstream = text;
    throw error;
  }
  const raw = await response.json();
  const text = raw?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw Object.assign(new Error('gemini_invalid_json'), { status: 502 }); }
  if (!VERDICTS.has(parsed.verdict) || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
    throw Object.assign(new Error('gemini_schema_mismatch'), { status: 502 });
  }
  return {
    verdict: parsed.verdict,
    confidence: parsed.confidence,
    feedbackKo: String(parsed.feedbackKo || '').slice(0, 500),
    correctedAnswer: String(parsed.correctedAnswer || '').slice(0, 500),
    modelUsed: model,
  };
}

/* A-7: 설정 누락을 /health 로 드러낸다. 배포 직후 육안 확인용. */
function configWarnings(env) {
  const warnings = [];
  const allowed = parseAllowedOrigins(env);
  if (!allowed.length) warnings.push('ALLOWED_ORIGIN 미설정: 브라우저 호출에 CORS 헤더가 나가지 않아 PWA 에서 모두 실패합니다.');
  if (allowed.includes(ORIGIN_PLACEHOLDER)) warnings.push(`ALLOWED_ORIGIN 이 플레이스홀더(${ORIGIN_PLACEHOLDER}) 그대로입니다. 실제 PWA 오리진으로 교체하십시오.`);
  if (allowed.includes('*')) warnings.push("ALLOWED_ORIGIN 이 '*' 입니다. 운영 환경에서는 특정 오리진으로 제한하십시오.");
  if (!env.GEMINI_API_KEY) warnings.push('GEMINI_API_KEY 시크릿이 없습니다.');
  return warnings;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);

    /* A-4: 인증 이전에 IP 기준 레이트리밋을 건다.
       인증 실패 요청도 SHA-256 두 번 + CPU 시간을 먹으므로 앞단에서 막는다. */
    const limited = await enforceRateLimit(request, env);
    if (!limited.ok) return json({ ok: false, error: limited.error }, limited.status, cors);

    const auth = await authenticate(request, env);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, cors);

    if (request.method === 'GET' && url.pathname === '/health') {
      const warnings = configWarnings(env);
      return json({
        ok: true,
        serviceVersion: SERVICE_VERSION,
        graderVersion: GRADER_VERSION,
        model: String(env.GEMINI_MODEL || DEFAULT_MODEL),
        apiVersion: API_VERSION,
        configured: Boolean(env.GEMINI_API_KEY),
        rateLimiter: Boolean(env.GRADE_RATE_LIMITER && typeof env.GRADE_RATE_LIMITER.limit === 'function'),
        verdicts: [...VERDICTS],
        warnings,
      }, 200, cors);
    }

    if (request.method === 'POST' && url.pathname === '/grade-answer') {
      /* A-4: 본문 크기 상한. content-length 로 1차, 실제 파싱 전 바이트 수로 2차.
         (chunked 전송에는 content-length 가 없으므로 2차 확인이 실질 방어선이다.) */
      const declared = Number(request.headers.get('content-length') || 0);
      if (Number.isFinite(declared) && declared > LIMITS.bodyBytes) {
        return json({ ok: false, error: 'payload_too_large' }, 413, cors);
      }
      let bodyText;
      try { bodyText = await request.text(); } catch { return json({ ok: false, error: 'invalid_json_body' }, 400, cors); }
      if (new TextEncoder().encode(bodyText).byteLength > LIMITS.bodyBytes) {
        return json({ ok: false, error: 'payload_too_large' }, 413, cors);
      }
      let rawBody;
      try { rawBody = JSON.parse(bodyText); } catch { return json({ ok: false, error: 'invalid_json_body' }, 400, cors); }

      const body = normalizeGradeRequest(rawBody);
      const validationError = validateGradeRequest(body);
      if (validationError) {
        const status = validationError === 'payload_too_large'
          || validationError === 'accepted_answer_too_long'
          || validationError === 'accepted_answers_too_large' ? 413 : 400;
        return json({ ok: false, error: validationError }, status, cors);
      }
      if (body.graderVersion && body.graderVersion !== GRADER_VERSION) {
        return json({ ok: false, error: 'grader_version_mismatch', expected: GRADER_VERSION }, 409, cors);
      }
      try {
        const grade = await callGemini(env, body);
        return json({
          ok: true,
          requestId: body.requestId,
          graderVersion: GRADER_VERSION,
          ...grade,
        }, 200, cors);
      } catch (error) {
        const status = Number(error.status) || 500;
        if (status >= 500) {
          console.warn('[CEMS Worker] 채점 실패:', error.message, error.upstreamStatus || '', (error.upstream || '').slice(0, 200));
        }
        return json({ ok: false, error: error.message || 'worker_error' }, status, cors);
      }
    }
    return json({ ok: false, error: 'not_found' }, 404, cors);
  },
};
