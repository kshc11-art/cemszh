/* CEMS Chinese PWA 9.4.4 — consolidated UI and lossless external library.
 * Replaces the 9.4.2 document-wide patch layer and the 9.4.1 refine runtime.
 * Native learning/database functions remain the source of truth.
 */

/* ========================================================================
   CEMS 9.4.4 — 단일 클릭 리스너 + 단일 디바운스 스케줄러 (UI 버스)
   ------------------------------------------------------------------------
   예전에는 이 파일의 세 IIFE 와 cems-v9.4.4-final.js 가 각자 document 클릭
   리스너를 달아, 앱 아무 곳이나 한 번 누르면 문서 전체 재작업이 4패스
   예약됐다(실측: 클릭 1회당 querySelectorAll 178회).

   이제 document 클릭 리스너는 이 버스 하나뿐이고, 각 레이어는
     - bus.onClick(key, fn)  : 클릭 즉시 처리해야 하는 일 (등록 순서대로 1회)
     - bus.register(key, fn, order) : 디바운스 후 순서대로 1회씩 도는 재작업
   으로 등록만 한다. 같은 key 로 다시 등록하면 교체되므로(멱등) 재설치
   타이머가 있어도 리스너가 중첩되지 않는다.
   ======================================================================== */
(() => {
  'use strict';
  if (window.CEMS944UiBus) return;

  const jobs = [];          // 디바운스 재작업 {key, fn, order}
  const clickHandlers = []; // 클릭 즉시 처리 {key, fn, order}
  let timer = 0;
  let dueAt = 0;
  let running = false;
  let pending = false;
  let wanted = null;        // Set(작업 키) 또는 null(=전체)

  function upsert(list, key, fn, order) {
    const entry = {key, fn, order};
    const index = list.findIndex((item) => item.key === key);
    if (index >= 0) list[index] = entry;
    else list.push(entry);
    list.sort((a, b) => a.order - b.order);
  }

  function runPass() {
    timer = 0;
    dueAt = 0;
    const selection = wanted;
    wanted = null;
    pending = false;
    if (running) return;   // 재진입 차단 (작업이 DOM 을 바꿔 다시 예약해도 한 패스만)
    running = true;
    try {
      for (const job of jobs) {
        if (selection && !selection.has(job.key)) continue;
        try { job.fn(); }
        catch (error) { try { console.warn('[CEMS944 UI bus] ' + job.key + ' 실패:', error); } catch (_) {} }
      }
    } finally { running = false; }
  }

  function runAll() {
    wanted = null;
    pending = true;
    runPass();
  }

  const bus = {
    VERSION: '9.4.4',
    /** 디바운스 재작업 등록. order 오름차순으로 한 패스에 1회씩만 실행된다. */
    register(key, fn, order = 100) {
      if (typeof fn !== 'function' || !key) return false;
      upsert(jobs, key, fn, order);
      return true;
    },
    /** 클릭 즉시 처리 훅 등록. 예외는 격리된다. */
    onClick(key, fn, order = 100) {
      if (typeof fn !== 'function' || !key) return false;
      upsert(clickHandlers, key, fn, order);
      return true;
    },
    /** 디바운스 예약. 이미 더 이른 시각에 예약돼 있으면 그대로 둔다.
        keys 를 주면 그 작업만 도는 부분 패스가 된다. DOM 변경 관찰자처럼 스스로를
        다시 깨울 수 있는 신호는 자기 작업만 예약해서 되먹임 고리를 끊는다. */
    schedule(delay = 60, keys) {
      const wait = Math.max(0, Number(delay) || 0);
      if (!pending) { pending = true; wanted = keys ? new Set(keys) : null; }
      else if (!keys) wanted = null;
      else if (wanted) keys.forEach((key) => wanted.add(key));
      const at = Date.now() + wait;
      if (timer && dueAt <= at) return;
      if (timer) clearTimeout(timer);
      dueAt = at;
      timer = setTimeout(runPass, wait);
    },
    runNow: runAll,
    inspect() {
      return {jobs: jobs.map((job) => job.key), click: clickHandlers.map((job) => job.key)};
    }
  };

  document.addEventListener('click', (event) => {
    for (const handler of clickHandlers) {
      try { handler.fn(event); }
      catch (error) { try { console.warn('[CEMS944 UI bus] click ' + handler.key + ' 실패:', error); } catch (_) {} }
    }
    /* 이 셸은 화면 전환이 클릭으로 일어나므로 렌더 뒤에 한 번 다시 표시해야 한다.
       예전에는 레이어마다 따로 예약해 클릭 1회에 4패스가 돌았다. 이제 1패스다. */
    bus.schedule(60);
  }, false);

  /* 부팅 직후 앱이 화면을 여러 번 다시 그리므로 지연 패스 두 번만 남긴다.
     예전에는 레이어마다 0/250/350/360/900/1200/2200/4200ms 타이머가 따로 있었다. */
  setTimeout(runAll, 400);
  setTimeout(runAll, 1200);

  Object.defineProperty(window, 'CEMS944UiBus', {value: bus, writable: false, configurable: false});
})();

(() => {
  'use strict';

  const VERSION = '9.4.4';
  const SCRIPT_URL = document.currentScript?.src || new URL('v944/cems-v9.4.4.js', location.href).href;
  const ASSET_BASE = new URL('.', SCRIPT_URL);
  const WORKER_URL = new URL('cems-v9.4.4-import-worker.js?v=9.5.0', ASSET_BASE).href;
  const ROUTINE_URL = new URL('zh-tw-travel-day3.json', ASSET_BASE).href;
  const DB_NAME = 'cemsExternalLibrary942';
  const DB_VERSION = 3;
  const OPTIONS_KEY = 'cems:v944:options:';
  const ROUTINE_KEY = 'cems:v944:routine:';
  const STUDY_PAGES = new Set([
    'flashcard','quiz','typing','listening','dictation','cloze','collocation',
    'expr-fc','expr-cloze','expr-typing','expr-quiz','pv-particle','pv-quiz',
    'zh-special','dialogue-practice','sentence-checker'
  ]);

  const state = {
    enhanceTimer: 0,
    observer: null,
    launchPromise: null,
    launchCard: null,
    activeModal: null,
    /* 열려 있는 모달의 정리 콜백. closeModal() 이 반드시 호출해야 한다. */
    activeModalOnClose: null,
    dbPromise: null,
    builtInRoutine: null,
    routineTimer: 0,
    routineRunning: false,
    routineSeconds: 0,
    externalDeck: null,
    initialized: false,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const cleanText = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const elementText = (element) => cleanText(element?.textContent);
  const uniq = (values) => {
    const out = [];
    const seen = new Set();
    for (const value of values || []) {
      const text = typeof value === 'string' ? cleanText(value) : value;
      const key = typeof text === 'string' ? text.toLowerCase() : JSON.stringify(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out;
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString('ko-KR');
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 ** 2)).toFixed(1)} MB`;
  }

  function activePageName() {
    return $('.page.active')?.id?.replace(/^page-/, '') || 'home';
  }

  function activeKind() {
    const page = activePageName();
    const pageNode = document.getElementById(`page-${page}`);
    const scope = page === 'study'
      ? $('#study-type-tabs .type-tab.active')
      : pageNode?.querySelector(':scope > .type-tabs .type-tab.active') || $('#page-home > .type-tabs .type-tab.active');
    const kind = scope?.dataset?.type;
    if (['vocab','expr','grammar','phrasal'].includes(kind)) return kind;
    try {
      const stored = window.CEMS932Decks?.loadStore?.()?.uiKind;
      if (['vocab','expr','grammar','phrasal'].includes(stored)) return stored;
    } catch (_) {}
    return 'vocab';
  }

  const ICONS = {
    home: '<path d="M3.5 10.5 12 3l8.5 7.5"/><path d="M5.5 9.2V21h13V9.2"/><path d="M9 21v-7h6v7"/>',
    study: '<path d="m8 5 11 7-11 7V5Z"/><path d="M4 5v14"/>',
    stats: '<path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V3"/>',
    data: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.1A1.7 1.7 0 0 0 8.2 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 3.8 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2V9.6h.1A1.7 1.7 0 0 0 3.7 8.2a1.7 1.7 0 0 0-.34-1.87l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8 3.8a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2h4v.1A1.7 1.7 0 0 0 14.8 3.7a1.7 1.7 0 0 0 1.87-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.2 8a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4h-.1a1.7 1.7 0 0 0-1.5 1.6Z"/>',
    word: '<path d="M5 4.5h12a2 2 0 0 1 2 2V20H7a2 2 0 0 1-2-2V4.5Z"/><path d="M7 4.5v13.2A2.3 2.3 0 0 0 9.3 20"/><path d="M10 8h6M10 11.5h6M10 15h4"/>',
    expression: '<path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9h8M8 12h5"/>',
    grammar: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m8.5 9 3.5 6 3.5-6M9.7 13h4.6"/>',
    focus: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>',
    dialogue: '<path d="M4 5h12v9H8l-4 4V5Z"/><path d="M9 18h7l4 3V10h-2"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22V5.5ZM20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22V5.5Z"/>',
    routine: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    deck: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 12h8M8 15h5"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    flashcard: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 8h6M9 12h4"/>',
    quiz: '<circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.3 2.3 0 1 1 3.7 1.8c-.9.7-1.5 1.1-1.5 2.2M12 17h.01"/>',
    reverse: '<path d="m8 7-4 4 4 4"/><path d="M4 11h12a4 4 0 0 1 4 4v1"/><path d="m16 5 4 4-4 4"/><path d="M20 9H8a4 4 0 0 0-4 4v1"/>',
    typing: '<path d="M5 6h14M8 6v12M16 6v12M5 18h14"/>',
    cloze: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h3M14 9h2M8 13h8M8 16h5"/>',
    link: '<path d="M10.5 13.5 13.5 10.5"/><path d="M7.5 16.5 5 19a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0" transform="translate(3 -3)"/><path d="m16.5 7.5 2.5-2.5a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" transform="translate(-3 3)"/>',
    listen: '<path d="M5 10v4M8 7v10M11 5v14M14 8v8M17 6v12M20 10v4"/>',
    write: '<path d="m4 20 4.3-1 10.8-10.8a2.2 2.2 0 0 0-3.1-3.1L5.2 15.9 4 20Z"/><path d="m14.5 6.5 3 3"/>',
    again: '<path d="m7 7-4 4 4 4"/><path d="M4 11h9a6 6 0 1 1-5.3 8.8"/>',
    hard: '<path d="M8 14s1.5-2 4-2 4 2 4 2"/><circle cx="9" cy="9" r=".8" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r=".8" fill="currentColor" stroke="none"/>',
    good: '<path d="M8 13s1.5 2 4 2 4-2 4-2"/><circle cx="9" cy="9" r=".8" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r=".8" fill="currentColor" stroke="none"/>',
    easy: '<path d="M8 12s1.5 4 4 4 4-4 4-4"/><path d="m8 8 2-1M16 8l-2-1"/>',
    speaker: '<path d="M5 10v4h3l4 3V7L8 10H5Z"/><path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a8 8 0 0 1 0 11"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    alert: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4M12 17h.01"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.6 2.6L16.5 9"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    tag: '<path d="M20 13 13 20 4 11V4h7l9 9Z"/><circle cx="8.5" cy="8.5" r="1.2"/>',
    edit: '<path d="m4 20 4.2-1 10.7-10.7a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z"/><path d="m14.5 6.7 2.8 2.8"/>',
    plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
    celebrate: '<path d="m5 19 4-12 8 8-12 4Z"/><path d="M14 5l1-2M18 8l3-1M11 3l-1-2M18 13l2 1"/>',
    bookmark: '<path d="M6 4h12v17l-6-4-6 4V4Z"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    filter: '<path d="M4 5h16l-6 7v6l-4 2v-8L4 5Z"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4V8Z"/>',
  };

  function iconGlyph(name, className = '') {
    const safeName = Object.prototype.hasOwnProperty.call(ICONS, name) ? name : 'deck';
    const classes = ['c943-icon', `c943-icon-${safeName}`, className].filter(Boolean).join(' ');
    return `<span class="${escapeHtml(classes)}" aria-hidden="true"></span>`;
  }

  function svgIcon(name, className = '') {
    return `<span class="${escapeHtml(className)}" aria-hidden="true">${iconGlyph(name)}</span>`;
  }

  function toast(message, duration = 2700) {
    let stack = $('#c943-toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'c943-toast-stack';
      stack.className = 'c943-toast-stack';
      stack.setAttribute('aria-live', 'polite');
      document.body.append(stack);
    }
    const item = document.createElement('div');
    item.className = 'c943-toast';
    item.textContent = message;
    stack.append(item);
    window.setTimeout(() => item.remove(), duration);
  }

  /* 9.4.4: 저장된 onClose 를 반드시 호출한다.
     openModal() 이 새 모달을 열기 전에 이 함수로 기존 모달을 파괴하므로,
     예전에는 JSON import 모달이 떠 있는 동안 다른 모달을 열면 Worker 정리
     (closed=true + worker.terminate())가 건너뛰어져 Worker 가 고아가 된 채
     계속 IndexedDB 에 썼다. */
  function closeModal() {
    const onClose = state.activeModalOnClose;
    state.activeModalOnClose = null;
    if (typeof onClose === 'function') {
      try { onClose(); } catch (error) { console.warn('[CEMS943 modal onClose]', error); }
    }
    if (state.activeModal?.isConnected) state.activeModal.remove();
    state.activeModal = null;
    if (state.routineTimer) clearInterval(state.routineTimer);
    state.routineTimer = 0;
    state.routineRunning = false;
  }

  function modalIconFor(title = '', id = '') {
    const text = `${id} ${cleanText(title)}`;
    if (/완료|성공/.test(text)) return 'check';
    if (/종료|삭제|초기화|오류|경고|중복/.test(text)) return 'alert';
    if (/태그/.test(text)) return 'tag';
    if (/편집|수정/.test(text)) return 'edit';
    if (/추가|등록|업로드|가져오기|분석/.test(text)) return 'plus';
    if (/교재|자료|라이브러리|카드덱/.test(text)) return 'book';
    if (/집중|학습/.test(text)) return 'study';
    return 'info';
  }

  function openModal({title, subtitle = '', body = '', footer = '', wide = false, className = '', icon = '', onClose = null}) {
    closeModal();
    const backdrop = document.createElement('div');
    const modalIcon = icon || modalIconFor(title);
    backdrop.className = 'c943-modal-backdrop';
    backdrop.innerHTML = `
      <section class="c943-modal${wide ? ' c943-modal-wide' : ''}${className ? ` ${escapeHtml(className)}` : ''}" role="dialog" aria-modal="true" aria-labelledby="c943-modal-title"${subtitle ? ' aria-describedby="c943-modal-subtitle"' : ''}>
        <header class="c943-modal-header">
          <div class="c943-modal-heading">${svgIcon(modalIcon, 'c943-modal-heading-icon')}<div class="c943-modal-title"><h2 id="c943-modal-title">${escapeHtml(title)}</h2>${subtitle ? `<p id="c943-modal-subtitle">${escapeHtml(subtitle)}</p>` : ''}</div></div>
          <button type="button" class="c943-modal-close" aria-label="닫기">${svgIcon('close','c943-close-icon')}</button>
        </header>
        <div class="c943-modal-body">${body}</div>
        ${footer ? `<footer class="c943-modal-footer">${footer}</footer>` : ''}
      </section>`;
    const close = () => {
      /* onClose 는 정확히 한 번만 돈다. closeModal() 이 같은 콜백을 다시 부르지
         않도록 실행 전에 등록을 해제한다. */
      if (state.activeModalOnClose === onClose) state.activeModalOnClose = null;
      try { onClose?.(); } catch (_) {}
      if (backdrop.isConnected) backdrop.remove();
      if (state.activeModal === backdrop) state.activeModal = null;
      if (state.routineTimer) clearInterval(state.routineTimer);
      state.routineTimer = 0;
      state.routineRunning = false;
    };
    $('.c943-modal-close', backdrop)?.addEventListener('click', close);
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
    backdrop.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
    document.body.append(backdrop);
    state.activeModal = backdrop;
    state.activeModalOnClose = typeof onClose === 'function' ? onClose : null;
    setTimeout(() => $('.c943-modal-close', backdrop)?.focus(), 0);
    return {backdrop, modal: $('.c943-modal', backdrop), close};
  }

  function cleanupLegacy() {
    $('#v942-global-scope')?.remove();
    $('#v942-study-quickbar')?.remove();
    $('#v942-json-import-card')?.remove();
    $$('.v942-modal-backdrop, #v942-toast-stack').forEach((node) => node.remove());
    $$('.v942-local-scope-source').forEach((node) => node.classList.remove('v942-local-scope-source'));
    document.body.classList.remove('cems-v942');
    document.body.classList.add('cems-v944');
  }

  function updateVersionLabels() {
    document.documentElement.dataset.cemsVersion = VERSION;
    document.documentElement.dataset.cemsBuild = VERSION;
    document.documentElement.setAttribute('data-cems-version', VERSION);
    document.querySelector('meta[name="cems-version"]')?.setAttribute('content', VERSION);
    document.querySelector('meta[name="app-version"]')?.setAttribute('content', VERSION);
    document.title = document.title.replace(/v?9\.4\.[0-9]+/g, `v${VERSION}`);
    const splashCopy = `v${VERSION} · 통합 학습 허브`;
    const brandCopy = `학습 분석 · FSRS-6 · v${VERSION}`;
    $$('.splash-sub').forEach((node) => { if (node.textContent !== splashCopy) node.textContent = splashCopy; });
    $$('.cems82-brand-sub').forEach((node) => { if (node.textContent !== brandCopy) node.textContent = brandCopy; });
    const build = $('#phase8-build-status');
    if (build && !build.textContent.includes(VERSION)) build.textContent = `v${VERSION}`;
  }

  function scopeIconFor(kind) {
    return kind === 'expr' ? 'expression' : kind === 'grammar' ? 'grammar' : kind === 'phrasal' ? 'link' : 'word';
  }

  function scopeLabelFor(kind) {
    return kind === 'expr' ? '표현' : kind === 'grammar' ? '문법' : kind === 'phrasal' ? '구동사' : '단어';
  }

  function enhanceScopeTabs() {
    $$('.page > .type-tabs').forEach((tabs) => {
      const typeChildren = Array.from(tabs.children).filter((child) => child.classList?.contains('type-tab') && child.dataset.type);
      if (typeChildren.length < 2) return;
      tabs.classList.add('c943-scope-tabs');
      tabs.dataset.c943ScopeTabs = '1';
      typeChildren.forEach((tab) => {
        const kind = tab.dataset.type;
        const label = scopeLabelFor(kind);
        if (tab.dataset.c943Label !== label) {
          tab.dataset.c943Label = label;
          tab.innerHTML = `${svgIcon(scopeIconFor(kind), 'c943-scope-icon')}<span>${escapeHtml(label)}</span>`;
        }
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(tab.classList.contains('active')));
        tab.tabIndex = tab.classList.contains('active') ? 0 : -1;
      });
    });
  }

  function enhanceBottomNav() {
    const nav = $('.bottom-nav');
    if (!nav) return;
    const config = {
      home: ['home', '홈'], study: ['book', '학습'], stats: ['stats', '분석'],
      data: ['data', '데이터'], settings: ['settings', '설정']
    };
    $$('.nav-item', nav).forEach((item) => {
      const page = item.dataset.page;
      const [icon, label] = config[page] || ['home', cleanText(item.textContent)];
      if (item.dataset.c943Nav !== label) {
        item.dataset.c943Nav = label;
        item.innerHTML = `<span class="c943-nav-icon">${iconGlyph(icon)}</span><span class="c943-nav-label">${escapeHtml(label)}</span>`;
      }
      item.setAttribute('aria-label', label);
    });
    updateBottomNavActive();
  }

  function updateBottomNavActive() {
    const page = activePageName();
    const immersive = STUDY_PAGES.has(page);
    document.body.classList.toggle('c943-immersive-study', immersive);
    $$('.bottom-nav .nav-item').forEach((item) => {
      const active = item.dataset.page === page || (immersive && item.dataset.page === 'study');
      item.classList.toggle('c943-nav-active', active);
      if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    });
  }

  function modeIcon(mode) {
    const map = {
      flashcard:'flashcard', quiz:'quiz', reverse:'reverse', typing:'typing', cloze:'cloze', collocation:'link', listening:'listen', dictation:'write',
      'expr-fc':'flashcard', 'expr-quiz':'quiz', 'expr-cloze':'cloze', 'expr-typing':'typing', 'expr-listening':'listen', 'expr-dictation':'write',
      'pv-flashcard':'flashcard', 'pv-particle':'link', 'pv-quiz':'quiz'
    };
    return map[mode] || 'flashcard';
  }

  function enhanceModeCards() {
    $$('#page-study .mode-card').forEach((card) => {
      const icon = $('.mode-card-icon', card);
      if (icon) {
        const name = modeIcon(card.dataset.mode);
        const hasIcon = Boolean(icon.querySelector(`.c943-icon-${name}`));
        icon.dataset.c943Icon = name;
        /* ux-polish.js preserves icons carrying this marker. */
        icon.dataset.cems941Icon = `c943-${name}`;
        if (!hasIcon) icon.innerHTML = iconGlyph(name);
      }
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
    });
    ['study-vocab','study-expr','study-phrasal'].forEach((id) => {
      const root = document.getElementById(id);
      const card = root?.querySelector(':scope > .card:has(.mode-card)');
      card?.classList.add('c943-mode-root');
    });
    $$('#page-study > div > .card').forEach((card) => {
      const title = elementText($('.card-title', card));
      if (/중국어 집중 모드|표현 집중 모드/.test(title)) card.classList.add('c943-legacy-focus-section');
    });
  }

  function countConfig(kind) {
    if (kind === 'expr' || kind === 'grammar') return {range: '#expr-study-count', root: '#study-expr'};
    if (kind === 'phrasal') return {range: '#pv-study-count', root: '#study-phrasal'};
    return {range: '#study-count', root: '#study-vocab'};
  }

  function createStudyOptions(kind) {
    const {range: rangeSelector, root: rootSelector} = countConfig(kind);
    const root = $(rootSelector);
    if (!root) return null;
    let details = root.querySelector(':scope > .c943-study-options');
    if (!details) {
      const modeRoot = root.querySelector(':scope > .card:has(.mode-card)');
      if (!modeRoot) return null;
      details = document.createElement('details');
      details.className = 'c943-study-options';
      details.dataset.kind = kind;
      let saved = 'open';
      try { saved = localStorage.getItem(OPTIONS_KEY + kind) || 'open'; } catch (_) {}
      details.open = saved !== 'closed';
      details.innerHTML = `
        <summary>
          ${svgIcon('deck', 'c943-options-icon')}
          <span class="c943-options-copy"><strong>카드덱 · 필터</strong><span data-c943-options-meta>학습 범위와 카드 수를 설정합니다</span></span>
          ${svgIcon('chevron', 'c943-options-chevron')}
        </summary>
        <div class="c943-options-body"><div class="c943-deck-slot"></div><div class="c943-settings-slot"></div><div class="c943-order-slot"></div></div>`;
      modeRoot.insertAdjacentElement('afterend', details);
      details.addEventListener('toggle', () => {
        try { localStorage.setItem(OPTIONS_KEY + kind, details.open ? 'open' : 'closed'); } catch (_) {}
      });
    }

    const range = $(rangeSelector);
    const countCard = range?.closest('.card');
    const filterId = kind === 'vocab' ? '#filter-mastery' : kind === 'phrasal' ? '#pv-filter-mastery' : '#expr-filter-mastery';
    const filterCard = $(filterId)?.closest('.card');
    const slot = $('.c943-settings-slot', details);
    if (countCard && !slot.contains(countCard)) slot.append(countCard);
    if (filterCard && !slot.contains(filterCard)) slot.append(filterCard);
    /* 9.4.4: enhanceCountControl 은 첫 줄이 return 이라 35줄이 전부 도달 불가였다.
       카드 수 UI 의 소유자는 CEMS944(IIFE2/IIFE3) 하나뿐이므로 죽은 코드를 지웠다. */
    return details;
  }

  function moveSharedStudyControls() {
    const kind = activeKind();
    const normalizedKind = kind === 'grammar' ? 'expr' : kind;
    const details = createStudyOptions(normalizedKind);
    if (!details) return;
    const deckSlot = $('.c943-deck-slot', details);
    const orderSlot = $('.c943-order-slot', details);
    const dock = $('#c86-study-dock');
    const orderCard = $('#option-order')?.closest('.card');
    if (dock && deckSlot && !deckSlot.contains(dock)) deckSlot.append(dock);
    if (orderCard && orderSlot && !orderSlot.contains(orderCard)) orderSlot.append(orderCard);
    const meta = $('[data-c943-options-meta]', details);
    if (meta) {
      const title = cleanText($('#c86-dock-title')?.textContent) || '현재 필터';
      const count = cleanText($('#c86-dock-count')?.textContent);
      const nextMeta = [scopeLabelFor(kind), title, count].filter(Boolean).join(' · ');
      if (meta.textContent !== nextMeta) meta.textContent = nextMeta;
    }
    enhanceDeckStepper();
  }

  function enhanceDeckStepper() {
    const known = $$('.c86-count-stepper');
    const candidates = known.length ? known : $$('button').filter((button) => ['−','-','–'].includes(elementText(button))).map((button) => button.parentElement);
    candidates.filter(Boolean).forEach((parent) => {
      const minus = Array.from(parent.querySelectorAll('button')).find((button) => ['−','-','–'].includes(elementText(button)));
      const plus = Array.from(parent.querySelectorAll('button')).find((button) => elementText(button) === '+');
      if (!minus || !plus) return;
      if (!/카드덱|카드|덱/.test(elementText(parent.closest('.card, section, div') || parent))) return;
      parent.classList.add('c943-deck-stepper');
      const valueElement = Array.from(parent.children).find((child) => child !== minus && child !== plus && /\d+/.test(elementText(child)));
      if (valueElement) {
        valueElement.classList.add('c943-stepper-value');
        if (!valueElement.dataset.c943Picker) {
          valueElement.dataset.c943Picker = '1';
          valueElement.title = '카드 수 직접 선택';
          valueElement.addEventListener('click', () => openDeckCountPicker(valueElement, minus, plus));
        }
      }
    });
  }

  function openDeckCountPicker(valueElement, minus, plus) {
    const current = Number(elementText(valueElement).match(/\d+/)?.[0] || 20);
    const modal = openModal({
      title: '카드덱 학습 수',
      subtitle: '이번 세션에서 사용할 카드 수를 선택합니다.',
      body: `<div class="c943-count-presets" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:0">${[5,10,20,30,50,75,100].map((n) => `<button type="button" data-pick-count="${n}" aria-pressed="${n === current}">${n}</button>`).join('')}</div>`,
      footer: '<button type="button" class="c943-btn" data-close>닫기</button>'
    });
    $('[data-close]', modal.backdrop)?.addEventListener('click', modal.close);
    $$('[data-pick-count]', modal.backdrop).forEach((button) => button.addEventListener('click', () => {
      const target = Number(button.dataset.pickCount);
      let value = Number(elementText(valueElement).match(/\d+/)?.[0] || current);
      let guard = 0;
      while (value < target && guard++ < 120) { plus.click(); value = Number(elementText(valueElement).match(/\d+/)?.[0] || value + 1); }
      guard = 0;
      while (value > target && guard++ < 120) { minus.click(); value = Number(elementText(valueElement).match(/\d+/)?.[0] || value - 1); }
      modal.close();
    }));
  }

  function ensureStudyQuickbar() {
    const page = $('#page-study');
    if (!page) return;
    let bar = $('#c943-study-quickbar');
    if (!bar) {
      bar = document.createElement('section');
      bar.id = 'c943-study-quickbar';
      bar.innerHTML = `
        <div class="c943-quick-head"><div><div class="c943-quick-title">바로 학습</div><div class="c943-quick-caption">집중 훈련, 실전 회화, 교재·외부 자료와 1시간 루틴</div></div></div>
        <div class="c943-quick-grid">
          <button type="button" data-c943-quick="focus">${svgIcon('focus','c943-quick-icon')}<span>집중 모드</span></button>
          <button type="button" data-c943-quick="practical">${svgIcon('dialogue','c943-quick-icon c943-mint')}<span>실전 회화</span></button>
          <button type="button" data-c943-quick="textbook">${svgIcon('book','c943-quick-icon')}<span>교재·자료</span></button>
          <button type="button" data-c943-quick="routine">${svgIcon('routine','c943-quick-icon c943-amber')}<span>1시간 루틴</span></button>
        </div>`;
      bar.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-c943-quick]');
        if (!button) return;
        const action = button.dataset.c943Quick;
        if (action === 'focus') openFocusHub();
        else if (action === 'practical') openPractical();
        else if (action === 'textbook') await openLibrary();
        else if (action === 'routine') await openRoutine();
      });
    }
    const tabs = $('#study-type-tabs');
    if (tabs && bar.previousElementSibling !== tabs) tabs.insertAdjacentElement('afterend', bar);
  }

  function openFocusHub() {
    const kind = activeKind();
    const options = kind === 'vocab' ? [
      ['zh-tone','성조 패턴','성조를 듣고 구분합니다.','listen'],
      ['zh-pinyin','병음·성조','병음과 성조 표기를 입력합니다.','typing'],
      ['zh-script','간체↔번체','두 표기 체계를 변환합니다.','reverse'],
      ['zh-measure','양사 선택','명사에 맞는 양사를 고릅니다.','quiz'],
      ['zh-sentence','예문 배열','문장 조각을 올바른 순서로 배열합니다.','cloze'],
    ] : [
      ['zh-expr-sentence','예문 배열','표현·문법 예문을 문장 순서로 복원합니다.','cloze'],
      [kind === 'grammar' ? 'expr-fc' : 'expr-typing', kind === 'grammar' ? '문법 카드' : '표현 쓰기', kind === 'grammar' ? '문형과 용법을 예문으로 확인합니다.' : '표현을 직접 입력합니다.', kind === 'grammar' ? 'flashcard' : 'typing']
    ];
    const modal = openModal({
      title: `${scopeLabelFor(kind)} 집중 모드`,
      subtitle: '필요한 정보가 있는 카드만 자동으로 선별합니다.',
      body: `<div class="c943-library-results">${options.map(([mode,title,desc,icon]) => `<button type="button" class="c943-library-row" data-focus-mode="${escapeHtml(mode)}" style="width:100%;text-align:left;color:inherit"><span><span class="zh" style="display:flex;align-items:center;gap:8px">${svgIcon(icon,'c943-scope-icon')} ${escapeHtml(title)}</span><span class="meta">${escapeHtml(desc)}</span></span><span>›</span></button>`).join('')}</div>`,
      footer: '<button type="button" class="c943-btn" data-close>닫기</button>'
    });
    $('[data-close]', modal.backdrop)?.addEventListener('click', modal.close);
    $$('[data-focus-mode]', modal.backdrop).forEach((button) => button.addEventListener('click', async () => {
      const mode = button.dataset.focusMode;
      modal.close();
      try {
        if (/^zh-/.test(mode) && typeof window.startChineseSpecialMode === 'function') await window.startChineseSpecialMode(mode);
        else await launchThroughCurrentScope(kind, mode);
      } catch (error) {
        console.error('[CEMS943 focus]', error);
        toast('집중 모드를 시작하지 못했습니다.');
      }
    }));
  }

  function openPractical() {
    try {
      if (window.CEMS932Hub?.openDialogue) return window.CEMS932Hub.openDialogue(activeKind());
      const names = ['startTodayPracticalLearning','startPracticalLearning','startRealLifeLearning','openPracticalLearning','startConversationCourse'];
      for (const name of names) if (typeof window[name] === 'function') return window[name]();
      window.CEMS932Hub?.open?.(activeKind());
    } catch (error) {
      console.error('[CEMS943 practical]', error);
      toast('실전 회화 화면을 열지 못했습니다.');
    }
  }

  async function launchThroughCurrentScope(kind, mode) {
    const decks = window.CEMS932Decks;
    if (decks?.activateKind) {
      try { decks.activateKind(kind, false); } catch (_) {}
    }
    if (decks?.scopeFor) {
      if (decks.scopeFor(kind) === 'deck') {
        const deck = decks.activeDeck?.(kind);
        if (!deck) {
          decks.openManager?.(kind);
          toast('카드덱을 먼저 선택하거나 만들어 주세요.');
          return;
        }
        return decks.startDeck?.(deck, mode);
      }
      if (decks.startFilteredKind) return decks.startFilteredKind(kind, mode);
    }
    if (window.CEMS85?.startMode) return window.CEMS85.startMode(kind === 'grammar' ? 'expr' : kind, mode, true);
    if (kind === 'expr' || kind === 'grammar') return window.startExprStudyWithMode?.(mode);
    if (kind === 'phrasal') return window.startPVStudyWithMode?.(mode);
    return window.startVocabStudyWithMode?.(mode);
  }

  function waitForStudyPage(timeout = 1800) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const page = activePageName();
        if (STUDY_PAGES.has(page) || Date.now() - start >= timeout) resolve(page);
        else requestAnimationFrame(tick);
      };
      tick();
    });
  }

  function setLaunchBusy(card, busy) {
    $('#page-study')?.classList.toggle('c943-launch-busy', busy);
    if (state.launchCard && state.launchCard !== card) {
      state.launchCard.classList.remove('is-launching');
      state.launchCard.removeAttribute('aria-busy');
    }
    state.launchCard = busy ? card : null;
    if (card) {
      card.classList.toggle('is-launching', busy);
      if (busy) card.setAttribute('aria-busy', 'true'); else card.removeAttribute('aria-busy');
    }
  }

  function launchMode(card) {
    if (!card) return Promise.resolve();
    if (state.launchPromise) return state.launchPromise;
    const kind = activeKind();
    const mode = card.dataset.mode || (kind === 'vocab' ? 'flashcard' : 'expr-fc');
    card.closest('[id^="study-"]')?.querySelectorAll('.mode-card').forEach((node) => node.classList.toggle('active', node === card));
    window.__CEMS943_LAUNCHING__ = true;
    window.__CEMS941_LAUNCHING__ = true;
    setLaunchBusy(card, true);
    state.launchPromise = Promise.resolve()
      .then(() => launchThroughCurrentScope(kind, mode))
      .then((result) => waitForStudyPage(1500).then(() => result))
      .catch((error) => {
        console.error('[CEMS943 launch]', error);
        toast('학습을 시작하지 못했습니다. 다시 시도해 주세요.');
      })
      .finally(() => {
        window.__CEMS943_LAUNCHING__ = false;
        window.__CEMS941_LAUNCHING__ = false;
        setLaunchBusy(card, false);
        setTimeout(() => { state.launchPromise = null; }, 320);
      });
    return state.launchPromise;
  }

  function markProgressHeaders() {
    $$('.page').forEach((page) => {
      const name = page.id.replace(/^page-/, '');
      if (!STUDY_PAGES.has(name)) return;
      const first = page.firstElementChild;
      if (first && (first.style.position === 'sticky' || first.querySelector('.progress-bar'))) first.classList.add('c943-progress-head');
    });
  }

  const RATING_META = {
    again: ['again','모름'], hard: ['hard','어려움'], good: ['good','보통'], easy: ['easy','쉬움']
  };

  function enhanceRatings(root = document) {
    $$('.rating-btn', root).forEach((button) => {
      const key = Object.keys(RATING_META).find((name) => button.classList.contains(name));
      if (!key) return;
      const interval = cleanText($('.rating-interval', button)?.textContent) || (key === 'again' ? '다시' : key === 'hard' ? '1일' : key === 'good' ? '3일' : '7일+');
      const [, label] = RATING_META[key];
      const shortcut = String(Object.keys(RATING_META).indexOf(key) + 1);
      if (button.dataset.c943Rating !== key || !button.querySelector(`.c943-icon-${key}`)) {
        button.dataset.c943Rating = key;
        button.innerHTML = `<span class="c943-rating-shortcut" aria-hidden="true">${shortcut}</span><span class="c943-rating-main">${svgIcon(key,'c943-rating-icon')}<span class="c943-rating-label">${label}</span></span><span class="rating-interval">${escapeHtml(interval)}</span>`;
      }
      button.dataset.c943Shortcut = shortcut;
      button.setAttribute('aria-keyshortcuts', shortcut);
      button.setAttribute('aria-label', `${label}, ${interval}, 단축키 ${shortcut}`);
    });
  }

  const SECTION_ICON_RULES = [
    [/오늘 학습/, 'target'], [/빠른 시작/, 'play'], [/학습 모드/, 'study'],
    [/카드덱|덱·필터|필터|카드 상태|Leitner/, 'deck'],
    [/데이터베이스|데이터 관리|데이터 점검|데이터 안전|백업|PWA/, 'database'],
    [/통계|분석/, 'stats'], [/태그/, 'tag'], [/추가/, 'plus'],
    [/앱 설정|설정/, 'settings'], [/공통 정답 처리|정답 처리/, 'check'],
    [/세션 엔진|통합 엔진/, 'layers'], [/FSRS|스케줄링/, 'routine'],
    [/중국어 집중|음성|학습/, 'study'], [/문장 의미|판독/, 'grammar'], [/버전 정보/, 'info']
  ];

  function stripLeadingSymbol(value) {
    return cleanText(value)
      .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '')
      .replace(/^[•·◆◇■□▣▦▤▥▧▨▩◉◎○●▸▶▷▹➜➤→←↔⚠✓✔✕×＋+\s]+/u, '')
      .trim();
  }

  function sectionIconFor(title) {
    const match = SECTION_ICON_RULES.find(([pattern]) => pattern.test(title));
    return match?.[1] || 'info';
  }

  function enhanceSectionHeadings() {
    $$('.card-title').forEach((heading) => {
      if (heading.closest('.modal-overlay, .c943-modal')) return;
      const existing = heading.querySelector(':scope > .c943-section-main');
      const existingText = existing?.querySelector('.c943-section-title-text');
      const existingIcon = existing?.querySelector('.c943-section-icon .c943-icon');
      if (existing && existingText && existingIcon) return;

      let sourceNode = Array.from(heading.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && cleanText(node.nodeValue));
      if (!sourceNode && existing && cleanText(existing.textContent)) sourceNode = existing;
      if (!sourceNode) {
        const simple = Array.from(heading.children).find((child) =>
          child.tagName === 'SPAN' &&
          !child.children.length &&
          cleanText(child.textContent) &&
          !child.matches('.pipeline-badge,.badge,.chip,.c943-section-main,[data-c943-ai-toggle]')
        );
        if (simple) sourceNode = simple;
      }
      if (!sourceNode) return;
      const currentTitle = stripLeadingSymbol(sourceNode.textContent || sourceNode.nodeValue);
      const title = currentTitle || heading.dataset.c943OriginalTitle;
      if (!title || title.length > 48) return;
      heading.dataset.c943OriginalTitle = title;
      const icon = sectionIconFor(title);
      heading.dataset.c943Heading = `${icon}:${title}`;
      heading.classList.add('c943-section-heading');
      const group = document.createElement('span');
      group.className = 'c943-section-main';
      group.innerHTML = `${svgIcon(icon, 'c943-section-icon')}<span class="c943-section-title-text">${escapeHtml(title)}</span>`;
      heading.insertBefore(group, sourceNode);
      sourceNode.remove();
    });
  }

  function enhanceInlineLegacyIcons() {
    ['#quick-filter-vocab', '#quick-filter-expr'].forEach((selector) => {
      const toggle = $(selector);
      const label = toggle?.parentElement?.querySelector(':scope > span');
      if (!label || label.dataset.c943Inline === 'filter') return;
      label.dataset.c943Inline = 'filter';
      label.classList.add('c943-inline-label');
      label.innerHTML = `${iconGlyph('filter', 'c943-inline-icon')}<span>필터</span>`;
    });
    const goalMap = [
      [/단어/, 'word', '단어'], [/표현/, 'expression', '표현'], [/문법/, 'grammar', '문법']
    ];
    $$('#daily-goal-card .cems941-goal-cell .t').forEach((label) => {
      const match = goalMap.find(([pattern]) => pattern.test(cleanText(label.textContent)));
      if (!match || label.dataset.c943GoalIcon === match[1]) return;
      label.dataset.c943GoalIcon = match[1];
      label.innerHTML = `${iconGlyph(match[1], 'c943-goal-icon')}<span>${match[2]}</span>`;
    });
  }

  function enhanceQuickActionIcons() {
    const rules = [
      [/플래시카드/, 'flashcard'], [/5지선다|퀴즈/, 'quiz'], [/산출|쓰기/, 'write'],
      [/오답/, 'alert'], [/리슨|듣기/, 'listen'], [/빈칸/, 'cloze']
    ];
    $$('.quick-action').forEach((action) => {
      const label = cleanText($('.quick-action-label', action)?.textContent || action.textContent);
      const match = rules.find(([pattern]) => pattern.test(label));
      const icon = $('.quick-action-icon', action);
      if (!match || !icon) return;
      const name = match[1];
      if (icon.dataset.c943Icon === name && icon.querySelector('.c943-icon')) return;
      icon.dataset.c943Icon = name;
      icon.dataset.cems941Icon = `c943-${name}`;
      icon.classList.add('c943-home-action-icon');
      icon.innerHTML = iconGlyph(name);
    });
  }

  function nativeModalIcon(overlay, title) {
    const id = overlay?.id || '';
    if (/complete/.test(id)) return 'check';
    if (/tag/.test(id)) return 'tag';
    if (/edit/.test(id)) return 'edit';
    if (/add|paste|upload/.test(id)) return 'plus';
    if (/duplicate/.test(id)) return 'layers';
    return modalIconFor(title, id);
  }

  function enhanceNativeModals() {
    $$('.modal-overlay').forEach((overlay) => {
      const modal = $('.modal', overlay);
      if (!modal) return;
      overlay.classList.add('c943-native-modal-overlay');
      modal.classList.add('c943-native-modal');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      const header = $('.modal-header', modal);
      const heading = header?.querySelector('h3');
      if (heading) {
        const title = stripLeadingSymbol(heading.textContent) || '안내';
        const icon = nativeModalIcon(overlay, title);
        const signature = `${icon}:${title}`;
        if (heading.dataset.c943ModalHeading !== signature || !heading.querySelector('.c943-modal-heading-text')) {
          heading.dataset.c943ModalHeading = signature;
          heading.innerHTML = `${svgIcon(icon, 'c943-modal-heading-icon')}<span class="c943-modal-heading-text">${escapeHtml(title)}</span>`;
        }
        if (!heading.id) heading.id = `${overlay.id || 'c943-modal'}-title`;
        modal.setAttribute('aria-labelledby', heading.id);
        modal.classList.toggle('c943-modal-danger', /종료|삭제|초기화|복원|중복/.test(title));
      }
      const close = $('.modal-close', modal);
      if (close && !close.querySelector('.c943-close-icon')) {
        close.innerHTML = svgIcon('close', 'c943-close-icon');
        close.setAttribute('aria-label', '닫기');
      }
      const message = $('#confirm-msg', modal);
      if (message) message.classList.add('c943-modal-message');
      const confirmButton = $('#confirm-btn', modal);
      const actionRow = confirmButton?.parentElement;
      if (actionRow) actionRow.classList.add('c943-modal-actions');
      $$('button.btn', modal).forEach((button) => button.classList.add('c943-modal-button'));
      if (confirmButton) {
        const label = cleanText($('.c943-button-label', confirmButton)?.textContent || confirmButton.textContent) || '확인';
        const danger = modal.classList.contains('c943-modal-danger');
        const icon = danger ? (/삭제/.test(label) ? 'trash' : 'alert') : 'check';
        if (confirmButton.dataset.c943ActionLabel !== label || !confirmButton.querySelector(`.c943-icon-${icon}`)) {
          confirmButton.dataset.c943ActionLabel = label;
          confirmButton.innerHTML = `${iconGlyph(icon, 'c943-button-icon')}<span class="c943-button-label">${escapeHtml(label)}</span>`;
        }
      }
      if (actionRow) {
        $$('button', actionRow).filter((button) => button !== confirmButton && !button.classList.contains('modal-close')).forEach((button) => {
          const label = cleanText($('.c943-button-label', button)?.textContent || button.textContent) || '취소';
          if (button.dataset.c943ActionLabel !== label || !button.querySelector('.c943-icon-close')) {
            button.dataset.c943ActionLabel = label;
            button.innerHTML = `${iconGlyph('close', 'c943-button-icon')}<span class="c943-button-label">${escapeHtml(label)}</span>`;
          }
        });
      }
    });
  }

  /* 9.4.4: window.showConfirm 재정의를 없앴다.
     예전 래퍼는 원본(index.html showConfirm)을 호출한 뒤 제목 정규식으로 확인 버튼
     문구만 다시 썼다. 전역 재정의는 소유권이 흐려지고 재설치 때마다 중첩되므로,
     같은 결과를 #confirm-modal 한 노드에 대한 1회성 관찰로 얻는다.
     CEMSHooks 에 모달 채널이 없어서 훅 대신 좁은 MutationObserver 를 쓴다
     (문서 전체가 아니라 이 모달 하나의 class 속성만 본다). */
  let confirmObserver = null;

  function confirmButtonLabel(title) {
    const text = cleanText(title);
    if (/종료/.test(text)) return '종료하기';
    if (/삭제/.test(text)) return '삭제하기';
    if (/초기화/.test(text)) return '초기화하기';
    if (/복원/.test(text)) return '복원하기';
    return '확인';
  }

  function relabelConfirmModal() {
    const overlay = $('#confirm-modal');
    if (!overlay || !overlay.classList.contains('show')) return;
    const title = cleanText($('#confirm-title', overlay)?.textContent);
    const confirmButton = $('#confirm-btn', overlay);
    const cancelButton = $('.c943-modal-actions button:not(#confirm-btn), .modal button:not(#confirm-btn):not(.modal-close)', overlay);
    const label = confirmButtonLabel(title);
    if (confirmButton && cleanText(confirmButton.textContent) !== label) confirmButton.textContent = label;
    if (cancelButton && /학습 종료|퀴즈 종료/.test(title) && cleanText(cancelButton.textContent) !== '계속 학습') {
      cancelButton.textContent = '계속 학습';
    }
    enhanceNativeModals();
  }

  function installConfirmEnhancer() {
    if (confirmObserver) return;
    const overlay = $('#confirm-modal');
    if (!overlay) return;
    confirmObserver = new MutationObserver(relabelConfirmModal);
    confirmObserver.observe(overlay, {attributes: true, attributeFilter: ['class']});
    relabelConfirmModal();
  }

  function enhanceStudyActionIcons() {
    const actions = [
      ['#fc-prev-btn,#expr-fc-prev-btn','left','이전 카드'],
      ['#fc-next-btn,#expr-fc-next-btn','right','다음 카드'],
      ['#fc-speak-btn,#expr-fc-speak-btn','speaker','발음 듣기'],
      ['#fc-bookmark-btn,#expr-fc-bookmark-btn','bookmark','북마크'],
      ['#fc-edit-btn,#expr-fc-edit-btn','edit','카드 편집']
    ];
    actions.forEach(([selector, icon, label]) => {
      $$(selector).forEach((button) => {
        const rawState = cleanText(button.textContent);
        const active = rawState ? /★|⭐|해제|저장됨/.test(rawState) : (button.classList.contains('is-active') || Boolean(button.style.color));
        button.classList.add('c943-icon-button');
        button.classList.toggle('is-active', active);
        if (!button.querySelector(`.c943-icon-${icon}`)) button.innerHTML = iconGlyph(icon);
        button.setAttribute('aria-label', label);
        button.title = label;
      });
    });
    ['#fc-exit-btn','#expr-fc-exit-btn'].forEach((selector) => {
      const button = $(selector);
      if (button) button.classList.add('c943-study-exit');
    });
  }

  function enhanceStats() {
    $('#page-stats')?.classList.add('c943-stats-root');
  }

  function enhanceDataTools() {
    const page = $('#page-data');
    if (!page) return;
    const catalog = $('#cems932-data-catalog', page);
    catalog?.classList.add('c943-data-catalog');
    const catalogTitle = $('summary strong', catalog);
    if (catalogTitle && !catalogTitle.querySelector('.c943-catalog-icon')) {
      catalogTitle.innerHTML = `${iconGlyph('database', 'c943-catalog-icon')}<span>데이터 인식 현황</span>`;
    }
    const uploadIcon = $('#upload-zone .upload-zone-icon', page);
    if (uploadIcon && !uploadIcon.querySelector('.c943-icon-upload')) {
      uploadIcon.classList.add('c943-upload-illustration');
      uploadIcon.innerHTML = iconGlyph('upload');
    }
    const homeUploadIcon = $('#db-card .empty-state-icon');
    if (homeUploadIcon && !homeUploadIcon.querySelector('.c943-icon-upload')) {
      homeUploadIcon.classList.add('c943-upload-illustration', 'c943-home-upload-illustration');
      homeUploadIcon.innerHTML = iconGlyph('upload');
    }
    const addPane = $('[data-ux25-data-pane="add"]', page);
    const excelPanel = findExcelPanel();
    const importCard = $('#c943-json-import-card');
    const aiCard = $('.ai-card', addPane || page);
    if (addPane && excelPanel) {
      excelPanel.dataset.c944R2DataRole = 'add';
      if (excelPanel.parentElement !== addPane) addPane.append(excelPanel);
      if (importCard && !excelPanel.contains(importCard)) excelPanel.append(importCard);
      /* Keep the AI helper first so the generation prompt is visible before file tools. */
      if (aiCard && addPane.firstElementChild !== aiCard) addPane.insertBefore(aiCard, addPane.firstElementChild);
    }
    if (!aiCard) return;
    aiCard.classList.add('c943-ai-helper');
    const title = $('.card-title', aiCard);
    const titleText = $('.c943-section-title-text', title);
    if (titleText && titleText.textContent !== 'AI 데이터 도우미') titleText.textContent = 'AI 데이터 도우미';
    else if (title && !title.querySelector('.c943-section-main')) title.childNodes[0] && (title.childNodes[0].nodeValue = 'AI 데이터 도우미');
    let toggle = $('[data-c943-ai-toggle]', title);
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'c943-ai-toggle';
      toggle.dataset.c943AiToggle = '1';
      toggle.addEventListener('click', () => {
        const collapsed = !aiCard.classList.contains('c943-collapsed');
        aiCard.classList.toggle('c943-collapsed', collapsed);
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.textContent = collapsed ? '열기' : '접기';
        try { localStorage.setItem('cems:v944:ai-helper', collapsed ? 'closed' : 'open'); } catch (_) {}
      });
      title?.append(toggle);
    }
    let stored = 'closed';
    try { stored = localStorage.getItem('cems:v944:ai-helper') || 'closed'; } catch (_) {}
    const collapsed = stored !== 'open';
    aiCard.classList.toggle('c943-collapsed', collapsed);
    toggle.textContent = collapsed ? '열기' : '접기';
    toggle.setAttribute('aria-expanded', String(!collapsed));
  }

  /* ------------------------ External library IndexedDB ------------------- */

  function toIndexItem(item) {
    const raw = item?.raw || {};
    const examples = Array.isArray(item?.examples) ? item.examples : [];
    const relations = item?.relations || {};
    const levels = item?.levels || {};
    const tags = Array.isArray(item?.tags) ? item.tags : listFrom(item?.tags || raw.tags);
    const searchText = [
      item?.front, item?.simplified, item?.pinyin, item?.meaning, item?.meaningEn,
      item?.pos, item?.function, item?.structure, item?.grammarPoint, item?.book, item?.lesson,
      ...Object.values(levels), ...tags,
      ...Object.values(relations).flatMap((value) => Array.isArray(value) ? value : listFrom(value)),
      ...examples.flatMap((example) => [example?.zh, example?.simplified, example?.pinyin, example?.ko, example?.en]),
      raw.Common_Error, raw['비고'], raw.Notes, raw.Note,
    ].filter(Boolean).join(' ').toLowerCase();
    return {
      id: item.id,
      sourceId: item.sourceId,
      sourceTitle: item.sourceTitle,
      sourceQuality: item.sourceQuality,
      qualityRank: Number(item.qualityRank || 1),
      importedAt: item.importedAt || Date.now(),
      type: item.type || (raw.Grammar_Point ? 'grammar' : raw.Expression ? 'expression' : raw.textTraditional ? 'example' : 'word'),
      mergeKey: item.mergeKey || item.id,
      front: item.front || raw.Traditional_CH || raw.Expression || raw.Grammar_Point || raw.textTraditional || '',
      simplified: item.simplified || raw.Simplified_CH || raw.textSimplified || '',
      pinyin: item.pinyin || raw.Pinyin || raw.pinyin || '',
      meaning: item.meaning || raw.Meaning_KO || raw.translationKo || raw.Function || '',
      meaningEn: item.meaningEn || raw.Meaning_EN || raw.translationEn || '',
      pos: item.pos || raw.POS || '',
      function: item.function || raw.Function || '',
      structure: item.structure || raw.Structure_CHT || raw.L3 || '',
      grammarPoint: item.grammarPoint || raw.Grammar_Point || '',
      relations,
      levels,
      notes: item.notes || {},
      tags,
      book: item.book || '',
      lesson: item.lesson || '',
      lessons: Array.isArray(item.lessons) ? item.lessons : listFrom(item.lessons || raw.lessons),
      exampleCount: examples.length,
      searchText,
    };
  }

  function openExternalDb() {
    if (state.dbPromise) return state.dbPromise;
    state.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const tx = request.transaction;
        const ensureIndex = (store, name, keyPath, options = {unique: false}) => {
          if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
        };
        if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', {keyPath: 'id'});
        const items = db.objectStoreNames.contains('items') ? tx.objectStore('items') : db.createObjectStore('items', {keyPath: 'id'});
        ensureIndex(items, 'sourceId', 'sourceId');
        ensureIndex(items, 'type', 'type');
        ensureIndex(items, 'book', 'book');
        ensureIndex(items, 'lesson', 'lesson');
        ensureIndex(items, 'mergeKey', 'mergeKey');
        ensureIndex(items, 'sourceType', ['sourceId','type']);

        const hadIndexStore = db.objectStoreNames.contains('itemIndex');
        const itemIndex = hadIndexStore ? tx.objectStore('itemIndex') : db.createObjectStore('itemIndex', {keyPath: 'id'});
        ensureIndex(itemIndex, 'sourceId', 'sourceId');
        ensureIndex(itemIndex, 'type', 'type');
        ensureIndex(itemIndex, 'book', 'book');
        ensureIndex(itemIndex, 'lesson', 'lesson');
        ensureIndex(itemIndex, 'mergeKey', 'mergeKey');
        ensureIndex(itemIndex, 'sourceType', ['sourceId','type']);
        if (!hadIndexStore) {
          const cursorRequest = items.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            try { itemIndex.put(toIndexItem(cursor.value)); } catch (error) { console.warn('[CEMS943 DB migrate]', error); }
            cursor.continue();
          };
        }

        if (!db.objectStoreNames.contains('routines')) db.createObjectStore('routines', {keyPath: 'id'});
        const progress = db.objectStoreNames.contains('progress') ? tx.objectStore('progress') : db.createObjectStore('progress', {keyPath: 'id'});
        ensureIndex(progress, 'mergeKey', 'mergeKey');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        state.dbPromise = null;
        reject(request.error || new Error('외부 라이브러리 DB를 열 수 없습니다.'));
      };
      request.onblocked = () => toast('다른 탭에서 데이터 화면을 닫은 뒤 다시 시도해 주세요.');
    });
    return state.dbPromise;
  }

  function idbResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 요청 실패'));
    });
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 트랜잭션 실패'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 트랜잭션 중단'));
    });
  }

  async function saveSource(source) {
    const db = await openExternalDb();
    const tx = db.transaction('sources', 'readwrite');
    tx.objectStore('sources').put(source);
    await transactionDone(tx);
  }

  async function saveBatch(items) {
    const db = await openExternalDb();
    const tx = db.transaction(['items','itemIndex'], 'readwrite');
    const fullStore = tx.objectStore('items');
    const indexStore = tx.objectStore('itemIndex');
    items.forEach((item) => {
      fullStore.put(item);
      indexStore.put(toIndexItem(item));
    });
    await transactionDone(tx);
  }

  async function saveRoutine(routine, fileName = '') {
    const db = await openExternalDb();
    const id = String(routine.id || `routine-${Date.now().toString(36)}`);
    const record = {...routine, id, importedAt: Date.now(), fileName};
    const tx = db.transaction('routines', 'readwrite');
    tx.objectStore('routines').put(record);
    await transactionDone(tx);
    return record;
  }

  async function getSources() {
    const db = await openExternalDb();
    return idbResult(db.transaction('sources', 'readonly').objectStore('sources').getAll());
  }

  async function getRoutines() {
    const db = await openExternalDb();
    return idbResult(db.transaction('routines', 'readonly').objectStore('routines').getAll());
  }

  function deleteBySource(store, sourceId) {
    const index = store.index('sourceId');
    const request = index.openKeyCursor(IDBKeyRange.only(sourceId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  }

  async function deleteSource(sourceId) {
    const db = await openExternalDb();
    const readTx = db.transaction('items', 'readonly');
    const itemStore = readTx.objectStore('items');
    const importedItems = itemStore.indexNames.contains('sourceId')
      ? await idbResult(itemStore.index('sourceId').getAll(IDBKeyRange.only(sourceId))).catch(() => [])
      : [];
    const mergeKeys = new Set(importedItems.map((item) => item && (item.mergeKey || item.id)).filter(Boolean));
    const stores = ['sources','items','itemIndex'];
    if (db.objectStoreNames.contains('progress')) stores.push('progress');
    const tx = db.transaction(stores, 'readwrite');
    tx.objectStore('sources').delete(sourceId);
    deleteBySource(tx.objectStore('items'), sourceId);
    deleteBySource(tx.objectStore('itemIndex'), sourceId);
    if (stores.includes('progress')) {
      const progress = tx.objectStore('progress');
      if (progress.indexNames.contains('mergeKey')) {
        mergeKeys.forEach((mergeKey) => {
          const request = progress.index('mergeKey').openKeyCursor(IDBKeyRange.only(mergeKey));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            progress.delete(cursor.primaryKey);
            cursor.continue();
          };
        });
      }
    }
    await transactionDone(tx);
    state.externalDeck = null;
    try {
      /* 9.4.4: 광역 삭제를 v944 자신의 외부 라이브러리 캐시 키로만 좁혔다.
         예전 패턴 `cems944\.final\.random` 은 learning/cems-9.4.1-deck-groups.js 의
         내장 학습 랜덤 회전 이력('cems944.final.random.<lang>.<kind>.<mode>')과
         매칭돼, 외부 JSON 하나를 지우면 내장 학습 전체의 회전 이력이 날아갔다.
         `external.*(deck|session)` 과 `cems(943|944).*external` 도 남의 키를
         삼킬 만큼 넓어 접두사 고정으로 바꿨다. 학습 설정·루틴 진행 같은
         외부 자료와 무관한 키는 건드리지 않는다. */
      Object.keys(localStorage)
        .filter((key) => /^cems(?:943|944)[.:_-]external/i.test(key))
        .forEach((key) => localStorage.removeItem(key));
    } catch (_) {}
    try {
      window.__CEMS943_ACTIVE_EXTERNAL_DECK__ = null;
      window.__cemsExternalDeck = null;
      window.dispatchEvent(new CustomEvent('cems:external-library-updated', {detail:{sourceId, deleted:true}}));
    } catch (_) {}
  }

  async function getItemsForQuery({sourceId = '__all__', type = 'word'} = {}) {
    const db = await openExternalDb();
    const tx = db.transaction('itemIndex', 'readonly');
    const store = tx.objectStore('itemIndex');
    const scoped = Boolean(sourceId) && sourceId !== '__all__';
    if (scoped && store.indexNames.contains('sourceType')) {
      return idbResult(store.index('sourceType').getAll(IDBKeyRange.only([sourceId, type])));
    }
    /* 9.4.4: sourceType 복합 인덱스가 없는 구버전 DB 에서 예전 코드는 sourceId 를
       통째로 무시하고 타입 전체를 돌려줬다("이 자료만 보기"가 먹지 않음).
       인덱스가 없으면 넓게 조회한 뒤 메모리에서 sourceId 로 거른다. */
    if (scoped && store.indexNames.contains('sourceId')) {
      const rows = await idbResult(store.index('sourceId').getAll(sourceId));
      return type ? rows.filter((row) => !row?.type || row.type === type) : rows;
    }
    if (store.indexNames.contains('type') && type) {
      const rows = await idbResult(store.index('type').getAll(type));
      return scoped ? rows.filter((row) => row?.sourceId === sourceId) : rows;
    }
    const rows = await idbResult(store.getAll());
    return rows.filter((row) => (!scoped || row?.sourceId === sourceId) && (!type || !row?.type || row.type === type));
  }

  async function getFullItemsByIds(ids) {
    const keys = uniq(ids || []).filter(Boolean);
    if (!keys.length) return [];
    const db = await openExternalDb();
    const tx = db.transaction('items', 'readonly');
    const store = tx.objectStore('items');
    const requests = keys.map((id) => idbResult(store.get(id)).catch(() => null));
    return (await Promise.all(requests)).filter(Boolean);
  }

  async function saveExternalProgress(item, grade) {
    const db = await openExternalDb();
    const id = `external:${item.mergeKey || item.id}`;
    const readTx = db.transaction('progress', 'readonly');
    const existing = await idbResult(readTx.objectStore('progress').get(id)).catch(() => null);
    const now = Date.now();
    const safeGrade = Math.max(0, Math.min(3, Number(grade) || 0));
    const intervals = [0,1,3,7];
    const record = {
      id,
      mergeKey: item.mergeKey || item.id,
      attempts: Number(existing?.attempts || 0) + 1,
      again: Number(existing?.again || 0) + (safeGrade === 0 ? 1 : 0),
      hard: Number(existing?.hard || 0) + (safeGrade === 1 ? 1 : 0),
      good: Number(existing?.good || 0) + (safeGrade === 2 ? 1 : 0),
      easy: Number(existing?.easy || 0) + (safeGrade === 3 ? 1 : 0),
      lastGrade: safeGrade,
      lastReviewedAt: now,
      nextReviewAt: now + intervals[safeGrade] * 86400000,
      updatedAt: now,
    };
    const writeTx = db.transaction('progress', 'readwrite');
    writeTx.objectStore('progress').put(record);
    await transactionDone(writeTx);
    return record;
  }

  function listFrom(value) {
    if (Array.isArray(value)) return value.filter((item) => item != null);
    const text = cleanText(value);
    if (!text) return [];
    return text.split(/\s*[,;|]\s*/).filter(Boolean);
  }

  function deriveBookLesson(item) {
    const tags = [...listFrom(item.tags), ...listFrom(item.raw?.tags), ...listFrom(item.lessons), ...listFrom(item.raw?.lessons)];
    const all = [item.book, item.lesson, item.raw?.book, item.raw?.lesson, ...tags].filter(Boolean).join(' ');
    const lessonMatch = all.match(/ACC\s*([1-6])\s*[-_: ]?\s*L(?:ESSON)?\s*0*([0-9]{1,2})/i);
    const bookMatch = lessonMatch || all.match(/ACC\s*([1-6])/i);
    const rawLesson = cleanText(item.lesson || item.raw?.lesson);
    const rawLessonMatch = rawLesson.match(/ACC\s*([1-6])\s*[-_: ]?\s*L(?:ESSON)?\s*0*([0-9]{1,2})/i);
    const lessonNumber = lessonMatch?.[2] || rawLessonMatch?.[2];
    return {
      book: bookMatch ? `ACC ${bookMatch[1]}` : cleanText(item.book || item.raw?.book),
      lesson: lessonNumber ? `L${String(Number(lessonNumber)).padStart(2,'0')}` : rawLesson
    };
  }

  function normalizeStoredItem(item, sourceMap = new Map()) {
    const raw = item.raw || {};
    const type = item.type || (raw.Grammar_Point ? 'grammar' : raw.Expression ? 'expression' : 'word');
    const front = cleanText(item.front || raw.Traditional_CH || raw.Expression || raw.Grammar_Point || raw.textTraditional || raw.targetText || raw.word);
    const simplified = cleanText(item.simplified || raw.Simplified_CH || raw.textSimplified);
    const pinyin = cleanText(item.pinyin || raw.Pinyin || raw.pinyin);
    const meaning = cleanText(item.meaning || raw.Meaning_KO || raw.translationKo || raw.Function || raw.Meaning_EN);
    const meaningEn = cleanText(item.meaningEn || raw.Meaning_EN || raw.translationEn);
    const tags = uniq([...listFrom(item.tags), ...listFrom(raw.tags), ...listFrom(raw.Style_Tags), ...listFrom(raw.lessons)]);
    const bookLesson = deriveBookLesson({...item, tags});
    const source = sourceMap.get(item.sourceId) || {};
    const examples = Array.isArray(item.examples) ? item.examples : [];
    if (!examples.length) {
      const pairs = [
        [raw.Example_CHT, raw.Example_Pinyin, raw.Example_KO, raw.Example_EN],
        [raw.Example1, raw.Example1_Pinyin, raw.Example1_KO, raw.Example1_EN],
        [raw.Example2, raw.Example2_Pinyin, raw.Example2_KO, raw.Example2_EN],
        [raw.textTraditional || raw.targetText, raw.pinyin, raw.translationKo, raw.translationEn],
      ];
      pairs.forEach(([zh,py,ko,en]) => { if (cleanText(zh || ko || en)) examples.push({zh:cleanText(zh), pinyin:cleanText(py), ko:cleanText(ko), en:cleanText(en)}); });
      const grammarExamples = Array.isArray(raw.grammarExamples) ? raw.grammarExamples : [];
      grammarExamples.forEach((zh, index) => examples.push({
        zh: cleanText(zh),
        pinyin: cleanText(raw.grammarExamplePinyin?.[index]),
        ko: cleanText(raw.grammarExampleTranslationsKO?.[index]),
        en: cleanText(raw.grammarExampleTranslationsEN?.[index]),
      }));
    }
    const pos = cleanText(item.pos || raw.POS);
    const structure = cleanText(item.structure || raw.Structure_CHT || raw.L3);
    const grammarPoint = cleanText(item.grammarPoint || raw.Grammar_Point);
    const mergeKey = item.mergeKey || `${type}:${front.toLowerCase()}|${pinyin.toLowerCase()}|${pos.toLowerCase()}`;
    return {
      ...item,
      type,
      front: front || '(내용 없음)',
      simplified,
      pinyin,
      meaning,
      meaningEn,
      pos,
      function: cleanText(item.function || raw.Function),
      structure,
      grammarPoint,
      examples: uniq(examples.map((example) => ({
        zh: cleanText(example.zh || example.textTraditional || example.targetText),
        simplified: cleanText(example.simplified || example.textSimplified),
        pinyin: cleanText(example.pinyin), ko: cleanText(example.ko || example.translationKo), en: cleanText(example.en || example.translationEn)
      }))).filter((example) => example.zh || example.ko || example.en),
      relations: {
        synonyms: uniq(item.relations?.synonyms || listFrom(raw.Synonym_CHT)),
        antonyms: uniq(item.relations?.antonyms || listFrom(raw.Antonym_CHT)),
        collocations: uniq(item.relations?.collocations || listFrom(raw.Collocation_CHT)),
        variants: uniq(item.relations?.variants || listFrom(raw.Variants_CHT)),
        measures: uniq(item.relations?.measures || listFrom(raw.Measure_CHT)),
        similar: uniq(item.relations?.similar || listFrom(raw.Similar_Expr)),
      },
      levels: {
        hsk: cleanText(item.levels?.hsk || raw.HSK), tocfl: cleanText(item.levels?.tocfl || raw.TOCFL),
        tbcl: cleanText(item.levels?.tbcl || raw.TBCL_Level), tbclBand: cleanText(item.levels?.tbclBand || raw.TBCL_Band),
        tbclSequence: item.levels?.tbclSequence ?? raw.TBCL_Sequence ?? '', cefr: cleanText(item.levels?.cefr || raw.CEFR),
        register: cleanText(item.levels?.register || raw.Register || raw.Formality), formality: cleanText(item.levels?.formality || raw.Formality || raw.Register),
        medium: cleanText(item.levels?.medium || raw.Medium), frequency: cleanText(item.levels?.frequency || raw.Frequency),
        priority: cleanText(item.levels?.priority || raw.Priority), currency: cleanText(item.levels?.currency || raw.Currency),
        topic: cleanText(item.levels?.topic || raw.Topic_Primary), l1: cleanText(item.levels?.l1 || raw.L1), l2: cleanText(item.levels?.l2 || raw.L2), l3: cleanText(item.levels?.l3 || raw.L3),
      },
      notes: {
        styleTags: cleanText(item.notes?.styleTags || raw.Style_Tags),
        commonError: cleanText(item.notes?.commonError || raw.Common_Error),
        note: cleanText(item.notes?.note || raw['비고'] || raw.Notes || raw.Note),
      },
      tags,
      book: bookLesson.book,
      lesson: bookLesson.lesson,
      lessons: uniq([...listFrom(item.lessons), ...listFrom(raw.lessons)]),
      acceptedAnswers: uniq([...listFrom(item.acceptedAnswers), front, simplified]),
      sourceRefs: item.sourceRefs || raw.sourceRefs || [],
      sourceTypes: uniq([...listFrom(item.sourceTypes), ...listFrom(raw.sourceTypes)]),
      audioRefs: uniq([...listFrom(item.audioRefs), ...listFrom(raw.audioRefs)]),
      mergeKey,
      qualityRank: Number(item.qualityRank || source.qualityRank || (source.quality === '교과서 정합형' ? 3 : source.quality === '자동 보강형' ? 2 : 1)),
      sourceTitle: item.sourceTitle || source.title || source.fileName || item.sourceId,
      sourceQuality: item.sourceQuality || source.quality || '외부 자료',
      raw,
    };
  }

  function unionObjects(arrays, keyFn) {
    const out = [];
    const seen = new Set();
    arrays.flat().forEach((value) => {
      if (!value) return;
      const key = keyFn(value);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(value);
    });
    return out;
  }

  function mergeExternalItems(items, sourceMap) {
    const groups = new Map();
    items.map((item) => normalizeStoredItem(item, sourceMap)).forEach((item) => {
      const key = item.mergeKey || item.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    const choose = (rows, path, fallback = '') => {
      for (const row of rows) {
        let value = row;
        for (const part of path.split('.')) value = value?.[part];
        if (value !== undefined && value !== null && cleanText(value) !== '') return value;
      }
      return fallback;
    };
    return Array.from(groups.values()).map((rows) => {
      rows.sort((a,b) => b.qualityRank - a.qualityRank || Number(b.importedAt || 0) - Number(a.importedAt || 0));
      const base = {...rows[0]};
      const relationKeys = ['synonyms','antonyms','collocations','variants','measures','similar'];
      const levelKeys = ['hsk','tocfl','tbcl','tbclBand','tbclSequence','cefr','register','formality','medium','frequency','priority','currency','topic','l1','l2','l3'];
      base.front = choose(rows, 'front');
      base.simplified = choose(rows, 'simplified');
      base.pinyin = choose(rows, 'pinyin');
      base.meaning = choose(rows, 'meaning');
      base.meaningEn = choose(rows, 'meaningEn');
      base.pos = choose(rows, 'pos');
      base.function = choose(rows, 'function');
      base.structure = choose(rows, 'structure');
      base.grammarPoint = choose(rows, 'grammarPoint');
      base.book = choose(rows, 'book');
      base.lesson = choose(rows, 'lesson');
      base.examples = unionObjects(rows.map((row) => row.examples || []), (example) => cleanText(example.zh || example.ko || example.en).toLowerCase());
      base.relations = {};
      relationKeys.forEach((key) => { base.relations[key] = uniq(rows.flatMap((row) => row.relations?.[key] || [])); });
      base.levels = {};
      levelKeys.forEach((key) => { base.levels[key] = choose(rows, `levels.${key}`); });
      base.notes = {
        styleTags: choose(rows, 'notes.styleTags'),
        commonError: choose(rows, 'notes.commonError'),
        note: choose(rows, 'notes.note'),
      };
      base.tags = uniq(rows.flatMap((row) => row.tags || []));
      base.lessons = uniq(rows.flatMap((row) => row.lessons || []));
      base.acceptedAnswers = uniq(rows.flatMap((row) => row.acceptedAnswers || []));
      base.sourceRefs = unionObjects(rows.map((row) => row.sourceRefs || []), (ref) => JSON.stringify(ref));
      base.sourceTypes = uniq(rows.flatMap((row) => row.sourceTypes || []));
      base.audioRefs = uniq(rows.flatMap((row) => row.audioRefs || []));
      base.sources = rows.map((row) => ({id: row.sourceId, title: row.sourceTitle, quality: row.sourceQuality, qualityRank: row.qualityRank}));
      base.sourceItemIds = uniq(rows.map((row) => row.id).filter(Boolean));
      base.searchText = rows.map((row) => row.searchText || '').filter(Boolean).join(' ');
      base.rawSources = rows.filter((row) => row.raw).map((row) => ({sourceId: row.sourceId, raw: row.raw}));
      return base;
    });
  }

  function findExcelPanel() {
    return $('#file-input')?.closest('.card') || $('#upload-zone')?.closest('.card') || null;
  }

  async function updateImportSummary(force = false) {
    const card = $('#c943-json-import-card');
    if (!card || (!force && card.dataset.summaryLoaded === '1')) return;
    const [sources, routines] = await Promise.all([getSources().catch(() => []), getRoutines().catch(() => [])]);
    const count = sources.reduce((sum, source) => sum + Object.values(source.counts || {}).reduce((a,b) => a + Number(b || 0), 0), 0);
    const nextText = sources.length
      ? `가져온 JSON ${sources.length}개 · 원본 항목 ${formatNumber(count)}개 · 사용자 루틴 ${routines.length}개`
      : '가져온 JSON 자료 없음';
    const signature = `${sources.length}:${count}:${routines.length}`;
    const changed = card.dataset.summarySignature !== signature;
    const summary = $('[data-c944-r2-import-summary]', card) || $('.c943-source-summary', card);
    if (summary && summary.textContent !== nextText) summary.textContent = nextText;
    card.dataset.summaryLoaded = '1';
    card.dataset.summarySignature = signature;
    if (changed) {
      try {
        window.dispatchEvent(new CustomEvent('cems:external-library-updated', {
          detail: {sources: sources.length, items: count, routines: routines.length}
        }));
      } catch (_) {}
    }
  }

  function ensureJsonImportCard() {
    const panel = findExcelPanel();
    if (!panel) return;
    panel.classList.add('c944-r2-import-panel');
    panel.dataset.c944R2DataRole = 'add';
    const addPane = $('[data-ux25-data-pane="add"]', $('#page-data') || document);
    if (addPane && panel.parentElement !== addPane) addPane.append(panel);

    const title = $('.card-title', panel);
    const titleText = $('.c943-section-title-text', panel);
    if (titleText) titleText.textContent = '자료 파일 가져오기';
    else if (title) title.textContent = '자료 파일 가져오기';
    if (title) title.dataset.c943Renamed = '1';

    const fileInput = $('#file-input');
    if (fileInput) {
      const accept = fileInput.getAttribute('accept') || '';
      if (!/\.json/i.test(accept)) fileInput.setAttribute('accept', `${accept},.json,application/json`);
      fileInput.setAttribute('aria-label', 'Excel 또는 JSON 자료 파일 선택');
      if (!fileInput.dataset.c943JsonCapture) {
        fileInput.dataset.c943JsonCapture = '1';
        fileInput.addEventListener('change', (event) => {
          const file = event.target.files?.[0];
          if (file && /\.json$/i.test(file.name)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            /* handleJsonFile 은 이제 프로미스를 돌려주므로 반드시 받아 처리한다. */
            handleJsonFile(file).catch((error) => { console.error('[CEMS943 JSON]', error); });
            event.target.value = '';
          }
        }, true);
      }
    }

    const zone = $('#upload-zone');
    if (zone) {
      const paragraph = zone.querySelector('p');
      if (paragraph) paragraph.innerHTML = '탭하거나 파일을 끌어오세요<br><small>Excel(.xlsx·.xlsm·.xls) 또는 JSON 자동 감지</small>';
      if (!zone.dataset.c943Drop) {
        zone.dataset.c943Drop = '1';
        zone.addEventListener('drop', (event) => {
          const file = Array.from(event.dataTransfer?.files || []).find((candidate) => /\.json$/i.test(candidate.name));
          if (!file) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          handleJsonFile(file).catch((error) => { console.error('[CEMS943 JSON]', error); });
        }, true);
      }
    }

    let card = $('#c943-json-import-card');
    if (card && !panel.contains(card)) card.remove();
    card = $('#c943-json-import-card');
    if (!card) {
      card = document.createElement('div');
      card.id = 'c943-json-import-card';
      card.className = 'c943-json-import-inline';
      card.innerHTML = `
        <div class="c943-source-summary" data-c944-r2-import-summary>외부 자료를 확인하는 중…</div>
        <button type="button" data-library-open>${svgIcon('book','c943-scope-icon')} 가져온 자료 보기</button>`;
      panel.append(card);
      $('[data-library-open]', card).addEventListener('click', () => openLibrary());
    }
    enhanceDataTools();
    updateImportSummary();
  }

  /* Main-thread fallback for environments that block module/classic Workers
     (direct file hosting, restrictive WebViews, or stale service-worker caches). */
/* ==========================================================================
 * CEMS 9.4.4 — JSON 가져오기 공통 정규화 코어 (CEMS_IMPORT_CORE)
 * --------------------------------------------------------------------------
 * ⚠ 이 블록은 v944/cems-v9.4.4.js 와 v944/cems-v9.4.4-import-worker.js 에
 *   똑같은 사본으로 들어 있다. Worker 는 별도 스레드라 import 를 쓸 수 없어
 *   코드를 복사해 두었다(들여쓰기까지 같게 유지해 diff 로 비교할 수 있다).
 *
 *   한쪽만 고치면 같은 파일을 Worker 경로와 폴백 경로로 넣었을 때 mergeKey·
 *   타입판정·sourceId 가 갈려 동일 항목이 2개로 분리된다. 반드시 함께 고칠 것.
 * ========================================================================== */
const CEMS_IMPORT_CORE_VERSION = '9.4.4-core1';
const CEMS_SUPERSCRIPT_DIGITS = {'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9'};
/* 리스트 구분자 — 반각 , ; | 와 전각 ， ； 、 를 모두 포함한다. */
const CEMS_LIST_SEPARATOR = /\s*[,;|，；、]\s*/;
/* 타입 판정 우선순위. Worker 와 폴백이 같은 순서를 본다
   (예전에는 Worker word→expression→grammar→example, 폴백 grammar→expression→
    example→word 로 서로 달라 같은 배열이 다른 타입으로 저장됐다). */
const CEMS_TYPE_ORDER = ['grammar', 'expression', 'example', 'word'];
const CEMS_TYPE_PATH_PATTERNS = {
  grammar: /(grammar|patterns?|문법|語法)/i,
  expression: /(expressions?|phrases?|phrasal|dialogues?|conversations?|표현|회화|短語|句型)/i,
  example: /(examples?|sentences?|example[_ -]?sentences?|예문|例句)/i,
  word: /(vocab(?:ulary)?|words?|lexemes?|terms?|단어|어휘|詞彙|生詞)/i
};

/* mergeKey·타입판정에 쓰이는 필드 후보 목록. 두 경로가 반드시 같은 순서로 봐야
   한다(예전에는 front/structure/grammarPoint 후보가 서로 달라 같은 행에서 다른
   mergeKey 가 나왔다). */
const CEMS_FIELD_KEYS = Object.freeze({
  wordFront: ['Traditional_CH', 'Traditional', 'traditional', 'Headword_CHT', 'word', 'term', 'front'],
  exampleFront: ['textTraditional', 'targetText', 'sentence', 'example', 'zh', 'text'],
  otherFront: ['Expression', 'expression', 'phrase', 'pattern', 'Grammar_Point', 'title', 'front'],
  pinyin: ['Pinyin', 'pinyin', 'romanization', 'pronunciation'],
  pos: ['POS', 'pos', 'partOfSpeech'],
  structure: ['Structure_CHT', 'structure', 'pattern', 'L3'],
  grammarPoint: ['Grammar_Point', 'grammarPoint', 'pattern', 'grammar_id'],
  originalId: ['id', 'uuid', 'key', '_id'],
  meaningKo: ['Meaning_KO', 'Meaning1_KO', 'meaningKo', 'translationKo', 'korean', 'ko', 'meaning', 'definition', 'gloss', 'back', '뜻', '해석']
});

function cemsImportIsObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cemsImportClean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

/* 메타데이터용 — 문자열·숫자만 받는다(객체가 "[object Object]" 로 새는 것 방지). */
function cemsImportScalar(value) {
  return typeof value === 'string' || typeof value === 'number' ? cemsImportClean(value) : '';
}

function cemsImportHash(input) {
  let hash = 0x811c9dc5;
  const value = String(input == null ? '' : input);
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/* 병합 비교용 정규화 — 위첨자(¹²³) 숫자화 + NFKC + 소문자. */
function cemsImportSenseText(value) {
  return cemsImportClean(value)
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (digit) => CEMS_SUPERSCRIPT_DIGITS[digit] || digit)
    .normalize('NFKC')
    .toLowerCase();
}

function cemsImportSplitList(value) {
  const text = cemsImportClean(value);
  return text ? text.split(CEMS_LIST_SEPARATOR).map(cemsImportClean).filter(Boolean) : [];
}

/* 타입 판정: 경로 이름 → 샘플 키 순. 두 단계 모두 같은 우선순위를 쓴다. */
function cemsImportTypeOf(pathText, records) {
  const name = String(pathText == null ? '' : pathText);
  for (const type of CEMS_TYPE_ORDER) {
    if (CEMS_TYPE_PATH_PATTERNS[type].test(name)) return type;
  }
  const sample = (records || []).find(cemsImportIsObject);
  if (!sample) return null;
  const keys = Object.keys(sample).join(' ');
  if (/(Grammar_Point|Structure_CHT|grammarExamples|grammar|pattern|語法)/i.test(keys)) return 'grammar';
  if (/(Expression|Function|Similar_Expr|dialogue|conversation|phrase)/i.test(keys)) return 'expression';
  if (/(textTraditional|targetText|translationKo|sentence|例句)/i.test(keys) && !/(Traditional_CH|headword|vocab)/i.test(keys)) return 'example';
  if (/(Traditional_CH|Simplified_CH|Pinyin|Meaning_KO|word|headword|vocab)/i.test(keys)) return 'word';
  return null;
}

/* 최상위가 배열인 JSON. Worker 는 예전에 여기서 컬렉션을 못 찾고 실패했다. */
function cemsImportRootArrayType(root) {
  return cemsImportTypeOf('root', root) || 'word';
}

/* mergeKey 시드 구성요소 — 타입별. */
function cemsImportKeyParts(type, fields) {
  const values = fields || {};
  if (type === 'word') return [values.front, values.pinyin, values.pos];
  if (type === 'grammar') return [values.front || values.grammarPoint, values.structure];
  return [values.front, values.pinyin];
}

/* mergeKey. 시드가 실제로 비었을 때만 원본 해시로 떨어진다.
   예전 Worker 는 `keySeed || fnv1a(...)` 였는데 keySeed 는 최악의 경우에도 "||"
   (truthy) 여서 해시 폴백이 절대 실행되지 않았고, front/pinyin/pos 가 전부 빈 행이
   모두 `word:||` 하나로 병합돼 사라졌다. */
function cemsImportMergeKey(type, fields, raw) {
  const parts = cemsImportKeyParts(type, fields).map(cemsImportSenseText);
  if (parts.some((part) => part !== '')) return `${type}:${parts.join('|')}`;
  let serialized = '';
  try { serialized = JSON.stringify(raw); } catch (_) { serialized = String(raw); }
  return `${type}:${cemsImportHash(serialized || `${type}|empty`)}`;
}

/* 항목 id — 원본 id 가 있으면 보존한다(폴백은 예전에 항상 해시로 덮었다). */
function cemsImportItemId(sourceId, type, originalId, mergeKey, index) {
  const original = cemsImportScalar(originalId);
  return `${sourceId}:${type}:${original || cemsImportHash(`${mergeKey}|${index}`)}`;
}

/* 자료 메타 기본값 — sourceId 조합에 쓰이므로 양쪽이 반드시 같아야 한다. */
function cemsImportMetaBasics(root, fileName) {
  const meta = cemsImportIsObject(root && root.meta)
    ? root.meta
    : cemsImportIsObject(root && root.metadata) ? root.metadata : {};
  const source = cemsImportIsObject(root && root.source) ? root.source : {};
  return {
    schema: cemsImportScalar(root && (root.schemaVersion || root.schema || root.format))
      || cemsImportScalar(meta.schema || meta.format) || 'generic-json',
    buildId: cemsImportScalar(root && (root.buildId || root.appVersion)) || cemsImportScalar(source.buildId),
    title: cemsImportScalar(meta.title) || cemsImportScalar(root && (root.title || root.name))
      || cemsImportClean(String(fileName || '').replace(/\.json$/i, '')),
    description: cemsImportScalar(meta.description) || cemsImportScalar(root && root.description)
      || cemsImportScalar(source.description),
    generatedAt: cemsImportScalar(source.generatedAt) || cemsImportScalar(meta.generatedAt)
  };
}

/* 자료 id — 같은 파일이면 Worker 경로와 폴백 경로가 같은 id 를 만든다. */
function cemsImportSourceId(info) {
  const values = info || {};
  const parts = [values.fileName, values.fileSize, values.schema, values.buildId, values.generatedAt, values.title];
  return `src-${cemsImportHash(parts.map((part) => cemsImportClean(part)).join('|'))}`;
}
/* ===================== 공통 정규화 코어 끝 (CEMS_IMPORT_CORE) ============= */

  /* 9.4.4: 해시는 공통 코어 하나만 쓴다(Worker 의 fnv1a 와 동일해야 한다). */
  function fallbackHash(value) { return cemsImportHash(value); }
  function fallbackObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function fallbackText(value) {
    if (Array.isArray(value)) return value.map(fallbackText).filter(Boolean).join(' / ');
    if (fallbackObject(value)) {
      for (const key of ['ko','korean','text','value','meaning','translation','definition','zh','traditional']) {
        if (value[key] != null && value[key] !== '') return fallbackText(value[key]);
      }
      return Object.values(value).filter((item) => typeof item === 'string').map(cleanText).filter(Boolean).slice(0, 4).join(' / ');
    }
    return cleanText(value);
  }
  function fallbackFirst(record, keys) {
    if (!fallbackObject(record)) return '';
    for (const key of keys) if (record[key] != null && record[key] !== '') return record[key];
    const lower = new Map(Object.keys(record).map((key) => [key.toLowerCase(), key]));
    for (const key of keys) {
      const actual = lower.get(String(key).toLowerCase());
      if (actual && record[actual] != null && record[actual] !== '') return record[actual];
    }
    return '';
  }
  function fallbackList(value) {
    if (Array.isArray(value)) return value.flatMap(fallbackList);
    if (fallbackObject(value)) return Object.values(value).flatMap(fallbackList);
    /* 9.4.4: 구분자는 공통 코어(반각 , ; | + 전각 ， ； 、)를 쓴다. */
    return cemsImportSplitList(value);
  }
  /* 9.4.4: 타입 판정은 공통 코어 하나만 쓴다(Worker 와 우선순위가 달라 같은
     배열이 다른 타입으로 저장되던 문제를 없앤다). */
  function fallbackType(path, rows) { return cemsImportTypeOf(path, rows); }
  function fallbackCollections(root) {
    const found = [], seenArrays = new Set(), seenObjects = new WeakSet();
    function visit(value, path, depth) {
      if (value == null || depth > 6) return;
      if (Array.isArray(value)) {
        if (seenArrays.has(value)) return;
        seenArrays.add(value);
        const type = fallbackType(path.join('.'), value);
        if (type && value.some(fallbackObject)) { found.push({type, path:path.join('.'), records:value}); return; }
        value.slice(0, 24).forEach((item, index) => visit(item, path.concat(String(index)), depth + 1));
        return;
      }
      if (!fallbackObject(value) || seenObjects.has(value)) return;
      seenObjects.add(value);
      Object.entries(value).forEach(([key, child]) => visit(child, path.concat(key), depth + 1));
    }
    if (Array.isArray(root)) {
      /* 최상위가 배열인 JSON. Worker 도 같은 규칙으로 처리한다(공통 코어). */
      const type = cemsImportRootArrayType(root);
      return root.some(fallbackObject) ? [{type, path:'root', records:root}] : [];
    }
    visit(root, [], 0);
    const out = [], signatures = new Set();
    found.sort((a,b) => b.records.length - a.records.length).forEach((entry) => {
      const signature = `${entry.type}:${entry.path}:${entry.records.length}`;
      if (!signatures.has(signature)) { signatures.add(signature); out.push(entry); }
    });
    return out;
  }
  function fallbackExample(raw, type) {
    if (type === 'word') {
      const zh = fallbackText(fallbackFirst(raw, ['Example_CHT','Example','example']));
      if (!zh) return [];
      return [{zh, pinyin:fallbackText(raw.Example_Pinyin), ko:fallbackText(raw.Example_KO), en:fallbackText(raw.Example_EN)}];
    }
    if (type === 'example') {
      const zh = fallbackText(fallbackFirst(raw, ['textTraditional','targetText','sentence','example','zh','text']));
      return zh ? [{zh, simplified:fallbackText(raw.textSimplified), pinyin:fallbackText(raw.pinyin), ko:fallbackText(raw.translationKo || raw.ko), en:fallbackText(raw.translationEn || raw.en)}] : [];
    }
    const result = [];
    [1,2].forEach((n) => {
      const zh = fallbackText(raw[`Example${n}`]);
      if (zh) result.push({zh, pinyin:fallbackText(raw[`Example${n}_Pinyin`]), ko:fallbackText(raw[`Example${n}_KO`]), en:fallbackText(raw[`Example${n}_EN`])});
    });
    if (type === 'grammar' && Array.isArray(raw.grammarExamples)) {
      raw.grammarExamples.forEach((zh, index) => result.push({zh:fallbackText(zh), pinyin:fallbackText(raw.grammarExamplePinyin?.[index]), ko:fallbackText(raw.grammarExampleTranslationsKO?.[index]), en:fallbackText(raw.grammarExampleTranslationsEN?.[index])}));
    }
    return result.filter((example) => example.zh || example.ko || example.en);
  }
  function fallbackNormalize(record, type, index, source) {
    const raw = fallbackObject(record) ? record : {value:record};
    /* 9.4.4: mergeKey 에 들어가는 필드 후보는 공통 코어(CEMS_FIELD_KEYS)를 쓴다.
       예전에는 폴백만 'Word' 가 더 있어 {Word, front} 를 함께 가진 행에서 Worker 와
       다른 표제어가 뽑혔다(대소문자 무시 조회가 뒤따르므로 결과 누락은 없다). */
    const front = fallbackText(type === 'word'
      ? fallbackFirst(raw, CEMS_FIELD_KEYS.wordFront)
      : type === 'example'
        ? fallbackFirst(raw, CEMS_FIELD_KEYS.exampleFront)
        : fallbackFirst(raw, CEMS_FIELD_KEYS.otherFront));
    const pinyin = fallbackText(fallbackFirst(raw, CEMS_FIELD_KEYS.pinyin));
    const meaning = fallbackText(fallbackFirst(raw, CEMS_FIELD_KEYS.meaningKo));
    const meaningEn = fallbackText(fallbackFirst(raw, ['Meaning_EN','meaningEn','translationEn','english','en']));
    const grammarPoint = fallbackText(fallbackFirst(raw, CEMS_FIELD_KEYS.grammarPoint));
    const pos = fallbackText(fallbackFirst(raw, CEMS_FIELD_KEYS.pos));
    const structure = fallbackText(fallbackFirst(raw, CEMS_FIELD_KEYS.structure));
    const safeFront = front || grammarPoint || `(내용 ${index + 1})`;
    /* 9.4.4: mergeKey·id 는 공통 코어로 계산한다. 예전 폴백은 언제나 2요소
       `safeFront|pinyin` 이고 위첨자 정규화가 없어서, 같은 파일을 Worker 로 넣었을
       때와 mergeKey 가 갈려 동일 항목이 2개로 분리됐다. */
    const mergeKey = cemsImportMergeKey(type, {front, pinyin, pos, structure, grammarPoint}, raw);
    const id = cemsImportItemId(source.id, type, fallbackFirst(raw, CEMS_FIELD_KEYS.originalId), mergeKey, index);
    const examples = fallbackExample(raw, type);
    return {
      id, sourceId:source.id, sourceTitle:source.title, sourceQuality:source.quality,
      qualityRank:source.qualityRank, type, mergeKey, front:safeFront,
      simplified:fallbackText(fallbackFirst(raw, ['Simplified_CH','Simplified','textSimplified','simplified','simp'])),
      pinyin, meaning:meaning || examples[0]?.ko || fallbackText(raw.Function) || meaningEn,
      meaningEn, pos,
      function:fallbackText(fallbackFirst(raw, ['Function','function','usage','explanation','description'])),
      structure, grammarPoint,
      examples, relations:{
        synonyms:fallbackList(fallbackFirst(raw, ['Synonym_CHT','Synonyms','synonyms'])),
        antonyms:fallbackList(fallbackFirst(raw, ['Antonym_CHT','Antonyms','antonyms'])),
        collocations:fallbackList(fallbackFirst(raw, ['Collocation_CHT','Key_Collocation','Collocation','collocations'])),
        variants:fallbackList(fallbackFirst(raw, ['Variants_CHT','Variants','variants'])),
        measures:fallbackList(fallbackFirst(raw, ['Measure_CHT','Classifier','Measure','classifiers'])),
        similar:fallbackList(fallbackFirst(raw, ['Similar_Expr','Alternatives','Formal_Equivalent','similar']))
      },
      levels:{hsk:fallbackText(raw.HSK || raw.HSK_Level), tocfl:fallbackText(raw.TOCFL || raw.TOCFL_Level), tbcl:fallbackText(raw.TBCL_Level || raw.TBCL), cefr:fallbackText(raw.CEFR), register:fallbackText(raw.Register || raw.Formality), frequency:fallbackText(raw.Frequency), priority:fallbackText(raw.Priority)},
      notes:{styleTags:fallbackText(raw.Style_Tags), commonError:fallbackText(raw.Common_Error), note:fallbackText(raw['비고'] || raw.Notes || raw.Note)},
      tags:Array.from(new Set(fallbackList(raw.tags).concat(fallbackList(raw.Style_Tags)))),
      book:fallbackText(raw.book || raw.textbook || raw.course || ''), lesson:fallbackText(raw.lesson || raw.unit || raw.chapter || ''),
      lessons:fallbackList(raw.lessons || raw.sourceLessons), acceptedAnswers:Array.from(new Set([safeFront, fallbackText(raw.Simplified_CH), ...fallbackList(raw.acceptedAnswers)].filter(Boolean))),
      sourceRefs:Array.isArray(raw.sourceRefs) ? raw.sourceRefs : [], sourceTypes:fallbackList(raw.sourceTypes), audioRefs:fallbackList(raw.audioRefs),
      importedAt:Date.now(), raw
    };
  }
  async function importJsonWithoutWorker(file, cause) {
    let root;
    try { root = JSON.parse(await file.text()); }
    catch (error) { toast(`JSON 문법 오류: ${error.message}`); throw error; }
    const schemaText = fallbackText(root?.schemaVersion || root?.schema || root?.format || root?.meta?.schema || root?.metadata?.schema);
    if (/cems-routine-1/i.test(schemaText) || (Array.isArray(root?.stages) && /routine/i.test(schemaText + file.name))) {
      await saveRoutine(root, file.name);
      toast('1시간 루틴을 등록했습니다.');
      updateImportSummary(true);
      return {routine:true};
    }
    const collections = fallbackCollections(root);
    if (!collections.length) throw new Error('가져올 수 있는 단어·표현·문법·예문 배열을 찾지 못했습니다.');
    const counts = {word:0, expression:0, grammar:0, example:0};
    collections.forEach((collection) => { counts[collection.type] += collection.records.length; });
    const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
    /* 9.4.4: 자료 메타와 sourceId 는 공통 코어로 만든다. 예전에는 폴백이
       [파일명,크기,스키마,항목수] 로 해시해서 Worker 경로와 다른 sourceId 를 냈고,
       같은 파일이 두 자료로 쌓였다. */
    const metaBasics = cemsImportMetaBasics(root, file.name);
    const sourceId = cemsImportSourceId({fileName:file.name, fileSize:file.size, schema:metaBasics.schema, buildId:metaBasics.buildId, generatedAt:metaBasics.generatedAt, title:metaBasics.title});
    const source = {id:sourceId, title:metaBasics.title, description:metaBasics.description, schema:metaBasics.schema, buildId:metaBasics.buildId, generatedAt:metaBasics.generatedAt, quality:'일반 외부 자료', qualityRank:1, fileName:file.name, fileSize:file.size, counts, importedAt:Date.now(), importerVersion:'9.4.4-final2', status:'pending'};
    const modal = openModal({
      title:'JSON 자료 분석', subtitle:'Worker를 사용할 수 없어 호환 가져오기로 처리합니다.',
      body:`<div class="c943-file-meta"><strong>${escapeHtml(file.name)}</strong><small>${formatBytes(file.size)} · ${formatNumber(total)}개 항목</small></div><div class="c943-import-preview"><div><strong>${formatNumber(counts.word)}</strong><span>단어</span></div><div><strong>${formatNumber(counts.expression)}</strong><span>표현</span></div><div><strong>${formatNumber(counts.grammar)}</strong><span>문법</span></div><div><strong>${formatNumber(counts.example)}</strong><span>예문</span></div></div>${cause ? '<div class="c943-progress-copy" style="margin-top:8px">호환 모드로 안전하게 가져옵니다.</div>' : ''}`,
      footer:'<button type="button" class="c943-btn" data-fallback-cancel>취소</button><button type="button" class="c943-btn c943-btn-primary" data-fallback-confirm>외부 라이브러리로 등록</button>'
    });
    $('[data-fallback-cancel]', modal.backdrop)?.addEventListener('click', modal.close);
    $('[data-fallback-confirm]', modal.backdrop)?.addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true; button.textContent = '등록 중…';
      try {
        const duplicates = (await getSources().catch(() => [])).filter((item) => item.fileName === file.name && Number(item.fileSize) === Number(file.size));
        for (const duplicate of duplicates) await deleteSource(duplicate.id);
        await saveSource({...source, status:'importing'});
        let processed = 0;
        let lastYield = 0;
        for (const collection of collections) {
          for (let start = 0; start < collection.records.length; start += 120) {
            const batch = collection.records.slice(start, start + 120).map((record, offset) => fallbackNormalize(record, collection.type, start + offset, source));
            await saveBatch(batch); processed += batch.length;
            /* 9.4.4: 예전 `processed % 480 === 0` 은 컬렉션 경계에서 배치가
               120 미만이 되면 480 의 배수를 영원히 비껴가 UI 를 한 번도
               양보하지 않았다. 누적 차이로 판단한다. */
            if (processed - lastYield >= 480) {
              lastYield = processed;
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
          }
        }
        await saveSource({...source, status:'ready', importedCount:processed, completedAt:Date.now()});
        modal.close(); toast(`JSON 외부 자료 ${formatNumber(processed)}개를 등록했습니다.`); updateImportSummary(true);
        window.dispatchEvent(new CustomEvent('cems:external-library-updated', {detail:{sourceId, items:processed}}));
      } catch (error) {
        console.error('[CEMS JSON fallback import]', error); button.disabled = false; button.textContent = '다시 등록'; toast(`JSON 등록 오류: ${error.message}`);
      }
    });
    return {fallback:true, sourceId, total};
  }


  /* 9.4.4: 항상 프로미스를 돌려준다.
     예전에는 Worker 경로가 undefined 를 반환해 호출부(cems-v9.4.4-final.js)의
     .catch(...) 가 Worker 실패를 절대 잡지 못했다. */
  function handleJsonFile(file) {
    if (!file || !/\.json$/i.test(file.name)) {
      toast('JSON 파일을 선택해 주세요.');
      return Promise.reject(new Error('JSON 파일이 아닙니다.'));
    }
    let worker;
    try { worker = new Worker(WORKER_URL); }
    catch (error) { console.warn('[CEMS943 worker fallback]', error); return importJsonWithoutWorker(file, error); }
    let analysis = null;
    let sourceRecord = null;
    let duplicateSources = [];
    let duplicateScan = null;   // 중복 조회 결과 프로미스 (타임아웃 없음)
    let importing = false;
    let closed = false;
    let settled = false;
    let resolveDone = () => {};
    let rejectDone = () => {};
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    const finish = (value) => { if (settled) return; settled = true; resolveDone(value); };
    const failWith = (error) => { if (settled) return; settled = true; rejectDone(error); };
    const modal = openModal({
      title: 'JSON 자료 분석',
      subtitle: '원본 행과 모든 선언 필드를 보존한 채 별도 라이브러리에 등록합니다.',
      body: `<div class="c943-file-meta"><strong>${escapeHtml(file.name)}</strong><small>${formatBytes(file.size)} · 구조를 분석하는 중…</small><div class="c943-progress"><span style="width:10%"></span></div><div class="c943-progress-copy">단어·표현·문법·예문 배열과 메타데이터를 찾고 있습니다.</div></div><div data-import-preview></div>`,
      footer: '<button type="button" class="c943-btn" data-import-cancel>취소</button><button type="button" class="c943-btn c943-btn-primary" data-import-confirm disabled>외부 라이브러리로 등록</button>',
      onClose: () => {
        closed = true;
        try { worker.postMessage({action:'cancel'}); } catch (_) {}
        try { worker.terminate(); } catch (_) {}
        finish({cancelled: true});
      }
    });
    const progress = $('.c943-progress > span', modal.backdrop);
    const progressCopy = $('.c943-progress-copy', modal.backdrop);
    const preview = $('[data-import-preview]', modal.backdrop);
    const confirmButton = $('[data-import-confirm]', modal.backdrop);
    $('[data-import-cancel]', modal.backdrop).addEventListener('click', modal.close);
    confirmButton.addEventListener('click', () => {
      if (!analysis || importing) return;
      importing = true;
      confirmButton.disabled = true;
      progress.style.width = '2%';
      progressCopy.textContent = '등록을 시작합니다…';
      worker.postMessage({action:'import'});
    });
    worker.onmessage = async (event) => {
      if (closed) return;
      const message = event.data || {};
      try {
        if (message.action === 'analyzed') {
          analysis = message;
          const counts = message.counts || {};
          const meta = message.meta || {};
          progress.style.width = '18%';
          progressCopy.textContent = `${meta.quality || '외부 자료'} · ${formatNumber(message.total)}개 항목을 찾았습니다.`;
          preview.innerHTML = `
            <div class="c943-import-preview">
              <div><strong>${formatNumber(counts.word)}</strong><span>단어</span></div><div><strong>${formatNumber(counts.expression)}</strong><span>표현</span></div><div><strong>${formatNumber(counts.grammar)}</strong><span>문법</span></div><div><strong>${formatNumber(counts.example)}</strong><span>예문</span></div>
            </div>
            <div class="c943-file-meta" style="margin-top:10px"><strong>${escapeHtml(meta.title || file.name)}</strong><small>${escapeHtml(meta.schema || '일반 JSON')} · ${escapeHtml(meta.quality || '')}${meta.buildId ? ` · 빌드 ${escapeHtml(meta.buildId)}` : ''}</small><small style="margin-top:6px">원본 raw, 예문 배열, 급수, 관계어, 출처 참조와 교재 태그를 함께 저장합니다.</small></div>`;
          /* 9.4.4: 1500ms 타임아웃을 없앴다. 예전에는 IndexedDB 가 느리면 중복이
             빈 배열로 "판정"돼 같은 파일 소스가 계속 누적됐다. 이제 실제 조회
             결과를 기다리고, 조회에 실패하면 "판정 불가"로 표시한 뒤 등록 직전에
             한 번 더 확인한다. */
          duplicateScan = getSources().then(
            (rows) => ({ok: true, rows: Array.isArray(rows) ? rows : []}),
            (error) => ({ok: false, rows: [], error})
          );
          const scan = await duplicateScan;
          duplicateSources = scan.rows.filter((source) => source.fileName === file.name && Number(source.fileSize) === Number(file.size));
          confirmButton.disabled = false;
          if (!scan.ok) {
            preview.insertAdjacentHTML('beforeend', '<div class="c943-progress-copy" style="margin-top:8px;color:#f1cb82">기존 자료 목록을 확인하지 못했습니다. 같은 파일을 이미 등록했다면 중복으로 쌓일 수 있으니, 등록 후 라이브러리에서 확인해 주세요.</div>');
          } else if (duplicateSources.length) {
            preview.insertAdjacentHTML('beforeend', `<div class="c943-progress-copy" style="margin-top:8px;color:#f1cb82">기존 동일 파일 ${duplicateSources.length}개는 9.4.4 형식으로 교체됩니다.</div>`);
          }
        } else if (message.action === 'source') {
          sourceRecord = message.source;
          /* 분석 시점에 중복 조회가 실패했으면 등록 직전에 한 번 더 시도한다. */
          const scan = duplicateScan ? await duplicateScan : {ok: true, rows: []};
          if (!scan.ok) {
            const retry = await getSources().catch(() => null);
            if (Array.isArray(retry)) {
              duplicateSources = retry.filter((source) => source.fileName === file.name && Number(source.fileSize) === Number(file.size));
            }
          }
          for (const duplicate of duplicateSources) await deleteSource(duplicate.id);
          await saveSource({...sourceRecord, status:'importing'});
        } else if (message.action === 'batch') {
          /* 9.4.4: ack 데드락 방지. saveBatch 가 throw 하면 예전에는 ack 에
             도달하지 못해 Worker 가 영구 정지했다. 실패해도 반드시 응답을 보내되
             ok:false 로 알려 Worker 가 스스로 중단하게 한다. */
          let saveError = null;
          try {
            await saveBatch(message.items || []);
          } catch (error) {
            saveError = error;
          } finally {
            try {
              worker.postMessage({action:'ack', batchId:message.batchId, ok: !saveError, reason: saveError ? String(saveError.message || saveError) : ''});
            } catch (_) {}
          }
          if (saveError) throw saveError;
        } else if (message.action === 'progress') {
          const ratio = message.total ? message.processed / message.total : 0;
          progress.style.width = `${Math.max(2, Math.min(98, ratio * 100))}%`;
          progressCopy.textContent = `${formatNumber(message.processed)} / ${formatNumber(message.total)}개 저장 중`;
        } else if (message.action === 'routine') {
          await saveRoutine(message.routine, message.fileName);
          progress.style.width = '100%';
          progressCopy.textContent = '루틴 등록이 완료되었습니다.';
          worker.terminate();
          finish({routine: true});
          setTimeout(() => { modal.close(); toast('1시간 루틴을 등록했습니다.'); updateImportSummary(true); }, 350);
        } else if (message.action === 'complete') {
          if (sourceRecord) await saveSource({...sourceRecord, status:'ready', importedCount:message.processed, completedAt:Date.now()});
          progress.style.width = '100%';
          progressCopy.textContent = `${formatNumber(message.processed)}개 항목 등록 완료`;
          worker.terminate();
          finish({sourceId: message.sourceId || sourceRecord?.id, items: message.processed});
          setTimeout(() => { modal.close(); toast('JSON 외부 자료를 등록했습니다.'); updateImportSummary(true); }, 450);
        } else if (message.action === 'cancelled') {
          progressCopy.textContent = message.reason ? `중단: ${message.reason}` : '가져오기를 중단했습니다.';
          confirmButton.disabled = false;
          finish({cancelled: true, processed: message.processed, reason: message.reason || ''});
        } else if (message.action === 'error') {
          throw new Error(message.message || 'JSON 가져오기 오류');
        }
      } catch (error) {
        console.error('[CEMS943 import]', error);
        progressCopy.textContent = `오류: ${error.message}`;
        progress.style.width = '100%';
        progress.style.background = 'var(--danger)';
        confirmButton.disabled = false;
        failWith(error);
      }
    };
    worker.onerror = (event) => {
      console.error('[CEMS943 worker]', event.error || event.message);
      if (!analysis && !importing) {
        try { worker.terminate(); } catch (_) {}
        try { modal.close(); } catch (_) {}
        importJsonWithoutWorker(file, event.error || new Error(event.message || 'Worker 오류')).then(finish, (error) => {
          console.error('[CEMS943 fallback]', error);
          toast(`JSON 파일을 열지 못했습니다: ${error.message}`);
          failWith(error);
        });
        return;
      }
      progressCopy.textContent = `Worker 오류: ${event.message || '알 수 없는 오류'}`;
      confirmButton.disabled = true;
      failWith(event.error || new Error(event.message || 'Worker 오류'));
    };
    worker.postMessage({action:'analyze', file});
    return done;
  }

  function typeLabel(type) {
    return type === 'expression' ? '표현' : type === 'grammar' ? '문법' : type === 'example' ? '예문' : '단어';
  }

  function itemSearchText(item) {
    if (item.searchText) return item.searchText;
    return [item.front,item.simplified,item.pinyin,item.meaning,item.meaningEn,item.pos,item.function,item.structure,item.grammarPoint,item.book,item.lesson,
      ...Object.values(item.levels || {}), ...(item.tags || []), ...(item.relations?.synonyms || []), ...(item.relations?.collocations || []),
      ...(item.examples || []).flatMap((example) => [example.zh,example.pinyin,example.ko,example.en])].join(' ').toLowerCase();
  }

  async function openLibrary({textbookOnly = false} = {}) {
    const sources = await getSources().catch(() => []);
    if (!sources.length) {
      toast('데이터 탭에서 JSON 자료를 먼저 등록해 주세요.');
      if (typeof window.showPage === 'function') window.showPage('data', true);
      return;
    }
    const sourceMap = new Map(sources.map((source) => [source.id, source]));
    const modal = openModal({
      title: textbookOnly ? '교과서 학습' : '외부 자료 라이브러리',
      subtitle: textbookOnly ? 'ACC 교재·과별 단어, 표현, 문법과 예문을 학습합니다.' : '자료별 원본은 보존하고, 통합 보기에서 정보가 많은 필드를 함께 사용합니다.',
      wide: true,
      body: `
        <div class="c943-library-toolbar">
          <select data-lib-source aria-label="자료 선택"><option value="__all__">모든 자료 통합</option>${sources.map((source) => `<option value="${escapeHtml(source.id)}">${escapeHtml(source.title || source.fileName)}</option>`).join('')}</select>
          <select data-lib-type aria-label="유형"><option value="word">단어</option><option value="expression">표현</option><option value="grammar">문법</option><option value="example">예문</option></select>
          <select data-lib-book aria-label="교재"><option value="">전체 교재</option></select>
          <select data-lib-lesson aria-label="과"><option value="">전체 과</option></select>
          <input type="search" data-lib-search placeholder="한자·병음·뜻·예문·태그 검색" aria-label="검색">
          <select data-lib-limit aria-label="표시 수"><option value="50">50개</option><option value="100">100개</option><option value="200">200개</option></select>
        </div>
        <div class="c943-progress-copy" data-lib-status>자료를 불러오는 중…</div>
        <div class="c943-library-results" data-lib-results><div class="c943-empty">자료를 불러오는 중…</div></div>`,
      footer: '<button type="button" class="c943-btn c943-btn-danger" data-lib-delete>현재 자료 삭제</button><button type="button" class="c943-btn" data-lib-close>닫기</button><button type="button" class="c943-btn c943-btn-primary" data-lib-start>선택 카드 학습</button>'
    });
    const sourceSelect = $('[data-lib-source]', modal.backdrop);
    const typeSelect = $('[data-lib-type]', modal.backdrop);
    const bookSelect = $('[data-lib-book]', modal.backdrop);
    const lessonSelect = $('[data-lib-lesson]', modal.backdrop);
    const searchInput = $('[data-lib-search]', modal.backdrop);
    const limitSelect = $('[data-lib-limit]', modal.backdrop);
    const results = $('[data-lib-results]', modal.backdrop);
    const status = $('[data-lib-status]', modal.backdrop);
    let mergedItems = [];
    let filteredItems = [];
    let loadToken = 0;
    typeSelect.value = activeKind() === 'expr' ? 'expression' : activeKind() === 'grammar' ? 'grammar' : 'word';

    const render = () => {
      const query = cleanText(searchInput.value).toLowerCase();
      const book = bookSelect.value;
      const lesson = lessonSelect.value;
      const limit = Number(limitSelect.value || 50);
      filteredItems = mergedItems.filter((item) => {
        if (textbookOnly && !item.book && !(item.tags || []).some((tag) => /^ACC/i.test(tag))) return false;
        if (book && item.book !== book) return false;
        if (lesson && item.lesson !== lesson && !(item.lessons || []).includes(lesson)) return false;
        if (query && !itemSearchText(item).includes(query)) return false;
        return true;
      });
      const visible = filteredItems.slice(0, limit);
      status.textContent = `통합 항목 ${formatNumber(filteredItems.length)}개 · 원본 출처 ${sourceSelect.value === '__all__' ? sources.length : 1}개`;
      results.innerHTML = visible.length ? visible.map((item, index) => `
        <label class="c943-library-row">
          <span><span class="zh">${escapeHtml(item.front)}</span><span class="meta">${escapeHtml([item.pinyin,item.meaning,item.book,item.lesson].filter(Boolean).join(' · '))}${item.sources?.length > 1 ? ` · ${item.sources.length}개 자료 통합` : ''}</span></span>
          <input type="checkbox" data-lib-item="${escapeHtml(item.mergeKey || item.id)}" ${index < Math.min(20, visible.length) ? 'checked' : ''}>
        </label>`).join('') : '<div class="c943-empty">현재 조건에 맞는 항목이 없습니다.</div>';
    };

    const updateLessons = () => {
      const book = bookSelect.value;
      const lessons = uniq(mergedItems.filter((item) => !book || item.book === book).flatMap((item) => [item.lesson, ...(item.lessons || [])].filter(Boolean))).sort((a,b) => a.localeCompare(b,'ko',{numeric:true}));
      const selected = lessonSelect.value;
      lessonSelect.innerHTML = '<option value="">전체 과</option>' + lessons.map((lesson) => `<option value="${escapeHtml(lesson)}">${escapeHtml(lesson)}</option>`).join('');
      if (lessons.includes(selected)) lessonSelect.value = selected;
      render();
    };

    const updateBooks = () => {
      const books = uniq(mergedItems.map((item) => item.book).filter(Boolean)).sort((a,b) => a.localeCompare(b,'ko',{numeric:true}));
      const selected = bookSelect.value;
      bookSelect.innerHTML = '<option value="">전체 교재</option>' + books.map((book) => `<option value="${escapeHtml(book)}">${escapeHtml(book)}</option>`).join('');
      if (books.includes(selected)) bookSelect.value = selected;
      if (textbookOnly && books.length && !bookSelect.value) bookSelect.value = books[0];
      updateLessons();
    };

    const load = async () => {
      const token = ++loadToken;
      results.innerHTML = '<div class="c943-empty">필요한 유형만 불러오는 중…</div>';
      status.textContent = 'IndexedDB에서 자료를 읽고 있습니다.';
      const rawItems = await getItemsForQuery({sourceId:sourceSelect.value, type:typeSelect.value});
      if (token !== loadToken) return;
      mergedItems = mergeExternalItems(rawItems, sourceMap);
      updateBooks();
    };

    sourceSelect.addEventListener('change', load);
    typeSelect.addEventListener('change', load);
    bookSelect.addEventListener('change', updateLessons);
    lessonSelect.addEventListener('change', render);
    searchInput.addEventListener('input', render);
    limitSelect.addEventListener('change', render);
    $('[data-lib-close]', modal.backdrop).addEventListener('click', modal.close);
    $('[data-lib-delete]', modal.backdrop).addEventListener('click', async () => {
      if (sourceSelect.value === '__all__') return toast('삭제할 개별 자료를 선택해 주세요.');
      const source = sourceMap.get(sourceSelect.value);
      if (!source || !confirm(`“${source.title || source.fileName}” 자료를 삭제할까요?\n가져온 자료와 해당 외부 학습 기록도 함께 삭제됩니다.`)) return;
      await deleteSource(source.id);
      modal.close();
      toast('외부 자료를 삭제했습니다.');
      updateImportSummary(true);
    });
    $('[data-lib-start]', modal.backdrop).addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const selected = new Set($$('input[data-lib-item]:checked', results).map((input) => input.dataset.libItem));
      let summaries = filteredItems.filter((item) => selected.has(item.mergeKey || item.id));
      if (!summaries.length) summaries = filteredItems.slice(0, 30);
      if (!summaries.length) return toast('학습할 항목이 없습니다.');
      button.disabled = true;
      const previousText = button.textContent;
      button.textContent = '전체 정보 불러오는 중…';
      status.textContent = `${formatNumber(summaries.length)}개 카드의 예문·관계어·출처 원문을 불러오고 있습니다.`;
      try {
        const ids = summaries.flatMap((item) => item.sourceItemIds?.length ? item.sourceItemIds : [item.id]);
        const fullRows = await getFullItemsByIds(ids);
        const deck = fullRows.length ? mergeExternalItems(fullRows, sourceMap) : summaries;
        if (!deck.length) return toast('학습할 전체 정보를 불러오지 못했습니다.');
        modal.close();
        openExternalDeck(deck);
      } catch (error) {
        console.error('[CEMS943 hydrate]', error);
        toast('카드의 전체 정보를 불러오지 못했습니다.');
        button.disabled = false;
        button.textContent = previousText;
      }
    });
    await load();
  }

  function speak(text, lang = 'zh-TW') {
    if (!('speechSynthesis' in window)) return toast('이 브라우저는 음성 합성을 지원하지 않습니다.');
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(cleanText(text));
    utterance.lang = lang;
    utterance.rate = 0.86;
    const voices = speechSynthesis.getVoices();
    utterance.voice = voices.find((voice) => /zh[-_]TW/i.test(voice.lang)) || voices.find((voice) => /^zh/i.test(voice.lang)) || null;
    speechSynthesis.speak(utterance);
  }

  function levelBadges(item) {
    const levels = item.levels || {};
    return uniq([
      levels.hsk && `HSK ${levels.hsk}`,
      levels.tocfl && `TOCFL ${levels.tocfl}`,
      levels.tbcl && `TBCL ${levels.tbcl}`,
      levels.cefr && `CEFR ${levels.cefr}`,
      levels.register, levels.medium, levels.frequency, levels.priority,
      item.book, item.lesson, typeLabel(item.type)
    ].filter(Boolean));
  }

  function detailBox(title, content, wide = false) {
    if (!cleanText(content)) return '';
    return `<section class="c943-detail-box${wide ? ' c943-wide' : ''}"><h4>${escapeHtml(title)}</h4><p>${escapeHtml(content)}</p></section>`;
  }

  function rawSourceDetails(item) {
    const rawSources = item.rawSources?.length
      ? item.rawSources
      : item.raw ? [{sourceId:item.sourceId, raw:item.raw}] : [];
    if (!rawSources.length) return '';
    const sourceNames = new Map((item.sources || []).map((source) => [source.id, source.title || source.id]));
    const bodies = rawSources.map((entry, index) => {
      const label = sourceNames.get(entry.sourceId) || entry.sourceId || `원본 ${index + 1}`;
      let json = '';
      try { json = JSON.stringify(entry.raw, null, 2); } catch (_) { json = String(entry.raw || ''); }
      return `<details class="c943-raw-source"><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(json)}</pre></details>`;
    }).join('');
    return `<details class="c943-raw-details c943-wide"><summary>원본 전체 필드 · ${rawSources.length}개 출처</summary><div>${bodies}</div></details>`;
  }

  function renderExternalCard(item) {
    const relations = item.relations || {};
    const examples = (item.examples || []).slice(0, 12);
    const sourceChips = (item.sources || [{title:item.sourceTitle,quality:item.sourceQuality}]).map((source) => `<span class="c943-source-chip">${escapeHtml(source.title || source.id)} · ${escapeHtml(source.quality || '')}</span>`).join('');
    return `
      <div class="c943-card-badges">${levelBadges(item).map((badge) => `<span class="c943-badge">${escapeHtml(badge)}</span>`).join('')}</div>
      <div class="c943-card-front"><h3>${escapeHtml(item.front)}</h3>${item.simplified && item.simplified !== item.front ? `<div class="simp">${escapeHtml(item.simplified)}</div>` : ''}${item.pinyin ? `<div class="py">${escapeHtml(item.pinyin)}</div>` : ''}</div>
      <div class="c943-card-hint">탭하여 전체 정보를 확인하세요</div>
      <div class="c943-card-details">
        <div class="c943-detail-primary"><strong>${escapeHtml(item.meaning || item.function || '뜻 정보 없음')}</strong>${item.meaningEn ? `<small>${escapeHtml(item.meaningEn)}</small>` : ''}</div>
        <div class="c943-detail-grid">
          ${detailBox('품사·기능', [item.pos,item.function].filter(Boolean).join(' · '))}
          ${detailBox('문형·구조', [item.grammarPoint,item.structure].filter(Boolean).join(' · '))}
          ${detailBox('급수·사용역', Object.entries(item.levels || {}).filter(([,v]) => cleanText(v)).map(([k,v]) => `${k.toUpperCase()}: ${v}`).join(' · '), true)}
          ${detailBox('연어', (relations.collocations || []).join(', '), true)}
          ${detailBox('유의어', (relations.synonyms || []).join(', '))}
          ${detailBox('반의어', (relations.antonyms || []).join(', '))}
          ${detailBox('이체·간체', uniq([...(relations.variants || []), item.simplified].filter(Boolean)).join(', '))}
          ${detailBox('양사', (relations.measures || []).join(', '))}
          ${detailBox('유사 표현', (relations.similar || []).join(', '), true)}
          ${(item.notes?.commonError || item.notes?.note) ? detailBox('주의·메모', [item.notes.commonError,item.notes.note].filter(Boolean).join(' · '), true) : ''}
          ${examples.length ? `<section class="c943-detail-box c943-wide"><h4>예문 ${examples.length}개</h4><div class="c943-examples">${examples.map((example, index) => `<div class="c943-example" data-example-index="${index}"><div class="zh">${escapeHtml(example.zh || example.simplified)}</div>${example.pinyin ? `<div class="py">${escapeHtml(example.pinyin)}</div>` : ''}${example.ko ? `<div class="ko">${escapeHtml(example.ko)}</div>` : ''}${example.en ? `<div class="ko">${escapeHtml(example.en)}</div>` : ''}</div>`).join('')}</div></section>` : ''}
          ${item.tags?.length ? detailBox('태그', item.tags.join(' · '), true) : ''}
          <section class="c943-detail-box c943-wide"><h4>출처</h4><div class="c943-source-list">${sourceChips}</div></section>
          ${rawSourceDetails(item)}
        </div>
      </div>`;
  }

  function ratingButtonsHtml(prefix = '') {
    return `<div class="rating-grid ${prefix}">
      <button type="button" class="rating-btn again" data-external-grade="0"><span class="c943-rating-main">${svgIcon('again','c943-rating-icon')}<span class="c943-rating-label">모름</span></span><span class="rating-interval">다시</span></button>
      <button type="button" class="rating-btn hard" data-external-grade="1"><span class="c943-rating-main">${svgIcon('hard','c943-rating-icon')}<span class="c943-rating-label">어려움</span></span><span class="rating-interval">1일</span></button>
      <button type="button" class="rating-btn good" data-external-grade="2"><span class="c943-rating-main">${svgIcon('good','c943-rating-icon')}<span class="c943-rating-label">보통</span></span><span class="rating-interval">3일</span></button>
      <button type="button" class="rating-btn easy" data-external-grade="3"><span class="c943-rating-main">${svgIcon('easy','c943-rating-icon')}<span class="c943-rating-label">쉬움</span></span><span class="rating-interval">7일+</span></button>
    </div>`;
  }

  function openExternalDeck(inputDeck) {
    const deck = inputDeck.slice();
    let index = 0;
    let reviewed = 0;
    const modal = openModal({
      title: '외부 자료 학습',
      subtitle: `${formatNumber(deck.length)}개 · 원본 전체 정보와 통합 출처를 사용합니다.`,
      wide: true,
      className: 'c943-deck-modal',
      body: `<div class="c943-deck-progress"><span data-deck-copy></span><span data-deck-reviewed></span></div><div class="c943-progress"><span data-deck-progress></span></div><article class="c943-external-card" data-external-card data-flipped="false"></article><div class="c943-external-actions"><button type="button" data-deck-prev aria-label="이전">←</button><button type="button" data-deck-speak aria-label="발음">${svgIcon('speaker','c943-scope-icon')}</button><button type="button" data-deck-flip>전체 정보 보기</button><button type="button" data-deck-next aria-label="다음">→</button></div><div class="c943-external-rating">${ratingButtonsHtml()}</div>`,
      footer: '<button type="button" class="c943-btn" data-deck-close>학습 종료</button>'
    });
    const card = $('[data-external-card]', modal.backdrop);
    const progress = $('[data-deck-progress]', modal.backdrop);
    const copy = $('[data-deck-copy]', modal.backdrop);
    const reviewedCopy = $('[data-deck-reviewed]', modal.backdrop);
    const flipButton = $('[data-deck-flip]', modal.backdrop);
    state.externalDeck = {deck,index,modal};

    const render = () => {
      const item = deck[index];
      card.dataset.flipped = 'false';
      card.innerHTML = renderExternalCard(item);
      progress.style.width = `${((index + 1) / Math.max(1, deck.length)) * 100}%`;
      copy.textContent = `${index + 1} / ${deck.length} · ${typeLabel(item.type)}`;
      reviewedCopy.textContent = `평가 ${reviewed}회`;
      flipButton.textContent = '전체 정보 보기';
    };
    const flip = () => {
      const next = card.dataset.flipped !== 'true';
      card.dataset.flipped = String(next);
      flipButton.textContent = next ? '앞면 보기' : '전체 정보 보기';
    };
    const next = () => { index = (index + 1) % deck.length; render(); };
    const prev = () => { index = (index - 1 + deck.length) % deck.length; render(); };
    const rate = async (grade) => {
      const item = deck[index];
      await saveExternalProgress(item, grade).catch((error) => console.warn('[CEMS943 progress]', error));
      reviewed += 1;
      if (grade === 0) {
        const [again] = deck.splice(index, 1);
        const insertAt = Math.min(index + 3, deck.length);
        deck.splice(insertAt, 0, again);
        if (index >= deck.length) index = 0;
      } else if (grade === 1 && deck.length > 2) {
        const [hard] = deck.splice(index, 1);
        deck.splice(Math.min(index + 2, deck.length), 0, hard);
        if (index >= deck.length) index = 0;
      } else {
        index = (index + 1) % deck.length;
      }
      render();
    };
    card.addEventListener('click', (event) => {
      const example = event.target.closest('[data-example-index]');
      if (example && card.dataset.flipped === 'true') {
        const item = deck[index];
        speak(item.examples?.[Number(example.dataset.exampleIndex)]?.zh || item.front);
      } else flip();
    });
    $('[data-deck-flip]', modal.backdrop).addEventListener('click', flip);
    $('[data-deck-next]', modal.backdrop).addEventListener('click', next);
    $('[data-deck-prev]', modal.backdrop).addEventListener('click', prev);
    $('[data-deck-speak]', modal.backdrop).addEventListener('click', () => speak(deck[index].front));
    $('[data-deck-close]', modal.backdrop).addEventListener('click', modal.close);
    $$('[data-external-grade]', modal.backdrop).forEach((button) => button.addEventListener('click', () => rate(Number(button.dataset.externalGrade))));
    modal.backdrop.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') next();
      else if (event.key === 'ArrowLeft') prev();
      else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); flip(); }
      else if (/^[1-4]$/.test(event.key)) rate(Number(event.key) - 1);
    });
    render();
  }

  /* ------------------------------ Routine -------------------------------- */

  async function loadBuiltInRoutine() {
    if (state.builtInRoutine) return state.builtInRoutine;
    const response = await fetch(ROUTINE_URL, {cache:'no-store'});
    if (!response.ok) throw new Error(`루틴 HTTP ${response.status}`);
    state.builtInRoutine = await response.json();
    return state.builtInRoutine;
  }

  function formatClock(seconds) {
    const value = Math.max(0, Number(seconds || 0));
    return `${String(Math.floor(value / 60)).padStart(2,'0')}:${String(value % 60).padStart(2,'0')}`;
  }

  async function openRoutine(rawRoutine = null) {
    let routine = rawRoutine;
    if (!routine) {
      const routines = await getRoutines().catch(() => []);
      routine = routines[0] || await loadBuiltInRoutine().catch(() => null);
    }
    if (!routine) return toast('사용 가능한 1시간 루틴이 없습니다.');
    const stages = Array.isArray(routine.stages) ? routine.stages : [];
    let stageIndex = 0;
    let itemIndex = 0;
    const totalSeconds = Number(routine.durationMinutes || stages.reduce((sum, stage) => sum + Number(stage.minutes || 0), 0) || 60) * 60;
    const savedKey = ROUTINE_KEY + (routine.id || 'default');
    try {
      const saved = JSON.parse(localStorage.getItem(savedKey) || '{}');
      stageIndex = Math.max(0, Math.min(stages.length - 1, Number(saved.stageIndex || 0)));
      itemIndex = Math.max(0, Number(saved.itemIndex || 0));
      state.routineSeconds = Math.max(0, Number(saved.seconds || 0));
    } catch (_) { state.routineSeconds = 0; }
    const modal = openModal({
      title: routine.title || '1시간 중국어 루틴',
      subtitle: routine.subtitle || `${Math.round(totalSeconds / 60)}분 단계 학습`,
      wide: true,
      body: `<div class="c943-deck-progress"><strong data-routine-clock>${formatClock(state.routineSeconds)}</strong><span data-routine-stage></span></div><div class="c943-progress"><span data-routine-progress></span></div><div class="c943-library-toolbar" style="grid-template-columns:repeat(${Math.max(1,Math.min(4,stages.length))},1fr);margin-top:10px" data-routine-tabs></div><article class="c943-external-card" data-routine-card></article><div class="c943-external-actions" style="grid-template-columns:44px minmax(0,1fr) 44px"><button type="button" data-routine-prev>←</button><button type="button" data-routine-speak>${svgIcon('speaker','c943-scope-icon')} 듣기</button><button type="button" data-routine-next>→</button></div>`,
      footer: '<button type="button" class="c943-btn" data-routine-timer>타이머 시작</button><button type="button" class="c943-btn c943-btn-primary" data-routine-done>단계 완료</button><button type="button" class="c943-btn" data-routine-close>닫기</button>'
    });
    const tabs = $('[data-routine-tabs]', modal.backdrop);
    const card = $('[data-routine-card]', modal.backdrop);
    const progress = $('[data-routine-progress]', modal.backdrop);
    const clock = $('[data-routine-clock]', modal.backdrop);
    const stageCopy = $('[data-routine-stage]', modal.backdrop);
    const timerButton = $('[data-routine-timer]', modal.backdrop);
    const save = () => {
      try { localStorage.setItem(savedKey, JSON.stringify({stageIndex,itemIndex,seconds:state.routineSeconds,updatedAt:Date.now()})); } catch (_) {}
    };
    const currentStage = () => stages[stageIndex] || {items:[]};
    const stageItems = () => Array.isArray(currentStage().items) ? currentStage().items : [];
    const itemText = (item) => cleanText(item.Traditional_CH || item.Expression || item.pattern || item.zh || item.text || item.question || item.prompt || item.title);
    const itemMeaning = (item) => cleanText(item.Meaning_KO || item.meaning || item.ko || item.translation || item.answer || item.Function || item.explanation);
    const itemPinyin = (item) => cleanText(item.Pinyin || item.pinyin);
    const render = () => {
      const stage = currentStage();
      const items = stageItems();
      if (itemIndex >= items.length) itemIndex = Math.max(0, items.length - 1);
      const item = items[itemIndex] || {};
      tabs.innerHTML = stages.map((candidate, index) => `<button type="button" class="c943-btn${index === stageIndex ? ' c943-btn-primary' : ''}" data-routine-tab="${index}">${escapeHtml(candidate.shortTitle || `${index + 1}단계`)}</button>`).join('');
      stageCopy.textContent = `${stageIndex + 1}/${stages.length} · ${stage.title || ''} · ${itemIndex + 1}/${Math.max(1,items.length)}`;
      progress.style.width = `${Math.min(100, (state.routineSeconds / totalSeconds) * 100)}%`;
      clock.textContent = formatClock(state.routineSeconds);
      const front = itemText(item) || stage.title || '학습 항목';
      const meaning = itemMeaning(item);
      card.dataset.flipped = 'false';
      card.innerHTML = `<div class="c943-card-badges"><span class="c943-badge">${escapeHtml(stage.shortTitle || `${stageIndex + 1}단계`)}</span><span class="c943-badge">${escapeHtml(String(stage.minutes || ''))}분</span></div><div class="c943-card-front"><h3 style="font-size:26px">${escapeHtml(front)}</h3>${itemPinyin(item) ? `<div class="py">${escapeHtml(itemPinyin(item))}</div>` : ''}</div><div class="c943-card-hint">탭하여 해석·답안 확인</div><div class="c943-card-details"><div class="c943-detail-primary"><strong>${escapeHtml(meaning || item.answerTraditional || item.modelAnswer || '직접 말하거나 써 보세요.')}</strong></div>${item.notes ? detailBox('연습 안내', cleanText(item.notes), true) : ''}</div>`;
      save();
    };
    const move = (delta) => {
      const items = stageItems();
      if (!items.length) return;
      itemIndex = (itemIndex + delta + items.length) % items.length;
      render();
    };
    tabs.addEventListener('click', (event) => {
      const button = event.target.closest('[data-routine-tab]');
      if (!button) return;
      stageIndex = Number(button.dataset.routineTab);
      itemIndex = 0;
      render();
    });
    card.addEventListener('click', () => { card.dataset.flipped = String(card.dataset.flipped !== 'true'); });
    $('[data-routine-prev]', modal.backdrop).addEventListener('click', () => move(-1));
    $('[data-routine-next]', modal.backdrop).addEventListener('click', () => move(1));
    $('[data-routine-speak]', modal.backdrop).addEventListener('click', () => speak(itemText(stageItems()[itemIndex] || {})));
    $('[data-routine-done]', modal.backdrop).addEventListener('click', () => {
      if (stageIndex < stages.length - 1) { stageIndex += 1; itemIndex = 0; render(); }
      else toast('오늘의 1시간 루틴을 완료했습니다.');
    });
    timerButton.addEventListener('click', () => {
      state.routineRunning = !state.routineRunning;
      timerButton.textContent = state.routineRunning ? '타이머 일시정지' : '타이머 계속';
      /* 9.4.4: 일시정지에 clearInterval 이 없어 라벨만 바뀌고 시간은 계속 흘렀다.
         이제 실제로 멈추고, 멈춘 시점의 경과 시간을 저장한다. */
      if (!state.routineRunning) {
        if (state.routineTimer) clearInterval(state.routineTimer);
        state.routineTimer = 0;
        save();
        return;
      }
      if (!state.routineTimer) {
        state.routineTimer = setInterval(() => {
          state.routineSeconds = Math.min(totalSeconds, state.routineSeconds + 1);
          clock.textContent = formatClock(state.routineSeconds);
          progress.style.width = `${Math.min(100, (state.routineSeconds / totalSeconds) * 100)}%`;
          if (state.routineSeconds % 15 === 0) save();
          if (state.routineSeconds >= totalSeconds) {
            clearInterval(state.routineTimer); state.routineTimer = 0; state.routineRunning = false; timerButton.textContent = '60분 완료'; toast('60분 루틴 시간이 완료되었습니다.');
          }
        }, 1000);
      }
    });
    $('[data-routine-close]', modal.backdrop).addEventListener('click', () => { save(); modal.close(); });
    render();
  }

  /* 9.4.4: 이 레이어 전용 타이머 대신 공용 UI 버스의 단일 디바운스를 쓴다.
     enhance 는 버스에 등록돼 있으므로 예약만 하면 정해진 순서로 1회 돈다. */
  function scheduleEnhance(delay = 80) {
    const bus = window.CEMS944UiBus;
    if (bus) { bus.schedule(delay); return; }
    clearTimeout(state.enhanceTimer);
    state.enhanceTimer = window.setTimeout(enhance, delay);
  }

  function enhance() {
    cleanupLegacy();
    updateVersionLabels();
    enhanceScopeTabs();
    enhanceBottomNav();
    ensureStudyQuickbar();
    enhanceModeCards();
    enhanceSectionHeadings();
    enhanceInlineLegacyIcons();
    enhanceQuickActionIcons();
    const homeUploadIcon = $('#db-card .empty-state-icon');
    if (homeUploadIcon && !homeUploadIcon.querySelector('.c943-icon-upload')) {
      homeUploadIcon.classList.add('c943-upload-illustration', 'c943-home-upload-illustration');
      homeUploadIcon.innerHTML = iconGlyph('upload');
    }
    enhanceNativeModals();
    enhanceStudyActionIcons();
    createStudyOptions('vocab');
    createStudyOptions('expr');
    if ($('#study-phrasal')) createStudyOptions('phrasal');
    moveSharedStudyControls();
    markProgressHeaders();
    enhanceRatings();
    enhanceStats();
    /* Avoid opening the external-library IndexedDB during ordinary startup. */
    if (activePageName() === 'data') {
      ensureJsonImportCard();
      enhanceDataTools();
    }
    installConfirmEnhancer();
    updateBottomNavActive();
  }

  /* 9.4.4: 모드 카드 클릭의 캡처단계 탈취를 제거했다.
     예전에는 여기서 preventDefault() + stopImmediatePropagation() 을 걸고 자체
     launchMode() 를 돌렸다. 그 결과
       - index.html 의 onclick="selectMode(this,'vocab')" 가 절대 실행되지 않고
       - index.html 의 버블 리스너가 죽어 "필터 결과 N개 · 현재 모드 가능 M개"
         카운터가 갱신되지 않았다.
     .active 토글과 카드덱 스코프 라우팅은 원래 경로가 이미 한다
     (selectMode → doSelectMode → start*StudyWithMode, deck-groups 가 이 셋을
      감싸 deck 스코프를 처리한다). 그래서 가로채기를 통째로 지우고 버블 단계에서
     화면 재작업만 예약한다. */
  /* 버스가 클릭 1회당 1패스를 예약하므로 여기서 따로 예약하지 않는다.
     (버스가 없는 환경에서만 쓰이는 폴백 경로) */
  function onDocumentClick(event) {
    if (event.target.closest?.('#page-study .mode-card, .type-tab, .nav-item, [onclick*="showPage"], [onclick*="switchGlobalType"]')) {
      scheduleEnhance(60);
    }
  }

  function isTypingTarget(target) {
    if (!target || target.nodeType !== 1) return false;
    if (target.isContentEditable) return true;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
  }

  function onDocumentKeydown(event) {
    /* Enter/Space 로 모드 카드를 여는 처리는 index.html 의 접근성 레이어가
       (role=button + keydown → el.click()) 이미 담당한다. 여기서 또 실행하면
       한 번의 키 입력으로 학습이 두 번 시작되므로 중복 처리를 두지 않는다. */
    if (/^[1-4]$/.test(event.key) && !state.activeModal) {
      /* 9.4.4: 입력 중일 때 숫자키를 삼키지 않는다(검색창에 1~4 를 못 치던 문제).
         defaultPrevented 검사는 index.html 의 동일 단축키와의 이중 실행을 막는다. */
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      const page = $('.page.active');
      const buttons = $$('.rating-grid .rating-btn:not(:disabled)', page).filter((button) => button.offsetParent !== null);
      const button = buttons[Number(event.key) - 1];
      if (button) { event.preventDefault(); button.click(); }
    }
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    cleanupLegacy();
    installConfirmEnhancer();
    /* 9.4.4: document 클릭 리스너를 직접 달지 않는다. 공용 UI 버스 하나만 듣고
       각 레이어는 훅으로 등록한다(캡처 단계 사용 금지). */
    const bus = window.CEMS944UiBus;
    if (bus) {
      bus.register('v944-core-enhance', enhance, 20);
    } else {
      document.addEventListener('click', onDocumentClick, false);
    }
    document.addEventListener('keydown', onDocumentKeydown);
    document.addEventListener('change', (event) => {
      if (event.target.matches('#study-count,#expr-study-count,#pv-study-count')) scheduleEnhance(30);
    });
    state.observer = new MutationObserver((records) => {
      /* Import/library modals are self-contained. Avoid a feedback loop where
         summary text changes schedule another full data-page enhancement. */
      if (state.activeModal) return;
      if (!records.some((record) => record.addedNodes.length || record.removedNodes.length)) return;
      /* 9.4.4: DOM 변경으로 깨어날 때는 이 레이어의 작업만 돌린다.
         전체 패스를 예약하면 다른 레이어의 DOM 쓰기가 다시 관찰자를 깨워
         클릭 없이도 재작업이 계속 도는 되먹임 고리가 생긴다. */
      if (bus) bus.schedule(100, ['v944-core-enhance']);
      else scheduleEnhance(100);
    });
    state.observer.observe(document.body, {childList:true, subtree:true});
    enhance();
    /* 후속 패스는 UI 버스가 400/1200ms 에 한 번씩만 돌린다(레이어별 타이머 제거). */
    if (!bus) [360, 1200].forEach((ms) => setTimeout(enhance, ms));
    window.CEMS943 = {
      VERSION,
      refresh: enhance,
      launchMode,
      openLibrary,
      openRoutine,
      openExternalDeck,
      importJson: handleJsonFile,
      importJsonFallback: importJsonWithoutWorker,
      mergeExternalItems,
      normalizeStoredItem,
      getSources,
      getRoutines,
      deleteSource,
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();


/* ========================================================================
   CEMS 9.4.4 stabilization layer
   - one owner for compact settings/statistics/card-count UI
   - independent grammar goal row (no container cloning)
   - IndexedDB seed integrity verification and non-destructive recovery
   ======================================================================== */
(() => {
  'use strict';

  const VERSION = '9.4.4';
  const RECOVERY_URL = "v944/cems-v9.4.4-recovery.json";
  const EXPECTED = Object.freeze({"words": 9447, "expressions": 697, "grammar": 992});
  /* 9.4.4(치명 결함 C3): 후보 목록에 실제 DB 이름이 없어서 시드 무결성 복구가
     한 번도 대상 DB 를 찾지 못했다. index.html 은 const DB_NAME='ChineseVocab_v1'
     (DB_VER=4)을 쓴다. 전역 const 는 window 프로퍼티가 아니지만 같은 스크립트
     스코프의 bare 참조로는 읽히므로 appDbName() 이 그것을 우선 사용한다. */
  const DB_CANDIDATES = Object.freeze(["ChineseVocab_v1", "CEMSChineseDB", "CEMS_DB", "ChineseLearningDB", "cems-chinese-db", "cemsExternalLibrary942", "chineseVocabularyDB"]);

  function appDbName() {
    try { if (typeof DB_NAME === 'string' && DB_NAME) return DB_NAME; }
    catch (_) { /* TDZ·미선언 — 후보 목록으로 폴백 */ }
    return null;
  }
  const COUNT_INPUT_IDS = Object.freeze(['study-count', 'expr-study-count', 'pv-study-count']);
  /* 한 세션에서 이미 정상 판정을 받았음을 기록해 매 로드마다 반복 스캔하지 않는다. */
  const VERIFIED_KEY = 'cems944-data-verified';
  const GRAMMAR_STORAGE_KEYS = Object.freeze([
    'grammarGoal', 'grammar_goal', 'settingGrammarGoal', 'setting-grammar-goal',
    'cems.grammarGoal', 'cems_grammar_goal', 'dailyGrammarGoal'
  ]);

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || min));

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  function transactionPromise(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  /* ------------------------------------------------------------------
     9.4.4: 텍스트로 패널을 찾는 비용을 최초 1회로 줄인다.
     예전에는 클릭마다 querySelectorAll('h1,…,span,p,div') (정적 노드만 1,511개)를
     돌며 노드마다 서브트리 텍스트를 직렬화해 비교했고, compactPanels 한 번에만
     8회 이상 반복됐다. 이제 찾은 노드에 data-c944-panel="<키>" 를 새기고
     이후에는 그 속성으로만 조회한다.
     ------------------------------------------------------------------ */
  const PANEL_EXACT_SELECTOR = 'h1,h2,h3,h4,h5,h6,label,legend,button,span,p,div';
  const PANEL_PARTIAL_SELECTOR = 'h1,h2,h3,h4,h5,h6,label,legend,button,span,p';

  function panelKey(mode, text) {
    return `${mode}:${cleanText(text)}`;
  }

  function markedPanelNode(key, root) {
    let node = null;
    try { node = (root || document).querySelector(`[data-c944-panel="${CSS.escape(key)}"]`); }
    catch (_) { node = null; }
    return node && node.isConnected ? node : null;
  }

  function findByText(mode, text, root = document) {
    const key = panelKey(mode, text);
    const cached = markedPanelNode(key, root);
    if (cached) return cached;
    const wanted = cleanText(text);
    if (!wanted) return null;
    const selector = mode === 'exact' ? PANEL_EXACT_SELECTOR : PANEL_PARTIAL_SELECTOR;
    for (const el of (root || document).querySelectorAll(selector)) {
      const value = cleanText(el.textContent);
      const hit = mode === 'exact' ? value === wanted : value.includes(wanted);
      if (!hit) continue;
      if (root === document || root === undefined) el.dataset.c944Panel = key;
      return el;
    }
    return null;
  }

  function elementWithText(text, root = document) {
    return findByText('exact', text, root);
  }

  function elementContainingText(text, root = document) {
    return findByText('partial', text, root);
  }

  function nearestPanel(el) {
    if (!el) return null;
    return el.closest('[data-panel], section, article, .panel, .card, .setting-card, .stats-card, .box, .accordion-item') || el.parentElement;
  }

  function locateSettingRow(input) {
    if (!input) return null;
    const direct = input.closest('[data-setting-row], .setting-row, .settings-row, .form-row, .form-group, .goal-row, li');
    if (direct) return direct;
    let node = input.parentElement;
    while (node && node !== document.body) {
      const inputCount = node.querySelectorAll('input,select').length;
      const text = cleanText(node.textContent);
      if (inputCount <= 2 && text.length < 100 && /목표|학습량/.test(text)) return node;
      node = node.parentElement;
    }
    return input.parentElement;
  }

  function getStoredGrammarGoal() {
    for (const key of GRAMMAR_STORAGE_KEYS) {
      const raw = localStorage.getItem(key);
      if (raw != null && Number.isFinite(Number(raw))) return clamp(raw, 1, 200);
    }
    return 10;
  }

  function storeGrammarGoal(value) {
    const normalized = String(clamp(value, 1, 200));
    for (const key of GRAMMAR_STORAGE_KEYS) localStorage.setItem(key, normalized);
    try {
      if (window.settings && typeof window.settings === 'object') window.settings.grammarGoal = Number(normalized);
      if (window.CEMSSettings && typeof window.CEMSSettings.set === 'function') {
        window.CEMSSettings.set('grammarGoal', Number(normalized));
      }
    } catch (error) {
      console.warn('[CEMS 9.4.4] grammar goal compatibility write failed', error);
    }
    return normalized;
  }

  function makeStepper(input, label) {
    let control = input.closest('.c944-stepper');
    if (control) return control;
    control = document.createElement('div');
    control.className = 'c944-stepper';
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'c944-stepper-button';
    minus.dataset.c944Delta = '-1';
    minus.setAttribute('aria-label', `${label} 감소`);
    minus.textContent = '−';
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'c944-stepper-button';
    plus.dataset.c944Delta = '1';
    plus.setAttribute('aria-label', `${label} 증가`);
    plus.textContent = '+';
    const parent = input.parentElement;
    parent.insertBefore(control, input);
    control.append(minus, input, plus);
    input.classList.add('c944-stepper-input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = input.min || '1';
    input.max = input.max || '200';
    input.step = input.step || '1';
    return control;
  }

  function removeNestedGrammarControls(exprRow) {
    if (!exprRow) return;
    const grammarInputs = $$('[id="setting-grammar-goal"], [data-setting="grammarGoal"]', exprRow);
    for (const input of grammarInputs) {
      const wrapper = locateSettingRow(input) || input.parentElement;
      if (wrapper && wrapper !== exprRow && wrapper.contains(input)) wrapper.remove();
      else input.remove();
    }
    const candidates = $$('label,span,p,div', exprRow).filter((el) => /문법\s*일일\s*목표/.test(cleanText(el.textContent)));
    for (const label of candidates) {
      const wrapper = label.closest('.setting-row,.form-row,.form-group,.goal-row') || label.parentElement;
      if (wrapper && wrapper !== exprRow && !wrapper.querySelector('#setting-expr-goal')) wrapper.remove();
    }
  }

  /* R2 레이어(IIFE3)가 학습 설정 카드를 재구성하는 환경인지. 재구성 대상 컨테이너
     (.cems-ux25-settings-body, learning/ux-polish.js 가 만든다)가 있으면 R2 가
     #setting-grammar-goal 의 유일한 소유자다. */
  function grammarGoalOwnedByR2() {
    return !!$('#page-settings .c944-r2-settings-body, #page-settings .cems-ux25-settings-body');
  }

  function ensureGoalRows() {
    if ($('#page-settings .c944-r2-learning-card .c944-r2-settings-body[data-c944-r2-built="1"]')) return;
    const vocab = $('#setting-vocab-goal');
    const expr = $('#setting-expr-goal');
    const defaultCount = $('#setting-count, #default-study-count, #setting-default-count');
    if (!expr && !vocab) return;

    const rows = [
      [vocab, '단어 일일 목표'],
      [expr, '표현 일일 목표'],
      [defaultCount, '기본 학습 분량']
    ];
    for (const [input, label] of rows) {
      if (!input) continue;
      const row = locateSettingRow(input);
      if (row) {
        row.classList.add('c944-setting-row', 'c944-goal-row');
        const labelEl = row.querySelector('label');
        if (labelEl) {
          labelEl.textContent = label;
          labelEl.setAttribute('for', input.id);
        }
      }
      makeStepper(input, label);
    }

    /* 9.4.4: #setting-grammar-goal 의 소유자를 하나로 고정했다.
       예전에는 이 레이어(IIFE2)와 R2 레이어(IIFE3 rebuildLearningSettings)가
       같은 id 를 각각 소유해서, 클릭마다 서로의 행을 제거하고 다시 만드는
       핑퐁이 일어났다. R2 가 학습 설정 카드를 통째로 다시 만들 수 있으면
       (= .cems-ux25-settings-body 가 있으면) 문법 목표 행은 R2 소유이고
       이 레이어는 손대지 않는다. R2 가 없는 환경에서만 폴백으로 만든다. */
    if (grammarGoalOwnedByR2()) {
      const panelWithR2 = nearestPanel(expr || vocab);
      if (panelWithR2) panelWithR2.classList.add('c944-compact-panel', 'c944-goals-panel');
      return;
    }

    const exprRow = locateSettingRow(expr);
    let input = document.getElementById('setting-grammar-goal');
    if (!input) {
      removeNestedGrammarControls(exprRow);
      const grammarRow = document.createElement('div');
      grammarRow.className = 'c944-setting-row c944-goal-row';
      grammarRow.dataset.settingRow = 'grammarGoal';
      const label = document.createElement('label');
      label.htmlFor = 'setting-grammar-goal';
      label.textContent = '문법 일일 목표';
      input = document.createElement('input');
      input.id = 'setting-grammar-goal';
      input.name = 'grammarGoal';
      input.type = 'number';
      input.min = '1';
      input.max = '200';
      input.step = '1';
      input.value = String(getStoredGrammarGoal());
      grammarRow.append(label, input);
      if (exprRow && exprRow.parentElement) exprRow.insertAdjacentElement('afterend', grammarRow);
      else {
        const anchor = expr || vocab;
        (nearestPanel(anchor) || anchor.parentElement).append(grammarRow);
      }
    }
    /* 이미 있는 행은 제거·재생성 없이 꾸미기만 한다(멱등). */
    makeStepper(input, '문법 일일 목표');
    if (input.dataset.c944GoalBound !== '1') {
      input.dataset.c944GoalBound = '1';
      input.addEventListener('input', () => storeGrammarGoal(input.value));
      input.addEventListener('change', () => {
        input.value = storeGrammarGoal(input.value);
        input.dispatchEvent(new CustomEvent('cems:grammar-goal-change', { bubbles: true, detail: { value: Number(input.value) } }));
      });
    }

    const panel = nearestPanel(expr || vocab);
    if (panel) panel.classList.add('c944-compact-panel', 'c944-goals-panel');
  }

  function findDuplicateCountContainer(label) {
    let node = label;
    while (node && node !== document.body) {
      const hasCompatInput = COUNT_INPUT_IDS.some((id) => node.querySelector && node.querySelector(`#${CSS.escape(id)}`));
      const hasRange = node.querySelector && node.querySelector('input[type="range"]');
      const text = cleanText(node.textContent);
      if ((hasCompatInput || hasRange) && text.includes('학습 카드 수')) return node;
      node = node.parentElement;
    }
    return null;
  }

  function hideCountPanel(panel) {
    if (!panel) return;
    panel.classList.add('c944-compat-count-panel');
    panel.dataset.c944CountPanel = '1';
    panel.hidden = true;
    panel.setAttribute('aria-hidden', 'true');
  }

  function hideDuplicateCountPanel() {
    /* 9.4.4: 여기도 클릭마다 문서 전체 텍스트를 훑던 자리다.
       이미 표시해 둔 패널이 살아 있으면 재스캔 없이 상태만 유지한다. */
    const marked = Array.from(document.querySelectorAll('[data-c944-count-panel="1"]'));
    if (marked.length) {
      marked.forEach(hideCountPanel);
    } else {
      Array.from(document.querySelectorAll('label,legend,h3,h4,div,span,p'))
        .filter((el) => cleanText(el.textContent) === '학습 카드 수')
        .forEach((label) => hideCountPanel(findDuplicateCountContainer(label)));
    }
    for (const id of COUNT_INPUT_IDS) {
      const input = document.getElementById(id);
      if (input) input.classList.add('c944-compat-count-input');
    }
  }

  function deckPanel() {
    const title = elementContainingText('카드덱 · 필터') || elementContainingText('카드덱');
    const panel = nearestPanel(title);
    if (panel) panel.classList.add('c944-compact-panel', 'c944-deck-panel');
    return panel;
  }

  function visibleDeckCount(panel = deckPanel()) {
    if (!panel) return null;
    const numberInput = Array.from(panel.querySelectorAll('input[type="number"]')).find((el) => !el.hidden && !COUNT_INPUT_IDS.includes(el.id));
    if (numberInput && Number.isFinite(Number(numberInput.value))) return clamp(numberInput.value, 1, 999);
    const explicit = panel.querySelector('[data-count-value], .count-value, .deck-count-value, output');
    if (explicit) {
      const match = cleanText(explicit.textContent || explicit.value).match(/\d+/);
      if (match) return clamp(match[0], 1, 999);
    }
    const candidates = Array.from(panel.querySelectorAll('span,strong,b,button,div'))
      .filter((el) => /^\d{1,3}$/.test(cleanText(el.textContent)) && !el.querySelector('*'));
    if (candidates.length) return clamp(cleanText(candidates[0].textContent), 1, 999);
    return null;
  }

  function syncCompatibilityCounts(value) {
    const normalized = clamp(value, 1, 999);
    for (const id of COUNT_INPUT_IDS) {
      const input = document.getElementById(id);
      if (!input) continue;
      if (String(input.value) !== String(normalized)) {
        input.value = String(normalized);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    try {
      localStorage.setItem('cems.sessionCount', String(normalized));
      localStorage.setItem('studyCount', String(normalized));
    } catch (_) {}
  }

  function syncCountFromDeck() {
    const value = visibleDeckCount();
    if (value != null) syncCompatibilityCounts(value);
  }

  function lowestCommonAncestor(elements) {
    if (!elements.length) return null;
    let node = elements[0];
    while (node && node !== document.body) {
      if (elements.every((el) => node.contains(el))) return node;
      node = node.parentElement;
    }
    return null;
  }

  function compactKpis(titleText, labels, panelClass) {
    const title = elementContainingText(titleText);
    const panel = nearestPanel(title);
    if (!panel) return;
    panel.classList.add('c944-compact-panel', panelClass);
    /* 9.4.4: KPI 카드는 한 번만 찾으면 된다. 라벨마다 패널 서브트리를 다시
       훑던 스캔을 표시(data-c944-kpi-done)로 대체한다. */
    if (panel.dataset.c944KpiDone === '1' && panel.querySelector('.c944-kpi')) return;
    const cards = [];
    for (const label of labels) {
      const labelEl = Array.from(panel.querySelectorAll('div,span,p,small')).find((el) => cleanText(el.textContent) === label);
      if (!labelEl) continue;
      let card = labelEl.closest('[data-kpi], .metric, .stat, .stat-card, .kpi, .summary-item');
      if (!card) {
        card = labelEl.parentElement;
        while (card && card.parentElement !== panel && card.querySelectorAll('div,span,p,small').length < 8) card = card.parentElement;
      }
      if (card && card !== panel) { card.classList.add('c944-kpi'); cards.push(card); }
    }
    const grid = lowestCommonAncestor(cards);
    if (grid && grid !== panel) grid.classList.add('c944-kpi-grid');
    if (cards.length) panel.dataset.c944KpiDone = '1';
  }

  function compactPanels() {
    compactKpis('핵심 지표', ['풀이 수', '정답률', '문항당 평균', '활동일', '복습 카드 평균 정답률', '복습 정확률', '숙달 카드'], 'c944-stats-panel');
    compactKpis('표현 현황', ['전체', '뜻·인지 숙달', '뜻·인지 취약', '복습'], 'c944-expression-status');

    for (const text of ['순서', '학습', '공통 세션 엔진', '공통 정답 처리', '새 단어 & 북마크', '추가 학습관리']) {
      const el = elementWithText(text) || elementContainingText(text);
      const panel = nearestPanel(el);
      if (panel) panel.classList.add('c944-compact-panel', `c944-${text.replace(/\s+/g, '-')}-panel`);
    }

    const aiTitle = elementContainingText('AI 프롬프트');
    if (aiTitle) {
      aiTitle.textContent = cleanText(aiTitle.textContent)
        .replace(/중국어\s*단어\s*DB용\s*AI\s*프롬프트.*$/, '중국어 DB 보완용 AI 프롬프트')
        .replace(/기존\s*형식/g, '');
      const panel = nearestPanel(aiTitle);
      if (panel) panel.classList.add('c944-compact-panel', 'c944-ai-panel');
    }
    /* 9.4.4: '지우기' 버튼도 한 번만 찾아 표시한다. */
    const clearButton = document.querySelector('button.c944-secondary-action[data-c944-panel="exact:지우기"]')
      || elementWithText('지우기');
    if (clearButton && clearButton.tagName === 'BUTTON') clearButton.classList.add('c944-secondary-action');
  }

  const ICONS = new Map([
    ['🔎', 'search'], ['🔍', 'search'], ['📝', 'edit'], ['📚', 'book'], ['📖', 'book'],
    ['⭐', 'star'], ['★', 'star'], ['🏷️', 'tag'], ['🏷', 'tag'], ['▶️', 'play'], ['▶', 'play'],
    ['📋', 'list'], ['ℹ️', 'info'], ['ℹ', 'info'], ['⚖️', 'balance'], ['⚖', 'balance'],
    ['➕', 'plus'], ['＋', 'plus']
  ]);

  function modernizeLeadingEmoji() {
    const selectors = 'button,h1,h2,h3,h4,h5,h6,label,legend,.section-title,.card-title';
    for (const el of document.querySelectorAll(selectors)) {
      if (el.dataset.c944Iconized === '1') continue;
      const textNode = Array.from(el.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && cleanText(node.nodeValue));
      if (!textNode) continue;
      const raw = textNode.nodeValue || '';
      const entry = Array.from(ICONS.entries()).find(([emoji]) => raw.trimStart().startsWith(emoji));
      if (!entry) continue;
      const [emoji, icon] = entry;
      const leading = raw.length - raw.trimStart().length;
      textNode.nodeValue = raw.slice(0, leading) + raw.trimStart().slice(emoji.length).replace(/^\s+/, '');
      const span = document.createElement('span');
      span.className = `c944-icon c944-icon-${icon}`;
      span.setAttribute('aria-hidden', 'true');
      el.insertBefore(span, textNode);
      el.dataset.c944Iconized = '1';
    }
  }

  function applyCompactUi() {
    ensureGoalRows();
    hideDuplicateCountPanel();
    deckPanel();
    compactPanels();
    modernizeLeadingEmoji();
    syncCountFromDeck();
    document.documentElement.dataset.cemsVersion = VERSION;
  }

  function keyFromRecord(record, keyPath, fallbackNames) {
    if (Array.isArray(keyPath)) return keyPath.map((part) => record && record[part]);
    if (typeof keyPath === 'string' && keyPath) return record && record[keyPath];
    for (const name of fallbackNames) {
      if (record && record[name] != null) return record[name];
      const actual = record && Object.keys(record).find((key) => key.toLowerCase() === name.toLowerCase());
      if (actual) return record[actual];
    }
    return undefined;
  }

  function serializeKey(key) {
    return typeof key === 'string' ? `s:${key}` : `j:${JSON.stringify(key)}`;
  }

  async function openDbByName(name) {
    return new Promise((resolve) => {
      let request;
      try { request = indexedDB.open(name); } catch (_) { resolve(null); return; }
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        const stores = Array.from(db.objectStoreNames);
        if (stores.includes('words') && stores.includes('expressions')) resolve(db);
        else { db.close(); resolve(null); }
      };
      request.onupgradeneeded = () => {
        // Opening an unknown name would create an empty database. Abort and delete it.
        try { request.transaction.abort(); } catch (_) {}
      };
    });
  }

  /* 9.4.4: 첫 로드에서는 무결성 점검(+700ms)이 앱보다 먼저 도는 경우가 있어
     ChineseVocab_v1 이 아직 만들어지지 않은 상태였고, 그러면 이 함수가 null 을
     돌려주고 점검이 조용히 끝나 상태 표시조차 뜨지 않았다.
     - 존재하는 DB 이름만 연다(없는 이름을 열면 빈 DB 가 생겼다 abort 되며,
       앱이 같은 이름을 만드는 중이면 경합이 된다).
     - 못 찾으면 짧게 몇 번 더 기다렸다 다시 본다(최대 ~3.6초). */
  async function openMatchingDb(attempts = 4) {
    const preferred = [appDbName(), ...DB_CANDIDATES].filter(Boolean);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let names = null;
      if (typeof indexedDB.databases === 'function') {
        try { names = (await indexedDB.databases() || []).map((info) => info && info.name).filter(Boolean); }
        catch (_) { names = null; }
      }
      const candidates = names
        ? preferred.filter((name) => names.includes(name)).concat(names.filter((name) => !preferred.includes(name)))
        : preferred;
      for (const name of candidates) {
        const db = await openDbByName(name);
        if (db) return db;
      }
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
    return null;
  }

  function isGrammarRecord(record) {
    const marker = cleanText(record && (record.contentKind || record.kind || record.type || record.category)).toLowerCase();
    return marker === 'grammar' || marker.includes('grammar') || marker.includes('문법');
  }

  async function countData(db) {
    const result = { words: 0, expressions: 0, grammar: 0, expressionStore: 0 };
    {
      const tx = db.transaction('words', 'readonly');
      result.words = await requestPromise(tx.objectStore('words').count());
      await transactionPromise(tx);
    }
    {
      const tx = db.transaction('expressions', 'readonly');
      const store = tx.objectStore('expressions');
      result.expressionStore = await requestPromise(store.count());
      await new Promise((resolve, reject) => {
        const cursor = store.openCursor();
        cursor.onerror = () => reject(cursor.error || new Error('Expression cursor failed'));
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) { resolve(); return; }
          if (isGrammarRecord(row.value)) result.grammar += 1;
          else result.expressions += 1;
          row.continue();
        };
      });
      await transactionPromise(tx);
    }
    return result;
  }

  function needsRepair(counts) {
    const wordBroken = counts.words === 0 || counts.words < Math.min(100, Math.floor(EXPECTED.words * 0.05));
    const expressionBroken = counts.expressions === 0;
    const grammarBroken = counts.grammar === 0;
    return { wordBroken, expressionBroken, grammarBroken, any: wordBroken || expressionBroken || grammarBroken };
  }

  async function existingRecordMap(db, storeName, fallbackNames) {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const values = await requestPromise(store.getAll());
    const keyPath = store.keyPath;
    await transactionPromise(tx);
    const map = new Map();
    for (const value of values) {
      const key = keyFromRecord(value, keyPath, fallbackNames);
      if (key !== undefined) map.set(serializeKey(key), value);
    }
    return { map, keyPath };
  }

  /* 학습 진행·사용자 입력 필드 — 시드보다 기존 값이 이겨야 하는 것들. */
  const PRESERVED_USER_FIELDS = Object.freeze([
    'stability', 'difficulty', 'nextReview', 'lastReview', 'lastStudied', 'firstStudied',
    'reviewCount', 'reps', 'wrongCount', 'correctCount', 'consecutiveWrong', 'consecutiveCorrect',
    'lapses', 'state', 'interval', 'easeFactor', 'elapsedDays', 'scheduledDays',
    'leitnerBox', 'box', 'level', 'mastered', 'isLeech', 'suspended',
    'starred', 'tags', 'userCollocations', 'memo', 'note', 'reviewLog', 'history',
    'addedAt', 'createdAt', 'updatedAt', 'userEdited'
  ]);

  /* 9.4.4: 병합 방향이 뒤집혀 있었다.
     예전 Object.assign({}, seed, existing) 는 기존 값이 시드를 전부 덮어써서
     주석과 달리 "내장 콘텐츠 갱신"이 한 번도 일어나지 않았다.
     이제 시드가 이기되(내장 콘텐츠 갱신), 학습 진행/북마크/사용자 입력 필드만
     기존 행에서 보존한다. */
  function mergeSeedRow(seed, existing) {
    if (!existing) return Object.assign({}, seed);
    const merged = Object.assign({}, existing, seed);
    const own = Object.prototype.hasOwnProperty;
    for (const field of PRESERVED_USER_FIELDS) {
      if (own.call(existing, field)) merged[field] = existing[field];
    }
    /* bookmark*, user*, custom* 처럼 접두사로만 알 수 있는 사용자 필드도 보존한다. */
    for (const key of Object.keys(existing)) {
      if (/^(bookmark|user|custom|my)/i.test(key)) merged[key] = existing[key];
    }
    return merged;
  }

  async function mergeSeedRecords(db, storeName, records, fallbackNames) {
    if (!records.length) return { queued: 0, failed: 0, samples: [] };
    const { map, keyPath } = await existingRecordMap(db, storeName, fallbackNames);
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    let queued = 0;
    let failed = 0;
    const samples = [];
    /* 9.4.4: put 실패를 warn 만 하고 삼켰다. keyPath 값이 없는 행(예: Expression
       누락)이 조용히 유실되므로 건수를 집계해 결과에 포함한다. */
    const noteFailure = (seed, error) => {
      failed += 1;
      if (samples.length < 5) {
        samples.push({
          store: storeName,
          key: String(keyFromRecord(seed, keyPath, fallbackNames) ?? ''),
          reason: String((error && error.message) || error || 'unknown')
        });
      }
    };
    for (const seed of records) {
      const key = keyFromRecord(seed, keyPath, fallbackNames);
      const existing = key !== undefined ? map.get(serializeKey(key)) : undefined;
      const merged = mergeSeedRow(seed, existing);
      try {
        const request = (keyPath == null && key !== undefined) ? store.put(merged, key) : store.put(merged);
        queued += 1;
        request.onerror = (event) => {
          /* 개별 실패로 트랜잭션 전체가 중단되지 않게 한다. */
          queued -= 1;
          noteFailure(seed, request.error);
          event.preventDefault();
          event.stopPropagation();
        };
      } catch (error) {
        noteFailure(seed, error);
      }
    }
    await transactionPromise(tx);
    if (failed) console.warn(`[CEMS 9.4.4] ${storeName} 시드 ${failed}건 저장 실패`, samples);
    return { queued, failed, samples };
  }

  async function loadRecoveryData() {
    const response = await fetch(RECOVERY_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Recovery data HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.words) || !Array.isArray(data.expressions) || !Array.isArray(data.grammar)) {
      throw new Error('Recovery data schema mismatch');
    }
    return data;
  }

  function emitIntegrity(detail) {
    window.CEMS944DataStatus = detail;
    document.dispatchEvent(new CustomEvent('CEMSDataIntegrity', { detail }));
    document.dispatchEvent(new CustomEvent('CEMSDataReady', { detail }));
  }

  function updateDataStatusUi(detail) {
    const anchor = elementContainingText('학습 데이터') || elementContainingText('데이터');
    const panel = nearestPanel(anchor);
    if (!panel || panel.querySelector('[data-c944-data-status]')) return;
    const row = document.createElement('div');
    row.className = 'c944-data-status';
    row.dataset.c944DataStatus = '1';
    const counts = detail.counts || {};
    const skipped = Number(detail.skipped || 0);
    const status = skipped > 0 ? `복구(누락 ${skipped}건)` : detail.repaired ? '복구 완료' : detail.error ? '확인 필요' : '정상';
    row.innerHTML = `<span>학습 데이터</span><strong>단어 ${counts.words ?? '—'} · 표현 ${counts.expressions ?? '—'} · 문법 ${counts.grammar ?? '—'}</strong><span class="c944-data-badge">${status}</span>`;
    panel.append(row);
  }

  /* count() 만 쓰는 저렴한 조회 — 커서로 전량을 훑지 않는다. */
  async function countQuick(db) {
    const result = { words: 0, expressionStore: 0 };
    {
      const tx = db.transaction('words', 'readonly');
      result.words = await requestPromise(tx.objectStore('words').count());
      await transactionPromise(tx);
    }
    {
      const tx = db.transaction('expressions', 'readonly');
      result.expressionStore = await requestPromise(tx.objectStore('expressions').count());
      await transactionPromise(tx);
    }
    return result;
  }

  /* 9.4.4: 매 로드마다 최대 2.3초 + expressions 스토어 전량 커서 스캔 3회였다.
     안정화 판정에는 count() 만으로 충분하므로 대기 구간은 저렴한 조회로 하고,
     문법/표현을 가르는 전량 스캔(countData)은 마지막 1회만 한다.
     한 세션에서 이미 정상 판정을 받았으면 대기 자체를 건너뛴다. */
  async function waitForStableCounts(db) {
    let previous = await countQuick(db);
    let verified = false;
    try { verified = sessionStorage.getItem(VERIFIED_KEY) === '1'; } catch (_) {}
    if (verified && previous.words > 0 && previous.expressionStore > 0) return countData(db);
    for (const delay of [900, 1400]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const current = await countQuick(db);
      if (current.words === previous.words && current.expressionStore === previous.expressionStore) break;
      previous = current;
    }
    return countData(db);
  }

  async function verifyAndRepairData() {
    if (!('indexedDB' in window)) return;
    let db;
    try {
      db = await openMatchingDb();
      if (!db) return;
      const before = await waitForStableCounts(db);
      const broken = needsRepair(before);
      if (!broken.any) {
        try { sessionStorage.setItem(VERIFIED_KEY, '1'); } catch (_) {}
        const detail = { version: VERSION, counts: before, repaired: false, healthy: true };
        emitIntegrity(detail);
        updateDataStatusUi(detail);
        db.close();
        return;
      }

      const recovery = await loadRecoveryData();
      let merged = 0;
      let skipped = 0;
      const skippedSamples = [];
      const collect = (result) => {
        merged += result.queued;
        skipped += result.failed;
        skippedSamples.push(...result.samples);
      };
      if (broken.wordBroken) collect(await mergeSeedRecords(db, 'words', recovery.words, ['Word', 'word', 'Traditional', 'Simplified', 'Chinese']));
      if (broken.expressionBroken || broken.grammarBroken) {
        const records = [].concat(recovery.expressions || [], recovery.grammar || []);
        collect(await mergeSeedRecords(db, 'expressions', records, ['Expression', 'expression', 'Pattern', 'Chinese']));
      }
      const after = await countData(db);
      const stillBroken = needsRepair(after);
      /* 9.4.4: 저장 실패 건수(skipped)를 결과에 포함한다. 예전에는 keyPath 값이
         없는 행이 warn 만 남기고 조용히 유실돼 복구가 "성공"으로 보고됐다. */
      const detail = { version: VERSION, counts: after, before, repaired: !stillBroken.any, healthy: !stillBroken.any, merged, skipped, skippedSamples: skippedSamples.slice(0, 10) };
      emitIntegrity(detail);
      updateDataStatusUi(detail);
      db.close();

      if (!stillBroken.any && sessionStorage.getItem('cems944-data-reload') !== '1') {
        sessionStorage.setItem('cems944-data-reload', '1');
        location.reload();
      }
    } catch (error) {
      if (db) try { db.close(); } catch (_) {}
      const detail = { version: VERSION, error: error && error.message ? error.message : String(error), healthy: false, repaired: false };
      console.error('[CEMS 9.4.4] data integrity check failed', error);
      emitIntegrity(detail);
      updateDataStatusUi(detail);
    }
  }

  /* 9.4.4: 이 레이어의 document 클릭 리스너를 공용 UI 버스로 옮겼다.
     예전에는 클릭 한 번에 applyCompactUi 가 자기 타이머로 따로 예약됐다. */
  function onBusClick(event) {
    const deltaButton = event.target.closest && event.target.closest('[data-c944-delta]');
    if (deltaButton) {
      const input = deltaButton.parentElement && deltaButton.parentElement.querySelector('input');
      if (input) {
        input.value = String(clamp(Number(input.value) + Number(deltaButton.dataset.c944Delta), Number(input.min || 1), Number(input.max || 200)));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    const panel = deckPanel();
    if (panel && event.target.nodeType === 1 && panel.contains(event.target)) syncCountFromDeck();
  }

  const bus = window.CEMS944UiBus;
  if (bus) {
    bus.onClick('v944-compact-click', onBusClick, 10);
    bus.register('v944-compact-ui', applyCompactUi, 10);
  } else {
    document.addEventListener('click', (event) => { onBusClick(event); setTimeout(applyCompactUi, 0); }, false);
  }
  const scheduleCompact = (delay = 0) => { if (bus) bus.schedule(delay); else setTimeout(applyCompactUi, delay); };

  document.addEventListener('change', (event) => {
    if (event.target && event.target.id === 'setting-grammar-goal') storeGrammarGoal(event.target.value);
  });
  document.addEventListener('CEMSDataReady', () => scheduleCompact(0));
  window.addEventListener('hashchange', () => scheduleCompact(0));
  window.addEventListener('pageshow', () => scheduleCompact(0));

  /* 9.4.4(항목 19): 무결성 점검을 앱의 초기 대량 쓰기와 겹치지 않게 미룬다.
     예전처럼 +700ms 에 바로 돌리면 시드 적재용 readwrite 트랜잭션 뒤에 우리
     readonly 커서가 줄을 서서 스캔 하나가 수 초씩 걸렸다.
     유휴 시점(늦어도 6초)에 한 번만 돈다. */
  function scheduleIntegrityCheck() {
    const run = () => { verifyAndRepairData(); };
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 6000 });
    else setTimeout(run, 2500);
  }

  const start = () => {
    applyCompactUi();
    if (!bus) setTimeout(applyCompactUi, 350);
    setTimeout(scheduleIntegrityCheck, 700);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.CEMS944 = Object.freeze({
    version: VERSION,
    applyCompactUi,
    verifyAndRepairData,
    syncCompatibilityCounts
  });
})();

/* ========================================================================
   CEMS 9.4.4 R2 regression repair
   - compact/overflow-safe settings and study controls
   - one unified Excel/JSON importer
   - persistent AI prompt access
   - Chinese-character prompt for pinyin typing
   - random deck rotation without recent repeats
   ======================================================================== */
(() => {
  'use strict';

  const BUILD = '9.4.4-final2';
  const COUNT_IDS = ['study-count', 'expr-study-count', 'pv-study-count'];
  const RANDOM_HISTORY_PREFIX = 'cems:v944:r2:random-history:';
  const RANDOM_HISTORY_LIMIT_MIN = 240;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const text = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  /* 9.4.4: 같은 문자열을 다시 써도 childList 변경이 생겨 MutationObserver 를 깨운다.
     값이 실제로 달라질 때만 쓴다(재작업 되먹임 고리 차단). */
  const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
  const setHtml = (node, value) => { if (node && node.innerHTML !== value) node.innerHTML = value; };

  function notify(message) {
    try {
      if (typeof showToast === 'function') return showToast(message);
      if (typeof window.showToast === 'function') return window.showToast(message);
    } catch (_) {}
    console.info('[CEMS 9.4.4 R2]', message);
  }

  function findSettingsCard(title) {
    return $$('#page-settings > .card').find((card) => text($('.c943-section-title-text', card)?.textContent || $('.card-title', card)?.textContent) === title) || null;
  }

  function makeToggle(input, labelText, hintText = '') {
    const row = document.createElement('div');
    row.className = 'c944-r2-setting-line c944-r2-toggle-line';
    const copy = document.createElement('div');
    copy.className = 'c944-r2-setting-copy';
    copy.innerHTML = `<strong>${labelText}</strong>${hintText ? `<small>${hintText}</small>` : ''}`;
    const label = document.createElement('label');
    label.className = 'toggle-switch';
    label.append(input, Object.assign(document.createElement('span'), { className: 'toggle-slider' }));
    row.append(copy, label);
    return row;
  }

  function makeRange(input, labelText, valueHtml, noteHtml = '') {
    const block = document.createElement('div');
    block.className = 'c944-r2-range-block';
    const head = document.createElement('div');
    head.className = 'c944-r2-range-head';
    head.innerHTML = `<strong>${labelText}</strong><output class="c944-r2-range-output">${valueHtml}</output>`;
    const track = document.createElement('div');
    track.className = 'c944-r2-range-track';
    track.append(input);
    block.append(head, track);
    if (noteHtml) {
      const note = document.createElement('small');
      note.className = 'c944-r2-range-note';
      note.innerHTML = noteHtml;
      block.append(note);
    }
    return block;
  }

  function normalizeNumberInput(input, fallback, min, max) {
    if (!input) {
      input = document.createElement('input');
      input.type = 'number';
      input.value = String(fallback);
    }
    input.type = 'number';
    input.min = input.min || String(min);
    input.max = input.max || String(max);
    input.step = input.step || '1';
    input.inputMode = 'numeric';
    input.classList.add('c944-stepper-input');
    input.removeAttribute('style');
    return input;
  }

  function makeGoalRow(input, labelText, settingKey) {
    const row = document.createElement('div');
    row.className = 'c944-r2-goal-row c944-setting-row c944-goal-row';
    row.dataset.settingRow = settingKey;
    const label = document.createElement('label');
    label.htmlFor = input.id;
    label.textContent = labelText;
    const stepper = document.createElement('div');
    stepper.className = 'c944-stepper';
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'c944-stepper-button';
    minus.dataset.c944Delta = '-1';
    minus.setAttribute('aria-label', `${labelText} 감소`);
    minus.textContent = '−';
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'c944-stepper-button';
    plus.dataset.c944Delta = '1';
    plus.setAttribute('aria-label', `${labelText} 증가`);
    plus.textContent = '+';
    stepper.append(minus, input, plus);
    row.append(label, stepper);
    return row;
  }

  function rebuildLearningSettings() {
    const card = findSettingsCard('학습');
    const body = $('.cems-ux25-settings-body', card || document);
    if (!card || !body || body.dataset.c944R2Built === '1') return;

    /* 9.4.4: 예전에는 null 검사 전에 detachInput() 이 DOM 에서 먼저 제거해서,
       하나라도 없으면 이미 지운 컨트롤이 영구 소실되고 data-c944-r2-built 도
       세워지지 않아 복구가 불가능했다.
       → 모두 조회 → null 검사 통과 → 그때 비로소 remove() 한다. */
    const found = {
      recent: document.getElementById('setting-recent-ratio'),
      wrongAuto: document.getElementById('setting-wrong-auto'),
      wrongLimit: document.getElementById('setting-wrong-limit'),
      vocab: document.getElementById('setting-vocab-goal'),
      expr: document.getElementById('setting-expr-goal'),
      grammar: document.getElementById('setting-grammar-goal'),
      defaultCount: document.getElementById('setting-count')
        || document.getElementById('default-study-count')
        || document.getElementById('setting-default-count')
    };
    if (!found.recent || !found.wrongAuto || !found.wrongLimit || !found.vocab || !found.expr || !found.defaultCount) return;

    const detach = (node) => { if (node) node.remove(); return node; };
    const recent = detach(found.recent);
    const wrongAuto = detach(found.wrongAuto);
    const wrongLimit = detach(found.wrongLimit);
    let vocab = detach(found.vocab);
    let expr = detach(found.expr);
    let grammar = detach(found.grammar);
    let defaultCount = detach(found.defaultCount);

    card.classList.add('c944-r2-learning-card');
    card.classList.remove('c944-goals-panel');
    body.dataset.c944R2Built = '1';
    body.classList.add('c944-r2-settings-body');
    body.replaceChildren();

    recent.removeAttribute('style');
    recent.classList.add('c944-r2-range');
    const recentBlock = makeRange(
      recent,
      '최근 추가 비중',
      '<span id="recent-ratio-val">' + recent.value + '</span>%',
      '최근 추가·수정 <span id="recent-ratio-val2">' + recent.value + '</span>% · 기존 DB <span id="old-ratio-val">' + (100 - Number(recent.value || 0)) + '</span>%'
    );

    wrongAuto.removeAttribute('style');
    const wrongToggle = makeToggle(wrongAuto, '오답 자동 포함', '목표 5개당 1개');

    wrongLimit.removeAttribute('style');
    wrongLimit.classList.add('c944-r2-range');
    const wrongBlock = makeRange(wrongLimit, '오답 추가 한도', '<span id="wrong-limit-val">' + wrongLimit.value + '</span>개');

    vocab = normalizeNumberInput(vocab, 20, 1, 100);
    expr = normalizeNumberInput(expr, 10, 1, 100);
    grammar = normalizeNumberInput(grammar, Number(localStorage.getItem('grammarGoal') || 10), 1, 200);
    if (!grammar.id) grammar.id = 'setting-grammar-goal';
    grammar.name = 'grammarGoal';
    defaultCount = normalizeNumberInput(defaultCount, 20, 5, 100);

    if (!grammar.dataset.c944R2Storage) {
      grammar.dataset.c944R2Storage = '1';
      const saveGrammar = () => {
        const value = String(Math.min(200, Math.max(1, Number(grammar.value) || 10)));
        grammar.value = value;
        ['grammarGoal', 'grammar_goal', 'settingGrammarGoal', 'setting-grammar-goal', 'cems.grammarGoal', 'cems_grammar_goal', 'dailyGrammarGoal']
          .forEach((key) => localStorage.setItem(key, value));
      };
      grammar.addEventListener('input', saveGrammar);
      grammar.addEventListener('change', saveGrammar);
    }

    const goals = document.createElement('section');
    goals.className = 'c944-r2-goals';
    const goalsTitle = document.createElement('div');
    goalsTitle.className = 'c944-r2-subhead';
    goalsTitle.textContent = '일일 목표';
    goals.append(
      goalsTitle,
      makeGoalRow(vocab, '단어', 'vocabGoal'),
      makeGoalRow(expr, '표현', 'exprGoal'),
      makeGoalRow(grammar, '문법', 'grammarGoal'),
      makeGoalRow(defaultCount, '기본 학습 분량', 'defaultCount')
    );

    body.append(recentBlock, wrongToggle, wrongBlock, goals);
  }

  function hideCompatibilityCountPanels() {
    for (const id of COUNT_IDS) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.classList.add('c944-compat-count-input');
      const card = input.closest('.card');
      if (card) {
        card.classList.add('c944-r2-compat-count-panel', 'c944-compat-count-panel');
        card.hidden = true;
        card.setAttribute('aria-hidden', 'true');
      }
    }
  }

  function organizeStudyFilters() {
    const configs = [
      ['study-vocab', 'filter-mastery', 'filter-tag'],
      ['study-expr', 'expr-filter-mastery', 'expr-filter-tag'],
      ['study-phrasal', 'pv-filter-mastery', 'pv-filter-tag']
    ];
    for (const [rootId, masteryId, tagId] of configs) {
      const root = document.getElementById(rootId);
      const mastery = document.getElementById(masteryId);
      const card = mastery?.closest('.card');
      if (!root || !card) continue;
      card.classList.add('c944-r2-filter-card');
      const advanced = $('.c86-advanced', card);
      const advancedBody = $('.c86-advanced-body', advanced || card);
      if (advanced && advancedBody) {
        advanced.classList.add('c944-r2-advanced-filter');
        if (!advanced.dataset.c944R2Prepared) {
          advanced.dataset.c944R2Prepared = '1';
          advanced.open = false;
        }
        const masteryGroup = mastery.closest('.form-group');
        if (masteryGroup && !advancedBody.contains(masteryGroup)) advancedBody.prepend(masteryGroup);
        const tagGroup = document.getElementById(tagId)?.closest('.form-group');
        if (tagGroup && !advancedBody.contains(tagGroup)) advancedBody.append(tagGroup);
        const actionRow = Array.from(card.children).find((node) => node !== advanced && /필터\s*초기화/.test(text(node.textContent)));
        if (actionRow && !advancedBody.contains(actionRow)) advancedBody.append(actionRow);
        const detail = Array.from(card.children).find((node) => node.classList?.contains('c86-filter-detail'));
        if (detail && !advancedBody.contains(detail)) advancedBody.append(detail);
      }
      const title = $('.card-title', card);
      const hint = title && Array.from(title.children).find((node) => node.tagName === 'SPAN' && !node.classList.contains('c943-section-main'));
      setText(hint, '클릭 포함 · 두 번 제외');
    }
  }

  function labelActionButton(button, label) {
    if (!button) return;
    button.classList.add('c944-r2-action-btn');
    button.dataset.c944R2Label = label;
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  function compactStudyActionButtons() {
    const labelsById = {
      'fc-production-btn': '쓰기', 'fc-tag-btn': '태그',
      'fc-prev-btn': '이전', 'fc-next-btn': '다음', 'fc-speak-btn': '듣기',
      'fc-bookmark-btn': '북마크', 'fc-edit-btn': '수정', 'fc-exit-btn': '종료',
      'expr-fc-production-btn': '쓰기', 'expr-fc-tag-btn': '태그',
      'expr-fc-prev-btn': '이전', 'expr-fc-next-btn': '다음', 'expr-fc-speak-btn': '듣기',
      'expr-fc-bookmark-btn': '북마크', 'expr-fc-edit-btn': '수정', 'expr-fc-exit-btn': '종료',
      'typing-bookmark-btn': '북마크', 'expr-typing-bookmark-btn': '북마크'
    };
    Object.entries(labelsById).forEach(([id, label]) => labelActionButton(document.getElementById(id), label));

    document.getElementById('fc-production-btn')?.parentElement?.classList.add('c944-r2-flash-meta-actions');
    document.getElementById('expr-fc-production-btn')?.parentElement?.classList.add('c944-r2-flash-meta-actions');

    $$('.quiz-action-bar').forEach((row) => {
      row.classList.add('c944-r2-quiz-actions');
      const labels = ['듣기', '북마크', '쓰기', '태그', '수정'];
      Array.from(row.querySelectorAll('button')).forEach((button, index) => labelActionButton(button, labels[index] || '동작'));
    });

    $$('.phase4-compact-actions').forEach((row) => {
      const buttons = Array.from(row.querySelectorAll('button'));
      if (buttons[0]) labelActionButton(buttons[0], '북마크');
      if (buttons[1]) labelActionButton(buttons[1], '수정');
    });

    const typingRows = [
      document.getElementById('typing-bookmark-btn')?.parentElement,
      document.getElementById('expr-typing-bookmark-btn')?.parentElement
    ].filter(Boolean);
    typingRows.forEach((row) => {
      const buttons = Array.from(row.querySelectorAll('button'));
      if (buttons[0]) labelActionButton(buttons[0], '북마크');
      if (buttons[1]) labelActionButton(buttons[1], '수정');
    });
  }

  function compactStudyStructures() {
    $$('.c943-study-options').forEach((details) => details.classList.add('c944-r2-study-options'));
    const orderCard = document.getElementById('option-order')?.closest('.card');
    if (orderCard) {
      orderCard.classList.add('c944-r2-order-card');
      setText(orderCard.querySelector('.c943-section-title-text'), '학습 순서');
      const label = orderCard.querySelector('.toggle-label');
      if (label) label.hidden = true;
    }
    const flashRows = [
      ['fc-prev-btn', 'c944-r2-flash-actions'],
      ['expr-fc-prev-btn', 'c944-r2-flash-actions']
    ];
    for (const [id, className] of flashRows) document.getElementById(id)?.parentElement?.classList.add(className);
    $$('.quiz-action-bar').forEach((row) => row.classList.add('c944-r2-quiz-actions'));
    $$('.phase4-compact-actions').forEach((row) => row.classList.add('c944-r2-two-actions'));
    document.getElementById('typing-bookmark-btn')?.parentElement?.classList.add('c944-r2-two-actions');
    document.getElementById('expr-typing-bookmark-btn')?.parentElement?.classList.add('c944-r2-two-actions');
    const labels = {
      vocabGoal: '단어', exprGoal: '표현', grammarGoal: '문법', defaultCount: '기본 학습 분량'
    };
    for (const [key, label] of Object.entries(labels)) {
      const row = document.querySelector(`[data-setting-row="${key}"]`);
      setText(row?.querySelector('label'), label);
    }
  }

  async function refreshVisibleImportSummary() {
    const output = document.querySelector('[data-c944-r2-import-summary]') || document.querySelector('#c943-json-import-card .c943-source-summary');
    if (!output) return;
    try {
      const [sources, routines] = await Promise.all([
        typeof window.CEMS943?.getSources === 'function' ? window.CEMS943.getSources() : Promise.resolve([]),
        typeof window.CEMS943?.getRoutines === 'function' ? window.CEMS943.getRoutines() : Promise.resolve([])
      ]);
      const sourceList = Array.isArray(sources) ? sources : [];
      const routineList = Array.isArray(routines) ? routines : [];
      const count = sourceList.reduce((sum, source) => sum + Object.values(source.counts || {}).reduce((a, b) => a + Number(b || 0), 0), 0);
      const parts = [];
      if (sourceList.length) parts.push(`가져온 JSON ${sourceList.length}개`, `원본 항목 ${count.toLocaleString('ko-KR')}개`);
      if (routineList.length) parts.push(`사용자 루틴 ${routineList.length}개`);
      const nextText = parts.length ? parts.join(' · ') : '가져온 JSON 자료 없음';
      if (output.textContent !== nextText) output.textContent = nextText;
    } catch (_) {
      const fallback = '외부 자료 상태를 확인할 수 없습니다';
      if (output.textContent !== fallback) output.textContent = fallback;
    }
  }

  function consolidateImportUi() {
    const panel = document.getElementById('file-input')?.closest('.card') || document.getElementById('upload-zone')?.closest('.card');
    if (!panel) return;
    panel.classList.add('c944-r2-import-panel');
    panel.dataset.c944R2DataRole = 'add';
    const dataPage = document.getElementById('page-data');
    const addPane = dataPage?.querySelector('[data-ux25-data-pane="add"]');
    if (addPane && panel.parentElement !== addPane) addPane.append(panel);
    const titleText = $('.c943-section-title-text', panel);
    if (titleText) setText(titleText, '자료 파일 가져오기');
    else setText($('.card-title', panel), '자료 파일 가져오기');
    const fileInput = document.getElementById('file-input');
    if (fileInput) {
      fileInput.accept = '.xlsx,.xlsm,.xls,.json,application/json';
      fileInput.setAttribute('aria-label', 'Excel 또는 JSON 자료 파일 선택');
    }
    const zone = document.getElementById('upload-zone');
    const paragraph = zone?.querySelector('p');
    setHtml(paragraph, '탭하거나 파일을 끌어오세요<br><small>Excel(.xlsx·.xlsm·.xls) 또는 JSON 자동 감지</small>');

    let inline = document.getElementById('c943-json-import-card');
    if (!inline) {
      inline = document.createElement('div');
      inline.id = 'c943-json-import-card';
      inline.className = 'c943-json-import-inline';
      inline.innerHTML = `
        <div class="c943-source-summary" data-c944-r2-import-summary>외부 자료를 확인하는 중…</div>
        <button type="button" data-library-open aria-label="가져온 자료 보기">가져온 자료 보기</button>`;
      inline.querySelector('[data-library-open]')?.addEventListener('click', () => {
        if (typeof window.CEMS943?.openLibrary === 'function') window.CEMS943.openLibrary();
      });
      panel.append(inline);
    } else {
      inline.classList.add('c943-json-import-inline');
      inline.hidden = false;
      inline.removeAttribute('aria-hidden');
      if (!panel.contains(inline)) panel.append(inline);
    }
    /* 9.4.4: 여기서 무조건 요약을 읽으면(→ openExternalDb) 매 UI 패스마다
       외부 라이브러리 IndexedDB 가 열린다. 데이터 화면일 때만 읽는다
       (진입 시점은 CEMSHooks 'afterPageShow' 훅이 담당). */
    if (document.getElementById('page-data')?.classList.contains('active')) refreshVisibleImportSummary();
  }

  const FALLBACK_PROMPTS = {
    vocab: '입력된 중국어 단어를 CEMS 단어 TSV 스키마에 맞춰 작성하세요. 첫 줄에 Traditional_CH, Simplified_CH, Pinyin, POS, Meaning_KO, Example_CHT, Example_KO, Synonym_CHT, Antonym_CHT, Measure_CHT, Collocation_CHT, HSK, Register, Priority, Style_Tags, Common_Error, 비고 헤더를 포함하고, 설명이나 마크다운 없이 TSV만 출력하세요.',
    expr: '입력된 중국어 표현을 CEMS 표현 TSV 스키마에 맞춰 작성하세요. 첫 줄에 Expression, L1, L2, L3, Function, Meaning_KO, Formality, Currency, Medium, Style_Tags, Example1, Example2, Similar_Expr, Common_Error, HSK, Frequency, Priority 헤더를 포함하고, 설명이나 마크다운 없이 TSV만 출력하세요.'
  };

  function promptMap() {
    try {
      if (typeof AI_PROMPTS_CN !== 'undefined' && AI_PROMPTS_CN) return AI_PROMPTS_CN;
    } catch (_) {}
    return FALLBACK_PROMPTS;
  }

  function activeAiType() {
    const active = document.querySelector('#ai-type-group .chip.active')?.dataset.value;
    if (active === 'expr' || active === 'vocab') return active;
    try {
      if (typeof aiType !== 'undefined' && (aiType === 'expr' || aiType === 'vocab')) return aiType;
    } catch (_) {}
    return 'vocab';
  }

  function updatePromptTools() {
    const tools = document.getElementById('c944-r2-prompt-tools');
    if (!tools) return;
    const type = activeAiType();
    const prompt = promptMap()[type] || FALLBACK_PROMPTS[type];
    const preview = $('[data-c944-r2-prompt-preview]', tools);
    const label = $('[data-c944-r2-prompt-type]', tools);
    setText(preview, prompt);
    setText(label, type === 'expr' ? '표현용' : '단어용');
  }

  async function copyText(value) {
    try { await navigator.clipboard.writeText(value); }
    catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.append(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
  }

  function installPromptTools() {
    const card = document.querySelector('#page-data .ai-card');
    if (!card) return;
    card.classList.add('c944-r2-ai-card');

    /* Surface the prompt once for existing 9.4.4 users who inherited the old collapsed default. */
    try {
      const migrationKey = 'cems:v944:r2:prompt-visible-migrated';
      if (localStorage.getItem(migrationKey) !== '1') {
        localStorage.setItem('cems:v944:ai-helper', 'open');
        localStorage.setItem(migrationKey, '1');
        card.classList.remove('c943-collapsed');
        const toggle = card.querySelector('[data-c943-ai-toggle]');
        if (toggle) {
          toggle.textContent = '접기';
          toggle.setAttribute('aria-expanded', 'true');
        }
      }
    } catch (_) {}

    if (document.getElementById('c944-r2-prompt-tools')) {
      updatePromptTools();
      return;
    }
    const details = document.createElement('details');
    details.id = 'c944-r2-prompt-tools';
    details.className = 'c944-r2-prompt-tools';
    details.innerHTML = `
      <summary><span><strong>AI 생성 프롬프트</strong><small>항목을 넣기 전에도 확인·복사할 수 있습니다.</small></span><em data-c944-r2-prompt-type>단어용</em></summary>
      <pre data-c944-r2-prompt-preview></pre>
      <button type="button" data-c944-r2-copy-prompt>현재 프롬프트 복사</button>`;
    const pending = document.getElementById('ai-pending-section');
    if (pending) card.insertBefore(details, pending);
    else card.append(details);
    $('[data-c944-r2-copy-prompt]', details).addEventListener('click', async () => {
      const type = activeAiType();
      await copyText(promptMap()[type] || FALLBACK_PROMPTS[type]);
      notify('프롬프트를 복사했습니다.');
    });
    updatePromptTools();
  }

  /* 타이핑 문제 프롬프트를 한자 우선으로 바꾼다.
     쓰기(write)를 실제로 값이 달라질 때만 하므로 몇 번 호출해도 안전하고,
     아래 관찰자가 자기 자신 때문에 다시 깨어나지 않는다. */
  function renderTypingPrompt() {
    try {
      if (typeof typingState === 'undefined') return;
      const item = typingState?.words?.[typingState.idx];
      if (!item) return;
      const hanzi = typeof getW === 'function' ? getW(item) : (item.Traditional_CH || item.Simplified_CH || item.Word || '');
      const meaning = typeof getMKO === 'function' ? getMKO(item) : (item.Meaning_KO || item.Meaning1_KO || '');
      const main = document.getElementById('typing-meaning');
      const sub = document.getElementById('typing-en');
      if (main) {
        const nextMain = hanzi || '(표제어 없음)';
        if (main.textContent !== nextMain) main.textContent = nextMain;
        main.classList.add('c944-r2-hanzi-prompt');
      }
      if (sub) {
        const nextSub = meaning || '';
        if (sub.textContent !== nextSub) sub.textContent = nextSub;
        sub.classList.add('c944-r2-meaning-prompt');
      }
    } catch (error) {
      console.warn('[CEMS 9.4.4 R2] typing prompt repair failed', error);
    }
  }

  /* 9.4.4: window.showTypingQ 재정의를 제거했다.
     ── 왜 훅이 아니라 노드 관찰인가
     CEMSHooks 에 문제 출제 시점 채널이 없다(보고서: "채널 추가 필요:
     afterTypingQuestion"). 그때까지는 #typing-meaning 한 노드만 보는 좁은
     관찰자로 대신한다. 문서 전체 MutationObserver 도, afterPageShow 폴링도
     아니고, 이 노드의 자식/문자 변경에만 반응한다.
     showTypingQ 가 한국어 뜻을 쓰면 곧바로 한자로 바꿔 쓰며, 값이 같으면
     쓰지 않으므로 무한 루프가 없다. 모듈 스코프 변수로 1회만 설치한다
     (함수 프로퍼티 플래그 금지). */
  let typingObserver = null;

  function installTypingRepair() {
    if (typingObserver) return;
    const main = document.getElementById('typing-meaning');
    if (!main) return;
    typingObserver = new MutationObserver(() => renderTypingPrompt());
    typingObserver.observe(main, { childList: true, characterData: true, subtree: true });
    renderTypingPrompt();
  }

  function itemKey(item, type) {
    try {
      if (typeof getItemKey === 'function') return String(getItemKey(item, type) || '');
    } catch (_) {}
    if (!item) return '';
    const keys = type === 'expr'
      ? ['Expression', 'expression', 'Pattern', 'front', 'id']
      : type === 'phrasal'
        ? ['Phrasal_Verb', 'PhrasalVerb', 'front', 'id']
        : ['Traditional_CH', 'Simplified_CH', 'Word', 'word', 'front', 'id'];
    for (const key of keys) if (item[key] != null && String(item[key]).trim()) return String(item[key]).trim();
    return '';
  }

  function uniquePool(items, type) {
    const map = new Map();
    for (const item of items || []) {
      const key = itemKey(item, type);
      if (key && !map.has(key)) map.set(key, item);
    }
    return Array.from(map.values());
  }

  function randomHistoryKey(type, mode) {
    return RANDOM_HISTORY_PREFIX + String(type || 'vocab') + ':' + String(mode || 'default');
  }

  function loadRandomHistory(type, mode) {
    try {
      const parsed = JSON.parse(localStorage.getItem(randomHistoryKey(type, mode)) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((row) => row && typeof row.k === 'string' && Number.isFinite(Number(row.t)));
    } catch (_) { return []; }
  }

  function saveRandomHistory(type, mode, rows, requested) {
    const limit = Math.max(RANDOM_HISTORY_LIMIT_MIN, Number(requested || 20) * 14);
    const compact = rows.sort((a, b) => Number(b.t) - Number(a.t)).slice(0, limit);
    try { localStorage.setItem(randomHistoryKey(type, mode), JSON.stringify(compact)); } catch (_) {}
  }

  function shuffled(items) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function randomTake(pool, count, used, historyMap, type) {
    if (count <= 0) return [];
    const ranked = uniquePool(pool, type)
      .map((item) => ({ item, key: itemKey(item, type), last: Number(historyMap.get(itemKey(item, type)) || 0), salt: Math.random() }))
      .filter((row) => row.key && !used.has(row.key))
      .sort((a, b) => {
        const aSeen = a.last > 0 ? 1 : 0;
        const bSeen = b.last > 0 ? 1 : 0;
        return aSeen - bSeen || a.last - b.last || a.salt - b.salt;
      });
    const selected = ranked.slice(0, count).map((row) => row.item);
    selected.forEach((item) => used.add(itemKey(item, type)));
    return selected;
  }

  function isNewItem(item) {
    try { return typeof phase1IsNew === 'function' ? phase1IsNew(item) : !(Number(item?.reviewCount) > 0); }
    catch (_) { return !(Number(item?.reviewCount) > 0); }
  }

  function isDueItem(item, now) {
    try { return typeof isItemDue === 'function' ? isItemDue(item, now) : false; }
    catch (_) { return false; }
  }

  function isWrongItem(item) {
    try { return typeof isWrong === 'function' ? isWrong(item) : Number(item?.wrongCount || item?.consecutiveWrong || 0) > 0; }
    catch (_) { return Number(item?.wrongCount || item?.consecutiveWrong || 0) > 0; }
  }

  function isAvailableItem(item, now) {
    try { return typeof isItemAvailable === 'function' ? isItemAvailable(item, now) : true; }
    catch (_) { return true; }
  }

  /* 9.4.4: 랜덤 회전 조건을 넓혔다.
     예전에는 #option-order 셀렉트가 'random' 이 아니면 무조건 조기 반환해서,
     "랜덤" 프리셋으로 만든 카드덱(learning/cems-9.4.1-deck-groups.js:610 이
     deck.preset === 'random' || deck.randomizeEachSession === true 일 때 랜덤을
     쓴다고 판단한다)이 전역 셀렉트가 fsrs 인 동안 회전하지 않았다.
     이제 호출부가 options.order/forceRandom 으로 의사를 밝히면 그것을 존중한다. */
  function wantsRandomOrder(options) {
    if (options) {
      if (options.forceRandom === true) return true;
      if (options.randomizeEachSession === true) return true;
      const explicit = String(options.order || options.sortOrder || '').toLowerCase();
      if (explicit === 'random') return true;
      if (explicit && explicit !== 'random') return false;
      const deck = options.deck;
      if (deck && (deck.preset === 'random' || deck.randomizeEachSession === true)) return true;
    }
    return document.getElementById('option-order')?.value === 'random';
  }

  function rotateRandomSelection(baseResult, filtered, count, type, options) {
    if (!baseResult?.items?.length) return baseResult;
    if (!wantsRandomOrder(options)) return baseResult;

    const now = (() => {
      try { return typeof safeParseDate === 'function' ? (safeParseDate(options?.now) || new Date()) : new Date(); }
      catch (_) { return new Date(); }
    })();
    const requested = Math.max(1, Number(baseResult.items.length || count || 1));
    const mode = options?.mode || 'default';
    const historyRows = loadRandomHistory(type, mode);
    const historyMap = new Map(historyRows.map((row) => [row.k, Number(row.t)]));
    const available = uniquePool((filtered || []).filter((item) => isAvailableItem(item, now)), type);
    if (!available.length) return baseResult;

    const baseItems = uniquePool(baseResult.items, type);
    const dueTarget = baseItems.filter((item) => isDueItem(item, now)).length;
    const newTarget = baseItems.filter((item) => !isDueItem(item, now) && isNewItem(item)).length;
    const reviewTarget = Math.max(0, requested - dueTarget - newTarget);
    const wrongTarget = baseItems.filter((item) => !isDueItem(item, now) && !isNewItem(item) && isWrongItem(item)).length;

    const duePool = available.filter((item) => isDueItem(item, now));
    const newPool = available.filter((item) => !isDueItem(item, now) && isNewItem(item));
    const reviewPool = available.filter((item) => !isDueItem(item, now) && !isNewItem(item));
    const wrongPool = reviewPool.filter(isWrongItem);
    const used = new Set();
    const selected = [];

    selected.push(...randomTake(duePool, dueTarget, used, historyMap, type));
    const wrongCount = Math.min(wrongTarget, reviewTarget);
    selected.push(...randomTake(wrongPool, wrongCount, used, historyMap, type));
    selected.push(...randomTake(reviewPool, reviewTarget - wrongCount, used, historyMap, type));
    selected.push(...randomTake(newPool, newTarget, used, historyMap, type));
    if (selected.length < requested) selected.push(...randomTake(available, requested - selected.length, used, historyMap, type));

    const finalItems = shuffled(uniquePool(selected, type)).slice(0, requested);
    const timestamp = Date.now();
    const mergedHistory = historyRows.filter((row) => !finalItems.some((item) => itemKey(item, type) === row.k));
    finalItems.forEach((item, index) => mergedHistory.push({ k: itemKey(item, type), t: timestamp + index }));
    saveRandomHistory(type, mode, mergedHistory, requested);

    baseResult.items = finalItems;
    baseResult.stats = Object.assign({}, baseResult.stats, {
      due: finalItems.filter((item) => isDueItem(item, now)).length,
      new: finalItems.filter((item) => !isDueItem(item, now) && isNewItem(item)).length,
      weak: finalItems.filter((item) => !isDueItem(item, now) && !isNewItem(item) && isWrongItem(item)).length,
      randomRotated: true,
      recentRepeatAvoidance: true
    });
    return baseResult;
  }

  /* 모드별 필수 데이터 — 이 필드가 없으면 그 모드에서는 출제할 수 없다.
     index.html 의 CEMS85.modeEligible 과 같은 기준이며, 그것을 쓸 수 없을 때의
     폴백으로도 쓴다. */
  const MODE_REQUIRED_FIELD = Object.freeze({
    typing: 'pinyin', dictation: 'pinyin',
    cloze: 'example', 'expr-cloze': 'example',
    collocation: 'collocation',
    reverse: 'meaning', quiz: 'meaning', 'expr-quiz': 'meaning'
  });

  function hasModeField(item, field) {
    if (!item) return false;
    const text = (value) => String(value == null ? '' : value).trim();
    if (field === 'pinyin') {
      try { if (typeof getPinyin === 'function') return !!text(getPinyin(item)); } catch (_) {}
      return !!text(item.Pinyin || item.pinyin);
    }
    if (field === 'example') {
      try { if (typeof getEx === 'function') return !!text(getEx(item)); } catch (_) {}
      return !!text(item.Example_CHT || item.Example1 || item.Example);
    }
    if (field === 'collocation') {
      try { if (typeof getCollocation === 'function') return !!text(getCollocation(item)); } catch (_) {}
      return !!text(item.Collocation_CHT || item.Key_Collocation);
    }
    if (field === 'meaning') {
      try { if (typeof getMKO === 'function') return !!text(getMKO(item)); } catch (_) {}
      return !!text(item.Meaning_KO || item.Meaning1_KO);
    }
    return true;
  }

  function modeFits(item, type, mode) {
    if (!mode) return true;
    try {
      if (window.CEMS85 && typeof window.CEMS85.modeEligible === 'function') {
        return !!window.CEMS85.modeEligible(item, type, mode);
      }
    } catch (_) {}
    const field = MODE_REQUIRED_FIELD[mode];
    return field ? hasModeField(item, field) : true;
  }

  /* 감사 H6: 모드 적합성 검사 없이 고른 카드가 그대로 출제됐다
     (실측: collocation 모드에서 10개 전부 연어 데이터 없는 카드).
     선택 결과의 마지막 관문에서 부적합 카드를 걸러내고, 후보 풀에 적합한 카드가
     있으면 그것으로 채운다. 부족하면 억지로 채우지 않고 부족한 채로 돌려준다
     (호출부가 stats.modeUnfit / stats.modeShort 로 사용자에게 알릴 수 있다). */
  function enforceModeFit(baseResult, filtered, count, type, options) {
    const mode = options?.mode;
    if (!mode || !baseResult?.items?.length) return baseResult;
    const items = baseResult.items;
    const fit = items.filter((item) => modeFits(item, type, mode));
    if (fit.length === items.length) return baseResult;

    const used = new Set(fit.map((item) => itemKey(item, type)));
    const replacements = [];
    for (const candidate of filtered || []) {
      if (fit.length + replacements.length >= items.length) break;
      const key = itemKey(candidate, type);
      if (!key || used.has(key)) continue;
      if (!modeFits(candidate, type, mode)) continue;
      used.add(key);
      replacements.push(candidate);
    }
    const merged = fit.concat(replacements);
    baseResult.items = merged;
    baseResult.stats = Object.assign({}, baseResult.stats, {
      modeUnfitRemoved: items.length - fit.length,
      modeRefilled: replacements.length,
      modeShort: Math.max(0, items.length - merged.length),
      modeFitEnforced: true
    });
    return baseResult;
  }

  /* 9.4.4: selectStudyItems 래퍼(installRandomRotation)를 제거하고 훅으로 등록한다.
     전역 함수 재정의는 소유권이 흐려지고 재설치 타이머마다 중첩된다.
     index.html 의 selectStudyItems 가 CEMSHooks.transform('studySelection', …) 로
     한 번만 불러 준다. */
  function installSelectionHooks() {
    const hooks = window.CEMSHooks;
    if (!hooks) return;
    hooks.on('studySelection', 'v944-random-rotation', function (result, filtered, count, type, options) {
      return rotateRandomSelection(result, filtered, count, type, options);
    });
    /* 모드 적합성은 회전 뒤에 마지막으로 적용한다(회전이 후보 풀에서 다시 뽑기 때문). */
    hooks.on('studySelection', 'v944-mode-fit', function (result, filtered, count, type, options) {
      return enforceModeFit(result, filtered, count, type, options);
    });
  }

  function refreshUi() {
    installTypingRepair();   // 관찰자가 이미 있으면 즉시 반환(모듈 스코프 1회 가드)
    rebuildLearningSettings();
    hideCompatibilityCountPanels();
    organizeStudyFilters();
    compactStudyStructures();
    consolidateImportUi();
    installPromptTools();
    updatePromptTools();
    compactStudyActionButtons();
    document.documentElement.dataset.cemsBuild = BUILD;
    document.documentElement.dataset.cemsRevision = 'final';
  }

  let refreshTimer = 0;
  /* 9.4.4: 이 레이어 전용 타이머 대신 공용 UI 버스의 단일 디바운스를 쓴다. */
  function scheduleRefresh(delay = 0) {
    const bus = window.CEMS944UiBus;
    if (bus) { bus.schedule(delay); return; }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshUi, delay);
  }

  function onBusClick(event) {
    const target = event.target;
    if (!target || !target.closest) return;
    if (target.closest('#ai-type-group .chip')) setTimeout(updatePromptTools, 0);
  }

  function start() {
    installTypingRepair();
    /* 전역 selectStudyItems 재정의 대신 훅 등록 (항목 1). */
    installSelectionHooks();
    refreshUi();

    const bus = window.CEMS944UiBus;
    if (bus) {
      bus.onClick('v944-r2-click', onBusClick, 30);
      bus.register('v944-r2-refresh', refreshUi, 30);
    } else {
      setTimeout(refreshUi, 250);
      setTimeout(refreshUi, 900);
      document.addEventListener('click', (event) => {
        onBusClick(event);
        scheduleRefresh(80);
      }, false);
    }

    /* 9.4.4(항목 18): 0/250/900/2200/4200ms 반복 타이머를 없앴다.
       그 타이머들이 매번 consolidateImportUi → refreshVisibleImportSummary →
       openExternalDb 를 불러, "시작 시 외부 라이브러리 DB 를 열지 않는다"는
       주석과 달리 매 로드마다 IndexedDB v3 업그레이드/마이그레이션 커서가 돌았다.
       이제 데이터 화면에 실제로 진입할 때만 요약을 읽는다. */
    if (window.CEMSHooks) {
      window.CEMSHooks.on('afterPageShow', 'v944-import-summary', function (pageName) {
        if (pageName === 'data') refreshVisibleImportSummary();
      });
    }

    document.addEventListener('change', (event) => {
      if (event.target?.id === 'option-order') scheduleRefresh(0);
      if (event.target?.id === 'file-input') setTimeout(refreshVisibleImportSummary, 1200);
    }, false);
    document.addEventListener('CEMSDataReady', () => scheduleRefresh(60));
    window.addEventListener('cems:external-library-updated', () => refreshVisibleImportSummary());
    window.addEventListener('hashchange', () => scheduleRefresh(80));
    window.addEventListener('pageshow', () => scheduleRefresh(80));

    /* 이미 데이터 화면이면 한 번만 읽는다. */
    if (document.getElementById('page-data')?.classList.contains('active')) refreshVisibleImportSummary();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.CEMS944R2 = Object.freeze({
    build: BUILD,
    refresh: refreshUi,
    renderTypingPrompt,
    refreshImportSummary: refreshVisibleImportSummary,
    clearRandomHistory(type = 'vocab', mode = 'default') {
      localStorage.removeItem(randomHistoryKey(type, mode));
    }
  });
})();
