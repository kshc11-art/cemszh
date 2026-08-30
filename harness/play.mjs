/**
 * CEMS 학습 모드 플레이스루
 *
 * probe 는 화면이 뜨는지, sweep 은 버튼이 눌리는지, modals 는 종료 경로를 본다.
 * 이 스크립트는 그 사이에 비어 있던 것 — **실제로 문제를 풀 수 있는가** — 를 본다.
 * 모드마다 문항을 정답/오답으로 번갈아 풀고, 카운터가 실제로 움직이는지,
 * 다음 문항으로 넘어가는지, 미처리 예외가 없는지를 확인한다.
 *
 * 사용법: node play.mjs <앱디렉터리> <라벨>
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(process.argv[2] || '..');
const LABEL = process.argv[3] || 'play';
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', LABEL);
fs.mkdirSync(OUT_DIR, { recursive: true });

const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png'};
const srv = http.createServer((q, s) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(APP_DIR, p);
  if (!f.startsWith(APP_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); s.end(); return; }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(s);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));

const report = { label: LABEL, appDir: APP_DIR, steps: [], pageErrors: [], console: [] };
const step = (name, status, detail) => {
  report.steps.push({ name, status, detail });
  console.log(`  ${(status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'INFO').padEnd(4)} ${name}${detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
};

const FROZEN = Symbol('frozen');
let frozen = false;
async function ev(page, fn, arg, ms = 30000) {
  if (frozen) return FROZEN;
  let t; const to = new Promise((r) => { t = setTimeout(() => r(FROZEN), ms); });
  const r = await Promise.race([page.evaluate(fn, arg).catch((e) => ({ __err: String(e.message).slice(0, 200) })), to]);
  clearTimeout(t);
  if (r === FROZEN) frozen = true;
  return r;
}

/* [모드, 시작 type, 화면 id, 카운터 접두사] */
const MODES = [
  ['flashcard',   'vocab', 'page-flashcard',   'fc'],
  ['quiz',        'vocab', 'page-quiz',        'quiz'],
  ['reverse',     'vocab', 'page-quiz',        'quiz'],
  ['typing',      'vocab', 'page-typing',      'typing'],
  ['cloze',       'vocab', 'page-cloze',       'cloze'],
  ['collocation', 'vocab', 'page-collocation', 'colloc'],
  ['listening',   'vocab', 'page-listening',   'listening'],
  ['dictation',   'vocab', 'page-dictation',   'dictation'],
  ['expr-fc',     'expr',  'page-expr-fc',     'expr-fc'],
  ['expr-quiz',   'expr',  'page-expr-quiz',   'expr-quiz'],
  ['expr-cloze',  'expr',  'page-expr-cloze',  'expr-cloze'],
  ['expr-typing', 'expr',  'page-expr-typing', 'expr-typing'],
];

const browser = await chromium.launch({ executablePath: process.env.CEMS_CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await (await browser.newContext({ viewport: { width: 430, height: 932 }, locale: 'ko-KR' })).newPage();
page.on('pageerror', (e) => report.pageErrors.push(String(e.message).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') report.console.push(m.text().slice(0, 300)); });

console.log(`\n[${LABEL}] ${APP_DIR}\n`);
await page.goto(`http://127.0.0.1:${srv.address().port}/index.html`, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(6000);
const seed = await ev(page, async () => {
  for (let i = 0; i < 90; i++) { try { const w = await getAllWords(); if (w?.length) return w.length; } catch (_) {} await new Promise((r) => setTimeout(r, 1000)); }
  return 0;
}, null, 120000);
step('시드 로드', seed === FROZEN ? 'fail' : (seed ? 'pass' : 'fail'), seed === FROZEN ? '정지' : `단어 ${seed}개`);

for (const [mode, type, pageId, prefix] of MODES) {
  if (frozen) { step(`모드 ${mode}`, 'fail', '앞 단계에서 정지'); continue; }
  const errBefore = report.pageErrors.length;

  const played = await ev(page, async ({ t, m, pid, px }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { rounds: [] };
    try {
      window.showPage('study', true); await sleep(300);
      await window.quickStartMode(t, m); await sleep(1400);
      out.active = document.querySelector('.page.active')?.id || null;
      if (out.active !== pid) return out;

      const el = (id) => document.getElementById(id);
      const num = (id) => Number(el(id)?.textContent || 0);
      /* 플래시카드 계열에는 정답/오답 카운터가 없다(진행 표시만 있다).
         모든 모드에 있는 <접두사>-current 로 "문항이 실제로 넘어갔는가" 를 잰다. */
      const counters = () => ({ c: num(px + '-correct'), w: num(px + '-wrong'), i: num(px + '-current') });
      out.start = counters();

      for (let round = 0; round < 3; round++) {
        const p = el(pid);
        const r = { round };
        /* 1) 플래시카드류: 카드를 뒤집고 평가한다 */
        const rating = [...p.querySelectorAll('.rating-btn,[class*="rating"] button,.rating-bar button')]
          .filter((b) => b.offsetParent !== null && !b.disabled);
        const options = [...p.querySelectorAll('.quiz-option')].filter((o) => o.offsetParent !== null && !o.disabled);
        const input = p.querySelector('input[type="text"]:not([disabled]),textarea:not([disabled])');

        if (options.length) {
          /* 짝수 회차는 정답, 홀수 회차는 오답 — 두 경로를 다 태운다 */
          const wantCorrect = round % 2 === 0;
          const pick = options.find((o) => (o.dataset.ans === 'true') === wantCorrect) || options[0];
          r.kind = 'options'; r.picked = wantCorrect ? 'correct' : 'wrong';
          pick.click();
        } else if (input) {
          r.kind = 'input';
          input.value = round % 2 === 0 ? (input.dataset.expected || 'zhe4ge5') : 'definitely-wrong';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const submit = [...p.querySelectorAll('button')].find((b) => /확인|제출|정답/.test(b.textContent || '') && b.offsetParent !== null && !b.disabled);
          if (!submit) { r.err = '제출 버튼 없음'; out.rounds.push(r); break; }
          submit.click();
        } else if (rating.length) {
          r.kind = 'rating';
          rating[Math.min(2, rating.length - 1)].click();
        } else {
          /* 카드 뒤집기가 먼저 필요한 화면 */
          const flip = [...p.querySelectorAll('button,.flashcard,[onclick]')].find((x) => /뒤집|정답 보기|보기/.test(x.textContent || '') && x.offsetParent !== null);
          if (flip) { r.kind = 'flip'; flip.click(); }
          else { r.err = '조작할 요소를 찾지 못함'; out.rounds.push(r); break; }
        }
        await sleep(1500);
        /* 평가 바가 떴으면 눌러서 다음으로 */
        const rating2 = [...el(pid).querySelectorAll('.rating-btn,[class*="rating"] button,.rating-bar button')]
          .filter((b) => b.offsetParent !== null && !b.disabled);
        if (rating2.length) { rating2[Math.min(2, rating2.length - 1)].click(); await sleep(1200); }
        /* "다음" 버튼이 있으면 누른다 */
        const next = el(px + '-next-btn') || el(px + '-submit-btn')
          || [...el(pid).querySelectorAll('button')].find((b) => /다음/.test(b.textContent || '') && b.offsetParent !== null && !b.disabled);
        if (next && next.offsetParent !== null && !next.disabled) { next.click(); await sleep(900); }
        /* 다음 문항이 실제로 준비될 때까지 기다린다. 채점 직후에는 보기와 입력칸이
           잠깐 비활성이라, 고정 sleep 으로는 그 구간을 잡아 "조작할 요소 없음" 으로
           오진한다. */
        for (let w = 0; w < 30; w++) {
          const q = el(pid);
          const ready = [...q.querySelectorAll('.quiz-option')].some((o) => o.offsetParent !== null && !o.disabled)
            || !!q.querySelector('input[type="text"]:not([disabled]),textarea:not([disabled])')
            || [...q.querySelectorAll('.rating-btn,[class*="rating"] button,.rating-bar button')].some((x) => x.offsetParent !== null && !x.disabled);
          if (ready) break;
          await sleep(200);
        }
        r.after = counters();
        out.rounds.push(r);
      }
      out.end = counters();
      out.moved = (out.end.c + out.end.w) > (out.start.c + out.start.w) || out.end.i > out.start.i;
      out.stillOnPage = document.querySelector('.page.active')?.id === pid;
      return out;
    } catch (e) { out.err = String(e.message).slice(0, 160); return out; }
  }, { t: type, m: mode, pid: pageId, px: prefix }, 60000);

  const newErr = report.pageErrors.length - errBefore;
  if (played === FROZEN) { step(`모드 ${mode} 플레이`, 'fail', '앱 정지'); continue; }
  if (played.err) { step(`모드 ${mode} 플레이`, 'fail', played.err); }
  else if (played.active !== pageId) { step(`모드 ${mode} 플레이`, 'fail', `시작 실패 — 화면 ${played.active}`); }
  else {
    const kinds = played.rounds.map((r) => r.kind || r.err).join('/');
    const ok = played.moved && newErr === 0 && !played.rounds.some((r) => r.err);
    step(`모드 ${mode} 플레이`, ok ? 'pass' : 'fail',
      `조작 ${kinds} · 정답/오답 ${played.start?.c}/${played.start?.w} → ${played.end?.c}/${played.end?.w} · 진행 ${played.start?.i} → ${played.end?.i}${played.moved ? '' : '  ← 문항이 넘어가지 않음'}${newErr ? `  ← 미처리 예외 ${newErr}건` : ''}`);
  }
  await ev(page, () => { try { document.querySelectorAll('.modal-overlay.show').forEach((o) => o.classList.remove('show')); window.showPage('study', true); } catch (_) {} }, null, 10000);
  await page.waitForTimeout(400);
}

const pass = report.steps.filter((s) => s.status === 'pass').length;
const fail = report.steps.filter((s) => s.status === 'fail').length;
report.totals = { pass, fail, pageErrors: report.pageErrors.length, consoleErrors: report.console.length, frozen };
fs.writeFileSync(path.join(OUT_DIR, 'play.json'), JSON.stringify(report, null, 2));
console.log('\n' + '─'.repeat(64));
console.log(`합계  pass ${pass} / fail ${fail}   페이지에러 ${report.pageErrors.length}  콘솔에러 ${report.console.length}${frozen ? '   ★ 앱 정지 발생' : ''}`);
if (report.pageErrors.length) console.log('미처리 예외: ' + JSON.stringify(report.pageErrors.slice(0, 6), null, 1));
if (report.console.length) console.log('콘솔 오류: ' + JSON.stringify(report.console.slice(0, 6), null, 1));
console.log(`리포트: ${path.join(OUT_DIR, 'play.json')}`);
await browser.close().catch(() => {});
srv.close();
process.exit(fail ? 1 : 0);
