/**
 * CEMS AI 문장 채점 회귀 테스트 — 계약을 지키는 모의 Worker 를 띄워 전 경로를 본다.
 *
 * 실제 Gemini 없이도 확인할 수 있는 것들:
 *   - 클라이언트가 보내는 요청이 worker/CONTRACT.md 와 맞는가 (409 로 거부되지 않는가)
 *   - 응답 verdict 열거를 UI 가 받아들이는가
 *   - 채점 성공 뒤에 "다음 문장" 으로 실제 넘어갈 수 있는가
 *   - 일일 사용량 카운터가 성공한 요청에만 오르는가
 *
 * 사용법: node ai-grader.mjs <앱디렉터리> <라벨>
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(process.argv[2] || '..');
const LABEL = process.argv[3] || 'ai';
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', LABEL);
fs.mkdirSync(OUT_DIR, { recursive: true });

const GRADER_VERSION = 'sentence-grader-v3';
const TOKEN = 'test-token-1234567890';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

const calls = [];
const healthCalls = [];
let nextMode = 'ok';   // 'ok' | 'fail'
let healthGrader = GRADER_VERSION;   // /health 가 보고할 채점기 버전

function readBody(req) {
  return new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => res(b)); });
}

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

  if (u.pathname.startsWith('/mock-worker/')) {
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + TOKEN) return send(401, { ok: false, error: 'unauthorized' });
    if (req.method === 'GET' && u.pathname === '/mock-worker/health') {
      healthCalls.push(healthGrader);
      return send(200, { ok: true, serviceVersion: 'mock', graderVersion: healthGrader, model: 'mock', configured: true, verdicts: ['correct', 'partial', 'incorrect'], warnings: [] });
    }
    if (req.method === 'POST' && u.pathname === '/mock-worker/grade-answer') {
      let body = {}; try { body = JSON.parse(await readBody(req)); } catch { return send(400, { ok: false, error: 'invalid_json_body' }); }
      calls.push({ body, mode: nextMode });
      if (body.graderVersion && body.graderVersion !== GRADER_VERSION) return send(409, { ok: false, error: 'grader_version_mismatch', expected: GRADER_VERSION });
      if (nextMode === 'fail') return send(500, { ok: false, error: 'upstream_error' });
      return send(200, { ok: true, requestId: body.requestId, graderVersion: GRADER_VERSION, verdict: 'partial', confidence: 0.95, feedbackKo: '모의 채점: 의미가 통합니다.', correctedAnswer: '', modelUsed: 'mock-model' });
    }
    return send(404, { ok: false, error: 'not_found' });
  }

  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  const f = path.join(APP_DIR, p);
  if (!f.startsWith(APP_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const steps = [];
const step = (name, status, detail) => { steps.push({ name, status, detail }); console.log(`  ${(status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'INFO').padEnd(4)} ${name}${detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); };

const FROZEN = Symbol('frozen');
async function ev(page, fn, arg, ms = 20000) {
  let t; const to = new Promise((r) => { t = setTimeout(() => r(FROZEN), ms); });
  const r = await Promise.race([page.evaluate(fn, arg).catch((e) => ({ __err: String(e.message).slice(0, 200) })), to]);
  clearTimeout(t); return r;
}

const browser = await chromium.launch({ executablePath: process.env.CEMS_CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await (await browser.newContext({ viewport: { width: 430, height: 932 }, locale: 'ko-KR' })).newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));

console.log(`\n[${LABEL}] ${APP_DIR}  →  ${BASE}\n`);
await page.goto(BASE + '/index.html', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(7000);
await ev(page, async () => { for (let i = 0; i < 90; i++) { try { const w = await getAllWords(); if (w?.length) return; } catch (_) {} await new Promise((r) => setTimeout(r, 1000)); } }, null, 120000);

/* ── 1. 모의 Worker 로 설정 ──────────────────────────────── */
const cfg = await ev(page, async ({ url, token }) => {
  window.showPage('settings', true);
  await new Promise((r) => setTimeout(r, 1500));
  const en = document.getElementById('cems931-ai-enabled'), u = document.getElementById('cems931-proxy-url'), t = document.getElementById('cems931-proxy-token');
  if (!en || !u || !t) return { err: 'AI 설정 카드가 없다' };
  en.checked = true; en.dispatchEvent(new Event('change', { bubbles: true }));
  u.value = url; u.dispatchEvent(new Event('change', { bubbles: true }));
  t.value = token; t.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  return { ok: true };
}, { url: BASE + '/mock-worker', token: TOKEN }, 30000);
step('AI 설정 입력', cfg !== FROZEN && cfg.ok ? 'pass' : 'fail', cfg === FROZEN ? '정지' : (cfg.err || `${BASE}/mock-worker`));

/* ── 2. 문장 검사기: 로컬로 판정이 안 되는 답을 넣어 AI 경로를 태운다 ── */
const graded = await ev(page, async () => {
  const api = window.CEMS931; if (!api) return { err: 'CEMS931 없음' };
  await api.openSentenceChecker('all');
  await new Promise((r) => setTimeout(r, 1800));
  const st = api.__test.state, local = api.__test.localSentenceGrade;
  const row = st.currentSentence; if (!row) return { err: '문장 풀이 비었다' };
  /* 로컬 규칙이 'uncertain' 을 내는 답을 찾는다 — 그래야 AI 를 호출한다 */
  const target = String(row.targetText || '');
  const cands = [target.slice(0, Math.max(1, target.length - 1)) + '嗎', target + '吧', target.split('').reverse().join(''), target.slice(1) + '呢'];
  let learner = null;
  for (const c of cands) { if (local(row, c).verdict === 'uncertain') { learner = c; break; } }
  if (!learner) return { err: '로컬이 uncertain 을 내는 답을 못 찾음', target };
  const input = document.getElementById('cems931-sentence-input'), submit = document.getElementById('cems931-sentence-submit');
  input.value = learner; input.dispatchEvent(new Event('input', { bubbles: true }));
  const beforeUsage = (await api.metaGet('aiUsage:' + new Date().toISOString().slice(0, 10), { count: 0 })) || { count: 0 };
  submit.click();
  for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 250)); if (!submit.disabled || (submit.textContent || '').includes('다음')) break; }
  await new Promise((r) => setTimeout(r, 700));
  const afterUsage = (await api.metaGet('aiUsage:' + new Date().toISOString().slice(0, 10), { count: 0 })) || { count: 0 };
  return {
    learner, indexBefore: st.sentenceIndex,
    statusText: (document.getElementById('cems931-grade-status')?.textContent || '').trim().slice(0, 90),
    submitLabel: (submit.textContent || '').trim(), submitDisabled: submit.disabled,
    usageBefore: Number(beforeUsage.count || 0), usageAfter: Number(afterUsage.count || 0),
  };
}, null, 60000);

if (graded === FROZEN) step('AI 채점 호출', 'fail', '정지');
else if (graded.err) step('AI 채점 호출', 'fail', graded.err + (graded.target ? ' target=' + graded.target : ''));
else {
  const req = calls[0]?.body;
  step('요청 계약', req ? 'pass' : 'fail', req ? { graderVersion: req.graderVersion, keys: Object.keys(req).sort().join(','), lang: req.language } : 'Worker 에 요청이 도달하지 않음');
  step('409 거부 없음', req && req.graderVersion === GRADER_VERSION ? 'pass' : 'fail', req ? req.graderVersion : '-');
  step('판정 표시', /모의 채점/.test(graded.statusText) ? 'pass' : 'fail', graded.statusText);
  step('채점 뒤 다음 문장으로 진행 가능', !graded.submitDisabled ? 'pass' : 'fail',
    `버튼="${graded.submitLabel}" disabled=${graded.submitDisabled}${graded.submitDisabled ? '  ← 눌러도 다음 문장으로 못 넘어감' : ''}`);
  step('성공 1회 = 사용량 +1', graded.usageAfter - graded.usageBefore === 1 ? 'pass' : 'fail', `${graded.usageBefore} → ${graded.usageAfter}`);

  /* ── 3. 실패한 요청은 일일 한도를 갉아먹지 않아야 한다 ── */
  nextMode = 'fail';
  const failed = await ev(page, async () => {
    const api = window.CEMS931, st = api.__test.state, local = api.__test.localSentenceGrade;
    const submit = document.getElementById('cems931-sentence-submit'), input = document.getElementById('cems931-sentence-input');
    if (!submit.disabled && (submit.textContent || '').includes('다음')) { submit.click(); await new Promise((r) => setTimeout(r, 900)); }
    const row = st.currentSentence; if (!row) return { err: '문장 없음' };
    const target = String(row.targetText || '');
    const cands = [target.slice(0, Math.max(1, target.length - 1)) + '嗎', target + '吧', target.slice(1) + '呢'];
    let learner = null;
    for (const c of cands) { if (local(row, c).verdict === 'uncertain') { learner = c; break; } }
    if (!learner) return { err: 'uncertain 답 못 찾음' };
    const key = 'aiUsage:' + new Date().toISOString().slice(0, 10);
    const before = Number(((await api.metaGet(key, { count: 0 })) || {}).count || 0);
    input.value = learner; input.dispatchEvent(new Event('input', { bubbles: true }));
    submit.click();
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 250)); if (!submit.disabled) break; }
    await new Promise((r) => setTimeout(r, 700));
    const after = Number(((await api.metaGet(key, { count: 0 })) || {}).count || 0);
    return { before, after, status: (document.getElementById('cems931-grade-status')?.textContent || '').trim().slice(0, 110), disabled: submit.disabled };
  }, null, 60000);
  if (failed === FROZEN || failed.err) step('실패 요청은 한도 소모 안 함', 'fail', failed === FROZEN ? '정지' : failed.err);
  else {
    step('실패 요청은 한도 소모 안 함', failed.after === failed.before ? 'pass' : 'fail', `${failed.before} → ${failed.after}`);
    step('실패 뒤에도 계속 사용 가능', !failed.disabled ? 'pass' : 'fail', `disabled=${failed.disabled} · ${failed.status}`);
  }
}

/* ── 4. "연결 확인" 이 채점 불가 상태를 잡아내는가 ──────────────
   /health 가 200 이기만 하면 "연결 성공" 이라고 답하던 버튼이다. 채점기 버전이
   다르면 모든 /grade-answer 가 409 로 거부되는데도 성공이라고 말했다. */
for (const [label, remote, wantOk] of [['버전 일치', GRADER_VERSION, true], ['버전 불일치', 'sentence-grader-v0-wrong', false]]) {
  healthGrader = remote;
  const r = await ev(page, async ({ url, token }) => {
    window.showPage('settings', true);
    await new Promise((x) => setTimeout(x, 1200));
    /* 설정 카드가 다시 그려졌을 수 있으므로 값을 확실히 채운 뒤 누른다 */
    const u = document.getElementById('cems931-proxy-url'), t = document.getElementById('cems931-proxy-token'), en = document.getElementById('cems931-ai-enabled');
    if (u) { u.value = url; u.dispatchEvent(new Event('change', { bubbles: true })); }
    if (t) { t.value = token; t.dispatchEvent(new Event('change', { bubbles: true })); }
    if (en) { en.checked = true; en.dispatchEvent(new Event('change', { bubbles: true })); }
    await new Promise((x) => setTimeout(x, 700));
    const btn = [...document.querySelectorAll('#cems931-ai-card button, #page-settings button')].find((b) => /연결 확인/.test(b.textContent || ''));
    if (!btn) return { err: '연결 확인 버튼 없음' };
    /* 직전 결과가 남아 있으면 새 결과와 구분되지 않는다 — 비우고 시작한다 */
    const state = document.getElementById('cems931-ai-state');
    if (state) { state.textContent = ''; state.className = 'cems931-ai-state'; }
    btn.click();
    for (let i = 0; i < 40; i++) { await new Promise((x) => setTimeout(x, 250)); const el = document.getElementById('cems931-ai-state'); if (el && el.textContent.trim() && !/확인하는 중/.test(el.textContent)) break; }
    const el = document.getElementById('cems931-ai-state');
    return { text: (el?.textContent || '').trim().slice(0, 130), cls: el?.className || '' };
  }, { url: BASE + '/mock-worker', token: TOKEN }, 30000);
  if (r === FROZEN || r.err) step(`연결 확인 · ${label}`, 'fail', r === FROZEN ? '정지' : r.err);
  else {
    const saysOk = /ok/.test(r.cls) && /연결 성공/.test(r.text);
    step(`연결 확인 · ${label}`, saysOk === wantOk ? 'pass' : 'fail',
      `${wantOk ? '성공이라고 해야 함' : '실패라고 해야 함'} → "${r.text}"`);
  }
}
healthGrader = GRADER_VERSION;

if (pageErrors.length) step('미처리 예외', 'fail', pageErrors.slice(0, 3));
const pass = steps.filter((s) => s.status === 'pass').length, fail = steps.filter((s) => s.status === 'fail').length;
fs.writeFileSync(path.join(OUT_DIR, 'ai.json'), JSON.stringify({ steps, calls, pageErrors }, null, 2));
console.log('\n' + '─'.repeat(64));
console.log(`합계  pass ${pass} / fail ${fail}   Worker 호출 ${calls.length}회 (health ${healthCalls.length}: ${healthCalls.join(', ')})  미처리 예외 ${pageErrors.length}`);
console.log(`리포트: ${path.join(OUT_DIR, 'ai.json')}`);
await browser.close(); srv.close();
process.exit(fail ? 1 : 0);
