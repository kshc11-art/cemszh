/**
 * CEMS 대화상자 · 학습 종료 회귀 테스트
 *
 * probe.mjs 와 sweep.mjs 는 학습 세션 화면(page-flashcard 등)에 들어가지 않고
 * 함수만 직접 부르기 때문에, "확인 대화상자를 여는 순간 앱이 멈춘다" 같은 결함을
 * 한 건도 잡지 못했다. 이 스크립트는 실제 DOM 클릭으로 그 경로만 집중해서 본다.
 *
 * 핵심 장치: 모든 page.evaluate 를 타임아웃과 함께 실행한다. 메인 스레드가 멈추면
 * evaluate 는 영원히 resolve 되지 않으므로, 타임아웃 = 앱 정지 = FAIL 이다.
 *
 * 사용법: node modals.mjs <앱디렉터리> <라벨>
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = process.argv[2] || path.resolve('..');
const LABEL   = process.argv[3] || 'modals';
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
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(f).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const FROZEN = Symbol('frozen');
const report = { label: LABEL, appDir: APP_DIR, steps: [], pageErrors: [], console: [] };
let frozen = false;

const step = (name, status, detail) => {
  report.steps.push({ name, status, detail });
  console.log(`  ${(status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'INFO').padEnd(4)} ${name}${detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
};

/* 멈춘 페이지에서 evaluate 는 reject 도 resolve 도 하지 않는다. 반드시 경주시킨다. */
async function ev(page, fn, arg, ms = 8000) {
  if (frozen) return FROZEN;
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r(FROZEN), ms); });
  const result = await Promise.race([
    page.evaluate(fn, arg).catch((e) => ({ __err: String(e.message).slice(0, 160) })),
    timeout,
  ]);
  clearTimeout(timer);
  if (result === FROZEN) frozen = true;
  return result;
}

/* 모드별 종료 버튼: [모드, 시작인자 type, 화면 id] */
const MODES = [
  ['flashcard',    'vocab', 'page-flashcard'],
  ['quiz',         'vocab', 'page-quiz'],
  ['reverse',      'vocab', 'page-quiz'],
  ['typing',       'vocab', 'page-typing'],
  ['cloze',        'vocab', 'page-cloze'],
  ['collocation',  'vocab', 'page-collocation'],
  ['listening',    'vocab', 'page-listening'],
  ['dictation',    'vocab', 'page-dictation'],
  ['expr-fc',      'expr',  'page-expr-fc'],
  ['expr-quiz',    'expr',  'page-expr-quiz'],
  ['expr-cloze',   'expr',  'page-expr-cloze'],
  ['expr-typing',  'expr',  'page-expr-typing'],
];

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
  page.on('pageerror', (e) => report.pageErrors.push(String(e.message).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') report.console.push(m.text().slice(0, 300)); });

  await page.goto(base + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(6000);
  const seed = await ev(page, async () => {
    for (let i = 0; i < 90; i++) {
      try { if (typeof getAllWords === 'function') { const w = await getAllWords(); if (w && w.length) return w.length; } } catch (_) {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    return 0;
  }, null, 120000);
  step('시드 로드', seed === FROZEN ? 'fail' : (seed ? 'pass' : 'fail'), seed === FROZEN ? '정지' : `단어 ${seed}개`);

  /* ── 1. 확인 대화상자 자체 ────────────────────────────────
     showConfirm 을 여는 것만으로 멈추면 여기서 전부 FAIL 이 난다. */
  const TITLES = ['학습 종료', '데이터 삭제', '전체 초기화', '백업 복원', '안내'];
  for (const title of TITLES) {
    const open = await ev(page, (t) => {
      window.__cb = 0;
      window.showConfirm(t, '회귀 테스트', () => { window.__cb++; });
      return 'opened';
    }, title, 8000);
    if (open === FROZEN) { step(`대화상자 "${title}" 열기`, 'fail', '앱 정지 — 메인 스레드가 응답하지 않음'); break; }

    const state = await ev(page, () => {
      const o = document.getElementById('confirm-modal');
      const b = document.getElementById('confirm-btn');
      const cancel = o?.querySelector('.modal button:not(#confirm-btn):not(.modal-close)');
      /* innerText 는 아직 렌더되지 않은 요소에서 '' 이 된다. 라벨 검증은 textContent 로. */
      return { shown: !!o?.classList.contains('show'), confirm: (b?.textContent || '').trim(), cancel: (cancel?.textContent || '').trim() };
    }, null, 8000);
    if (state === FROZEN) { step(`대화상자 "${title}" 상태`, 'fail', '앱 정지'); break; }

    /* 실제 DOM 클릭으로 확인 */
    let clickErr = null;
    try { await page.click('#confirm-btn', { timeout: 6000 }); } catch (e) { clickErr = String(e.message).split('\n')[0].slice(0, 100); }
    const after = await ev(page, () => ({ cb: window.__cb, open: !!document.getElementById('confirm-modal')?.classList.contains('show') }), null, 8000);
    if (after === FROZEN) { step(`대화상자 "${title}" 확인 클릭`, 'fail', '클릭 후 앱 정지'); break; }
    const wantConfirm = /종료/.test(title) ? '종료하기' : /삭제/.test(title) ? '삭제하기' : /초기화/.test(title) ? '초기화하기' : /복원/.test(title) ? '복원하기' : '확인';
    const wantCancel = /학습 종료|퀴즈 종료/.test(title) ? '계속 학습' : '취소';
    const ok = state.shown && !clickErr && after.cb === 1 && after.open === false
      && state.confirm === wantConfirm && state.cancel === wantCancel;
    step(`대화상자 "${title}"`, ok ? 'pass' : 'fail',
      `확인="${state.confirm}"(기대 ${wantConfirm}) 취소="${state.cancel}"(기대 ${wantCancel}) 콜백=${after.cb} 닫힘=${after.open === false}${clickErr ? ' 클릭실패:' + clickErr : ''}`);
  }

  /* 취소 버튼도 확인한다 — 콜백이 실행되면 안 된다. */
  if (!frozen) {
    await ev(page, () => { window.__cb = 0; window.showConfirm('학습 종료', '취소 테스트', () => { window.__cb++; }); }, null, 8000);
    let cancelErr = null;
    try { await page.click('#confirm-modal .modal button:not(#confirm-btn):not(.modal-close)', { timeout: 6000 }); } catch (e) { cancelErr = String(e.message).split('\n')[0].slice(0, 100); }
    const r = await ev(page, () => ({ cb: window.__cb, open: !!document.getElementById('confirm-modal')?.classList.contains('show') }), null, 8000);
    step('대화상자 취소', r !== FROZEN && !cancelErr && r.cb === 0 && r.open === false ? 'pass' : 'fail',
      r === FROZEN ? '앱 정지' : `콜백=${r.cb} 닫힘=${r.open === false}${cancelErr ? ' ' + cancelErr : ''}`);
  }

  /* ── 1b. 학습모드 선택기가 확인 버튼을 실제로 감추는가 ────────────
     showStudyModeModal 계열은 같은 #confirm-modal 을 재사용하면서 확인 버튼을
     인라인 display:none 으로 감추려 했지만, v944 CSS 의 !important 규칙이 이를
     이겨서 버튼이 계속 보였다. 게다가 그 버튼에는 직전 확인 대화상자의 onclick 이
     그대로 남아 있어, 선택기에서 확인을 누르면 엉뚱한 동작이 조용히 실행됐다.
     (예: 직전에 취소한 "학습 종료" 가 여기서 실행된다.)
     되돌리기가 "시작" 버튼에만 있던 문제도 함께 본다 — ✕ 로 닫은 뒤 다음 대화상자. */
  if (!frozen) {
    const picker = await ev(page, async () => {
      if (typeof window.showStudyModeModal !== 'function') return { skipped: true };
      window.__stale = 0;
      window.showConfirm('학습 종료', '직전 대화상자', () => { window.__stale++; });
      await new Promise((r) => setTimeout(r, 250));
      document.querySelector('#confirm-modal .modal-close')?.click();
      await new Promise((r) => setTimeout(r, 250));
      window.showStudyModeModal('학습 모드 선택', 3, 'vocab', [], []);
      await new Promise((r) => setTimeout(r, 350));
      const btn = document.getElementById('confirm-btn');
      const visible = btn.offsetParent !== null;
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      return { visible, stale: window.__stale, pickerOpen: document.getElementById('confirm-modal').classList.contains('show') };
    }, null, 12000);

    if (picker === FROZEN) step('선택기 확인 버튼', 'fail', '앱 정지');
    else if (picker.skipped) step('선택기 확인 버튼', 'info', 'showStudyModeModal 없음 — 건너뜀');
    else {
      step('선택기 확인 버튼', !picker.visible && picker.stale === 0 && picker.pickerOpen ? 'pass' : 'fail',
        `보임=${picker.visible}(기대 false) 직전콜백실행=${picker.stale}(기대 0) 선택기유지=${picker.pickerOpen}(기대 true)`);

      /* ✕ 로 닫은 뒤 다음 확인 대화상자에서 버튼이 되살아나야 한다 */
      let xErr = null;
      try { await page.click('#confirm-modal .modal-close', { timeout: 6000 }); } catch (e) { xErr = String(e.message).split('\n')[0].slice(0, 90); }
      await ev(page, () => { window.__cb2 = 0; window.showConfirm('학습 종료', '선택기 이후 확인', () => { window.__cb2++; }); }, null, 8000);
      const vis = await ev(page, () => {
        const b = document.getElementById('confirm-btn');
        return { display: b ? getComputedStyle(b).display : null, offset: b ? b.offsetParent !== null : false };
      }, null, 8000);
      let cErr = null;
      try { await page.click('#confirm-btn', { timeout: 6000 }); } catch (e) { cErr = String(e.message).split('\n')[0].slice(0, 90); }
      const fired = await ev(page, () => window.__cb2, null, 8000);
      step('선택기 ✕ 이후 확인 버튼 복구', vis !== FROZEN && vis.offset && !cErr && fired === 1 ? 'pass' : 'fail',
        `display=${vis === FROZEN ? '정지' : vis.display} 보임=${vis === FROZEN ? '-' : vis.offset} 콜백=${fired}${xErr ? ' ✕:' + xErr : ''}${cErr ? ' 확인:' + cErr : ''}`);
      await ev(page, () => { document.querySelectorAll('.modal-overlay.show').forEach((o) => o.classList.remove('show')); }, null, 8000);
    }
  }

  /* ── 2. 학습 모드 진입 → 학습 종료 → 종료하기 ─────────────── */
  for (const [mode, type, pageId] of MODES) {
    if (frozen) { step(`모드 ${mode} 종료`, 'fail', '앞 단계에서 정지'); continue; }

    const started = await ev(page, async ({ t, m }) => {
      try {
        window.showPage('study', true);
        await new Promise((r) => setTimeout(r, 300));
        await window.quickStartMode(t, m);
        await new Promise((r) => setTimeout(r, 1200));
        const active = document.querySelector('.page.active')?.id || null;
        return { active };
      } catch (e) { return { err: String(e.message).slice(0, 140) }; }
    }, { t: type, m: mode }, 30000);

    if (started === FROZEN) { step(`모드 ${mode} 시작`, 'fail', '앱 정지'); continue; }
    if (started.err || started.active !== pageId) {
      step(`모드 ${mode} 시작`, 'fail', started.err || `기대 ${pageId} / 실제 ${started.active}`);
      await ev(page, () => window.showPage('study', true), null, 8000);
      continue;
    }

    /* 활성 화면 안에서 "종료" 버튼을 실제로 클릭한다 */
    const exit = await ev(page, (id) => {
      const p = document.getElementById(id);
      if (!p) return { err: '화면 없음' };
      const btn = Array.from(p.querySelectorAll('button')).find((b) => /종료/.test((b.innerText || b.getAttribute('aria-label') || '')));
      if (!btn) return { err: '종료 버튼 없음' };
      btn.click();
      return { clicked: (btn.innerText || '').trim() };
    }, pageId, 12000);
    if (exit === FROZEN) { step(`모드 ${mode} 종료 버튼`, 'fail', '종료 버튼 클릭 후 앱 정지'); continue; }
    if (exit.err) { step(`모드 ${mode} 종료 버튼`, 'fail', exit.err); await ev(page, () => window.showPage('study', true), null, 8000); continue; }

    const dlg = await ev(page, () => {
      const o = document.getElementById('confirm-modal');
      return { shown: !!o?.classList.contains('show'), title: (document.getElementById('confirm-title')?.textContent || '').trim(), confirm: (document.getElementById('confirm-btn')?.textContent || '').trim() };
    }, null, 8000);
    if (dlg === FROZEN) { step(`모드 ${mode} 종료 대화상자`, 'fail', '대화상자가 뜨는 순간 앱 정지'); continue; }

    if (dlg.shown) {
      let clickErr = null;
      try { await page.click('#confirm-btn', { timeout: 6000 }); } catch (e) { clickErr = String(e.message).split('\n')[0].slice(0, 100); }
      const done = await ev(page, () => ({ active: document.querySelector('.page.active')?.id || null, open: Array.from(document.querySelectorAll('.modal-overlay.show')).map((e) => e.id) }), null, 12000);
      if (done === FROZEN) { step(`모드 ${mode} 종료하기`, 'fail', '"종료하기" 클릭 후 앱 정지'); continue; }
      const ok = !clickErr && !done.open.length && done.active !== pageId;
      step(`모드 ${mode} 종료하기`, ok ? 'pass' : 'fail',
        `대화상자="${dlg.title}"/"${dlg.confirm}" → 화면 ${done.active} 남은모달 ${JSON.stringify(done.open)}${clickErr ? ' ' + clickErr : ''}`);
    } else {
      /* 평가한 항목이 없으면 확인 없이 바로 끝나는 모드도 있다 */
      const done = await ev(page, () => ({ active: document.querySelector('.page.active')?.id || null }), null, 8000);
      step(`모드 ${mode} 종료하기`, done !== FROZEN && done.active !== pageId ? 'pass' : 'fail',
        done === FROZEN ? '앱 정지' : `확인 없이 종료 → 화면 ${done.active}`);
    }
    await ev(page, () => window.showPage('study', true), null, 8000);
  }

  /* ── 3. 마무리 ───────────────────────────────────────────── */
  const pass = report.steps.filter((s) => s.status === 'pass').length;
  const fail = report.steps.filter((s) => s.status === 'fail').length;
  report.totals = { pass, fail, pageErrors: report.pageErrors.length, consoleErrors: report.console.length, frozen };
  fs.writeFileSync(path.join(OUT_DIR, 'modals.json'), JSON.stringify(report, null, 2));
  console.log('\n' + '─'.repeat(64));
  console.log(`합계  pass ${pass} / fail ${fail}   페이지에러 ${report.pageErrors.length}  콘솔에러 ${report.console.length}${frozen ? '   ★ 앱 정지 발생' : ''}`);
  if (report.pageErrors.length) console.log('미처리 예외: ' + JSON.stringify(report.pageErrors.slice(0, 5), null, 1));
  console.log(`리포트: ${path.join(OUT_DIR, 'modals.json')}`);

  await browser.close().catch(() => {});
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
