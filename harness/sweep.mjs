/**
 * CEMS 전수 점검 — 모든 화면의 모든 버튼을 실제로 눌러보고 결과를 기록한다.
 * 사용법: node sweep.mjs <앱디렉터리> <라벨>
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = process.argv[2] || path.resolve('..');
const LABEL = process.argv[3] || 'sweep';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', LABEL);
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };
function serve(root) {
  return new Promise((res) => {
    const s = http.createServer((rq, rs) => {
      let p = decodeURIComponent(rq.url.split('?')[0]); if (p === '/') p = '/index.html';
      const f = path.join(root, p);
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rs.writeHead(404); rs.end(); return; }
      rs.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(f).pipe(rs);
    });
    s.listen(0, '127.0.0.1', () => res({ s, port: s.address().port }));
  });
}

const R = { label: LABEL, findings: [], buttons: [], console: [], pageErrors: [] };
const find = (sev, area, what, detail) => { R.findings.push({ sev, area, what, detail }); console.log(`  [${sev}] ${area} — ${what}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); };

(async () => {
  const { s, port } = await serve(APP_DIR);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') R.console.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => R.pageErrors.push(String(e.message).slice(0, 300)));

  console.log(`\n[전수 점검] ${APP_DIR}\n`);
  await page.goto(base + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(7000);
  await page.evaluate(async () => { for (let i = 0; i < 90; i++) { try { const w = await getAllWords(); if (w?.length) return; } catch (_) {} await new Promise(r => setTimeout(r, 1000)); } });

  // ── A. 빈 버튼 정밀 검사 ──────────────────────────────────
  const emptyBtns = await page.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll('button')) {
      const cs = getComputedStyle(b);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const rect = b.getBoundingClientRect();
      const txt = (b.innerText || b.textContent || '').trim();
      const hasChildGfx = !!b.querySelector('svg,img,i,.c943-icon,[class*="icon"]');
      const bef = getComputedStyle(b, '::before');
      const aft = getComputedStyle(b, '::after');
      const pseudoGfx = [bef, aft].some(p => (p.maskImage && p.maskImage !== 'none') || (p.webkitMaskImage && p.webkitMaskImage !== 'none') || (p.backgroundImage && p.backgroundImage !== 'none') || (p.content && p.content !== 'none' && p.content !== '""'));
      const aria = b.getAttribute('aria-label') || b.getAttribute('title') || '';
      if (!txt && !hasChildGfx && !pseudoGfx) {
        out.push({ id: b.id || null, cls: b.className || null, aria, page: b.closest('[id^="page-"]')?.id || null, w: Math.round(rect.width), h: Math.round(rect.height), onscreen: rect.width > 0 && rect.height > 0 });
      }
    }
    return out;
  });
  const realEmpty = emptyBtns.filter(b => b.onscreen);
  if (realEmpty.length) find('MED', 'UI', `내용도 아이콘도 없는 버튼 ${realEmpty.length}개`, realEmpty.slice(0, 8).map(b => b.id || b.cls || '(무명)'));
  else find('OK', 'UI', '빈 버튼 없음 (모든 버튼이 텍스트 또는 아이콘 보유)');
  R.buttons = emptyBtns;

  // ── B. 접근성: 아이콘 전용 버튼의 라벨 ────────────────────
  const unlabeled = await page.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll('button')) {
      const cs = getComputedStyle(b);
      if (cs.display === 'none') continue;
      const txt = (b.innerText || '').trim();
      const aria = b.getAttribute('aria-label') || b.getAttribute('title');
      if (!txt && !aria) out.push(b.id || b.className || '(무명)');
    }
    return out;
  });
  if (unlabeled.length) find('LOW', '접근성', `텍스트도 aria-label 도 없는 버튼 ${unlabeled.length}개`, unlabeled.slice(0, 10));

  // ── C. 래핑 깊이 실측 (호출 횟수로 측정) ──────────────────
  const depth = await page.evaluate(async () => {
    const out = {};
    // showPage: 최내곽 기반 함수가 몇 번 호출되는지 = 래퍼가 몇 겹인지의 실측 대용
    let base = window.showPage, chain = 0;
    while (base && typeof base.__previous === 'function' && chain < 60) { base = base.__previous; chain++; }
    out.showPageChain = chain;
    // replaceState 호출 횟수 = v9.1.1 라우터 래퍼가 몇 겹인지
    let rs = 0; const origRS = history.replaceState;
    history.replaceState = function (...a) { rs++; return origRS.apply(this, a); };
    // updateWordTable 호출 횟수 = switchGlobalType 래퍼 겹수
    let uwt = 0; const origU = window.updateWordTable;
    if (typeof origU === 'function') window.updateWordTable = function (...a) { uwt++; return origU.apply(this, a); };
    try { window.showPage('stats', true); } catch (_) {}
    await new Promise(r => setTimeout(r, 400));
    try { if (typeof window.switchGlobalType === 'function') window.switchGlobalType('expr'); } catch (_) {}
    await new Promise(r => setTimeout(r, 600));
    history.replaceState = origRS; if (typeof origU === 'function') window.updateWordTable = origU;
    out.replaceStatePerShowPage = rs;
    out.updateWordTablePerTabSwitch = uwt;
    return out;
  });
  find(depth.replaceStatePerShowPage > 1 ? 'HIGH' : 'OK', '구조', `showPage 1회 → history.replaceState ${depth.replaceStatePerShowPage}회`, '');
  find(depth.updateWordTablePerTabSwitch > 1 ? 'HIGH' : 'OK', '구조', `탭 전환 1회 → updateWordTable ${depth.updateWordTablePerTabSwitch}회`, '');
  R.depth = depth;

  // ── D. getAllExpr 누수 정밀 재현 (표현/문법 탭 상태에서) ──
  const leak = await page.evaluate(async () => {
    const out = {};
    try {
      out.before = (await getAllExpr()).length;
      // 표현 탭으로 전환 → ui.js 의 kind 가 'expr' 이 되어야 스왑이 활성화됨
      if (typeof window.switchGlobalType === 'function') window.switchGlobalType('expr');
      await new Promise(r => setTimeout(r, 300));
      // 동시 4회 (탭 클릭 1회에 실제로 벌어지는 일)
      await Promise.all([0, 1, 2, 3].map(() => Promise.resolve().then(() => { try { return window.updateWordTable(); } catch (_) { } })));
      await new Promise(r => setTimeout(r, 1500));
      out.after = (await getAllExpr()).length;
      out.leaked = out.after !== out.before;
      out.identityChanged = window.getAllExpr.name !== undefined;
    } catch (e) { out.err = e.message; }
    return out;
  });
  find(leak.leaked ? 'CRIT' : 'OK', '데이터', leak.leaked ? `getAllExpr 오염 재현: ${leak.before} → ${leak.after}` : `getAllExpr 누수 미재현 (${leak.before} 유지)`, leak.err || '');
  R.leak = leak;

  // ── E. 설정 화면 컨트롤 실존 (H4) ────────────────────────
  const settings = await page.evaluate(async () => {
    window.showPage('settings', true);
    await new Promise(r => setTimeout(r, 1200));
    const want = ['setting-recent-ratio', 'setting-wrong-auto', 'setting-wrong-limit', 'setting-grammar-goal'];
    const o = {};
    for (const id of want) o[id] = !!document.getElementById(id);
    o.totalInputs = document.querySelectorAll('#page-settings input,#page-settings select').length;
    o.r2Built = document.body.dataset.c944R2Built || null;
    return o;
  });
  const missingSettings = Object.entries(settings).filter(([k, v]) => k.startsWith('setting-') && !v).map(([k]) => k);
  find(missingSettings.length ? 'HIGH' : 'OK', '설정', missingSettings.length ? `설정 컨트롤 소실 ${missingSettings.length}개` : `설정 컨트롤 전부 존재 (입력 ${settings.totalInputs}개)`, missingSettings);
  R.settings = settings;

  // ── F. 숫자키 1-4 가 입력 필드를 삼키는지 (M11) ───────────
  const numkey = await page.evaluate(async () => {
    window.showPage('data', true);
    await new Promise(r => setTimeout(r, 800));
    const inp = document.querySelector('#page-data input[type="text"],#page-data input:not([type]),#page-data input[type="search"]');
    if (!inp) return { skipped: '입력 필드 없음' };
    inp.focus(); inp.value = '';
    const ev = new KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true });
    const prevented = !document.dispatchEvent(ev) || ev.defaultPrevented;
    return { prevented, field: inp.id || inp.className };
  });
  find(numkey.prevented ? 'MED' : 'OK', '입력', numkey.skipped || (numkey.prevented ? '입력 필드에서 숫자키가 가로채짐' : '입력 필드에서 숫자키 정상'), numkey.field || '');

  // ── G. 모드별 카드 데이터 적합성 (H6) ─────────────────────
  const modeFit = await page.evaluate(async () => {
    const all = await getAllWords();
    const need = {
      typing: (x) => x.Pinyin, dictation: (x) => x.Pinyin,
      cloze: (x) => x.Example_CHT, collocation: (x) => x.Collocation_CHT,
      reverse: (x) => x.Meaning_KO, listening: (x) => x.Traditional_CH,
    };
    const o = {};
    for (const [m, fn] of Object.entries(need)) {
      const eligible = all.filter(fn).length;
      let picked = 0, bad = 0;
      try {
        const r = selectStudyItems(all, 10, 'vocab', { mode: m });
        const items = r?.items || [];
        picked = items.length; bad = items.filter(x => !fn(x)).length;
      } catch (_) {}
      o[m] = { eligible, picked, unfit: bad };
    }
    return o;
  });
  for (const [m, v] of Object.entries(modeFit)) {
    if (v.unfit > 0) find('HIGH', '학습모드', `${m}: 필수 데이터 없는 카드 ${v.unfit}/${v.picked}개 출제됨`, `적합 후보 ${v.eligible}`);
    else if (v.eligible < 100) find('MED', '학습모드', `${m}: 적합 후보가 ${v.eligible}개뿐`, `콘텐츠 부족`);
  }
  R.modeFit = modeFit;

  // ── H. 화면별 전체 버튼 클릭 스윕 ─────────────────────────
  const ROUTES = ['home', 'study', 'stats', 'data', 'settings', 'lean', 'lean-studio', 'chinese-lab'];
  const clickLog = [];
  for (const route of ROUTES) {
    await page.evaluate((r) => window.showPage(r, true), route).catch(() => { });
    await page.waitForTimeout(700);
    const btns = await page.evaluate((r) => {
      const p = document.getElementById('page-' + r); if (!p) return [];
      return Array.from(p.querySelectorAll('button')).map((b, i) => ({ i, label: (b.innerText || b.getAttribute('aria-label') || b.id || '').trim().slice(0, 24) }))
        .filter(x => x.label);
    }, route);
    for (const b of btns.slice(0, 14)) {
      const errBefore = R.pageErrors.length, conBefore = R.console.length;
      const res = await page.evaluate(async ({ r, i }) => {
        const p = document.getElementById('page-' + r); if (!p) return { skip: 1 };
        const el = p.querySelectorAll('button')[i]; if (!el) return { skip: 1 };
        const cs = getComputedStyle(el); if (cs.display === 'none' || el.disabled) return { skip: 1 };
        try { el.click(); } catch (e) { return { err: e.message }; }
        await new Promise(x => setTimeout(x, 160));
        return { ok: 1, nowPage: document.querySelector('.page.active,[id^="page-"]:not([style*="display: none"])')?.id || null };
      }, { r: route, i: b.i }).catch((e) => ({ err: String(e).slice(0, 120) }));
      const newErrs = R.pageErrors.length - errBefore, newCon = R.console.length - conBefore;
      if (res?.err || newErrs > 0 || newCon > 0) {
        clickLog.push({ route, label: b.label, err: res?.err, pageErrors: newErrs, consoleErrors: newCon });
        find('MED', '클릭', `${route} / "${b.label}" 클릭 시 오류`, res?.err || `pageError ${newErrs} · console ${newCon}`);
      }
      // 다른 화면으로 튀었으면 되돌린다
      await page.evaluate((r) => { try { window.showPage(r, true); } catch (_) { } }, route);
      await page.waitForTimeout(80);
    }
  }
  R.clickLog = clickLog;
  if (!clickLog.length) find('OK', '클릭', '순회한 버튼에서 오류 없음');

  // ── I. 최종 콘솔 상태 ─────────────────────────────────────
  if (R.console.length) find('MED', '콘솔', `콘솔 에러 ${R.console.length}건`, R.console.slice(0, 5));
  if (R.pageErrors.length) find('HIGH', '런타임', `미처리 예외 ${R.pageErrors.length}건`, R.pageErrors.slice(0, 5));

  fs.writeFileSync(path.join(OUT, 'sweep.json'), JSON.stringify(R, null, 2));
  console.log(`\n${'─'.repeat(60)}\n발견 ${R.findings.filter(f => f.sev !== 'OK').length}건  (CRIT ${R.findings.filter(f => f.sev === 'CRIT').length} / HIGH ${R.findings.filter(f => f.sev === 'HIGH').length} / MED ${R.findings.filter(f => f.sev === 'MED').length} / LOW ${R.findings.filter(f => f.sev === 'LOW').length})`);
  console.log(`리포트: ${path.join(OUT, 'sweep.json')}`);
  await browser.close(); s.close();
})().catch(e => { console.error('SWEEP ERROR', e); process.exit(1); });
