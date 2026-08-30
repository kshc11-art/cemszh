/**
 * CEMS CSS 렌더 기준선 기록기
 *
 * 앱을 실제 Chromium 으로 띄우고, 주요 화면마다
 *   - 전체 스크린샷
 *   - 대표 요소의 computed style 덤프 (색·배경·테두리·타이포·여백·레이아웃)
 *   - :root 의 디자인 토큰 실측값
 *   - 아이콘 ::before 의 mask/content (아이콘 소실 회귀 감지용)
 * 를 기록해 out/css-<라벨>/styles.json 에 저장한다.
 *
 * CSS 구조 정리 전후로 이 덤프가 동일해야 "겉모습 무변경" 이 증명된다.
 *
 * 사용법:  node css-baseline.mjs <앱디렉터리> <라벨>
 *   예)    node css-baseline.mjs .. before
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP_DIR = process.argv[2] || path.resolve('..');
const LABEL   = process.argv[3] || 'run';
const HERE    = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out', `css-${LABEL}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8',
};

/** probe.mjs 의 정적 서버 재사용 */
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

/* ── 감시 대상 CSS 속성 ─────────────────────────────────────── */
const PROPS = [
  'display', 'position', 'visibility', 'opacity', 'z-index', 'overflow',
  'color', 'background-color', 'background-image',
  'border-top-width', 'border-top-style', 'border-top-color',
  'border-bottom-width', 'border-bottom-color',
  'border-left-width', 'border-left-color', 'border-right-width',
  'border-radius', 'box-shadow', 'outline-color', 'outline-width', 'outline-style',
  'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-transform', 'text-decoration-line',
  'white-space', 'text-overflow',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'width', 'height', 'min-height', 'max-width', 'min-width',
  'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'gap',
  'grid-template-columns', 'grid-auto-flow', 'flex-grow', 'flex-shrink', 'flex-basis',
  'transform', 'transition-property', 'transition-duration',
  'animation-name', 'animation-duration',
  'backdrop-filter', 'mask-image', '-webkit-mask-image', 'content',
  'pointer-events', 'cursor', 'user-select', 'touch-action', 'accent-color',
];

/* ── :root 에서 실측할 디자인 토큰 ──────────────────────────── */
const TOKENS = [
  // 앱 토큰 (index.html 정의 → v944 가 덮어씀)
  '--primary', '--primary-strong', '--primary-soft', '--bg', '--bg2', '--card', '--border',
  '--text', '--muted', '--success', '--warning', '--danger', '--expr', '--phrasal',
  '--accent-secondary', '--accent-contrast',
  '--cems-accent', '--cems-accent-strong', '--cems-accent-secondary', '--cems-accent-contrast',
  // v944 원시 팔레트
  '--c943-bg', '--c943-bg-soft', '--c943-surface', '--c943-surface-2', '--c943-surface-3',
  '--c943-border', '--c943-border-soft', '--c943-text', '--c943-muted',
  '--c943-accent', '--c943-accent-strong', '--c943-cyan', '--c943-mint',
  '--c943-amber', '--c943-rose', '--c943-violet', '--c943-shadow',
  // 그 외 레이어 토큰
  '--phase7-vvh', '--phase7-keyboard',
];

/* ── 화면별 대표 셀렉터 ─────────────────────────────────────── */
/* 시각적으로 중요한 것 위주: 카드·버튼·탭·입력·표·칩·모달·네비·아이콘 */
const GLOBAL_SEL = [
  'html', 'body', '#app-main', '.bottom-nav', '.bottom-nav .nav-item',
  '.bottom-nav .nav-item.active', '#toast', '.skip-link',
  '#complete-modal', '#complete-modal .modal', '#edit-modal .modal',
  '#tag-modal .modal-overlay, #tag-modal', '#confirm-modal .modal',
  '.modal-overlay .modal-title', '.modal-overlay .btn',
  '#cems932-hub-overlay', '#c86-data-sheet', '.c86-sheet',
  '#phase7-network', '#phase7-update', '.phase7-banner button',
  '#splash',
];

const PAGE_SEL = {
  home: [
    '#page-home', '#cems82-appbar', '.cems82-brand-title', '.cems82-brand-sub',
    '#cems82-settings', '#streak-banner', '.streak-days',
    '#daily-goal-card', '.cems941-goal-grid', '.cems941-goal-cell',
    '#daily-vocab-progress', '.progress-bar', '.progress-fill',
    '#page-home .card', '#page-home .card-title',
    '#page-home .c943-section-heading', '#page-home .c943-section-icon',
    '#page-home .c943-section-title-text',
    '#page-home .type-tabs', '#page-home .type-tab', '#page-home .type-tab.active',
    '#page-home .c943-scope-tabs', '#page-home .c943-scope-icon',
    '#page-home .quick-actions', '#page-home .quick-action',
    '#page-home .quick-action-icon', '#page-home .quick-action-label',
    '#page-home .quick-action-badge',
    '#page-home .stat-grid', '#page-home .stat-item', '#page-home .stat-value',
    '#page-home .stat-value.success', '#page-home .stat-value.warning',
    '#page-home .stat-value.danger', '#page-home .stat-label',
    '#page-home .btn', '#page-home .btn-primary', '#page-home .btn-secondary',
    '#page-home .btn-sm', '#page-home .form-select',
    '#quick-search-input', '#home-tag-select',
    '#page-home .c943-icon', '#page-home .c943-icon-info', '#page-home .c944-icon',
    '#page-home .filter-toggle', '#page-home .c944-kpi', '#page-home .c944-compact-panel',
    '#page-home .empty-state', '#page-home .empty-state-icon',
    '#page-home .c943-home-action-icon', '#session-resume-card',
  ],
  study: [
    '#page-study', '#study-type-tabs', '#page-study .type-tab', '#page-study .type-tab.active',
    '#c943-study-quickbar', '.c943-quick-title', '.c943-quick-caption', '.c943-quick-grid',
    '.c943-quick-icon',
    '#page-study .card', '#page-study .card-title',
    '.mode-selector', '.mode-card', '.mode-card.active', '.mode-card-icon',
    '.mode-card-title', '.mode-card-desc',
    '.chip-multi .chip', '.chip-multi .chip.checked', '.chip-small .chip',
    '.c86-quick-filters', '.c86-filter-preset', '.c86-filter-preset.active',
    '.c86-advanced', '.c86-advanced > summary', '.c86-advanced-body',
    '.c86-filter-detail', '.c86-filter-line', '.c86-filter-clear',
    '.c85-filter-summary', '.c85-filter-summary.warn',
    '#c86-study-dock', '#c86-dock-title', '#c86-dock-meta', '#c86-start',
    '.c86-count-stepper', '.c86-count-stepper button', '#c86-dock-count',
    '.range-container', '.range-slider', '.range-value',
    '#page-study .form-group', '#page-study .form-label', '#page-study .form-select',
    '.c943-options-body', '.c943-options-chevron',
    '.c944-compat-count-panel', '.c944-r2-filter-card', '.c944-deck-panel',
    '#page-study .toggle-row', '#page-study .toggle-switch', '#page-study .toggle-slider',
    '.zh-mode-grid', '.zh-mode-count',
  ],
  stats: [
    '#page-stats', '#cems83-dashboard', '.c83-dashboard', '.c83-toolbar',
    '.c83-segment', '.c83-chip', '.c83-chip.active', '.c83-icon-btn',
    '.c83-card', '.c83-card-title', '.c83-card-sub', '.c83-badge',
    '.c83-kpis', '.c83-kpi', '.c83-kpi-icon', '.c83-kpi strong', '.c83-kpi span',
    '.c83-loading', '.c83-spin',
    '#c86-stats-quality', '.c86-quality-head', '.c86-quality-badge',
    '.c86-quality-grid', '.c86-quality-cell', '.c86-quality-foot',
    '#page-stats .card', '#page-stats .card-title',
    '#page-stats .stat-item', '#page-stats .stat-value', '#page-stats .stat-label',
    '#page-stats .stat-value.success', '#page-stats .stat-value.warning',
    '#page-stats .stat-value.danger',
    '.skill-dashboard-item', '.skill-dashboard-name', '.skill-progress-bar',
    '.skill-progress-fill', '.chart-container',
    '#page-stats .btn', '#page-stats .btn-sm', '#page-stats .type-tab.active',
    '.leitner-container', '.c944-final-stats',
  ],
  data: [
    '#page-data', '#page-data .card', '#page-data .card-title',
    '#cems932-data-catalog', '.c943-data-catalog', '.cems932-catalog-metrics',
    '#page-data .type-tab', '#page-data .type-tab.active',
    '.cems-ux25-data-nav', '.cems-ux25-tabs', '.cems-ux25-data-pane',
    '#word-search', '#data-filter-hsk', '#data-sort',
    '.table-container', '.word-table', '.word-table th', '.word-table td',
    '#col1-h', '#word-table-body',
    '.ai-card', '.ai-stat-box', '.ai-stat-num', '.ai-stat-label', '.ai-divider',
    '.ai-info-box', '#ai-word-input', '.c944-ai-panel', '.c944-r2-ai-card',
    '.upload-zone', '.upload-zone-icon', '.c943-upload-illustration',
    '#page-data .btn', '#page-data .btn-primary', '#page-data .btn-secondary',
    '#page-data .chip', '.c86-data-title', '.c86-data-icon', '.c86-data-status',
    '.c86-data-actions', '.c86-data-note',
    '#db-stat-vocab', '#dist-vocab-cefr',
  ],
  settings: [
    '#page-settings', '#page-settings .card', '#page-settings .card-title',
    '.cems-ux25-settings-title', '.cems-ux25-settings-body', '.cems-ux25-settings-toggle',
    '.cems-ux25-settings-toolbar',
    '#page-settings .toggle-row', '#page-settings .toggle-label',
    '#page-settings .toggle-switch', '#page-settings .toggle-slider',
    '#page-settings .form-input', '#page-settings .form-label', '#page-settings .form-select',
    '#setting-dark', '#setting-count', '#setting-zh-tts-rate',
    '.cems-theme-accent-setting', '.cems-theme-accent-options', '.cems-theme-accent-option',
    '.cems-theme-accent-option.active',
    '.c944-stepper', '.c944-stepper-button', '.c944-stepper-input',
    '.c944-r2-range-block', '.c944-r2-range-head', '.c944-r2-range-output',
    '.c944-r2-range-track', '.c944-r2-range',
    '.phase7-health-grid', '.phase7-health-item', '.phase7-health-label',
    '.phase7-health-value', '.phase7-status-warn', '.phase8-status-good',
    '.phase7-action-grid', '.phase7-backup-reminder', '.phase7-audit-result',
    '#cems931-ai-card', '.cems931-ai-grid', '.cems931-danger-note',
    '.c84-term', '.c84-term strong', '.c84-status', '.c84-diag',
    '.cems9-row', '.cems9-row b', '.cems9-note', '.cems9-actions .btn',
    '.cems9-skill-title',
    '#page-settings .btn', '#page-settings .btn-primary', '#page-settings .btn-secondary',
    '.session-engine-grid', '.pipeline-badge', '.skill-migration-note',
  ],
  lean: [
    '#page-lean', '.cems-lean-shell', '.cems-lean-header', '.cems-lean-eyebrow',
    '.cems-lean-icon', '#cems-lean-dashboard', '#page-lean .btn',
    '#page-lean .btn-secondary',
  ],
};

/* 학습 세션(플래시카드) 진입 후에만 존재하는 요소 — v944 규칙이 가장 많은 영역 */
const SESSION_SEL = [
  '#page-flashcard', '.c943-progress-head', '.c943-progress-head .progress-bar',
  '.c943-progress-head .progress-fill', '.c943-progress-head .progress-text',
  '.flashcard-container', '.flashcard', '.flashcard-face', '.flashcard-word',
  '.flashcard-hint', '.flashcard-meaning-ko', '.flashcard-meaning-en',
  '.flashcard-example', '.card-info-view',
  '.rating-section', '.rating-grid', '.rating-btn',
  '.rating-btn.again', '.rating-btn.hard', '.rating-btn.good', '.rating-btn.easy',
  '.rating-btn .rating-interval', '.c943-rating-main', '.c943-rating-icon',
  '.c943-rating-label', '.c943-rating-shortcut',
  '.c944-r2-flash-actions', '.cems932-flashcard-toolbar',
  '.c944-r2-flash-actions > .btn', '.c943-icon-button', '.c943-study-exit',
  'button.c944-r2-action-btn', '.c944-final-action',
  'button.c944-final-action[data-final-action="bookmark"]',
  'button.c944-final-action[data-final-action="speak"]',
  '.c944-final-bar', '.c944-final-stats',
];

/* ── ::before / ::after 를 별도로 확인할 셀렉터 (아이콘·토글 노브 등) ── */
const PSEUDO_SEL = [
  ['.c943-icon-home', ''], ['.c943-icon-study', ''], ['.c943-icon-stats', ''],
  ['.c943-icon-data', ''], ['.c943-icon-settings', ''], ['.c943-icon-info', ''],
  ['.c943-icon-flashcard', ''], ['.c943-icon-word', ''],
  ['.filter-toggle', '::after'], ['.toggle-slider', '::before'],
  ['.c86-advanced > summary', '::after'],
  ['.c944-final-action', '::before'],
  ['button.c944-final-action[data-final-action="bookmark"]', '::before'],
  ['button.c944-final-action[data-final-action="speak"]', '::before'],
  ['.c944-icon', '::before'], ['.c944-icon-star', '::before'],
  ['.c944-icon-plus', '::before'], ['.c944-icon-search', '::before'],
  ['.c944-icon-book', '::before'], ['.c944-icon-tag', '::before'],
  ['.c944-icon-list', '::before'], ['.c944-icon-edit', '::before'],
];

/* 전체 DOM 스캔용 — 페인트에 직접 보이는 속성만 (레이아웃 치수는 텍스트 길이에 흔들리므로 제외) */
const DOM_PROPS = [
  'display', 'position', 'visibility', 'opacity', 'overflow', 'z-index',
  'color', 'background-color', 'background-image',
  'border-top-width', 'border-top-color', 'border-bottom-width', 'border-bottom-color',
  'border-left-width', 'border-left-color', 'border-right-width', 'border-right-color',
  'border-radius', 'box-shadow', 'outline-style',
  'font-size', 'font-weight', 'font-family', 'line-height', 'letter-spacing',
  'text-align', 'text-transform', 'white-space',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'gap', 'grid-template-columns', 'flex-direction', 'align-items', 'justify-content',
  'min-height', 'max-width', 'width', 'height',
  'transform', 'mask-image', 'backdrop-filter', 'pointer-events', 'accent-color',
];

/** 지연 렌더(표·차트)가 끝날 때까지 노드 수가 안정될 때를 기다린다. */
async function settle(page, rootSel, tries = 24) {
  let last = -1, stable = 0;
  for (let i = 0; i < tries; i++) {
    const n = await page.evaluate((s) => document.querySelector(s)?.querySelectorAll('*').length ?? -1, rootSel);
    if (n === last) { stable++; if (stable >= 3) return n; } else { stable = 0; last = n; }
    await page.waitForTimeout(400);
  }
  return last;
}

/** 루트 아래 모든 요소의 computed style 을 DOM 경로 키로 덤프한다. */
async function scanDom(page, rootSel) {
  const raw = await page.evaluate(({ rootSel, props }) => {
    const root = document.querySelector(rootSel);
    if (!root) return [];
    const out = [];
    // 키: 태그 + id + 정렬된 클래스 + 같은 키 안에서의 서수.
    // 인덱스 기반 경로와 달리, 무관한 노드가 하나 끼어들어도 나머지 키가 밀리지 않는다.
    const seen = new Map();
    const pathOf = (el) => {
      const cls = (typeof el.className === 'string' ? el.className : '')
        .trim().split(/\s+/).filter(Boolean).sort().join('.');
      let depth = 0; for (let n = el; n && n !== root; n = n.parentElement) depth++;
      const base = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}@d${depth}`;
      const i = (seen.get(base) || 0); seen.set(base, i + 1);
      return `${base}[${i}]`;
    };
    const all = [root, ...root.querySelectorAll('*')];
    for (const el of all) {
      if (/^(SCRIPT|STYLE|TEMPLATE)$/.test(el.tagName)) continue;
      const cs = getComputedStyle(el);
      const o = { k: pathOf(el), c: el.className && typeof el.className === 'string' ? el.className : '', v: [] };
      for (const p of props) o.v.push(cs.getPropertyValue(p));
      out.push(o);
    }
    return out;
  }, { rootSel, props: DOM_PROPS });
  // 긴 값(데이터 URI 등)은 해시로 축약
  for (const row of raw) row.v = row.v.map((x) => (x && x.length > 120 ? `«${x.length}·${crypto.createHash('sha1').update(x).digest('hex').slice(0, 10)}»` : x));
  return raw;
}

const short = (v) => {
  if (v == null) return v;
  const s = String(v);
  if (s.length <= 160) return s;
  return `«${s.length}·${crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)}»`;
};

(async () => {
  const { server, port } = await serve(APP_DIR);
  const base = `http://127.0.0.1:${port}`;
  console.log(`\n[css-${LABEL}] ${APP_DIR}  →  ${base}`);

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 }, locale: 'ko-KR',
    deviceScaleFactor: 1, reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));

  await page.goto(base + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(6000);
  const seed = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 90; i++) {
      try {
        if (typeof getAllWords === 'function') {
          const w = await getAllWords();
          if (w && w.length) return w.length;
        }
      } catch (_) {}
      await wait(1000);
    }
    return 0;
  });
  console.log(`  시드 로드: 단어 ${seed}개`);
  if (!seed) console.warn('  ! 경고: 시드가 비어 있음 — 덤프 신뢰도 낮음');

  // 애니메이션이 프레임마다 값을 바꾸지 않도록 정지
  await page.addStyleTag({
    content: '*,*::before,*::after{animation-play-state:paused!important}',
  });

  const result = {
    label: LABEL, appDir: APP_DIR, seedWords: seed,
    capturedAt: new Date().toISOString(),
    props: PROPS, domProps: DOM_PROPS, tokens: {}, pages: {}, dom: {}, pseudo: {}, pageErrors,
  };

  // ── 토큰 실측 ────────────────────────────────────────────────
  result.tokens = await page.evaluate((names) => {
    const rs = getComputedStyle(document.documentElement);
    const bs = getComputedStyle(document.body);
    const out = { root: {}, body: {} };
    for (const n of names) {
      out.root[n] = rs.getPropertyValue(n).trim();
      out.body[n] = bs.getPropertyValue(n).trim();
    }
    out._bodyClass = document.body.className;
    out._htmlAttrs = Object.fromEntries(
      [...document.documentElement.attributes].map((a) => [a.name, a.value]));
    out._bodyAttrs = Object.fromEntries(
      [...document.body.attributes].map((a) => [a.name, a.value]));
    return out;
  }, TOKENS);

  // ── 화면 순회 ────────────────────────────────────────────────
  const routes = Object.keys(PAGE_SEL);
  for (const r of routes) {
    await page.evaluate((n) => { try { window.showPage(n, true); } catch (_) {} }, r);
    await page.waitForTimeout(900);
    await settle(page, '#page-' + r);

    const sels = [...(r === routes[0] ? GLOBAL_SEL : []), ...PAGE_SEL[r]];
    const dump = await page.evaluate(({ selectors, props }) => {
      const out = {};
      for (const sel of selectors) {
        let el = null;
        try { el = document.querySelector(sel); } catch (_) { out[sel] = { error: 'bad-selector' }; continue; }
        if (!el) { out[sel] = null; continue; }
        const cs = getComputedStyle(el);
        const o = { _count: document.querySelectorAll(sel).length, _tag: el.tagName.toLowerCase() };
        for (const p of props) o[p] = cs.getPropertyValue(p);
        const rect = el.getBoundingClientRect();
        o._box = [Math.round(rect.width), Math.round(rect.height)];
        out[sel] = o;
      }
      return out;
    }, { selectors: sels, props: PROPS });

    for (const k of Object.keys(dump)) {
      const v = dump[k];
      if (v && typeof v === 'object') for (const p of Object.keys(v)) v[p] = short(v[p]);
    }
    result.pages[r] = dump;
    result.dom[r] = await scanDom(page, '#page-' + r);

    await page.screenshot({ path: path.join(OUT_DIR, `${r}.png`), fullPage: true });
    const found = Object.values(dump).filter((v) => v && !v.error).length;
    console.log(`  ${r.padEnd(9)} 셀렉터 ${found}/${sels.length} 매치, DOM ${result.dom[r].length}노드`);
  }

  // ── 학습 세션(플래시카드) ────────────────────────────────────
  // 세션 진입은 비동기라 타이밍에 흔들린다 → 카드가 실제로 보일 때까지 폴링해
  // before/after 가 항상 같은 상태에서 측정되도록 고정한다.
  const started = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = () => {
      const el = document.getElementById('page-flashcard');
      if (!el || getComputedStyle(el).display === 'none') return false;
      const card = el.querySelector('.flashcard');
      return !!card && card.getBoundingClientRect().height > 40;
    };
    try {
      if (typeof window.quickStartMode !== 'function') return 'no-fn';
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await window.quickStartMode('vocab', 'flashcard'); } catch (_) {}
        for (let i = 0; i < 40; i++) { if (visible()) return 'ok'; await wait(250); }
      }
      return 'hidden';
    } catch (e) { return 'err:' + e.message; }
  });
  // 세션 시작 뒤 앱이 라우트를 되돌리는 경우가 있어, 덤프 직전에 다시 강제 표시한다.
  const shown = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const vis = () => {
      const el = document.getElementById('page-flashcard');
      return !!el && getComputedStyle(el).display !== 'none'
        && (el.querySelector('.flashcard')?.getBoundingClientRect().height || 0) > 40;
    };
    for (let i = 0; i < 12; i++) {
      if (vis()) { await wait(400); if (vis()) return true; }
      try { window.showPage('flashcard', true); } catch (_) {}
      await wait(500);
    }
    return vis();
  });
  if (!shown) console.warn('  ! 플래시카드 화면을 안정적으로 띄우지 못함');
  result.pages.session = await page.evaluate(({ selectors, props }) => {
    const out = {};
    for (const sel of selectors) {
      let el = null;
      try { el = document.querySelector(sel); } catch (_) { out[sel] = { error: 'bad-selector' }; continue; }
      if (!el) { out[sel] = null; continue; }
      const cs = getComputedStyle(el);
      const o = { _count: document.querySelectorAll(sel).length, _tag: el.tagName.toLowerCase() };
      for (const p of props) o[p] = cs.getPropertyValue(p);
      return_box: { const rect = el.getBoundingClientRect(); o._box = [Math.round(rect.width), Math.round(rect.height)]; }
      out[sel] = o;
    }
    return out;
  }, { selectors: SESSION_SEL, props: PROPS });
  for (const k of Object.keys(result.pages.session)) {
    const v = result.pages.session[k];
    if (v && typeof v === 'object') for (const p of Object.keys(v)) v[p] = short(v[p]);
  }
  result.dom.session = await scanDom(page, '#page-flashcard');
  await page.screenshot({ path: path.join(OUT_DIR, 'session.png'), fullPage: true });
  {
    const found = Object.values(result.pages.session).filter((v) => v && !v.error).length;
    console.log(`  session   진입 ${started} · 셀렉터 ${found}/${SESSION_SEL.length} 매치, DOM ${result.dom.session.length}노드`);
  }

  // 플래시카드 뒷면(뒤집은 상태) — 의미/예문 영역 스타일
  await page.evaluate(() => { document.querySelector('.flashcard')?.click(); });
  await page.waitForTimeout(700);
  result.dom['session-flipped'] = await scanDom(page, '#page-flashcard');
  await page.screenshot({ path: path.join(OUT_DIR, 'session-flipped.png'), fullPage: true });
  console.log(`  flipped   DOM ${result.dom['session-flipped'].length}노드`);

  // ── 나머지 라우트 (DOM 스캔만) ───────────────────────────────
  // 대표 셀렉터 목록은 없지만, v944 규칙이 닿는 범위를 넓게 덮기 위해 전수 스캔한다.
  const EXTRA = ['quiz', 'typing', 'cloze', 'dictation', 'listening', 'collocation',
    'weak', 'expr-fc', 'expr-quiz', 'expr-typing', 'expr-cloze',
    'chinese-lab', 'lean-studio', 'dialogue-practice', 'sentence-check'];
  for (const r of EXTRA) {
    const exists = await page.evaluate((n) => !!document.getElementById('page-' + n), r);
    if (!exists) continue;
    await page.evaluate((n) => { try { window.showPage(n, true); } catch (_) {} }, r);
    await page.waitForTimeout(600);
    await settle(page, '#page-' + r, 10);
    result.dom['route-' + r] = await scanDom(page, '#page-' + r);
  }
  console.log(`  추가 라우트 ${EXTRA.filter((r) => result.dom['route-' + r]).length}개 스캔`);

  // ── 모달 열린 상태 ───────────────────────────────────────────
  // .show 를 직접 붙여 열린 모습을 재현한다 (before/after 동일 절차이므로 비교 가능).
  const MODALS = ['complete-modal', 'confirm-modal', 'edit-modal', 'tag-modal',
    'add-word-modal', 'paste-modal', 'quiz-complete-modal', 'expr-edit-modal',
    'phase4-duplicate-modal', 'zh-complete-modal', 'cems932-manager-overlay'];
  await page.evaluate((ids) => {
    for (const id of ids) document.getElementById(id)?.classList.add('show');
    document.getElementById('c86-data-sheet')?.classList.add('show');
  }, MODALS);
  await page.waitForTimeout(600);
  for (const id of [...MODALS, 'c86-data-sheet']) {
    const d = await scanDom(page, '#' + id);
    if (d.length) result.dom['modal-' + id] = d;
  }
  await page.screenshot({ path: path.join(OUT_DIR, 'modals.png'), fullPage: false });
  console.log(`  모달 ${Object.keys(result.dom).filter((k) => k.startsWith('modal-')).length}개 스캔`);
  await page.evaluate((ids) => {
    for (const id of [...ids, 'c86-data-sheet']) document.getElementById(id)?.classList.remove('show');
  }, MODALS);

  // ── 의사요소 ─────────────────────────────────────────────────
  // 플래시카드 액션 버튼은 학습 진입 후에만 생기므로 study 화면에서 시도
  await page.evaluate(() => { try { window.showPage('study', true); } catch (_) {} });
  await page.waitForTimeout(500);
  result.pseudo = await page.evaluate(({ pairs, props }) => {
    const out = {};
    for (const [sel, pseudo] of pairs) {
      const key = sel + pseudo;
      let el = null;
      try { el = document.querySelector(sel); } catch (_) { out[key] = { error: 'bad-selector' }; continue; }
      if (!el) { out[key] = null; continue; }
      const cs = getComputedStyle(el, pseudo || undefined);
      const o = {};
      for (const p of props) o[p] = cs.getPropertyValue(p);
      out[key] = o;
    }
    return out;
  }, {
    pairs: PSEUDO_SEL,
    props: ['content', 'display', 'mask-image', '-webkit-mask-image', 'background-color',
      'background-image', 'color', 'width', 'height', 'opacity', 'position', 'transform',
      'border-radius', 'font-size'],
  });
  for (const k of Object.keys(result.pseudo)) {
    const v = result.pseudo[k];
    if (v && typeof v === 'object') for (const p of Object.keys(v)) v[p] = short(v[p]);
  }

  // ── 스타일시트 로드 상태 ──────────────────────────────────────
  result.sheets = await page.evaluate(() => {
    const out = [];
    for (const s of document.styleSheets) {
      let n = -1;
      try { n = s.cssRules.length; } catch (_) { n = 'blocked'; }
      out.push({ href: s.href ? s.href.replace(location.origin, '') : '(inline)', rules: n });
    }
    return out;
  });

  fs.writeFileSync(path.join(OUT_DIR, 'styles.json'), JSON.stringify(result, null, 1));
  const n = Object.values(result.pages).reduce((a, p) => a + Object.keys(p).length, 0);
  console.log(`  덤프 ${n}개 셀렉터 + 의사요소 ${Object.keys(result.pseudo).length}개`);
  console.log(`  → ${path.join(OUT_DIR, 'styles.json')}`);
  if (pageErrors.length) console.log(`  ! 페이지 에러 ${pageErrors.length}건`);

  await browser.close();
  server.close();
})().catch((e) => { console.error('BASELINE ERROR', e); process.exit(1); });
