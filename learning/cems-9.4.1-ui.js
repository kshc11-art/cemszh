/* CEMS v9.4.1 UI restructure
 * ---------------------------------------------------------------------------
 * 화면 재구성 계층. 메인 앱과 안정 복구판이 공유하며, 없는 요소는 조용히 건너뛴다.
 *
 *  1) 상단 고정 세션 알림 제거 (테마 CSS 와 이중 안전장치)
 *  2) 분석·데이터 페이지에 '문법' 탭 추가, 표현 목록에서 문법 분리
 *  3) 홈 '오늘 활동량' → '오늘 학습' + 문법 목표 열 추가 (설정 연동)
 *  4) 학습 페이지 하단 고정 도크를 페이지 상단 인라인 카드로 이동
 *  5) 분석 페이지 문법 현황 패널
 * ==========================================================================*/
(function () {
  'use strict';
  var VERSION = '9.4.4';
  var LANG = (window.CEMS_LANG || document.documentElement.lang || 'zh').indexOf('zh') === 0 ? 'zh' : 'en';
  /* v9.5: 설치 여부는 전부 이 모듈 스코프 상태로만 판단한다.
     예전에는 함수 프로퍼티 플래그(fn.__cems941)를 썼는데, 다른 모듈이 같은 전역을
     다시 감싸면 플래그가 사라져 재설치 타이머가 돌 때마다 중복 래핑됐다. */
  var state = {
    kind: 'vocab', installed: false, goalPatched: false, tablePatched: false,
    goalAdjustPatched: false, synced: false,
    tableRunning: null,   // 진행 중인 updateWordTable 프로미스 (렌즈 중첩 방지)
    tablePending: null    // 트레일링 엣지로 예약된 다음 1회
  };

  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function text(v) { return String(v == null ? '' : v).trim(); }
  function isGrammarRow(row) {
    var s = window.CEMS941Schema;
    if (s) return s.isGrammarRow(row);
    return !!(row && (row.contentKind === 'grammar' || row.Grammar_Point || text(row.L1) === '문법'));
  }
  function grammarSession(s) {
    return !!(s && s.type === 'expr' && s.contentKind === 'grammar');
  }

  /* ---- 1. 세션 상태 알림 무력화 -------------------------------------------*/
  function killStatusPill() {
    var pill = document.getElementById('session-engine-status');
    if (pill) pill.remove();
    var engine = window.SESSION_ENGINE_V2;
    if (engine && !engine.__cems941PillOff) {
      engine.__cems941PillOff = true;
      engine.updateStatusPill = function () {};
      engine.ensureStatusPill = function () {
        var stub = document.getElementById('session-engine-status');
        if (!stub) {
          stub = document.createElement('div');
          stub.id = 'session-engine-status';
          stub.className = 'session-engine-status hidden';
          stub.style.display = 'none';
          document.body.appendChild(stub);
        }
        return stub;
      };
      try { engine.hideStatusPill(); } catch (_) {}
    }
  }

  /* ---- 2. 분석·데이터 문법 탭 ---------------------------------------------*/
  function makeGrammarTab() {
    var tab = document.createElement('div');
    tab.className = 'type-tab grammar';
    tab.dataset.type = 'grammar';
    tab.textContent = '🧩 문법';
    tab.setAttribute('role', 'button');
    tab.tabIndex = 0;
    /* v9.5: switchGlobalType('grammar') 는 index.html 본체가 모르는 값이라
       deck-groups 래퍼가 인자를 'expr' 로 바꿔 처리해 왔다. 래핑을 없앴으므로
       deck-groups 가 공개한 activateKind 를 직접 부른다(내부에서 'expr' 로 전환). */
    tab.onclick = function () {
      var decks = window.CEMS932Decks;
      if (decks && typeof decks.activateKind === 'function') decks.activateKind('grammar', true);
      else if (typeof window.switchGlobalType === 'function') window.switchGlobalType('expr');
    };
    tab.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tab.click(); } };
    return tab;
  }
  function installTabs() {
    if (LANG !== 'zh' || !window.CEMS932Decks) return;   // 문법 개념이 있는 빌드에서만
    [q('#page-stats > .type-tabs'), q('#page-data > .type-tabs')].forEach(function (tabs) {
      if (tabs && !tabs.querySelector('[data-type="grammar"]')) tabs.appendChild(makeGrammarTab());
    });
  }
  function markTabs(kind) {
    ['#page-stats > .type-tabs', '#page-data > .type-tabs'].forEach(function (sel) {
      qa(sel + ' .type-tab').forEach(function (tab) {
        tab.classList.toggle('active', tab.dataset.type === kind);
      });
    });
  }

  /* v9.5: switchGlobalType 전역 재정의를 없애고 afterTypeSwitch 훅으로 옮겼다.
     예전에는 이 모듈과 deck-groups 가 서로를 다시 감싸며(플래그 소실) 탭 클릭 1회에
     updateWordTable 이 5회씩 돌았다. 훅은 같은 키로 멱등 등록되므로 중첩되지 않는다.

     주의: deck-groups 는 '문법'을 내부적으로 'expr' 전환으로 바꿔 실행한다.
     따라서 훅 인자만 보면 문법 탭을 눌러도 'expr' 로 보인다 → deck-groups 가
     들고 있는 uiKind 를 먼저 확인한다. */
  function resolveKind(kind) {
    var decks = window.CEMS932Decks;
    var deckKind = null;
    try { if (decks && typeof decks.uiKind === 'function') deckKind = decks.uiKind(); } catch (_) {}
    if (deckKind === 'grammar') return 'grammar';
    if (kind === 'grammar' && decks) return 'grammar';
    return ['vocab', 'phrasal', 'expr'].indexOf(kind) >= 0 ? kind : state.kind;
  }
  function installTypeHook() {
    if (!window.CEMSHooks) return;
    window.CEMSHooks.on('afterTypeSwitch', 'ui-kind', function (kind) {
      var next = resolveKind(kind);
      var changed = next !== state.kind;
      state.kind = next;
      markTabs(state.kind);
      syncStatsPanels();
      /* index.html 의 switchDataType 이 이 훅보다 먼저 updateWordTable 을 부른다.
         하지만 위 래퍼는 실제 렌더를 마이크로태스크로 미루고 그때 state.kind 를 읽으므로,
         지금(동기) 갱신한 kind 가 이미 반영된다 → 대부분 추가 호출이 필요 없다.
         예약된 렌더가 아예 없을 때만(다른 경로로 종류가 바뀐 경우) 1회 보충한다.
         결과: 탭 전환 1회당 updateWordTable 1회 (예전 5회). */
      if (changed && !state.tableRunning && !state.tablePending) {
        try { if (typeof window.updateWordTable === 'function') window.updateWordTable(); } catch (_) {}
      }
    });
  }

  /* 데이터 목록: 표현 탭 = 순수 표현만, 문법 탭 = 문법만
     v9.5(치명 C4): 예전에는 window.getAllExpr 을 임시로 바꿔치기했다가 finally 에서
     되돌렸다. updateWordTable 이 async 라 호출이 겹치면 복원 대상이 어긋나 전역이
     영구 오염됐다(표현 개수가 686 ↔ 1678 로 요동). 이제 전역은 그대로 두고
     CEMS_LENS 로 조회 결과에만 필터를 겹친다. 렌즈는 고유 id 로 등록/해제하므로
     동시 호출이 서로를 덮어쓰지 않는다. */
  function wrapWordTable() {
    if (state.tablePatched || typeof window.updateWordTable !== 'function') return;
    state.tablePatched = true;
    var base = window.updateWordTable;   // index.html 의 updateWordTable 은 인자를 받지 않는다

    function runOnce() {
      var want = state.kind === 'grammar' ? 'grammar' : (state.kind === 'expr' ? 'expression' : null);
      if (!want || !window.CEMS932Decks || !window.CEMS_LENS) return Promise.resolve(base.call(window));
      /* 렌즈가 켜져 있는 동안에는 앱 어디서 getAllExpr 을 불러도 필터가 걸린다.
         index.html 의 updateWordTable 은 맨 앞에서 getAllExpr 을 "딱 한 번" 부르고
         나머지는 동기 렌더링이다(표 1678행에 수 초). 그래서 첫 적용 뒤 스스로
         무장 해제해, 노출 구간을 "긴 렌더링 전체" → "데이터 조회 순간"으로 줄인다. */
      var used = false;
      return window.CEMS_LENS.with(function (rows, kind) {
        if (kind !== 'expr' || used) return rows;  // 표현 조회에만, 그것도 1회만
        used = true;
        return (rows || []).filter(function (row) {
          return want === 'grammar' ? isGrammarRow(row) : !isGrammarRow(row);
        });
      }, function () { return base.call(window); });
    }

    /* 렌즈는 "켜져 있는 동안" 전역 조회 결과에 걸린다. 그래서 렌즈를 잡는 구간이
       짧고 겹치지 않아야 한다. 그런데 표 하나를 그리는 데 1.5초 넘게 걸리고,
       index.html 은 탭 전환·검색·필터·더보기에서 updateWordTable 을 겹쳐 부른다.
       실측 결과 렌즈가 동시에 2개 잡힌 채로 남아, 그 사이 다른 코드가 부른
       getAllExpr 까지 문법이 걸러진 686개를 받았다.
       → 실행을 직렬화한다(트레일링 엣지). 진행 중이면 "끝난 뒤 1회 더"만 예약하므로
         렌즈는 항상 최대 1개, 마지막 요청의 state.kind 로 최종 화면이 확정된다. */
    window.updateWordTable = function () {
      if (state.tableRunning) {
        if (!state.tablePending) {
          state.tablePending = state.tableRunning
            .catch(function () {})
            .then(function () { state.tablePending = null; return window.updateWordTable(); });
        }
        return state.tablePending;
      }
      state.tableRunning = Promise.resolve()
        .then(runOnce)
        .finally(function () { state.tableRunning = null; });
      return state.tableRunning;
    };

    var title = q('#page-data .card .card-title');
    if (title && !title.dataset.cems941) title.dataset.cems941 = '1';
  }
  function dataListTitle() {
    var title = null;
    qa('#page-data .card-title').some(function (node) {
      if (/목록/.test(node.textContent)) { title = node; return true; }
      return false;
    });
    if (!title) return;
    var label = state.kind === 'grammar' ? '문법 목록'
              : state.kind === 'expr' ? '표현 목록'
              : '단어 목록';
    var refined = title.querySelector('.c943-section-title-text');
    if (refined) { refined.textContent = label; return; }
    var count = title.querySelector('span');
    var keep = count ? count.outerHTML : '';
    title.innerHTML = label + ' ' + keep;
  }

  /* ---- 3. 홈 오늘 학습 카드 ----------------------------------------------*/
  function rebuildGoalCard() {
    var card = document.getElementById('daily-goal-card');
    if (!card || card.dataset.cems941) return;
    card.dataset.cems941 = '1';
    var title = card.querySelector('.card-title .c943-section-title-text') || card.querySelector('.card-title span');
    if (title) title.textContent = '오늘 학습';

    var vocabCell = document.getElementById('daily-vocab-done');
    var row = vocabCell && vocabCell.closest('div[style*="display:flex"]');
    if (!row) return;
    var hasGrammar = !!window.CEMS932Decks;
    var grid = document.createElement('div');
    grid.className = 'cems941-goal-grid';
    if (!hasGrammar) grid.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
    grid.innerHTML =
      '<div class="cems941-goal-cell"><div class="t">📖 단어</div><div class="v"><span id="daily-vocab-done">0</span>/<span id="daily-vocab-target">20</span></div><div class="progress-bar"><div class="progress-fill" id="daily-vocab-progress" style="width:0%"></div></div></div>' +
      '<div class="cems941-goal-cell"><div class="t">💬 표현</div><div class="v"><span id="daily-expr-done">0</span>/<span id="daily-expr-target">10</span></div><div class="progress-bar"><div class="progress-fill" id="daily-expr-progress" style="width:0%"></div></div></div>' +
      (hasGrammar
        ? '<div class="cems941-goal-cell"><div class="t">🧩 문법</div><div class="v"><span id="daily-grammar-done">0</span>/<span id="daily-grammar-target">10</span></div><div class="progress-bar"><div class="progress-fill" id="daily-grammar-progress" style="width:0%"></div></div></div>'
        : '');
    row.replaceWith(grid);
  }
  function wrapDailyGoal() {
    if (state.goalPatched || typeof window.updateDailyGoal !== 'function' || typeof window.getSessions !== 'function') return;
    state.goalPatched = true;
    window.updateDailyGoal = async function cems941DailyGoal() {
      var today = new Date().toDateString();
      var sessions = [];
      try { sessions = await window.getSessions(); } catch (_) { sessions = []; }
      var todays = (sessions || []).filter(function (s) { return s && new Date(s.date).toDateString() === today; });
      var hasGrammar = !!document.getElementById('daily-grammar-done');

      var sum = { vocab: 0, expr: 0, grammar: 0 };
      todays.forEach(function (s) {
        var n = Number(s.total || 0);
        if (grammarSession(s)) { sum.grammar += n; return; }
        if (s.type === 'vocab') sum.vocab += n;
        else if (s.type === 'expr') sum.expr += n;
      });
      if (!hasGrammar) sum.expr += sum.grammar;   // 문법 열이 없는 빌드는 기존 방식 유지

      var goals = {
        vocab: parseInt(localStorage.getItem('vocabGoal') || '20', 10) || 20,
        expr: parseInt(localStorage.getItem('exprGoal') || '10', 10) || 10,
        grammar: parseInt(localStorage.getItem('grammarGoal') || '10', 10) || 10
      };
      function paint(kind) {
        var done = document.getElementById('daily-' + kind + '-done');
        if (!done) return 0;
        var target = document.getElementById('daily-' + kind + '-target');
        var bar = document.getElementById('daily-' + kind + '-progress');
        done.textContent = sum[kind];
        if (target) target.textContent = goals[kind];
        if (bar) bar.style.width = Math.min(100, Math.round(sum[kind] / goals[kind] * 100)) + '%';
        return Math.min(sum[kind], goals[kind]);
      }
      var capped = paint('vocab') + paint('expr') + (hasGrammar ? paint('grammar') : 0);
      var total = goals.vocab + goals.expr + (hasGrammar ? goals.grammar : 0);
      var pct = Math.min(100, Math.round(capped / total * 100));
      var doneEl = document.getElementById('daily-done');
      var targetEl = document.getElementById('daily-target');
      var barEl = document.getElementById('daily-total-progress');
      var pctEl = document.getElementById('daily-percent');
      if (doneEl) doneEl.textContent = capped;
      if (targetEl) targetEl.textContent = total;
      if (barEl) barEl.style.width = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
      if (pct >= 100 && localStorage.getItem('dailyGoalComplete') !== today) {
        localStorage.setItem('dailyGoalComplete', today);
        try { setTimeout(function () { window.showToast('🎉 오늘의 학습 목표 달성! 수고하셨습니다!'); }, 500); } catch (_) {}
      }
    };
  }
  function installGrammarGoalSetting() {
    if (!window.CEMS932Decks) return;
    var exprInput = document.getElementById('setting-expr-goal');
    var row = exprInput && exprInput.closest('.setting-row, .form-group, div');
    if (!exprInput || !row || document.getElementById('setting-grammar-goal')) return;
    var clone = row.cloneNode(true);
    var label = clone.querySelector('.toggle-label, .form-label, span');
    if (label) label.textContent = '🧩 문법 목표 (개)';
    var input = clone.querySelector('#setting-expr-goal');
    if (!input) return;
    input.id = 'setting-grammar-goal';
    input.value = localStorage.getItem('grammarGoal') || '10';
    input.setAttribute('onchange', "saveSetting('grammarGoal',this.value)");
    qa('button', clone).forEach(function (btn) {
      var on = btn.getAttribute('onclick') || '';
      btn.setAttribute('onclick', on.replace("'expr'", "'grammar'"));
    });
    row.insertAdjacentElement('afterend', clone);

    /* v9.5: 함수 프로퍼티 플래그(__cems941) 대신 모듈 상태로 1회 가드한다.
       예전 플래그 방식은 남이 adjustGoal 을 다시 감싸면 플래그가 사라져 중복 래핑됐다. */
    var baseAdjust = window.adjustGoal;
    if (!state.goalAdjustPatched && typeof baseAdjust === 'function') {
      state.goalAdjustPatched = true;
      window.adjustGoal = function (type, delta) {
        if (type !== 'grammar') return baseAdjust.apply(this, arguments);
        var el = document.getElementById('setting-grammar-goal');
        if (!el) return;
        var next = Math.max(1, Math.min(100, (parseInt(el.value, 10) || 10) + delta));
        el.value = String(next);
        window.saveSetting('grammarGoal', String(next));
      };
    }
  }

  /* ---- 4. 카드덱 도크 (접이식 설정 안으로 이동) ---------------------------*/
  function relocateDock() {
    var dock = document.getElementById('c86-study-dock');
    var tabs = document.getElementById('study-type-tabs');
    if (!dock || !tabs) return;
    var host = document.querySelector(
      '#study-vocab:not(.hidden) .c943-options-body, ' +
      '#study-expr:not(.hidden) .c943-options-body, ' +
      '#study-phrasal:not(.hidden) .c943-options-body, ' +
      '#study-vocab:not(.hidden) .cems941-options-body, ' +
      '#study-expr:not(.hidden) .cems941-options-body, ' +
      '#study-phrasal:not(.hidden) .cems941-options-body'
    );
    if (host) {
      var deckSlot = host.querySelector('.c943-deck-slot, .cems941-deck-slot') || host;
      if (!deckSlot.contains(dock)) deckSlot.appendChild(dock);
    } else if (tabs.nextElementSibling !== dock) {
      tabs.insertAdjacentElement('afterend', dock);
    }
    var label = dock.querySelector('.cems932-dock-label');
    if (label && label.textContent !== '카드덱') label.textContent = '카드덱';
    var button = document.getElementById('cems932-dock-scope');
    if (button) button.title = '카드덱 만들기 · 저장한 카드덱 선택';
  }

  /* ---- 5. 분석 문법 패널 ---------------------------------------------------*/
  function ensureGrammarStats() {
    if (!window.CEMS932Decks) return null;
    var host = document.getElementById('cems941-grammar-stats');
    if (host) return host;
    var page = document.getElementById('page-stats');
    var anchor = document.getElementById('cems83-dashboard');
    if (!page) return null;
    host = document.createElement('div');
    host.id = 'cems941-grammar-stats';
    host.className = 'cems941-grammar-stats';
    if (anchor) anchor.insertAdjacentElement('beforebegin', host);
    else page.appendChild(host);
    return host;
  }
  async function renderGrammarStats() {
    var host = ensureGrammarStats();
    if (!host || typeof window.getAllExpr !== 'function') return;
    var rows = [];
    try { rows = (await window.getAllExpr()).filter(isGrammarRow); } catch (_) { rows = []; }
    var now = Date.now();
    var stat = { total: rows.length, mastered: 0, weak: 0, due: 0, untouched: 0 };
    rows.forEach(function (row) {
      var mastery = Number(row.mastery || 0);
      var seen = Number(row.reviewCount || row.reps || 0) > 0;
      if (!seen) stat.untouched++;
      if (mastery >= 90) stat.mastered++;
      else if (seen && mastery < 40) stat.weak++;
      if (row.nextReview && new Date(row.nextReview).getTime() <= now) stat.due++;
    });
    var sessions = [];
    try { sessions = await window.getSessions(); } catch (_) {}
    var cut = now - 30 * 86400000;
    var recent = (sessions || []).filter(function (s) { return grammarSession(s) && new Date(s.date).getTime() >= cut; });
    var attempts = recent.reduce(function (a, s) { return a + Number(s.total || 0); }, 0);
    var correct = recent.reduce(function (a, s) { return a + Number(s.correct || 0); }, 0);
    var acc = attempts ? Math.round(correct / attempts * 100) + '%' : '-';

    host.innerHTML =
      '<div class="card"><div class="card-title">🧩 문법 현황</div>' +
        '<div class="stat-grid">' +
          '<div class="stat-item"><div class="stat-value">' + stat.total + '</div><div class="stat-label">전체 문형</div></div>' +
          '<div class="stat-item"><div class="stat-value success">' + stat.mastered + '</div><div class="stat-label">숙달</div></div>' +
          '<div class="stat-item"><div class="stat-value warning">' + stat.weak + '</div><div class="stat-label">취약</div></div>' +
          '<div class="stat-item"><div class="stat-value danger">' + stat.due + '</div><div class="stat-label">오늘 복습</div></div>' +
        '</div>' +
        '<div class="cems941-gs-note">최근 30일 문법 세션 ' + recent.length + '회 · 풀이 ' + attempts + '회 · 정답률 ' + acc +
        (stat.untouched ? ' · 미학습 ' + stat.untouched + '개' : '') + '</div>' +
      '</div>' +
      '<div class="card"><div class="card-title">🚀 바로 시작</div><div class="quick-actions">' +
        '<div class="quick-action" data-cems941-mode="expr-fc"><div class="quick-action-icon">🃏</div><div class="quick-action-label">문법 카드</div></div>' +
        '<div class="quick-action" data-cems941-mode="expr-cloze"><div class="quick-action-icon">📝</div><div class="quick-action-label">예문 빈칸</div></div>' +
        '<div class="quick-action" data-cems941-mode="expr-quiz"><div class="quick-action-icon">❓</div><div class="quick-action-label">용법 선택</div></div>' +
      '</div></div>';
    host.onclick = function (event) {
      var target = event.target.closest && event.target.closest('[data-cems941-mode]');
      if (!target) return;
      var decks = window.CEMS932Decks;
      if (decks && decks.startFilteredKind) decks.startFilteredKind('grammar', target.dataset.cems941Mode);
    };
  }
  function syncStatsPanels() {
    var grammar = state.kind === 'grammar';
    var host = document.getElementById('cems941-grammar-stats');
    var dash = document.getElementById('cems83-dashboard');
    var nav = q('#page-stats .cems-ux25-stats-nav');
    var quality = document.getElementById('c86-stats-quality');
    if (grammar) { renderGrammarStats(); host = document.getElementById('cems941-grammar-stats'); }
    if (host) host.classList.toggle('show', grammar);
    [dash, nav, quality].forEach(function (node) { if (node) node.style.display = grammar ? 'none' : ''; });
    dataListTitle();
  }

  /* ---- 부팅 ----------------------------------------------------------------*/
  /* DOM 삽입만 하는 멱등 작업. 이미 있으면 조용히 넘어가므로 몇 번 불러도 안전하다. */
  function installDom() {
    killStatusPill();
    installTabs();
    rebuildGoalCard();
    installGrammarGoalSetting();
    relocateDock();
  }
  function tick() {
    installDom();
    wrapDailyGoal();      // 모듈 상태 가드 — 두 번째 호출부터는 즉시 반환한다
    wrapWordTable();      // 모듈 상태 가드
    installTypeHook();    // 훅 등록은 같은 키로 멱등
    if (!state.synced) { state.synced = true; markTabs(state.kind); }
    try { if (typeof window.updateDailyGoal === 'function') window.updateDailyGoal(); } catch (_) {}
  }
  /* v9.5: 0ms + 500ms×8 재설치 루프를 없앴다. 래핑/훅이 전부 멱등 가드를 갖게 되어
     반복 설치가 필요 없다. 남은 것은 DOMContentLoaded 1회 + 다른 모듈(deck-groups 는
     360ms 뒤 init)이 만든 DOM 을 붙잡기 위한 안전망 1회뿐이다.
     이후 갱신은 타이머가 아니라 페이지 전환 훅으로 처리한다. */
  function start() {
    if (state.installed) return;
    state.installed = true;
    tick();
    setTimeout(tick, 700);                                   // 안전망 1회
    if (window.CEMSHooks) {
      window.CEMSHooks.on('afterPageShow', 'ui-dom', function () { installDom(); });
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) installDom(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.CEMS941UI = { VERSION: VERSION, refresh: tick, state: state };
})();
