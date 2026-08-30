/**
 * CEMS 회귀 테스트 하네스
 * 실제 Chromium 에서 앱을 구동하고 화면·학습모드·데이터도구를 순회하며 동작을 기록한다.
 *
 * 사용법:  node probe.mjs <앱디렉터리> <출력라벨>
 *   예)    node probe.mjs .. baseline
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = process.argv[2] || path.resolve('..');
const LABEL   = process.argv[3] || 'run';
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', LABEL);
fs.mkdirSync(OUT_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.md': 'text/markdown; charset=utf-8',
};

function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(root, p);
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(f)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'service-worker-allowed': '/',
      });
      fs.createReadStream(f).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const report = {
  label: LABEL, appDir: APP_DIR, startedAt: new Date().toISOString(),
  console: [], pageErrors: [], failedRequests: [], steps: [], summary: {},
};
const step = (name, status, detail) => {
  report.steps.push({ name, status, detail });
  const icon = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'INFO';
  console.log(`  ${icon.padEnd(4)} ${name}${detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
};

(async () => {
  const { server, port } = await serve(APP_DIR);
  const base = `http://127.0.0.1:${port}`;
  console.log(`\n[${LABEL}] ${APP_DIR}  →  ${base}\n`);

  const browser = await chromium.launch({
    executablePath: process.env.CEMS_CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, locale: 'ko-KR' });
  const page = await ctx.newPage();

  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      report.console.push({ type: m.type(), text: m.text().slice(0, 400) });
    }
  });
  page.on('pageerror', (e) => report.pageErrors.push({ message: String(e.message).slice(0, 400) }));
  page.on('requestfailed', (r) => report.failedRequests.push({ url: r.url().replace(base, ''), err: r.failure()?.errorText }));

  // ── 1. 부팅 ────────────────────────────────────────────────
  const t0 = Date.now();
  await page.goto(base + '/index.html', { waitUntil: 'load', timeout: 60000 });
  step('페이지 load', 'pass', `${Date.now() - t0}ms`);

  // 부팅 타이머가 4200ms 까지 있고, 15MB 시드 로드가 뒤따른다.
  await page.waitForTimeout(6000);
  const seed = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 90; i++) {
      try {
        if (typeof getAllWords === 'function') {
          const w = await getAllWords();
          if (w && w.length) return { words: w.length, ok: true };
        }
      } catch (_) {}
      await wait(1000);
    }
    return { words: 0, ok: false };
  });
  step('시드 로드', seed.ok ? 'pass' : 'fail', `단어 ${seed.words}개`);

  const counts = await page.evaluate(async () => {
    const out = {};
    try { out.words = (await getAllWords()).length; } catch (e) { out.words = 'ERR:' + e.message; }
    try { out.expr  = (await getAllExpr()).length;  } catch (e) { out.expr  = 'ERR:' + e.message; }
    return out;
  });
  step('데이터 건수', 'info', counts);

  // ── 2. 지층/래핑 깊이 실측 ─────────────────────────────────
  const layering = await page.evaluate(() => {
    const depth = (fn) => { let d = 0, f = fn; while (f && typeof f.__previous === 'function' && d < 60) { f = f.__previous; d++; } return d; };
    const flags = (fn) => fn ? Object.getOwnPropertyNames(fn).filter((k) => k.startsWith('__')) : [];
    const names = ['showPage', 'switchGlobalType', 'selectStudyItems', 'startQuiz', 'updateWordTable', 'getAllExpr', 'quickStartMode'];
    const o = {};
    for (const n of names) {
      const f = window[n];
      o[n] = typeof f === 'function' ? { wrapDepth: depth(f), flags: flags(f) } : null;
    }
    o._docClickListeners = 'n/a';
    return o;
  });
  step('래핑 깊이 (__previous 체인)', 'info', Object.fromEntries(Object.entries(layering).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, v ? v.wrapDepth : 'MISSING'])));
  report.summary.layering = layering;

  // ── 3. 전역 심볼 존재 확인 ─────────────────────────────────
  const globals = await page.evaluate(() => {
    const want = ['CEMS943', 'CEMS944', 'CEMS944R2', 'CEMS944Final', 'CEMS931', 'CEMS932Decks',
      'CEMS932Hub', 'CEMS941UI', 'CEMS941Schema', 'CEMS_LEAN', 'CEMS_UX25', 'db', 'showPage'];
    const o = {};
    for (const w of want) { try { o[w] = typeof window[w] !== 'undefined' && window[w] !== null; } catch (_) { o[w] = false; } }
    o['CEMS_LEAN._modules'] = !!(window.CEMS_LEAN && window.CEMS_LEAN._modules);
    return o;
  });
  const missingGlobals = Object.entries(globals).filter(([, v]) => !v).map(([k]) => k);
  step('전역 심볼', missingGlobals.length ? 'info' : 'pass', missingGlobals.length ? { 없음: missingGlobals } : '전부 존재');
  report.summary.globals = globals;

  // ── 4. 화면 순회 ───────────────────────────────────────────
  const ROUTES = ['home', 'study', 'stats', 'data', 'settings', 'chinese-lab', 'lean', 'lean-studio', 'dialogue-practice', 'sentence-check'];
  const pages = [];
  for (const r of ROUTES) {
    const before = report.pageErrors.length;
    const res = await page.evaluate(async (name) => {
      try { window.showPage(name, true); } catch (e) { return { err: e.message }; }
      await new Promise((x) => setTimeout(x, 700));
      const el = document.getElementById('page-' + name);
      if (!el) return { exists: false };
      const vis = el.offsetParent !== null || getComputedStyle(el).display !== 'none';
      const txt = (el.innerText || '').trim();
      const btns = el.querySelectorAll('button').length;
      const emptyBtns = Array.from(el.querySelectorAll('button')).filter((b) => !(b.innerText || '').trim() && !b.querySelector('img,svg') && !getComputedStyle(b, '::before').maskImage?.includes('url')).length;
      return { exists: true, visible: vis, textLen: txt.length, buttons: btns, emptyButtons: emptyBtns, head: txt.slice(0, 60).replace(/\s+/g, ' ') };
    }, r);
    const newErr = report.pageErrors.length - before;
    pages.push({ route: r, ...res, newPageErrors: newErr });
    const bad = !res.exists || res.visible === false || (res.textLen || 0) < 20 || newErr > 0;
    step(`화면 ${r}`, bad ? 'fail' : 'pass', res.exists ? `${res.textLen}자 / 버튼 ${res.buttons}개${res.emptyButtons ? ` / 빈버튼 ${res.emptyButtons}` : ''}${newErr ? ` / 에러 ${newErr}` : ''}` : '페이지 없음');
  }
  report.summary.pages = pages;

  // ── 5. 학습 모드 실행 ──────────────────────────────────────
  await page.evaluate(() => window.showPage('study', true));
  await page.waitForTimeout(500);
  const MODES = ['flashcard', 'quiz', 'reverse', 'typing', 'dictation', 'listening', 'cloze', 'collocation'];
  const modes = [];
  for (const m of MODES) {
    const before = report.pageErrors.length;
    const res = await page.evaluate(async (mode) => {
      const out = { mode };
      try {
        const items = await (async () => {
          const all = await getAllWords();
          if (typeof selectStudyItems !== 'function') return { err: 'selectStudyItems 없음' };
          return selectStudyItems(all, 5, 'vocab', { mode });
        })();
        out.selected = Array.isArray(items?.items) ? items.items.length : (Array.isArray(items) ? items.length : 0);
        out.stats = items?.stats ? Object.keys(items.stats).length : 0;
      } catch (e) { out.err = e.message; }
      return out;
    }, m);
    const newErr = report.pageErrors.length - before;
    modes.push({ ...res, newPageErrors: newErr });
    step(`모드 ${m}`, res.err || res.selected === 0 ? 'fail' : 'pass', res.err ? res.err : `카드 ${res.selected}개`);
  }
  report.summary.modes = modes;

  // ── 6. 랜덤 회전: 연속 두 세션 중복 검사 ────────────────────
  const rot = await page.evaluate(async () => {
    try {
      const all = await getAllWords();
      const key = (x) => x?.Traditional_CH || x?.id || JSON.stringify(x).slice(0, 40);
      const a = (selectStudyItems(all, 5, 'vocab', { mode: 'flashcard' })?.items || []).map(key);
      const b = (selectStudyItems(all, 5, 'vocab', { mode: 'flashcard' })?.items || []).map(key);
      return { a, b, overlap: a.filter((k) => b.includes(k)) };
    } catch (e) { return { err: e.message }; }
  });
  step('랜덤 회전 중복', rot.err ? 'fail' : (rot.overlap?.length ? 'info' : 'pass'), rot.err || `중복 ${rot.overlap.length}개`);
  report.summary.rotation = rot;

  // ── 6b. 빈 답이 정답으로 채점되는가 ────────────────────────
  //  정규화 결과가 양쪽 다 빈 문자열이면 '일치' 가 된다. 병음이 없는 카드(가져온
  //  데이터에는 있을 수 있다)에 빈 답을 내면 만점으로 기록됐다.
  const emptyAnswer = await page.evaluate(async () => {
    try {
      const all = await getAllWords();
      const fake = { ...all[0], Traditional_CH: '測試空白', Pinyin: '', Meaning_KO: '빈 병음 테스트' };
      window.showPage('study', true); await new Promise((r) => setTimeout(r, 300));
      startTyping([fake], [fake, ...all.slice(0, 5)]);
      await new Promise((r) => setTimeout(r, 900));
      const inp = document.getElementById('typing-input');
      if (!inp) return { err: 'typing-input 없음' };
      inp.value = '';
      document.getElementById('typing-submit-btn').click();
      await new Promise((r) => setTimeout(r, 1200));
      return {
        correct: Number(document.getElementById('typing-correct')?.textContent || 0),
        wrong: Number(document.getElementById('typing-wrong')?.textContent || 0),
      };
    } catch (e) { return { err: e.message }; }
  });
  step('빈 답 채점', emptyAnswer.err ? 'fail' : (emptyAnswer.correct === 0 && emptyAnswer.wrong === 1 ? 'pass' : 'fail'),
    emptyAnswer.err || `병음 없는 카드에 빈 답 → 정답 ${emptyAnswer.correct} / 오답 ${emptyAnswer.wrong}${emptyAnswer.correct ? '  ← 빈 답이 정답 처리됨' : ''}`);
  report.summary.emptyAnswer = emptyAnswer;
  await page.evaluate(() => { try { window.showPage('study', true); } catch (_) {} });
  await page.waitForTimeout(300);

  // ── 6c. 탭을 벗어났다 돌아오면 학습 타이머가 다시 도는가 ────
  //  숨길 때 cleanupAllTimers 가 표시용 인터벌까지 지우는데 복구하는 쪽이 없었다.
  const visTimer = await page.evaluate(async () => {
    try {
      window.showPage('study', true); await new Promise((r) => setTimeout(r, 300));
      await window.quickStartMode('vocab', 'flashcard');
      await new Promise((r) => setTimeout(r, 2200));
      const read = () => document.getElementById('fc-timer')?.textContent;
      const a = read(); await new Promise((r) => setTimeout(r, 2200)); const b = read();
      const setHidden = (v) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => v });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (v ? 'hidden' : 'visible') });
        document.dispatchEvent(new Event('visibilitychange'));
      };
      setHidden(true); await new Promise((r) => setTimeout(r, 1000));
      setHidden(false); await new Promise((r) => setTimeout(r, 600));
      const c = read(); await new Promise((r) => setTimeout(r, 2400)); const d = read();
      return { before: a !== b, after: c !== d, a, b, c, d };
    } catch (e) { return { err: e.message }; }
  });
  step('탭 복귀 후 학습 타이머', visTimer.err ? 'fail' : (visTimer.before && visTimer.after ? 'pass' : 'fail'),
    visTimer.err || `숨김 전 ${visTimer.a}→${visTimer.b} · 복귀 후 ${visTimer.c}→${visTimer.d}${visTimer.after ? '' : '  ← 복귀 뒤 멈춰 있음'}`);
  report.summary.visibilityTimer = visTimer;
  await page.evaluate(() => { try { window.showPage('study', true); } catch (_) {} });
  await page.waitForTimeout(300);

  // ── 7. getAllExpr 누수 재현 (C4) ───────────────────────────
  const leak = await page.evaluate(async () => {
    try {
      const baseline = (await getAllExpr()).length;
      // updateWordTable 을 동시 4회 — 탭 클릭 1회와 동일한 상황
      if (typeof window.updateWordTable === 'function') {
        await Promise.all([0, 1, 2, 3].map(() => Promise.resolve().then(() => window.updateWordTable())));
      }
      await new Promise((r) => setTimeout(r, 1200));
      const after = (await getAllExpr()).length;
      return { baseline, after, leaked: after !== baseline };
    } catch (e) { return { err: e.message }; }
  });
  step('getAllExpr 누수(C4)', leak.err ? 'fail' : (leak.leaked ? 'fail' : 'pass'),
    leak.err || `전 ${leak.baseline} → 후 ${leak.after}${leak.leaked ? '  ← 오염됨' : ''}`);
  report.summary.exprLeak = leak;

  // ── 7a. 강제 종료가 세션을 올바른 종류로 기록하는가 ──────────
  //  forceEndCurrentStudy 의 받아쓰기 분기만 currentListeningType 을 쓰고 있었다.
  const forcedEnd = await page.evaluate(async () => {
    try {
      const words = await getAllWords(), exprs = await getAllExpr();
      window.showPage('study', true); await new Promise((r) => setTimeout(r, 250));
      startListening(words.slice(0, 3), words, 'vocab');          // currentListeningType = 'vocab'
      await new Promise((r) => setTimeout(r, 600));
      window.showPage('study', true); await new Promise((r) => setTimeout(r, 350));
      startDictation(exprs.slice(0, 3), exprs, 'expr');           // currentDictationType = 'expr'
      await new Promise((r) => setTimeout(r, 800));
      dictationState.correct = 1; dictationState.wrong = 0;
      await forceEndCurrentStudy();
      await new Promise((r) => setTimeout(r, 800));
      const dict = (await getSessions()).filter((x) => x.mode === 'dictation').slice(-1)[0];
      return { saved: !!dict, type: dict ? dict.type : null };
    } catch (e) { return { err: e.message }; }
  });
  step('강제 종료 세션 종류', forcedEnd.err ? 'fail' : (forcedEnd.saved && forcedEnd.type === 'expr' ? 'pass' : 'fail'),
    forcedEnd.err || `표현 받아쓰기를 화면 이동으로 종료 → 기록된 type="${forcedEnd.type}" (기대 expr)`);
  report.summary.forcedEnd = forcedEnd;
  await page.evaluate(() => { try { window.showPage('study', true); } catch (_) {} });
  await page.waitForTimeout(300);

  // ── 7b. 데이터 필터 렌즈가 다른 컬렉션까지 걸러내는가 ────────
  //  CEMS_LENS 콜백은 kind 를 봐야 한다. 보지 않으면 "최근 7일" 필터가 걸린 동안
  //  다른 모듈의 getAllExpr / getAllPV 까지 같이 걸러진다.
  const lensIsolation = await page.evaluate(async () => {
    try {
      window.showPage('data', true); await new Promise((r) => setTimeout(r, 800));
      const sel = document.getElementById('data-filter-special');
      if (!sel) return { skipped: 'data-filter-special 없음' };
      /* 시드를 방금 넣은 프로필은 모든 행의 addedDate 가 오늘이라 필터가 아무것도
         걸러내지 않는다. 실제 기기처럼 일부 표현의 추가일을 60일 전으로 돌린다. */
      const old = new Date(Date.now() - 60 * 86400000).toISOString();
      const rows = await getAllFromStore('expressions');
      for (const r of rows.slice(0, 300)) { r.addedDate = old; await saveExpr(r); }
      await new Promise((r) => setTimeout(r, 300));
      const baseline = (await getAllExpr()).length;
      sel.value = 'new-7days';
      const running = window.updateWordTable();
      let during = baseline, active = 0;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 25));
        if (CEMS_LENS.active()) { active++; if (i === 2) during = (await getAllExpr()).length; }
      }
      await running;
      sel.value = 'all';
      return { baseline, during, activeSamples: active };
    } catch (e) { return { err: e.message }; }
  });
  step('데이터 필터 렌즈 격리', lensIsolation.err ? 'fail' : (lensIsolation.skipped ? 'info' : (lensIsolation.during === lensIsolation.baseline ? 'pass' : 'fail')),
    lensIsolation.err || lensIsolation.skipped ||
    `필터 동작 중 getAllExpr ${lensIsolation.baseline} → ${lensIsolation.during}${lensIsolation.during !== lensIsolation.baseline ? '  ← 표현까지 걸러짐' : ''} (렌즈 활성 샘플 ${lensIsolation.activeSamples}/40)`);
  report.summary.lensIsolation = lensIsolation;

  // ── 8. 시드 무결성 복구기 도달 여부 (C3) ────────────────────
  const recovery = await page.evaluate(async () => {
    const o = {};
    try { o.dbName = typeof DB_NAME === 'string' ? DB_NAME : null; } catch (_) { o.dbName = null; }
    o.status = window.CEMS944DataStatus || null;
    try { o.dbs = (await indexedDB.databases()).map((d) => d.name); } catch (_) { o.dbs = 'unsupported'; }
    return o;
  });
  step('시드 복구기(C3)', recovery.status ? 'info' : 'fail',
    { 실제DB: recovery.dbName, 상태: recovery.status ? (recovery.status.repaired ?? recovery.status) : '미도달' });
  report.summary.recovery = recovery;

  // ── 9. SW 업데이트 플래그 (C2) ─────────────────────────────
  const swflag = await page.evaluate(() => {
    const src = String(window.phase7ApplyUpdate || '');
    return {
      registered: !!navigator.serviceWorker.controller || !!window.phase7SWRegistration,
      applyIsPhase8: /phase8/i.test(src) || src.includes('ActivateWaiting'),
      setsFlag: /phase7UpdateRequested\s*=\s*true/.test(String(window.phase8ActivateWaiting || '')),
    };
  });
  step('SW 업데이트 플래그(C2)', swflag.setsFlag ? 'pass' : 'fail',
    swflag.setsFlag ? '적용 경로가 플래그를 세움' : '적용 경로가 phase7UpdateRequested 를 세우지 않음 → 새로고침 안 됨');
  report.summary.swUpdate = swflag;

  // ── 10. Gemini 채점 버전 (C1) ──────────────────────────────
  const grader = await page.evaluate(() => {
    const s = document.querySelector('script[src*="stable"]');
    return { clientVersionVisible: !!s };
  });
  report.summary.grader = grader;

  // ── 11. 성능: 클릭 1회당 재작업량 ──────────────────────────
  const perf = await page.evaluate(async () => {
    let qsa = 0;
    const orig = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function (...a) { qsa++; return orig.apply(this, a); };
    document.body.click();
    await new Promise((r) => setTimeout(r, 500));
    Document.prototype.querySelectorAll = orig;
    return { querySelectorAllCalls: qsa };
  });
  step('클릭 1회당 document.querySelectorAll', 'info', perf.querySelectorAllCalls + '회');
  report.summary.perf = perf;

  // ── 12. 스크린샷 ───────────────────────────────────────────
  for (const r of ['home', 'study', 'stats', 'data', 'settings']) {
    try {
      await page.evaluate((n) => window.showPage(n, true), r);
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUT_DIR, `${r}.png`), fullPage: false });
    } catch (_) {}
  }
  step('스크린샷', 'info', '5장');

  // ── 마무리 ─────────────────────────────────────────────────
  report.finishedAt = new Date().toISOString();
  report.summary.totals = {
    steps: report.steps.length,
    pass: report.steps.filter((s) => s.status === 'pass').length,
    fail: report.steps.filter((s) => s.status === 'fail').length,
    consoleErrors: report.console.filter((c) => c.type === 'error').length,
    consoleWarnings: report.console.filter((c) => c.type === 'warning').length,
    pageErrors: report.pageErrors.length,
    failedRequests: report.failedRequests.length,
  };

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n' + '─'.repeat(64));
  console.log(`합계  pass ${report.summary.totals.pass} / fail ${report.summary.totals.fail}` +
    `   콘솔에러 ${report.summary.totals.consoleErrors}  경고 ${report.summary.totals.consoleWarnings}` +
    `   페이지에러 ${report.summary.totals.pageErrors}  요청실패 ${report.summary.totals.failedRequests}`);
  console.log(`리포트: ${path.join(OUT_DIR, 'report.json')}`);

  await browser.close();
  server.close();
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
