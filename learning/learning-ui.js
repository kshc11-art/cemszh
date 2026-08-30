/* CEMS v9.4.4 Learning-first — goal-led small courses, local audit and delayed learning UI */
(function () {
  'use strict';

  var moduleRoot = window.CEMS_LEAN = window.CEMS_LEAN || {};
  var modules = moduleRoot._modules || {};
  var schema = modules.schema;
  var exercise = modules.exercise;
  var progress = modules.progress;
  var scheduler = modules.scheduler;
  var studio = modules.studio;
  var VERSION = '9.5.0';
  var LANG = (window.CEMS_LANG === 'zh' || (window.CEMS9 && CEMS9.LANG === 'zh') || (typeof DB_NAME !== 'undefined' && /ChineseVocab/.test(String(DB_NAME)))) ? 'zh' : 'en';
  var initPromise = null;
  var state = {
    ready: false,
    refreshing: null,        // 진행 중인 refreshAll 프로미스 (null = 유휴)
    refreshPending: null,    // 트레일링 엣지로 예약된 다음 1회
    pageHookInstalled: false,
    quickStartPatched: false,
    plan: null,
    unitStates: [],
    allUnitStates: [],
    courses: [],
    summary: null,
    run: null,
    lastImportReport: null,
    originalShowPage: null,
    eventsBound: false,
    studio: { prompt: '', report: null, raw: null, fileName: '', validatedSource: '' }
  };

  function qs(selector, root) { return (root || document).querySelector(selector); }
  function qsa(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]; }); }
  function text(value) { return String(value == null ? '' : value); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function toast(message) {
    try { if (typeof showToast === 'function') showToast(message); else console.log(message); }
    catch (_) { console.log(message); }
  }
  function syncLeanFocus(name) {
    var leanPage = name === 'lean' || name === 'lean-studio' || name === 'lean-run';
    document.body.classList.toggle('cems-lean-focus', leanPage);
  }
  function page(name) {
    try { if (typeof showPage === 'function') showPage(name, true); }
    catch (error) { console.error('[CEMS Lean] page', error); }
    syncLeanFocus(name);
  }
  function currentTask() { return state.run && state.run.queue[state.run.index] || null; }
  function taskTargetLabel(unit, task) {
    /* 목표 문형 자체를 제출 전에 보여 주면 guidedProduction의 무힌트 근거가 무너진다.
       학습자에게는 기능·의미만 보이고 목표어 표면형은 피드백 뒤에만 공개한다. */
    var labels = (task.targetRefs || []).map(function (id) {
      var target = (unit.targets || []).find(function (item) { return item.targetId === id; });
      if (!target) return '';
      return text(target.meaningKo || target.usageNoteKo || '').replace(/\{[^}]+\}/g, '해당 요소').replace(/해당 요소을/g, '해당 요소를').replace(/해당 요소이/g, '해당 요소가').trim();
    }).filter(Boolean);
    labels = Array.from(new Set(labels));
    return labels.join(' · ') || text(unit.functionKo || '문맥에 맞는 표현 사용');
  }
  function taskTypeLabel(task) {
    var labels = {
      contextChoice: '문맥 이해',
      listenChoiceOrDictation: task && task.listenMode === 'dictation' ? '받아쓰기' : '듣기 이해',
      cloze: '빈칸 회상',
      tokenOrder: '어순 배열',
      transform: '문장 변형',
      guidedProduction: '문장 만들기',
      errorCorrection: '오류 고치기'
    };
    return labels[text(task && task.type)] || '학습 문제';
  }
  function unitTitle(record) { return record.functionKo || record.unit.functionKo || record.unitId; }
  function percent(value) { return Math.round(Number(value || 0) * 100); }
  function shortDate(value) {
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return (date.getMonth() + 1) + '월 ' + date.getDate() + '일';
  }
  function metric(summary) {
    if (!summary || summary.total < 5) return '<b>자료 부족</b><span>' + (summary ? summary.total : 0) + '문항</span>';
    return '<b>' + percent(summary.rate) + '%</b><span>' + summary.total + '문항</span>';
  }
  function delayedMetric(summary) {
    if (!summary || !summary.total) return '<b>미측정</b><span>첫 시도 기록 없음</span>';
    return '<b>' + Number(summary.independent || 0) + '/' + Number(summary.total || 0) + '</b><span>' + percent(summary.rate) + '% · 첫 시도' + (summary.total < 5 ? ' · 초기 표본' : '') + '</span>';
  }
  function baselineMetric(summary) {
    if (!summary || !summary.total) return '<b>미측정</b><span>학습 전 기록 없음</span>';
    return '<b>' + Number(summary.total || 0) + '건</b><span>완료 · 성공 여부 비공개</span>';
  }
  function pairedMetric(summary) {
    summary = summary || {};
    var paired = Number(summary.paired || 0);
    if (!paired || summary.deltaPercentagePoints == null) return '<b>비교 전</b><span>짝지은 단원 0개</span>';
    var delta = Number(summary.deltaPercentagePoints || 0);
    var deltaText = (delta > 0 ? '+' : '') + delta.toFixed(1) + '%p';
    return '<b>' + deltaText + '</b><span>동일 핵심 수행 n=' + paired + ' · 향상 ' + Number(summary.improved || 0) + ' · 유지 ' + Number(summary.maintained || 0) + ' · 하락 ' + Number(summary.declined || 0) + (summary.constructMismatch ? ' · 구성 불일치 제외 ' + Number(summary.constructMismatch) : '') + '</span>';
  }
  function issueHtml(report) {
    if (!report) return '';
    var errors = report.issues.filter(function (item) { return item.severity === 'error'; });
    var warnings = report.issues.filter(function (item) { return item.severity === 'warning'; });
    var compactWarnings = warnings.filter(function (item) { return item.code !== 'qa.language' && item.code !== 'course.qa.language'; });
    var hiddenQaWarnings = warnings.length - compactWarnings.length;
    var visible = errors.concat(compactWarnings).slice(0, 8);
    var items = visible.map(function (item) {
      return '<li class="cems-lean-issue ' + esc(item.severity) + '"><strong>' + esc(item.code) + '</strong><span>' + esc(item.message) + '</span><small>' + esc(item.path) + '</small></li>';
    }).join('');
    var summary = (errors.length ? '최근 가져오기 차단' : '최근 가져오기 검사 통과') + ' · 오류 ' + errors.length + ' · 경고 ' + warnings.length;
    var note = hiddenQaWarnings ? '<p>사람 미검수 상태 경고 ' + hiddenQaWarnings + '건은 한 줄로 요약했습니다. 자동 검사는 자연스러움을 보증하지 않습니다.</p>' : '';
    return '<details class="cems-lean-import-report ' + (errors.length ? 'blocked' : 'ok') + '" ' + (errors.length ? 'open' : '') + '><summary>' + esc(summary) + '</summary>' + note + (items ? '<ul>' + items + '</ul>' : '') + '</details>';
  }

  function pageMarkup() {
    return '<div id="page-lean" class="page"><div class="cems-lean-shell">' +
      '<header class="cems-lean-header"><div><div class="cems-lean-eyebrow">CEMS Learning 9.2.6</div><h1>실전 문맥 코스</h1><p>생활 기능을 문맥에서 이해하고 직접 산출한 뒤, 새 문맥과 지연 확인으로 검증합니다.</p></div><button class="btn btn-secondary cems-lean-icon" data-lean-action="go-home" aria-label="홈">⌂</button></header>' +
      '<div id="cems-lean-dashboard"></div></div></div>' +
      '<div id="page-lean-run" class="page"><div id="cems-lean-run-host" class="cems-lean-run"></div></div>' +
      '<div id="page-lean-studio" class="page"><div class="cems-lean-shell cems-lean-studio-shell">' +
        '<header class="cems-lean-header"><div><div class="cems-lean-eyebrow">오프라인 셀프서비스</div><h1>학습 콘텐츠 추가</h1><p>한 번의 언어별 프롬프트와 로컬 자동 검사로 작은 코스 팩을 추가합니다.</p></div><button class="btn btn-secondary cems-lean-icon" data-lean-action="go-lean" aria-label="뒤로">←</button></header>' +
        '<section class="cems-lean-studio-intro"><strong>8단원은 시작 코스입니다</strong><p>앞으로 필요한 주제마다 1~4단원짜리 작은 팩을 한 번의 프롬프트로 만들고, 앱의 구조·누출·실제 채점 검사를 통과한 뒤 별도 코스로 추가하십시오. 상시 API 연결은 필요하지 않습니다.</p><ol><li>목표를 적고 프롬프트 복사</li><li>사용 중인 생성형 모델에 붙여넣기</li><li>반환 JSON을 여기 붙여넣기</li><li>로컬 검사 통과 후 명시적으로 추가</li></ol></section>' +
        '<section class="cems-lean-studio-card"><span class="cems-lean-step">1</span><h2>작은 코스 설계</h2><p>대량 생성보다 1~4단원씩 실제로 사용하고 고치는 편이 안전합니다.</p>' +
          '<label>코스 제목<input class="form-input" data-studio-field="titleKo" maxlength="80" placeholder="예: 분실물 찾기 실전 코스"></label>' +
          '<div class="cems-lean-studio-grid"><label>수준<select class="form-input" data-studio-field="level"><option>A1</option><option selected>A2</option><option>B1</option></select></label><label>단원 수<select class="form-input" data-studio-field="unitCount"><option>1</option><option selected>2</option><option>3</option><option>4</option></select></label></div>' +
          '<label>집중할 생활 기능<textarea class="form-input" data-studio-field="focusKo" rows="3" maxlength="300" placeholder="예: 분실물을 설명하고 보관 여부와 수령 방법을 확인하기"></textarea></label>' +
          '<label>피할 주제·이미 충분한 항목<textarea class="form-input" data-studio-field="avoidKo" rows="2" maxlength="240" placeholder="선택 사항"></textarea></label>' +
          '<div class="cems-lean-studio-actions"><button class="btn btn-primary" data-lean-action="studio-build-prompt">언어별 프롬프트 만들기</button><button class="btn btn-secondary" data-lean-action="studio-copy-prompt" disabled>복사</button><button class="btn btn-secondary" data-lean-action="studio-download-prompt" disabled>저장</button></div>' +
          '<textarea id="cems-lean-studio-prompt" class="form-input cems-lean-code" rows="8" readonly placeholder="여기에 하나의 완성형 프롬프트가 생성됩니다."></textarea>' +
          '<button class="btn btn-secondary" data-lean-action="studio-download-guide">오프라인 추가 가이드 저장</button>' +
        '</section>' +
        '<section class="cems-lean-studio-card"><span class="cems-lean-step">2</span><h2>JSON 검사와 추가</h2><p>사람 검수 완료라고 표시하지 않으며, 구조·실제 채점·연습/평가 누출·언어별 핵심 규칙을 기기 안에서 검사합니다.</p>' +
          '<textarea id="cems-lean-studio-json" class="form-input cems-lean-code" rows="12" maxlength="2097152" placeholder="생성된 JSON 객체를 붙여넣으세요."></textarea>' +
          '<input id="cems-lean-studio-file" class="cems-lean-file" type="file" accept="application/json,.json">' +
          '<div class="cems-lean-studio-actions vertical"><button class="btn btn-secondary" data-lean-action="studio-open-file">JSON 파일 열기</button><button class="btn btn-primary" data-lean-action="studio-validate">로컬 자동 검사</button></div>' +
          '<div class="cems-lean-studio-result">JSON을 붙여넣고 로컬 자동 검사를 실행하십시오. 파일의 사람 검수 주장은 무시됩니다.</div>' +
          '<button class="btn btn-primary" data-lean-action="studio-import" disabled>검사 통과 코스로 추가</button>' +
        '</section>' +
        '<section class="cems-lean-studio-card"><span class="cems-lean-step">3</span><h2>추가 및 사용 중 수정</h2><p>자동 검사는 자연스러움을 완벽히 보증하지 못합니다. 실제 학습 중 발견한 문제만 모아 조건부 수리 프롬프트로 고칩니다.</p>' +
          '<div id="cems-lean-studio-issues" class="cems-lean-studio-result"></div>' +
          '<div class="cems-lean-studio-actions vertical"><button class="btn btn-secondary" data-lean-action="studio-copy-repair" disabled>수리 프롬프트 복사</button><button class="btn btn-secondary" data-lean-action="studio-download-repair" disabled>수리문 저장</button><button class="btn btn-secondary" data-lean-action="studio-export-issues" disabled>오류 묶음 저장</button><button class="btn btn-secondary" data-lean-action="studio-clear-issues" disabled>오류 기록 비우기</button><button class="btn btn-secondary" data-lean-action="export-active-course">현재 활성 코스 JSON 저장</button></div>' +
        '</section>' +
      '</div></div>' +
      '<input id="cems-lean-import-file" class="cems-lean-file" type="file" accept="application/json,.json">';
  }
  function homeCardMarkup() {
    return '<div class="card cems-lean-home cems-lf-home-goal" id="cems-lean-home-card">' +
      '<div class="cems-lean-home-top"><div><div class="card-title">오늘의 목표</div><div class="cems-lean-home-sub" id="cems-lean-home-meta">학습 계획을 정리하는 중입니다.</div></div><span class="cems-lf-time" id="cems-lean-home-time">약 --분</span></div>' +
      '<section class="cems-lf-goal-focus"><small>다음 학습</small><strong id="cems-lean-home-next">학습 계획을 불러오는 중입니다.</strong><p id="cems-lean-home-reason">지연 확인과 오류 보완을 우선합니다.</p></section>' +
      '<div class="cems-lean-plan-counts cems-lf-plan-queue" id="cems-lean-home-counts"></div>' +
      '<div class="cems-lf-home-course" id="cems-lean-home-course"></div>' +
      '<div class="cems-lean-home-actions"><button class="btn btn-primary" data-lean-action="start-today">목표 시작</button><button class="btn btn-secondary" data-lean-action="open-dashboard">계획·코스 보기</button></div>' +
      '</div>';
  }
  function injectUi() {
    if (!qs('#page-lean')) {
      var app = qs('.app');
      if (app) app.insertAdjacentHTML('beforeend', pageMarkup());
      else document.body.insertAdjacentHTML('beforeend', pageMarkup());
    }
    /* v9.4.4-r3: keep the original Home hierarchy. The learning dashboard
       remains available on its own page, but it is no longer injected above
       the legacy daily-goal and quick-start cards. */
    var legacyHomeCard = qs('#cems-lean-home-card');
    if (legacyHomeCard) legacyHomeCard.remove();
  }
  function planCountsHtml(plan) {
    var steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
    if (!steps.length) return '<div class="cems-lf-plan-complete"><span>✓</span><div><b>오늘 목표 완료</b><small>새 일정이 생기면 여기에 표시됩니다.</small></div></div>';
    return steps.map(function (step, index) {
      var unit = step.id === 'course' ? '단원' : '개';
      return '<div class="cems-lf-plan-step ' + (index === 0 ? 'next' : '') + '"><span>' + (index + 1) + '</span><div><b>' + esc(step.label) + '</b><small>' + esc(step.detail || '') + '</small></div><em>' + Number(step.count || 0) + unit + '</em></div>';
    }).join('');
  }
  function nextActionText(plan) {
    if (!plan || !plan.action) return '오늘 예정된 학습을 모두 마쳤습니다.';
    var action = plan.action;
    if (action.kind === 'baseline') return '학습 전 기준선 · ' + unitTitle(action.state.record);
    if (action.kind === 'benchmark') {
      var first = (action.benchmarks || [])[0];
      return (first && first.phase === 'retention' ? '14일 유지 확인 · ' : '3일 새 문맥 확인 · ') + unitTitle(action.state.record);
    }
    if (action.kind === 'repair') return '오류 보완 · ' + unitTitle(action.state.record);
    if (action.kind === 'legacy') return '카드 복습 · ' + Number(plan.reviewCount || 0) + '개';
    if (action.kind === 'continueUnit') return '진행 단원 · ' + unitTitle(action.state.record);
    return '새 단원 · ' + unitTitle(action.state.record);
  }
  function renderHome() {
    var plan = state.plan || {};
    var counts = qs('#cems-lean-home-counts'), next = qs('#cems-lean-home-next'), reason = qs('#cems-lean-home-reason');
    if (counts) counts.innerHTML = planCountsHtml(plan);
    if (next) next.textContent = nextActionText(plan);
    if (reason) reason.textContent = nextActionReason(plan);
    var time = qs('#cems-lean-home-time');
    if (time) time.textContent = plan.action ? '약 ' + Number(plan.estimatedMinutes || 1) + '분' : '완료';
    var meta = qs('#cems-lean-home-meta');
    if (meta) meta.textContent = plan.action ? '우선순위에 따라 ' + Number((plan.steps || []).length) + '단계로 정리했습니다.' : '새 일정이 생기면 자동으로 갱신됩니다.';
    var course = qs('#cems-lean-home-course');
    if (course) course.innerHTML = activeCourseSummary();
    var button = qs('#cems-lean-home-card [data-lean-action="start-today"]');
    if (button) { button.disabled = !plan.action; button.textContent = actionButtonText(plan); }
  }

  function nextActionReason(plan) {
    if (!plan || !plan.action) return '오늘은 추가로 해야 할 항목이 없습니다.';
    var action = plan.action;
    if (action.kind === 'baseline') return '학습 전 상태를 가린 채 저장해 이후 새 문맥·지연 결과와 비교합니다.';
    if (action.kind === 'benchmark') return '같은 답을 다시 외우는 대신 다른 문맥의 첫 시도만 확인합니다.';
    if (action.kind === 'repair') return '정답을 본 문장이 아니라 다른 변형으로 오류를 다시 고칩니다.';
    if (action.kind === 'continueUnit') return '끊긴 문맥→회상→산출 흐름을 먼저 마쳐 학습 단위를 완결합니다.';
    if (action.kind === 'legacy') return '복습 예정 카드와 아직 시작하지 않은 신규 카드를 작은 묶음으로 학습합니다.';
    return '생활 기능 하나를 문맥에서 이해하고 선택지 없는 짧은 산출까지 진행합니다.';
  }
  function actionButtonText(plan) {
    if (!plan || !plan.action) return '오늘 목표 완료';
    var action = plan.action;
    if (action.kind === 'baseline') return '기준선 시작';
    if (action.kind === 'benchmark') return ((action.benchmarks || [])[0] || {}).phase === 'retention' ? '유지 확인 시작' : '전이 확인 시작';
    if (action.kind === 'repair') return '오류 보완 시작';
    if (action.kind === 'continueUnit') return '이어서 학습';
    if (action.kind === 'legacy') return '카드 복습 시작';
    return '새 단원 시작';
  }
  function activeCourseSummary() {
    var active = (state.courses || []).find(function (row) { return row.active; });
    if (!active) return '<span>활성 코스</span><strong>코스를 준비하는 중입니다.</strong>';
    var current = (state.unitStates || []).find(function (row) { return row.started && !row.complete; }) || (state.unitStates || []).find(function (row) { return !row.started && row.unlocked; });
    return '<span>활성 코스</span><strong>' + esc(active.titleKo) + '</strong><small>' + (current ? '다음: ' + esc(unitTitle(current.record)) : active.completedCount + '/' + active.unitCount + '단원 완료') + '</small>';
  }
  function courseCardsHtml() {
    var courses = state.courses || [];
    if (!courses.length) return '<div class="cems-lean-empty">설치된 코스가 없습니다.</div>';
    return courses.map(function (course) {
      var label = course.builtIn ? '내장 시작 코스' : '사용자 추가';
      return '<article class="cems-lean-course-card ' + (course.active ? 'active' : '') + '"><div><span>' + esc(label) + '</span><strong>' + esc(course.titleKo) + '</strong><small>' + course.completedCount + '/' + course.unitCount + '단원 완료</small></div><button class="btn ' + (course.active ? 'btn-primary' : 'btn-secondary') + '" data-lean-action="set-active-course" data-course-id="' + esc(course.courseId) + '" ' + (course.active ? 'disabled' : '') + '>' + (course.active ? '현재 학습 코스' : '이 코스 학습') + '</button></article>';
    }).join('');
  }

  function unitCardsHtml() {
    if (!state.unitStates.length) return '<div class="cems-lean-empty">활성 코스에 단원이 없습니다.</div>';
    return state.unitStates.map(function (unitState) {
      var record = unitState.record, completion = unitState.completion, checks = unitState.benchmarks || {};
      var ratio = completion.total ? Math.round(completion.completed / completion.total * 100) : 0;
      var courseTotal = state.unitStates.filter(function (item) { return item.record.courseId === record.courseId; }).length || state.unitStates.length;
      var status = '새 단원', detail = '학습 전', button = '단원 시작', disabled = false;
      if (!unitState.unlocked) { status = '잠김'; detail = '선행 단원 완료 후 열림'; button = '선행 단원 필요'; disabled = true; }
      else if (!checks.baselineSatisfied) { status = '기준선 필요'; detail = '정답을 보지 않은 첫 산출 1문항'; button = '학습 전 기준선'; }
      else if (checks.baselineNotEligible && !unitState.started) { detail = '기존 노출 기록이 있어 기준선 제외'; }
      if (unitState.unlocked && unitState.started && !unitState.complete) { status = '진행 중'; detail = '핵심 과제 진행 중'; button = '계속 학습'; }
      if (unitState.unlocked && unitState.complete) {
        status = '학습 완료'; button = '예약일에 자동 확인'; disabled = true; detail = '정답 재노출을 막고 지연 확인의 첫 시도를 보존합니다.';
        var failed = (checks.completed || []).filter(function (row) { return row.phase !== 'baseline' && row.result === 'failed'; }).length;
        if (checks.retentionCompleted) {
          status = checks.retentionConfirmed ? '유지 확인' : '유지 미확인';
          detail = checks.retentionConfirmed ? '최소 14일 뒤 다른 문맥의 첫 시도 성공' : '유지 첫 시도 실패 · 결과는 연습과 분리됨';
          button = checks.retentionConfirmed ? '유지 확인 완료' : '오류 보완 예약됨';
        } else if (checks.due && checks.due.some(function (row) { return row.phase === 'retention'; })) {
          status = '유지 확인 필요'; detail = '최소 14일 유지 문항이 열렸습니다.'; button = '유지 확인'; disabled = false;
        } else if (checks.transferCompleted) {
          status = checks.transferConfirmed ? '전이 확인' : checks.transferMissed ? '전이 미실시' : '전이 미확인';
          if (checks.transferMissed) detail = checks.nextDueAt ? '3일 전이 창을 놓침 · 유지 확인 ' + shortDate(checks.nextDueAt) : '3일 전이 창을 놓쳤습니다.';
          else detail = checks.nextDueAt ? (checks.transferConfirmed ? '새 문맥 첫 시도 성공 · 유지 확인 ' : '새 문맥 첫 시도 실패 · 유지 확인 ') + shortDate(checks.nextDueAt) : (checks.transferConfirmed ? '새 문맥 첫 시도 성공' : '새 문맥 첫 시도 실패');
          button = '다음 확인 대기';
        } else if (checks.due && checks.due.some(function (row) { return row.phase === 'transfer'; })) {
          status = '전이 확인 필요'; detail = '3일 전이 문항이 열렸습니다.'; button = '전이 확인'; disabled = false;
        } else if (checks.nextDueAt) {
          status = '전이 예정'; detail = shortDate(checks.nextDueAt) + ' 이후 첫 시도';
        }
        if (failed && !checks.retentionCompleted && !checks.transferMissed) detail += ' · 오류 보완 예약됨';
      }
      var qa = record.qa || record.unit.qa || {};
      var qaBadge = qa.languageReviewed === true ? '<span class="cems-lean-qa reviewed">사람 검수</span>' : '<span class="cems-lean-qa draft">자동 검사</span>';
      return '<article class="cems-lean-unit ' + (!unitState.unlocked ? 'locked' : '') + '"><div class="cems-lean-unit-head"><div><em>' + Number(record.sequence || 0) + '/' + courseTotal + '</em><strong>' + esc(unitTitle(record)) + '</strong><small>' + esc(record.situationKo || '') + '</small></div><div class="cems-lean-unit-badges"><span>' + esc(status) + '</span>' + qaBadge + '</div></div>' +
        '<div class="cems-lean-progress"><i style="width:' + ratio + '%"></i></div><div class="cems-lean-unit-meta">과제 ' + completion.completed + '/' + completion.total + ' · ' + esc(detail) + ' · v' + record.version + '</div>' +
        '<button class="btn btn-secondary" data-lean-action="start-unit" data-unit-id="' + esc(record.unitId) + '" ' + (disabled ? 'disabled' : '') + '>' + esc(button) + '</button></article>';
    }).join('');
  }
  function evidenceRate(value) { return Math.round(Number(value || 0) * 100); }
  function pairedEvidenceCard(summary, title, description) {
    summary = summary || {};
    var paired = Number(summary.paired || 0);
    if (!paired || summary.deltaPercentagePoints == null) {
      return '<article class="cems-lf-paired-card pending"><span>' + esc(title) + '</span><strong>측정 전</strong><p>' + esc(description) + '</p><small>기준선과 대응 결과가 모두 있는 단원 0개</small></article>';
    }
    var delta = Number(summary.deltaPercentagePoints || 0);
    var cls = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral';
    var deltaText = (delta > 0 ? '+' : '') + delta.toFixed(1) + '%p';
    return '<article class="cems-lf-paired-card ' + cls + '"><span>' + esc(title) + '</span><strong>' + deltaText + '</strong><p>' + esc(description) + '</p><div class="cems-lf-rate-compare"><b>학습 전 ' + evidenceRate(summary.baselineRate) + '%</b><i>→</i><b>확인 시점 ' + evidenceRate(summary.endpointRate) + '%</b></div><small>짝지은 단원 n=' + paired + ' · 향상 ' + Number(summary.improved || 0) + ' · 유지 ' + Number(summary.maintained || 0) + ' · 하락 ' + Number(summary.declined || 0) + '</small></article>';
  }
  function currentSkillRow(label, summary, note, tone) {
    summary = summary || {};
    var total = Number(summary.total || 0), independent = Number(summary.independent || 0), rate = summary.rate == null ? 0 : evidenceRate(summary.rate);
    var value = total < 5 ? '자료 부족' : independent + '/' + total + ' · ' + rate + '%';
    return '<div class="cems-lf-skill-row ' + esc(tone || '') + '"><div><span>' + esc(label) + '</span><strong>' + value + '</strong><small>' + esc(note) + ' · n=' + total + '</small></div><div class="cems-lf-skill-track" aria-hidden="true"><i style="width:' + (total ? rate : 0) + '%"></i></div></div>';
  }
  function performanceGapText(summary) {
    var c = summary && summary.comprehension || {}, p = summary && summary.production || {};
    if (Number(c.total || 0) < 5 || Number(p.total || 0) < 5) return '이해와 산출이 각각 5문항 이상 쌓이면 두 능력의 차이에 맞춰 다음 연습을 안내합니다.';
    var gap = Math.round((Number(c.rate || 0) - Number(p.rate || 0)) * 100);
    if (gap >= 15) return '문맥을 알아보는 능력보다 직접 만드는 능력이 ' + gap + '%p 낮습니다. 빈칸보다 문장 변형·직접 입력을 우선하십시오.';
    if (gap <= -15) return '현재 표본에서는 산출 결과가 이해보다 높습니다. 새로운 읽기·듣기 문맥 표본을 더 쌓아 균형을 확인하십시오.';
    return '현재 이해와 산출의 차이는 ' + Math.abs(gap) + '%p입니다. 두 경로가 비교적 균형을 이루고 있습니다.';
  }
  function statsHtml() {
    var summary = state.summary || {};
    var recent = summary.recent30 || summary;
    var activeCourse = (state.courses || []).find(function (row) { return row.active; });
    var completed = activeCourse ? Number(activeCourse.completedCount || 0) : Number(summary.course && summary.course.completedUnits || 0);
    var totalUnits = activeCourse ? Number(activeCourse.unitCount || 0) : Number(summary.course && summary.course.totalUnits || 0);
    var results = recent.results || { independent: 0, assisted: 0, failed: 0 };
    var independent = Number(results.independent || 0), assisted = Number(results.assisted || 0), failed = Number(results.failed || 0), resultTotal = independent + assisted + failed;
    function outcomeWidth(value) { return resultTotal ? Math.max(value ? 2 : 0, value / resultTotal * 100) : 0; }
    var outcome = resultTotal ? '<section class="cems-lf-outcomes"><div class="cems-lf-section-head"><div><span>최근 30일</span><strong>첫 결과 분포</strong></div><b>n=' + resultTotal + '</b></div><div class="cems-lf-outcome-bar"><i class="independent" style="width:' + outcomeWidth(independent) + '%"></i><i class="assisted" style="width:' + outcomeWidth(assisted) + '%"></i><i class="failed" style="width:' + outcomeWidth(failed) + '%"></i></div><div class="cems-lf-outcome-legend"><span><i class="independent"></i>혼자 해결 <b>' + independent + '</b></span><span><i class="assisted"></i>도움받음 <b>' + assisted + '</b></span><span><i class="failed"></i>다시 복습 <b>' + failed + '</b></span></div></section>' : '<section class="cems-lf-outcomes empty"><strong>최근 30일 본 학습 기록이 없습니다.</strong><span>단원을 시작하면 혼자 해결·도움·실패를 분리해 표시합니다.</span></section>';
    var errors = recent.topErrors && recent.topErrors.length ? recent.topErrors.map(function (row) { return '<span>' + esc(row.errorCode) + ' · ' + row.count + '</span>'; }).join('') : '<span>반복 오류 없음</span>';
    return '<section class="cems-lf-evidence-intro"><div><span>가장 중요한 근거</span><h3>새 문맥 적용과 지연 유지</h3><p>같은 문제 정답률보다 학습 전 기준선과 다른 문맥의 첫 시도를 짝지어 봅니다.</p></div><div class="cems-lf-course-evidence"><b>' + completed + '/' + totalUnits + '</b><span>활성 코스 완료</span></div></section>' +
      '<div class="cems-lf-paired-grid">' + pairedEvidenceCard(summary.baselineToTransfer, '기준선 → 3일 전이', '표면 문장이 다른 새 문맥에 적용했는지 봅니다.') + pairedEvidenceCard(summary.baselineToRetention, '기준선 → 14일 유지', '최소 14일 뒤에도 독립 산출이 남았는지 봅니다.') + '</div>' +
      '<section class="cems-lf-evidence-card"><div class="cems-lf-section-head"><div><span>현재 수행</span><strong>최근 30일 무힌트 결과</strong></div><b>표본 5개부터 비율 표시</b></div>' + currentSkillRow('문맥 이해', recent.comprehension, '읽기·듣기에서 첫 시도 독립 성공', 'comprehension') + currentSkillRow('짧은 산출', recent.production, '선택지 없이 직접 입력한 첫 시도', 'production') + currentSkillRow('힌트 의존', recent.hintDependence && { total: recent.hintDependence.total, independent: recent.hintDependence.used, rate: recent.hintDependence.rate }, '힌트 또는 텍스트 대체 사용', 'hint') + '<p class="cems-lf-gap-note">' + esc(performanceGapText(recent)) + '</p></section>' +
      outcome +
      '<section class="cems-lf-evidence-card cems-lf-next-actions"><div class="cems-lf-section-head"><div><span>다음 조정</span><strong>학습에 바로 반영할 신호</strong></div></div><div class="cems-lf-action-grid"><div><b>' + Number(summary.openRepairs || 0) + '</b><span>미해결 오류 보완</span></div><div><b>' + Number(summary.missedTransfers || 0) + '</b><span>놓친 3일 전이</span></div><div><b>' + Number(summary.repairAttempts && summary.repairAttempts.failed || 0) + '</b><span>보완 후 재실패</span></div></div><div class="cems-lean-errors"><strong>최근 반복 오류</strong><div>' + errors + '</div></div></section>' +
      '<details class="cems-lf-method"><summary>측정 방법·해석 범위·내보내기</summary><p>기준선 성공 여부는 대응하는 D3·D14 결과가 생기기 전에는 공개하지 않습니다. 최근 수행은 30일 창, 지연 변화는 동일 핵심 수행의 누적 짝 표본입니다. 카드 FSRS 기억률은 별도 보조 통계이며 이 수치와 합산하지 않습니다. 이 결과를 자유 회화·발음·장문 작문이나 CEFR·HSK 등급으로 환산하지 않습니다. 자동 검사는 구조와 채점을 확인하지만 원어민 자연스러움을 완벽히 보증하지 않습니다.</p><div class="cems-lean-export-actions"><button class="btn btn-secondary" data-lean-action="export-pilot-json">JSON 집계</button><button class="btn btn-secondary" data-lean-action="export-pilot-csv">CSV 집계</button></div></details>';
  }

  function renderDashboard() {
    var host = qs('#cems-lean-dashboard');
    if (!host) return;
    var plan = state.plan || {};
    host.innerHTML = '<section class="cems-lean-hero cems-lf-goal-hero"><div class="cems-lf-hero-head"><div><span>오늘의 목표</span><strong>' + esc(nextActionText(plan)) + '</strong><p>' + esc(nextActionReason(plan)) + '</p></div><em>' + (plan.action ? '약 ' + Number(plan.estimatedMinutes || 1) + '분' : '완료') + '</em></div><div class="cems-lean-plan-counts cems-lf-plan-queue">' + planCountsHtml(plan) + '</div><div class="cems-lf-dashboard-course">' + activeCourseSummary() + '</div><button class="btn btn-primary" data-lean-action="start-today" ' + (!plan.action ? 'disabled' : '') + '>' + actionButtonText(plan) + '</button></section>' +
      '<section class="cems-lean-section cems-lf-course-section"><div class="cems-lean-section-title"><div><h2>학습 코스</h2><p>새 단원은 활성 코스에서만 이어가고, 다른 코스의 열린 전이·유지 확인은 오늘 목표에 남깁니다.</p></div></div><div class="cems-lean-courses">' + courseCardsHtml() + '</div><div class="cems-lean-expand"><span>코스 확장</span><h2>내장 8단원은 시작 코스입니다</h2><p>필요한 생활 기능을 1~4단원씩 만들고 로컬 검사 후 별도 코스로 추가합니다.</p><button class="btn btn-secondary" data-lean-action="open-studio">학습 콘텐츠 추가</button></div></section>' +
      '<section class="cems-lean-section cems-lf-units-section"><div class="cems-lean-section-title"><div><h2>활성 코스 단원</h2><p>선행 단원을 마치면 다음 단원이 열리며 새 단원은 하루 최대 하나입니다.</p></div><button class="btn btn-secondary" data-lean-action="open-studio">코스 추가·검사</button></div><div class="cems-lean-units">' + unitCardsHtml() + '</div>' + issueHtml(state.lastImportReport) + '</section>' +
      '<details class="cems-lean-section cems-lean-stats-details" open><summary><div><h2>학습 근거</h2><p>문제 수보다 새 문맥 적용·지연 유지·무힌트 산출을 우선합니다.</p></div><span>펼치기</span></summary>' + statsHtml() + '</details>';
    try { window.dispatchEvent(new CustomEvent('cems:lean-dashboard-rendered')); } catch (_) {}
  }
  async function refreshOnce() {
    try {
      var results = await Promise.all([scheduler.buildTodayPlan(LANG), progress.getProgressSummary(LANG)]);
      state.plan = results[0];
      state.unitStates = state.plan.unitStates || [];
      state.allUnitStates = state.plan.allUnitStates || state.unitStates;
      state.courses = state.plan.courses || [];
      state.summary = results[1];
      renderHome(); renderDashboard(); renderStudio();
    } catch (error) {
      console.error('[CEMS Lean] refresh', error);
      toast('Lean 학습 계획을 불러오지 못했습니다: ' + error.message);
    }
  }
  /* v9.5: 재진입 요청을 버리지 않는다(트레일링 엣지).
     예전에는 `if (state.refreshing) return;` 로 즉시 반환해서, 겹쳐 들어온 호출이
     아무 일도 하지 않고 undefined 를 돌려줬다. `await refreshAll()` 한 호출자는
     "갱신이 끝났다"고 오인했고, 진행 중이던 갱신은 그 호출자의 변경분을 보지 못한
     상태로 끝나 화면이 낡은 채로 남았다.
     이제 진행 중이면 "끝난 뒤 1회 더" 를 예약하고, 호출자에게는 그 완료를 기다리는
     프로미스를 돌려준다. 여러 번 겹쳐 들어와도 뒤따르는 실행은 1회로 합쳐진다. */
  function refreshAll() {
    if (state.refreshing) {
      if (!state.refreshPending) {
        state.refreshPending = state.refreshing
          .catch(function () {})
          .then(function () {
            state.refreshPending = null;
            return refreshAll();
          });
      }
      return state.refreshPending;
    }
    state.refreshing = refreshOnce().finally(function () { state.refreshing = null; });
    return state.refreshing;
  }
  async function importUnit(raw, options) {
    options = options || {};
    var report = schema.validateAndNormalize(raw, LANG);
    state.lastImportReport = report;
    if (!report.valid) {
      var error = new Error('단원 검사에서 차단 오류가 발견되었습니다.');
      error.code = 'VALIDATION_FAILED'; error.report = report;
      renderDashboard(); throw error;
    }
    var result = await progress.saveUnit(report.unit, options.source || { type: 'local_json' }, !!options.overwrite);
    await refreshAll();
    return { report: report, result: result };
  }
  async function importPack(raw, options) {
    options = options || {};
    var report = options.report || schema.validatePackAndNormalize(raw, LANG);
    state.lastImportReport = report;
    if (!report.valid) {
      var error = new Error('콘텐츠 팩 검사에서 차단 오류가 발견되었습니다.');
      error.code = 'VALIDATION_FAILED'; error.report = report;
      renderDashboard(); throw error;
    }
    var packSource = Object.assign({}, options.source || { type: 'local_pack' }, { packId: report.pack.packId, packVersion: Number(report.pack.version || 1) });
    var result = await progress.saveUnitPack(report.pack, packSource, !!options.overwrite);
    if (options.activate !== false && scheduler.setActiveCourseId) scheduler.setActiveCourseId(LANG, report.pack.packId);
    await refreshAll();
    return { report: report, result: result };
  }
  async function ensureBuiltInPack() {
    try {
      var response = await fetch('./content/lean_pack.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var pack = await response.json();
      var report = schema.validatePackAndNormalize(pack, LANG);
      if (!report.valid) throw new Error('내장 팩 검증 실패: ' + report.issues.filter(function (item) { return item.severity === 'error'; }).map(function (item) { return item.code; }).join(', '));
      await progress.saveUnitPack(report.pack, { type: 'built_in_pack', fileName: 'lean_pack.json', packId: report.pack.packId, packVersion: Number(report.pack.version || 1) }, false);
    } catch (error) {
      if (error.code !== 'PACK_CONFLICT') console.warn('[CEMS Lean] built-in pack import', error);
    }
  }
  function newTaskState() {
    return {
      response: { text: '', optionId: null, tokenIds: [] },
      attemptId: progress.uid('attempt'),
      hintsUsed: 0,
      hintsAtFirstSubmission: 0,
      firstResponseNormalized: null,
      firstSubmittedAt: null,
      assistanceUsed: false,
      saving: false,
      firstAttemptCorrect: null,
      firstErrorCode: null,
      retryCount: 0,
      phase: 'answer',
      grade: null,
      finalized: false,
      finalResult: null,
      transcriptVisible: false,
      startedAt: progress.nowIso ? progress.nowIso() : new Date().toISOString()
    };
  }
  function suppressLegacyOnboarding() {
    var overlay = document.getElementById('cems-ux-onboard');
    if (!overlay) return;
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
  }
  function startRun(record, queue, kind) {
    suppressLegacyOnboarding();
    setTimeout(suppressLegacyOnboarding, 350);
    setTimeout(suppressLegacyOnboarding, 1450);
    if (!record || !queue || !queue.length) { toast('실행할 과제가 없습니다.'); return false; }
    state.run = {
      unitRecord: record,
      unit: record.unit,
      queue: queue,
      kind: kind || 'unit',
      index: 0,
      sessionId: progress.uid('lean-session'),
      startedAt: progress.nowIso ? progress.nowIso() : new Date().toISOString(),
      results: [],
      taskState: newTaskState()
    };
    document.body.classList.add('cems-lean-running');
    page('lean-run');
    renderTask();
    return true;
  }
  async function startToday() {
    state.plan = await scheduler.buildTodayPlan(LANG);
    renderHome(); renderDashboard();
    var action = state.plan.action;
    if (!action) { toast(state.plan.dailyNewLimitReached ? '오늘 새 단원 한도를 마쳤습니다. 예정 복습이 생기면 다시 표시됩니다.' : '오늘 예정된 학습을 모두 마쳤습니다.'); return { kind: 'complete' }; }
    if (action.kind === 'legacy') {
      scheduler.launchLegacy(action.legacy);
      return { kind: 'legacy', count: action.legacy.sessionCount };
    }
    if (action.kind === 'benchmark' || action.kind === 'baseline') {
      var checks = scheduler.queueForBenchmarks(action.state.record, action.benchmarks || []);
      startRun(action.state.record, checks, action.kind);
      return { kind: action.kind, unitId: action.state.record.unitId, count: checks.length, phase: checks[0] && checks[0]._benchmarkPhase };
    }
    var queue = await scheduler.queueForUnit(action.state.record, action.repairs || [], action.kind === 'repair');
    startRun(action.state.record, queue, action.kind);
    return { kind: action.kind, unitId: action.state.record.unitId, count: queue.length };
  }
  async function startUnit(unitId) {
    var states = await scheduler.listUnitStates(LANG);
    var selected = states.find(function (item) { return item.record.unitId === unitId; });
    if (!selected) throw new Error('단원을 찾지 못했습니다.');
    if (!selected.unlocked) throw new Error('선행 단원을 완료하면 열립니다.');
    var record = selected.record;
    var todayPlan = await scheduler.buildTodayPlan(LANG);
    if (!selected.started && todayPlan.dailyNewLimitReached) throw new Error('새 단원은 하루 최대 하나입니다. 다음 학습일에 시작하십시오.');
    var dueChecks = await scheduler.dueBenchmarksForUnit(record, 2);
    if (dueChecks.length) {
      var checks = scheduler.queueForBenchmarks(record, dueChecks);
      var kind = checks[0] && checks[0]._benchmarkPhase === 'baseline' ? 'baseline' : 'benchmark';
      startRun(record, checks, kind);
      return { kind: kind, unitId: unitId, count: checks.length, phase: checks[0] && checks[0]._benchmarkPhase };
    }
    var checkState = await progress.benchmarkStateForUnit(record);
    if (!checkState.baselineSatisfied) throw new Error('학습 전 기준선을 먼저 완료하십시오.');
    var completion = await progress.completionForUnit(record);
    if (completion.complete) {
      toast(checkState.nextDueAt ? '다음 지연 확인은 ' + shortDate(checkState.nextDueAt) + ' 이후 열립니다.' : '완료 단원의 지연 확인이 모두 끝났습니다.');
      return { kind: 'locked', unitId: unitId, nextDueAt: checkState.nextDueAt || null };
    }
    var repairs = (await progress.dueRepairs(LANG, 2)).filter(function (repair) { return repair.unitId === unitId; });
    var queue = await scheduler.queueForUnit(record, repairs, false);
    startRun(record, queue, 'unit');
    return { kind: 'unit', unitId: unitId, count: queue.length };
  }
  function contextHtml(task, unit, taskState) {
    var blocks = [];
    /* 목표어 이해를 한국어 번역만 보고 풀지 못하게 한다.
       번역은 힌트를 요청했거나 첫 오답 피드백을 받은 뒤에만 공개한다. */
    var showTranslation = !!(taskState && (taskState.hintsUsed > 0 || taskState.grade || taskState.finalized));
    if (task.contextKo) blocks.push('<div class="cems-lean-context-ko">' + esc(task.contextKo) + '</div>');
    if (task.context) blocks.push('<div class="cems-lean-stimulus">' + esc(task.context) + '</div>');
    if (Array.isArray(task.contextLines)) {
      blocks.push('<div class="cems-lean-dialogue">' + task.contextLines.map(function (line) {
        var surface = unit.language === 'zh'
          ? (unit.primaryScript === 'simplified' ? (line.simplified || line.traditional) : (line.traditional || line.simplified))
          : line.text;
        return '<div><b>' + esc(line.speaker || '') + '</b><span>' + esc(surface || '') + '</span>' + (showTranslation && line.translationKo ? '<small>' + esc(line.translationKo) + '</small>' : '') + '</div>';
      }).join('') + '</div>');
    }
    if (task.type === 'cloze' && task.clozeText) blocks.push('<div class="cems-lean-stimulus cloze">' + esc(task.clozeText) + '</div>');
    return blocks.join('');
  }
  function responseHtml(task, taskState) {
    if (task.type === 'contextChoice' || (task.type === 'listenChoiceOrDictation' && task.listenMode === 'choice')) {
      return '<div class="cems-lean-options">' + (task.options || []).map(function (option) {
        return '<button class="cems-lean-option ' + (taskState.response.optionId === option.optionId ? 'selected' : '') + '" data-lean-action="select-option" data-option-id="' + esc(option.optionId) + '" ' + (taskState.finalized ? 'disabled' : '') + '>' + esc(option.text) + '</button>';
      }).join('') + '</div>';
    }
    if (task.type === 'tokenOrder') {
      var selected = new Set(taskState.response.tokenIds || []);
      var byId = new Map((task.tokens || []).map(function (token) { return [token.tokenId, token]; }));
      var answer = (taskState.response.tokenIds || []).map(function (id) {
        var token = byId.get(id); return token ? '<button data-lean-action="remove-token" data-token-id="' + esc(id) + '">' + esc(token.text) + '</button>' : '';
      }).join('');
      var bank = (task.tokens || []).filter(function (token) { return !selected.has(token.tokenId); }).map(function (token) {
        return '<button data-lean-action="add-token" data-token-id="' + esc(token.tokenId) + '">' + esc(token.text) + '</button>';
      }).join('');
      return '<div class="cems-lean-token-answer">' + (answer || '<span>토큰을 순서대로 선택하세요.</span>') + '</div><div class="cems-lean-token-bank">' + bank + '</div>';
    }
    var placeholder = task.type === 'guidedProduction' ? '짧은 문장으로 입력하세요' : '정답 입력';
    return '<div class="cems-lean-input-wrap"><input id="cems-lean-response" class="form-input" type="text" maxlength="220" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="' + esc(placeholder) + '" value="' + esc(taskState.response.text || '') + '" ' + (taskState.finalized ? 'disabled' : '') + '></div>';
  }
  function listenHtml(task, unit, taskState) {
    if (task.type !== 'listenChoiceOrDictation') return '';
    var transcript = exercise.ttsText(task, unit);
    return '<div class="cems-lean-listen"><button class="btn btn-secondary" data-lean-action="play-tts">듣기 재생</button><button class="btn btn-secondary" data-lean-action="toggle-transcript">' + (taskState.transcriptVisible ? '텍스트 숨기기' : '텍스트 대체') + '</button>' + (taskState.transcriptVisible ? '<div class="cems-lean-transcript">' + esc(transcript) + '</div>' : '') + '</div>';
  }
  function hintHtml(task, taskState) {
    var shown = (task.hints || []).slice(0, taskState.hintsUsed);
    return shown.length ? '<div class="cems-lean-hints">' + shown.map(function (hint, index) { return '<div><b>힌트 ' + (index + 1) + '</b><span>' + esc(hint) + '</span></div>'; }).join('') + '</div>' : '';
  }
  function feedbackHtml(task, taskState) {
    if (!taskState.grade) return '';
    var final = taskState.finalized;
    var benchmark = !!task.isBenchmark;
    if (task._benchmarkPhase === 'baseline') {
      return '<div class="cems-lean-feedback baseline"><strong>학습 전 기준선 저장됨</strong><div><p>정답·해설·성공 여부는 지금 공개하지 않습니다. 이어지는 단원 학습에서 처음 확인합니다.</p></div></div>';
    }
    var label = benchmark
      ? (taskState.finalResult === 'independent' ? '첫 시도 적용 성공' : '첫 시도 실패')
      : final ? (taskState.finalResult === 'independent' ? '혼자 해결' : taskState.finalResult === 'assisted' ? '도움받아 해결' : '다시 복습 필요') : '첫 시도 오답';
    var cls = final ? taskState.finalResult : 'wrong';
    var feedback = task.feedback || {};
    var details = taskState.grade.details || {};
    var diagnostic = [];
    if (details.missingRequired && details.missingRequired.length) diagnostic.push('빠진 요소: ' + details.missingRequired.join(', '));
    if (details.missingAnchors && details.missingAnchors.length) diagnostic.push('필수 표현: ' + details.missingAnchors.join(', '));
    if (details.forbiddenPresent && details.forbiddenPresent.length) diagnostic.push('피할 형태: ' + details.forbiddenPresent.join(', '));
    if (details.orderedSlotsOk === false) diagnostic.push('필수 요소의 순서를 확인하세요.');
    return '<div class="cems-lean-feedback ' + esc(cls) + '"><strong>' + esc(label) + '</strong>' +
      '<div><small>정답 예</small><p>' + esc(taskState.grade.answerDisplay || feedback.correctAnswer || '') + '</p></div>' +
      (feedback.contrastKo ? '<div><small>대조</small><p>' + esc(feedback.contrastKo) + '</p></div>' : '') +
      (feedback.explanationKo ? '<div><small>한 줄 규칙</small><p>' + esc(feedback.explanationKo) + '</p></div>' : '') +
      (diagnostic.length ? '<div><small>확인</small><p>' + esc(diagnostic.join(' · ')) + '</p></div>' : '') +
      (final ? '<div class="cems-lean-feedback-issues"><span>내용에 문제가 있나요?</span><button data-lean-action="report-content-issue" data-issue-kind="answer_judgement">정답 판정</button><button data-lean-action="report-content-issue" data-issue-kind="unnatural_sentence">부자연스러운 문장</button><button data-lean-action="report-content-issue" data-issue-kind="unclear_instruction">설명 불명확</button></div>' : '') + '</div>';
  }
  function renderTask() {
    var host = qs('#cems-lean-run-host'), run = state.run, task = currentTask();
    if (!host || !run || !task) return;
    var taskState = run.taskState, benchmark = !!task.isBenchmark || run.kind === 'benchmark';
    var progressPercent = Math.round(run.index / Math.max(1, run.queue.length) * 100);
    var canHint = !benchmark && !taskState.finalized && !taskState.saving && taskState.hintsUsed < (task.hints || []).length;
    var canSubmit = !taskState.finalized && !taskState.saving && exercise.hasResponse(task, taskState.response);
    var submitLabel = task._benchmarkPhase === 'baseline' ? '기준선 저장' : benchmark ? '첫 답 제출' : taskState.phase === 'retry' ? '다시 확인' : '제출';
    var actions = '';
    if (!taskState.finalized) {
      actions = (canHint ? '<button class="btn btn-secondary" data-lean-action="show-hint">힌트 ' + taskState.hintsUsed + '/' + task.hints.length + '</button>' : '') +
        (!benchmark && taskState.phase === 'retry' ? '<button class="btn btn-secondary" data-lean-action="defer-task">다음에 복습</button>' : '') +
        (benchmark ? '<button class="btn btn-secondary" data-lean-action="submit-unknown">모름</button>' : '') +
        '<button class="btn btn-primary" data-lean-action="submit-task" ' + (canSubmit ? '' : 'disabled') + '>' + submitLabel + '</button>';
    } else actions = '<button class="btn btn-primary" data-lean-action="next-task">' + (run.index + 1 >= run.queue.length ? '결과 보기' : '다음 문제') + '</button>';
    var phaseLabel = task._benchmarkPhase === 'baseline' ? '학습 전 기준선' : task._benchmarkPhase === 'retention' ? '14일 유지 확인' : task._benchmarkPhase === 'transfer' ? '3일 전이 확인' : task.domain === 'production' ? '산출' : '이해';
    var benchmarkNotice = benchmark ? '<div class="cems-lean-benchmark-notice"><strong>' + esc(phaseLabel) + '</strong><span>' + (task._benchmarkPhase === 'baseline' ? '학습 내용을 보기 전 한 번만 응답하며, 정답과 결과는 공개하지 않습니다.' : '힌트·재시도 없이 첫 답 한 번만 평가 기록으로 저장합니다.') + '</span></div>' : '';
    host.innerHTML = '<div class="cems-lean-runbar"><button class="btn btn-secondary cems-lean-icon" data-lean-action="exit-run">←</button><div><div class="cems-lean-progress"><i style="width:' + progressPercent + '%"></i></div><span>' + (run.index + 1) + ' / ' + run.queue.length + '</span></div></div>' +
      '<main class="cems-lean-task">' + benchmarkNotice + '<div class="cems-lean-task-meta"><span>' + esc(phaseLabel) + '</span><span>' + esc(taskTypeLabel(task)) + '</span>' + (task.isRepair ? '<span>오류 보완</span>' : '') + '</div>' +
      '<h2>' + esc(task.promptKo) + '</h2><div class="cems-lean-target">' + esc(taskTargetLabel(run.unit, task)) + '</div>' +
      contextHtml(task, run.unit, taskState) + listenHtml(task, run.unit, taskState) + responseHtml(task, taskState) + hintHtml(task, taskState) + feedbackHtml(task, taskState) +
      '<div class="cems-lean-actions">' + actions + '</div></main>';
    var input = qs('#cems-lean-response');
    if (input && !taskState.finalized && !taskState.saving) setTimeout(function () { try { input.focus(); } catch (_) {} }, 40);
  }
  function resetResponseForRetry(taskState) {
    taskState.response = { text: '', optionId: null, tokenIds: [] };
  }
  function injectRepairTask(repair) {
    if (!state.run || !repair || !repair.repairTaskId) return;
    if (state.run.queue.some(function (task) { return task._repairId === repair.repairId; })) return;
    var source = (state.run.unit.repairPlan || []).find(function (task) { return task.taskId === repair.repairTaskId; });
    if (!source) return;
    var task = clone(source); task.isRepair = true; task._repairId = repair.repairId; task._repairErrorCode = repair.errorCode;
    var minimum = state.run.index + 3;
    var target = Math.max(minimum, Number(repair.eligibleAfterIndex || minimum));
    /* 세션에 충분한 간격이 없으면 억지로 바로 반복하지 않고 다음 계획에 남긴다. */
    if (target > state.run.queue.length) return;
    state.run.queue.splice(target, 0, task);
  }
  function buildAttempt(grade, result) {
    var run = state.run, task = currentTask(), taskState = run.taskState;
    return {
      attemptId: taskState.attemptId,
      language: LANG,
      unitId: run.unitRecord.unitId,
      targetIds: (task.targetRefs || []).slice(),
      taskId: task.taskId,
      taskType: task.type,
      domain: task.domain,
      sessionId: run.sessionId,
      sessionIndex: run.index,
      startedAt: taskState.startedAt,
      firstSubmittedAt: taskState.firstSubmittedAt,
      submittedAt: progress.nowIso ? progress.nowIso() : new Date().toISOString(),
      firstAttemptCorrect: taskState.firstAttemptCorrect === true,
      hintsAtFirstSubmission: taskState.hintsAtFirstSubmission,
      hintsUsed: taskState.hintsUsed,
      assistanceUsed: taskState.assistanceUsed || taskState.hintsUsed > 0,
      retryCount: taskState.retryCount,
      result: result,
      /* 힌트·대체 텍스트로 해결한 문항도 독립 회상을 확인할 다른 변형을 예약한다.
         실제 오답은 firstErrorCode를 보존하고, assisted/failed는 task 오류 범주를 사용한다. */
      errorCode: taskState.firstErrorCode || (result !== 'independent' ? (grade.errorCode || text(task.feedback && task.feedback.errorCode) || null) : null),
      firstResponseNormalized: taskState.firstResponseNormalized,
      responseNormalized: grade.normalized,
      repairId: task._repairId || null,
      sourceKind: task.isRepair ? 'repair' : 'practice',
      variantKey: task.variantKey || task.taskId
    };
  }
  async function finalizeAttempt(eventuallyCorrect, grade) {
    var run = state.run, task = currentTask(), taskState = run.taskState;
    var result = exercise.classifyResult(taskState.firstAttemptCorrect === true, eventuallyCorrect, taskState.hintsUsed);
    var attempt = buildAttempt(grade, result);
    var saved = await progress.recordAttempt(attempt, run.unit, task);
    if (!saved.duplicate) run.results.push(saved.attempt);
    if (saved.repair && !task.isRepair) injectRepairTask(saved.repair);
    taskState.grade = grade;
    taskState.finalized = true;
    taskState.finalResult = result;
    renderTask();
  }
  async function submitTask() {
    var run = state.run, task = currentTask();
    if (!run || !task || run.taskState.finalized || run.taskState.saving) return;
    var taskState = run.taskState;
    taskState.saving = true;
    try {
      var grade = exercise.grade(task, taskState.response, run.unit);
      if (task.isBenchmark || run.kind === 'benchmark') {
        taskState.firstAttemptCorrect = grade.correct;
        taskState.firstSubmittedAt = new Date(progress.nowMs()).toISOString();
        taskState.hintsAtFirstSubmission = 0;
        taskState.firstResponseNormalized = grade.normalized;
        var savedCheck = await progress.recordBenchmarkResult(task._benchmarkId, grade, taskState.response, run.unit, task);
        if (!savedCheck.duplicate) run.results.push(savedCheck.benchmark);
        taskState.grade = grade;
        taskState.finalized = true;
        taskState.finalResult = savedCheck.benchmark.result;
        renderTask();
        return;
      }
      if (taskState.firstAttemptCorrect === null) {
        taskState.firstAttemptCorrect = grade.correct;
        taskState.firstSubmittedAt = new Date(progress.nowMs()).toISOString();
        taskState.hintsAtFirstSubmission = taskState.hintsUsed;
        taskState.firstResponseNormalized = grade.normalized;
        if (grade.correct) { await finalizeAttempt(true, grade); return; }
        taskState.firstErrorCode = grade.errorCode;
        taskState.grade = grade;
        var pending = buildAttempt(grade, 'pending');
        var savedPending = await progress.recordFirstSubmission(pending, run.unit, task);
        if (savedPending.repair && !task.isRepair) injectRepairTask(savedPending.repair);
        taskState.phase = 'retry';
        resetResponseForRetry(taskState);
        renderTask();
        return;
      }
      taskState.retryCount += 1;
      if (grade.correct) await finalizeAttempt(true, grade);
      else await finalizeAttempt(false, grade);
    } finally { taskState.saving = false; }
  }
  async function submitUnknown() {
    var run = state.run, task = currentTask();
    if (!run || !task || !task.isBenchmark || run.taskState.finalized || run.taskState.saving) return;
    var taskState = run.taskState;
    taskState.saving = true;
    try {
      var grade = { correct: false, normalized: '', answerDisplay: '', errorCode: null, details: { unknown: true } };
      taskState.firstAttemptCorrect = false;
      taskState.firstSubmittedAt = new Date(progress.nowMs()).toISOString();
      taskState.hintsAtFirstSubmission = 0;
      taskState.firstResponseNormalized = '';
      var saved = await progress.recordBenchmarkResult(task._benchmarkId, grade, taskState.response, run.unit, task);
      if (!saved.duplicate) run.results.push(saved.benchmark);
      taskState.grade = grade;
      taskState.finalized = true;
      taskState.finalResult = saved.benchmark.result;
      renderTask();
    } finally { taskState.saving = false; }
  }
  async function deferTask() {
    var task = currentTask(), taskState = state.run && state.run.taskState;
    if (!task || !taskState || taskState.phase !== 'retry' || taskState.saving) return;
    taskState.saving = true;
    try {
      var grade = taskState.grade || exercise.grade(task, taskState.response, state.run.unit);
      await finalizeAttempt(false, grade);
    } finally { taskState.saving = false; }
  }
  function showHint() {
    var task = currentTask(), taskState = state.run && state.run.taskState;
    if (!task || task.isBenchmark || !taskState || taskState.finalized || taskState.saving) return;
    taskState.hintsUsed = Math.min((task.hints || []).length, taskState.hintsUsed + 1);
    taskState.assistanceUsed = true;
    renderTask();
  }
  function toggleTranscript() {
    var taskState = state.run && state.run.taskState;
    if (!taskState || taskState.finalized || (currentTask() && currentTask().isBenchmark)) return;
    if (!taskState.transcriptVisible) {
      taskState.transcriptVisible = true;
      taskState.assistanceUsed = true;
      taskState.hintsUsed = Math.max(1, taskState.hintsUsed);
    } else taskState.transcriptVisible = false;
    renderTask();
  }
  function playTts() {
    var task = currentTask(), run = state.run;
    if (!task || !run) return;
    var value = exercise.ttsText(task, run.unit);
    if (!value) return toast('재생할 문장이 없습니다.');
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      run.taskState.transcriptVisible = true; run.taskState.assistanceUsed = true; run.taskState.hintsUsed = Math.max(1, run.taskState.hintsUsed); renderTask(); toast('이 브라우저에서는 텍스트 대체를 사용합니다.'); return;
    }
    try {
      speechSynthesis.cancel();
      var utterance = new SpeechSynthesisUtterance(value);
      utterance.lang = LANG === 'zh' ? (run.unit.targetVariety || 'zh-TW') : 'en-US';
      utterance.rate = 0.9;
      speechSynthesis.speak(utterance);
    } catch (error) { run.taskState.transcriptVisible = true; renderTask(); }
  }
  function nextTask() {
    var run = state.run;
    if (!run || !run.taskState.finalized) return;
    if (run.index + 1 >= run.queue.length) { renderComplete(); return; }
    run.index += 1; run.taskState = newTaskState(); renderTask();
  }
  async function renderComplete() {
    var host = qs('#cems-lean-run-host'), run = state.run;
    if (!host || !run) return;
    if (run.kind === 'baseline') {
      host.innerHTML = '<div class="cems-lean-complete"><div class="cems-lean-complete-icon">✓</div><h2>학습 전 기준선 저장 완료</h2><p>정답이나 성공 여부를 공개하지 않았습니다. 이제 같은 기능을 문맥과 형태부터 학습합니다.</p><button class="btn btn-primary" data-lean-action="continue-after-baseline" data-unit-id="' + esc(run.unitRecord.unitId) + '">단원 학습 시작</button><button class="btn btn-secondary" data-lean-action="finish-run">학습 근거 보기</button></div>';
      refreshAll();
      return;
    }
    await refreshAll();
    var hasNext = !!(state.plan && state.plan.action);
    var followButtons = (hasNext ? '<button class="btn btn-primary" data-lean-action="continue-today">오늘 목표 계속</button>' : '<button class="btn btn-primary" data-lean-action="go-home">오늘 목표 완료</button>') + '<button class="btn btn-secondary" data-lean-action="finish-run">학습 근거 보기</button>';
    if (run.kind === 'benchmark') {
      var independent = run.results.filter(function (row) { return row.result === 'independent'; }).length;
      var failed = run.results.filter(function (row) { return row.result === 'failed'; }).length;
      var retention = run.results.some(function (row) { return row.phase === 'retention'; });
      host.innerHTML = '<div class="cems-lean-complete"><div class="cems-lean-complete-icon">✓</div><h2>' + (retention ? '최소 14일 유지 확인 완료' : '새 문맥 전이 확인 완료') + '</h2><p>연습 정답률과 섞지 않고, 힌트 없는 첫 시도 한 번만 별도 평가 기록으로 저장했습니다.</p><div class="cems-lean-complete-grid benchmark"><div><b>' + independent + '</b><span>첫 시도 성공</span></div><div><b>' + failed + '</b><span>첫 시도 실패</span></div></div><div class="cems-lean-complete-errors"><strong>다음 행동</strong><span>' + (failed ? '다른 변형의 오류 보완을 예약했습니다. 보완 뒤 유지 확인은 최소 7일 간격을 둡니다.' : retention ? '최소 14일 유지 근거를 별도 기록했습니다.' : '정답 재노출을 피하고 예약된 유지 확인을 기다립니다.') + '</span></div>' + followButtons + '</div>';
      return;
    }
    var counts = { independent: 0, assisted: 0, failed: 0 }, errors = {};
    run.results.forEach(function (attempt) {
      counts[attempt.result] += 1;
      if (attempt.errorCode) errors[attempt.errorCode] = Number(errors[attempt.errorCode] || 0) + 1;
    });
    var top = Object.keys(errors).sort(function (a, b) { return errors[b] - errors[a]; }).slice(0, 3);
    host.innerHTML = '<div class="cems-lean-complete"><div class="cems-lean-complete-icon">✓</div><h2>학습 구간 완료</h2><p>힌트를 사용하거나 다시 맞힌 문항은 독립 성공과 분리해 저장했습니다.</p><div class="cems-lean-complete-grid"><div><b>' + counts.independent + '</b><span>혼자 해결</span></div><div><b>' + counts.assisted + '</b><span>도움받아 해결</span></div><div><b>' + counts.failed + '</b><span>다시 복습</span></div></div><div class="cems-lean-complete-errors"><strong>이번 오류</strong><span>' + (top.length ? esc(top.join(' · ')) : '반복 오류 없음') + '</span></div>' + followButtons + '</div>';
  }
  function exitRun(force) {
    suppressLegacyOnboarding();
    if (state.run && !force && !state.run.taskState.finalized && !window.confirm('현재 문항의 입력은 저장되지 않습니다. 종료할까요?')) return;
    state.run = null;
    document.body.classList.remove('cems-lean-running');
    page('lean');
    refreshAll();
  }
  function copyText(value) {
    value = text(value);
    if (!value) return Promise.resolve(false);
    function legacyCopy() {
      var area = document.createElement('textarea'); area.value = value; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0'; document.body.appendChild(area); area.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (_) {} area.remove(); return ok;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(value).then(function () { return true; }).catch(function () { return legacyCopy(); });
    return Promise.resolve(legacyCopy());
  }
  function studioReportHtml(report) {
    if (!report) return 'JSON을 붙여넣고 로컬 자동 검사를 실행하십시오. 파일의 사람 검수 주장은 무시됩니다.';
    var errors = report.issues.filter(function (row) { return row.severity === 'error'; });
    var warnings = report.issues.filter(function (row) { return row.severity === 'warning'; });
    var preview = report.preview || {};
    var list = report.issues.slice(0, 12).map(function (row) { return '<li><b>' + esc(row.code) + '</b> ' + esc(row.message) + '<small>' + esc(row.path) + '</small></li>'; }).join('');
    return '<strong>' + (report.valid ? '검사 통과' : '추가 차단') + ' · 오류 ' + errors.length + ' · 경고 ' + warnings.length + '</strong>' +
      '<p>' + esc(preview.titleKo || '') + (preview.unitCount != null ? ' · ' + preview.unitCount + '단원' : '') + ' · 자동 검사/사람 미검수 상태로 저장</p>' + (list ? '<ul>' + list + '</ul>' : '');
  }
  function renderStudio() {
    var prompt = qs('#cems-lean-studio-prompt');
    if (prompt && prompt.value !== state.studio.prompt) prompt.value = state.studio.prompt || '';
    var reportBox = qs('.cems-lean-studio-result', qs('#page-lean-studio'));
    if (reportBox) reportBox.innerHTML = studioReportHtml(state.studio.report);
    ['studio-copy-prompt','studio-download-prompt'].forEach(function (action) { var button = qs('[data-lean-action="' + action + '"]'); if (button) button.disabled = !state.studio.prompt; });
    var importButton = qs('[data-lean-action="studio-import"]'); if (importButton) importButton.disabled = !(state.studio.report && state.studio.report.valid);
    var issues = studio ? studio.readIssues(LANG) : [];
    var issueBox = qs('#cems-lean-studio-issues'); if (issueBox) issueBox.innerHTML = issues.length ? '<strong>사용 중 기록 ' + issues.length + '건</strong><p>실제 문제가 있을 때만 수리 프롬프트에 반영됩니다.</p>' : '<strong>사용 중 기록 없음</strong><p>학습 화면의 세 버튼으로 판정·문장·설명 문제를 기록할 수 있습니다.</p>';
    ['studio-export-issues','studio-clear-issues'].forEach(function (action) { var button = qs('[data-lean-action="' + action + '"]'); if (button) button.disabled = !issues.length; });
    var canRepair = !!((state.studio.report && state.studio.report.issues && state.studio.report.issues.length) || issues.length);
    ['studio-copy-repair','studio-download-repair'].forEach(function (action) { var button = qs('[data-lean-action="' + action + '"]'); if (button) button.disabled = !canRepair || !state.studio.raw; });
  }
  function openStudio() { page('lean-studio'); renderStudio(); }
  function studioConfig() {
    return {
      titleKo: qs('[data-studio-field="titleKo"]') && qs('[data-studio-field="titleKo"]').value,
      level: qs('[data-studio-field="level"]') && qs('[data-studio-field="level"]').value,
      unitCount: qs('[data-studio-field="unitCount"]') && qs('[data-studio-field="unitCount"]').value,
      focusKo: qs('[data-studio-field="focusKo"]') && qs('[data-studio-field="focusKo"]').value,
      avoidKo: qs('[data-studio-field="avoidKo"]') && qs('[data-studio-field="avoidKo"]').value
    };
  }
  /* v9.5: 입력 누락은 "예외"가 아니라 사용자에게 알려줄 상태다.
     예전에는 throw 해서 호출 경로에 따라 미처리 예외/미처리 프로미스 거부가 됐고,
     콘솔에는 error 로 찍히면서 정작 사용자는 무엇을 채워야 하는지 알기 어려웠다.
     → 토스트(전역 showToast 로 위임)로 알리고, 비어 있는 첫 입력칸에 포커스를 준다. */
  function buildStudioPrompt() {
    var config = studioConfig();
    var missing = !text(config.titleKo).trim() ? 'titleKo'
                : !text(config.focusKo).trim() ? 'focusKo' : '';
    if (missing) {
      toast('⚠️ 코스 제목과 집중할 생활 기능을 입력하십시오.');
      var field = qs('[data-studio-field="' + missing + '"]');
      if (field) { try { field.focus(); } catch (_) {} }
      return null;
    }
    state.studio.prompt = studio.buildGenerationPrompt(LANG, config);
    renderStudio(); toast('언어별 단일 생성 프롬프트를 만들었습니다.'); return state.studio.prompt;
  }
  async function validateStudioJson() {
    var area = qs('#cems-lean-studio-json');
    var source = text(area && area.value);
    state.studio.report = null; state.studio.raw = null; state.studio.validatedSource = '';
    renderStudio();
    var raw = studio.parseJson(source);
    var installed = await progress.listUnits(LANG);
    var report = studio.auditPack(raw, LANG, { selfService: true, installedRecords: installed });
    state.studio.raw = raw; state.studio.report = report; state.studio.validatedSource = source; state.lastImportReport = report;
    renderStudio(); return report;
  }
  async function handleStudioFile(file) {
    if (!file) return null;
    if (file.size > studio.MAX_JSON_BYTES) throw new Error('JSON은 2MB 이하만 열 수 있습니다.');
    var value = await file.text();
    var area = qs('#cems-lean-studio-json'); if (area) area.value = value;
    state.studio.fileName = file.name;
    return validateStudioJson();
  }
  async function importStudioPack() {
    var report = state.studio.report;
    var area = qs('#cems-lean-studio-json');
    var currentSource = text(area && area.value);
    if (!report || !report.valid) throw new Error('먼저 로컬 자동 검사를 통과하십시오.');
    if (currentSource !== state.studio.validatedSource) throw new Error('검사 후 JSON이 변경되었습니다. 다시 로컬 자동 검사를 실행하십시오.');
    var raw = studio.parseJson(currentSource);
    var installed = await progress.listUnits(LANG);
    report = studio.auditPack(raw, LANG, { selfService: true, installedRecords: installed });
    state.studio.raw = raw; state.studio.report = report; state.studio.validatedSource = currentSource; state.lastImportReport = report;
    renderStudio();
    if (!report.valid) throw new Error('설치 상태가 바뀌어 다시 검사한 결과 차단 오류가 발견되었습니다.');
    var source = { type: 'self_service_pack', fileName: state.studio.fileName || 'pasted.json', packId: report.pack.packId, packVersion: Number(report.pack.version || 1), qaStatus: 'machine_validated_unreviewed' };
    try {
      var outcome = await importPack(report.pack, { report: report, source: source, activate: true });
      toast(outcome.result.duplicate ? '같은 코스가 이미 있습니다.' : '검사 통과 코스를 추가하고 활성화했습니다.');
      page('lean'); return outcome;
    } catch (error) {
      if ((error.code === 'PACK_VERSION_NOT_INCREMENTED' || error.code === 'UNIT_VERSION_NOT_INCREMENTED') && error.message) throw error;
      if (error.code === 'PACK_CONFLICT' && window.confirm('같은 ID의 사용자 코스가 있습니다. 더 높은 version의 검사 통과 내용으로 갱신할까요?')) {
        var replaced = await importPack(report.pack, { report: report, source: source, overwrite: true, activate: true });
        toast('코스를 갱신하고 활성화했습니다.'); page('lean'); return replaced;
      }
      throw error;
    }
  }
  function currentRepairPrompt() {
    if (!state.studio.raw) throw new Error('검사하거나 연 파일이 없습니다.');
    return studio.buildRepairPrompt(LANG, state.studio.raw, state.studio.report && state.studio.report.issues || [], studio.readIssues(LANG));
  }
  async function exportActiveCourse() {
    var records = await progress.listUnits(LANG);
    var courseId = state.plan && state.plan.activeCourseId || (scheduler.getActiveCourseId && scheduler.getActiveCourseId(LANG, state.allUnitStates));
    var selected = records.filter(function (record) { return record.courseId === courseId; }).sort(function (a,b) { return Number(a.sequence||0)-Number(b.sequence||0); });
    if (!selected.length) throw new Error('내보낼 활성 코스가 없습니다.');
    var units = selected.map(function (record) { return clone(record.unit); });
    var recordedPackVersions = selected.map(function(record){return Number(record.packVersion || record.source && record.source.packVersion || 0);}).filter(function(value){return Number.isInteger(value) && value > 0;});
    var exportedPackVersion = recordedPackVersions.length ? Math.max.apply(Math, recordedPackVersions) : Math.max.apply(Math, units.map(function(u){return Number(u.version||1);}));
    var pack = { schemaVersion:'cems-lean-pack-1', version:exportedPackVersion, language:LANG, packId:courseId, titleKo:selected[0].courseTitleKo || units[0].courseTitleKo || courseId, descriptionKo:'CEMS에서 내보낸 활성 코스', expectedWeeks:Math.max(1,Math.ceil(units.length/2)), newUnitsPerDayMax:1, sequencePolicy:'linear', unitOrder:units.map(function(u){return u.unitId;}), unitFiles:units.map(function(u,i){return 'units/'+String(i+1).padStart(2,'0')+'_'+u.unitId+'.json';}), units:units, qa:{status:'machine_validated_unreviewed',languageReviewed:false,crossUnitLeakChecked:true} };
    downloadTextFile(JSON.stringify(pack,null,2),'application/json','cems_'+LANG+'_'+courseId+'.json'); return pack;
  }
  function reportContentIssue(kind) {
    var run = state.run, task = currentTask(); if (!run || !task || !run.taskState.grade) return;
    var note = window.prompt('선택 사항: 무엇이 문제였는지 짧게 적으세요. 필요한 경우 본인이 생각한 답을 메모에 직접 포함하십시오. 현재 입력 답안은 자동 저장하지 않습니다.', '') || '';
    studio.recordIssue({ language: LANG, courseId: run.unitRecord.courseId || run.unit.courseId || '', unitId: run.unitRecord.unitId, contentVersion: run.unitRecord.version || run.unit.version, taskId: task.taskId, taskType: task.type, kind: kind, note: note, appVersion: VERSION });
    renderStudio(); toast('문제 위치와 메모만 기기에 기록했습니다. 답안은 자동 저장하거나 정답에 추가하지 않습니다.');
  }
  async function handleImportFile(file) {
    if (!file) return;
    try { openStudio(); await handleStudioFile(file); toast('JSON을 열어 검사했습니다. 자동으로 추가하지 않았습니다.'); }
    catch (error) { console.error('[CEMS Lean] import', error); toast('JSON 콘텐츠를 열지 못했습니다: ' + error.message); }
    finally { var input = qs('#cems-lean-import-file'); if (input) input.value = ''; }
  }
  function downloadTextFile(content, mimeType, fileName) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url; link.download = fileName;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  async function exportPilotJson() {
    var report = await progress.buildPilotReport(LANG);
    downloadTextFile(JSON.stringify(report, null, 2), 'application/json', 'cems_' + LANG + '_pilot_report_' + progress.dayKey(progress.nowMs()) + '.json');
    toast('원문 응답과 정답표를 제외한 JSON 집계 보고서를 저장했습니다.');
    return report;
  }
  async function exportPilotCsv() {
    var report = await progress.buildPilotReport(LANG);
    var csv = '\ufeff' + progress.pilotReportToCsv(report);
    downloadTextFile(csv, 'text/csv;charset=utf-8', 'cems_' + LANG + '_pilot_report_' + progress.dayKey(progress.nowMs()) + '.csv');
    toast('단원별 기준선·전이·유지 결과를 CSV로 저장했습니다.');
    return report;
  }
  async function exportPilotReport() { return exportPilotJson(); }
  function bindEvents() {
    if (state.eventsBound) return;
    state.eventsBound = true;
    document.addEventListener('click', function (event) {
      var button = event.target.closest('[data-lean-action]');
      if (!button) return;
      var action = button.dataset.leanAction;
      var fail = function (error) { if (error && error.cemsExpected) console.warn(error.message); else console.error(error); toast(error && error.message ? error.message : '작업을 완료하지 못했습니다.'); };
      if (action === 'start-today') startToday().catch(fail);
      else if (action === 'open-dashboard') { page('lean'); refreshAll(); }
      else if (action === 'open-studio') openStudio();
      else if (action === 'go-lean') { page('lean'); refreshAll(); }
      else if (action === 'go-home') { if (state.run) state.run = null; document.body.classList.remove('cems-lean-running'); page('home'); refreshAll(); }
      else if (action === 'start-unit') startUnit(button.dataset.unitId).catch(fail);
      else if (action === 'set-active-course') { scheduler.setActiveCourseId(LANG, button.dataset.courseId); refreshAll(); }
      else if (action === 'choose-import') openStudio();
      else if (action === 'studio-build-prompt') buildStudioPrompt();   // v9.5: 더 이상 throw 하지 않는다
      else if (action === 'studio-copy-prompt') copyText(state.studio.prompt).then(function(){toast('프롬프트를 복사했습니다.');});
      else if (action === 'studio-download-prompt') downloadTextFile(state.studio.prompt,'text/plain;charset=utf-8','CEMS_'+LANG+'_COURSE_GENERATION_PROMPT.txt');
      else if (action === 'studio-download-guide') fetch('./authoring/CEMS_CONTENT_ADDITION_GUIDE_v4.md').then(function(r){if(!r.ok)throw new Error('가이드를 읽지 못했습니다.');return r.text();}).then(function(v){downloadTextFile(v,'text/markdown;charset=utf-8','CEMS_CONTENT_ADDITION_GUIDE_v4.md');}).catch(fail);
      else if (action === 'studio-open-file') qs('#cems-lean-studio-file').click();
      else if (action === 'studio-validate') validateStudioJson().then(function(report){toast(report.valid?'검사를 통과했습니다.':'차단 오류를 확인하십시오.');}).catch(function(error){toast(error.message);});
      else if (action === 'studio-import') importStudioPack().catch(fail);
      else if (action === 'studio-copy-repair') { try { copyText(currentRepairPrompt()).then(function(){toast('조건부 수리 프롬프트를 복사했습니다.');}); } catch(error){fail(error);} }
      else if (action === 'studio-download-repair') { try { downloadTextFile(currentRepairPrompt(),'text/plain;charset=utf-8','CEMS_'+LANG+'_COURSE_REPAIR_PROMPT.txt'); } catch(error){fail(error);} }
      else if (action === 'studio-export-issues') downloadTextFile(JSON.stringify(studio.issueBundle(LANG),null,2),'application/json','CEMS_'+LANG+'_CONTENT_ISSUES.json');
      else if (action === 'studio-clear-issues') { if (window.confirm('기록한 콘텐츠 문제를 모두 지울까요?')) { studio.clearIssues(LANG); renderStudio(); } }
      else if (action === 'export-active-course') exportActiveCourse().catch(fail);
      else if (action === 'report-content-issue') reportContentIssue(button.dataset.issueKind);
      else if (action === 'export-pilot' || action === 'export-pilot-json') exportPilotJson().catch(fail);
      else if (action === 'export-pilot-csv') exportPilotCsv().catch(fail);
      else if (action === 'continue-after-baseline') { var unitId = button.dataset.unitId; state.run = null; document.body.classList.remove('cems-lean-running'); startUnit(unitId).catch(fail); }
      else if (action === 'select-option' && state.run) { state.run.taskState.response.optionId = button.dataset.optionId; renderTask(); }
      else if (action === 'add-token' && state.run) { if (state.run.taskState.response.tokenIds.indexOf(button.dataset.tokenId) < 0) state.run.taskState.response.tokenIds.push(button.dataset.tokenId); renderTask(); }
      else if (action === 'remove-token' && state.run) { state.run.taskState.response.tokenIds = state.run.taskState.response.tokenIds.filter(function (id) { return id !== button.dataset.tokenId; }); renderTask(); }
      else if (action === 'show-hint') showHint();
      else if (action === 'submit-task') submitTask().catch(fail);
      else if (action === 'submit-unknown') submitUnknown().catch(fail);
      else if (action === 'defer-task') deferTask().catch(fail);
      else if (action === 'next-task') nextTask();
      else if (action === 'play-tts') playTts();
      else if (action === 'toggle-transcript' && state.run) toggleTranscript();
      else if (action === 'exit-run') exitRun(false);
      else if (action === 'continue-today') { state.run = null; document.body.classList.remove('cems-lean-running'); refreshAll().then(function () { return startToday(); }).catch(fail); }
      else if (action === 'finish-run') { state.run = null; document.body.classList.remove('cems-lean-running'); page('lean'); refreshAll().then(function () { if (window.CEMS_UX26 && CEMS_UX26.activateLeanTab) CEMS_UX26.activateLeanTab('evidence'); else if (window.CEMS_UX25 && CEMS_UX25.activateLeanTab) CEMS_UX25.activateLeanTab('evidence'); }).catch(fail); }
    });
    document.addEventListener('input', function (event) {
      if (!event.target) return;
      if (event.target.id === 'cems-lean-response' && state.run) {
        state.run.taskState.response.text = event.target.value;
        var submit = qs('[data-lean-action="submit-task"]');
        if (submit) submit.disabled = !exercise.hasResponse(currentTask(), state.run.taskState.response);
        return;
      }
      if (event.target.id === 'cems-lean-studio-json') {
        state.studio.raw = null; state.studio.report = null; state.studio.validatedSource = ''; state.studio.fileName = '';
        renderStudio();
        return;
      }
      if (event.target.matches && event.target.matches('[data-studio-field]') && state.studio.prompt) {
        state.studio.prompt = '';
        renderStudio();
      }
    });
    document.addEventListener('keydown', function(event){
      if(event.isComposing || event.key !== 'Enter' || !event.target) return;
      if(event.target.id === 'cems-lean-studio-json' && (event.ctrlKey || event.metaKey)){ event.preventDefault(); validateStudioJson().catch(function(e){toast(e.message);}); }
    });
    var file = qs('#cems-lean-import-file'); if (file) file.addEventListener('change', function () { handleImportFile(file.files && file.files[0]); });
    var studioFile = qs('#cems-lean-studio-file'); if (studioFile) studioFile.addEventListener('change', function () { handleStudioFile(studioFile.files && studioFile.files[0]).then(function(){toast('JSON을 열어 검사했습니다. 자동으로 추가하지 않았습니다.');}).catch(function(e){toast(e.message);}); studioFile.value=''; });
    window.addEventListener('hashchange', function () { if (location.hash === '#lean' && state.ready) { page('lean'); refreshAll(); } else if(location.hash === '#lean-studio' && state.ready) openStudio(); });
  }
  /* v9.5: 함수 프로퍼티 플래그(__cemsLeanZhPatched) 대신 모듈 상태로 1회 가드한다.
     플래그 방식은 deck-groups 도 quickStartMode 를 감싸기 때문에, 설치 순서에 따라
     플래그가 사라져 재설치 때마다 중복 래핑됐다. */
  function patchLegacyChineseQuickStart() {
    if (state.quickStartPatched) return false;
    if (LANG !== 'zh' || typeof quickStartMode !== 'function') return false;
    state.quickStartPatched = true;
    var previous = quickStartMode;
    quickStartMode = function (type, mode) {
      if (/^zh-/.test(String(mode || '')) && typeof startChineseSpecialMode === 'function') return startChineseSpecialMode(mode);
      return previous.apply(this, arguments);
    };
    return true;
  }
  /* v9.5: showPage 전역 재정의 → afterPageShow 훅.
     예전에는 이 모듈을 포함해 여러 확장이 showPage 를 감쌌고, 재설치가 돌 때마다
     겹이 늘어 showPage 1회에 history.replaceState 가 5회 실행됐다.
     훅은 'lean-ui' 키로 멱등 등록되므로 몇 번 불러도 1겹이다.
     afterPageShow 는 showPage 본문 끝에서 발행되므로 실행 시점도 예전과 같다. */
  function patchPageRefresh() {
    if (state.pageHookInstalled || !window.CEMSHooks) return;
    state.pageHookInstalled = true;
    window.CEMSHooks.on('afterPageShow', 'lean-ui', function (name) {
      var target = String(name || '');
      if (target === 'home' || target === 'lean') {
        /* v9.5: 예전에는 여러 확장이 showPage 를 겹겹이 감싸고 재설치 타이머까지 돌아서
           refreshAll 이 한 화면 전환에 여러 번 걸렸고, 그중 하나가 일찍 끝나 화면이 채워졌다.
           이제 훅이 1회만 도는 대신, IndexedDB 조회를 기다리는 동안 화면이 비어 보인다.
           → 직전에 받아둔 계획으로 즉시 한 번 그리고, 그 다음 실제 갱신을 건다. */
        if (state.plan) { try { renderHome(); renderDashboard(); } catch (_) {} }
        setTimeout(refreshAll, 30);
      }
      if (target === 'lean-studio') setTimeout(renderStudio, 30);
      syncLeanFocus(target);
      if (target !== 'lean-run') document.body.classList.remove('cems-lean-running');
    });
  }
  function syncLeanVersion() {
    document.documentElement.dataset.cemsVersion = VERSION;
    var visible = (LANG === 'zh' ? '中文學習' : 'CEMS English') + ' v9.4.4';
    document.title = visible;
    var meta = document.querySelector('meta[name="app-version"]'); if (meta) meta.content = VERSION;
    document.querySelectorAll('.splash-sub').forEach(function (node) { node.textContent = 'v9.4.4 · 통합 학습 허브'; });
    document.querySelectorAll('.cems82-brand-sub').forEach(function (node) { node.textContent = '학습 분석 · FSRS-6 · v9.4.4'; });
    var versionCard = Array.from(document.querySelectorAll('#page-settings .card')).find(function (card) { var title = card.querySelector('.card-title'); return title && title.textContent.indexOf('버전 정보') >= 0; });
    var strong = versionCard && versionCard.querySelector('strong'); if (strong) strong.textContent = (LANG === 'zh' ? '중국어 학습' : 'CEMS English') + ' v9.4.4 · 통합 학습 허브';
    var buildStatus = document.getElementById('phase8-build-status'); if (buildStatus) buildStatus.textContent = 'v9.4.4';
  }
  function protectLeanVersion() {
    if (state.versionObserver) return;
    var expectedTitle = (LANG === 'zh' ? '中文學習' : 'CEMS English') + ' v9.4.4';
    var titleNode = document.querySelector('title');
    state.versionObserver = new MutationObserver(function () {
      if (document.title !== expectedTitle || document.documentElement.dataset.cemsVersion !== VERSION) setTimeout(syncLeanVersion, 0);
    });
    if (titleNode) state.versionObserver.observe(titleNode, { childList: true, subtree: true, characterData: true });
    state.versionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-cems-version'] });
  }
  function init() {
    if (state.ready) return Promise.resolve(true);
    if (initPromise) return initPromise;
    initPromise = (async function () {
      if (!schema || !exercise || !progress || !scheduler || !studio) throw new Error('Lean 모듈 로드 순서가 잘못되었습니다.');
      injectUi(); bindEvents(); patchPageRefresh(); patchLegacyChineseQuickStart();
      /* 기존 레이어의 지연 초기화가 진입점을 다시 덮어쓸 수 있어 안정화 뒤 재적용한다. */
      setTimeout(patchLegacyChineseQuickStart, 350);
      setTimeout(patchLegacyChineseQuickStart, 1400);
      await progress.waitForDb();
      await ensureBuiltInPack();
      await progress.ensureAllBenchmarks(LANG);
      syncLeanVersion();
      protectLeanVersion();
      setTimeout(syncLeanVersion, 700);
      setTimeout(syncLeanVersion, 1500);
      setTimeout(syncLeanVersion, 3000);
      setTimeout(syncLeanVersion, 6000);
      await refreshAll();
      if (location.hash === '#lean') page('lean');
      if (location.hash === '#lean-studio') openStudio();
      /* ready는 데이터 import·benchmark 생성·첫 계획 렌더가 모두 끝난 뒤에만 공개한다.
         이전 순서는 테스트와 백업 초기화가 진행 중 refresh와 경합할 수 있었다. */
      state.ready = true;
      return true;
    })();
    initPromise = initPromise.catch(function (error) { initPromise = null; throw error; });
    return initPromise;
  }
  async function getProgressSummary() { return progress.getProgressSummary(LANG); }

  var publicApi = {
    VERSION: VERSION,
    init: init,
    importUnit: importUnit,
    importPack: importPack,
    exportPilotReport: exportPilotReport,
    exportPilotJson: exportPilotJson,
    exportPilotCsv: exportPilotCsv,
    openStudio: openStudio,
    exportActiveCourse: exportActiveCourse,
    startToday: startToday,
    startUnit: startUnit,
    refresh: refreshAll,
    getProgressSummary: getProgressSummary
  };
  if (/[?&]cemsTest=1(?:&|$)/.test(location.search)) {
    Object.defineProperty(publicApi, '__test', {
      enumerable: false,
      value: {
        language: LANG,
        state: state,
        schema: schema,
        exercise: exercise,
        progress: progress,
        scheduler: scheduler,
        studio: studio,
        currentTask: currentTask,
        startRun: startRun,
        renderTask: renderTask,
        submitTask: submitTask,
        submitUnknown: submitUnknown,
        nextTask: nextTask,
        refreshAll: refreshAll,
        renderStudio: renderStudio,
        validateStudioJson: validateStudioJson,
        syncLeanVersion: syncLeanVersion
      }
    });
  }
  /* v9.5: 예전에는 window.CEMS_LEAN = publicApi 로 통째로 갈아끼워서, 파일 첫머리에서
     읽어 온 moduleRoot._modules(schema/exercise/progress/scheduler/studio 레지스트리)가
     통째로 사라졌다. 나중에 로드되는 코드가 CEMS_LEAN._modules 를 보면 undefined 였다.
     → 기존 객체에 병합하고 _modules 를 명시적으로 보존한다. */
  publicApi._modules = modules;
  Object.assign(moduleRoot, publicApi);
  window.CEMS_LEAN = moduleRoot;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(function () { init().catch(function (error) { console.error('[CEMS Lean] init', error); }); }, 900); });
  else setTimeout(function () { init().catch(function (error) { console.error('[CEMS Lean] init', error); }); }, 900);
})();
