/* CEMS v9.2.8 Learning-first — goal-aligned courses, delayed checks, repairs and
 * fixed-interval scheduling.
 *
 * v9.5 정정: 예전 헤더는 "FSRS" 라고 적혀 있었지만 이 파일에는 FSRS 의 안정성/난이도
 * 파라미터도, 기억 확률 모델도 없다. 실제 구현은 고정 지연 스케줄(단계별로 미리 정해 둔
 * 간격으로 다음 복습일을 잡는 방식)이다. 잘못된 이름이 "FSRS 를 손보면 된다"는
 * 오해를 만들어 왔다. */
(function () {
  'use strict';

  var api = window.CEMS_LEAN = window.CEMS_LEAN || {};
  var modules = api._modules = api._modules || {};
  var progress = modules.progress;
  var NEW_UNIT_DAILY_LIMIT = 1;

  function text(value) { return String(value == null ? '' : value); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function activeCourseKey(language) { return 'cemsLeanActiveCourse:' + language; }
  function getActiveCourseId(language, states) {
    var stored = '';
    try { stored = text(localStorage.getItem(activeCourseKey(language))).trim(); } catch (_) {}
    var ids = new Set((states || []).map(function (state) { return state.courseId; }));
    if (stored && ids.has(stored)) return stored;
    var builtIn = (states || []).find(function (state) { return state.record && state.record.source && /^built_in_/.test(text(state.record.source.type)); });
    var selected = builtIn ? builtIn.courseId : ((states || [])[0] && states[0].courseId) || '';
    if (selected) try { localStorage.setItem(activeCourseKey(language), selected); } catch (_) {}
    return selected;
  }
  function setActiveCourseId(language, courseId) {
    try { localStorage.setItem(activeCourseKey(language), text(courseId)); } catch (_) {}
    return text(courseId);
  }
  function summarizeCourses(states, activeCourseId) {
    var map = new Map();
    (states || []).forEach(function (state) {
      var id = state.courseId;
      if (!map.has(id)) map.set(id, { courseId: id, titleKo: state.record.courseTitleKo || state.record.unit.courseTitleKo || id, unitCount: 0, completedCount: 0, startedCount: 0, builtIn: !!(state.record.source && /^built_in_/.test(text(state.record.source.type))), active: id === activeCourseId });
      var row = map.get(id); row.unitCount += 1; if (state.complete) row.completedCount += 1; if (state.started) row.startedCount += 1;
    });
    return Array.from(map.values()).sort(function (a, b) { return Number(b.builtIn) - Number(a.builtIn) || text(a.titleKo).localeCompare(text(b.titleKo)); });
  }
  function isDue(item, now) {
    var raw = item && (item.nextReview || item.due || item.reviewAt);
    if (!raw) return false;
    var when = new Date(raw).getTime();
    return Number.isFinite(when) && when <= now;
  }
  function isNewCard(item) {
    return Number(item && (item.reviewCount || item.reps || 0)) <= 0;
  }
  async function legacyDueSummary(language) {
    var now = progress && progress.nowMs ? progress.nowMs() : Date.now();
    var groups = [];
    /* v9.5: 예전에는 세 조회를 하나의 try/catch 로 묶고 catch 를 비워 뒀다.
       단어 조회가 실패하면 표현·구동사는 시도조차 못 한 채 groups 가 부분만 채워지고,
       호출자는 그것을 "오늘 복습할 카드가 이만큼뿐"이라는 정상 결과로 받아들였다.
       → 종류별로 따로 감싸고, 실패한 종류는 콘솔에 남겨 원인을 알 수 있게 한다. */
    async function collect(type, mode, label, loader) {
      try { groups.push({ type: type, mode: mode, label: label, rows: await loader() }); }
      catch (error) {
        console.warn('[CEMS scheduler] ' + type + ' 목록을 읽지 못해 오늘 계획에서 제외합니다:', error && error.message ? error.message : error);
      }
    }
    if (typeof getAllWords === 'function') await collect('vocab', 'flashcard', language === 'zh' ? '단어' : '어휘', getAllWords);
    if (language === 'en' && typeof getAllPV === 'function') await collect('phrasal', 'pv-flashcard', '구동사', getAllPV);
    if (typeof getAllExpr === 'function') await collect('expr', 'expr-fc', '표현', getAllExpr);
    groups.forEach(function (group) {
      var rows = group.rows || [];
      group.due = rows.filter(function (item) { return isDue(item, now); }).length;
      group.fresh = rows.filter(function (item) { return isNewCard(item) && !isDue(item, now); }).length;
      group.available = group.due + group.fresh;
      group.totalCards = rows.length;
      delete group.rows;
    });
    groups.sort(function (a, b) { return b.due - a.due || b.fresh - a.fresh; });
    var dueTotal = groups.reduce(function (sum, group) { return sum + group.due; }, 0);
    var freshTotal = groups.reduce(function (sum, group) { return sum + group.fresh; }, 0);
    var total = dueTotal + freshTotal;
    var selected = groups.find(function (group) { return group.available > 0; }) || null;
    return {
      total: total,
      dueTotal: dueTotal,
      freshTotal: freshTotal,
      groups: groups,
      selected: selected,
      sessionCount: selected ? Math.min(8, Math.max(1, selected.available)) : 0
    };
  }
  function taskTarget(task) { return (task.targetRefs || [])[0] || ''; }
  function interleave(tasks) {
    var remaining = tasks.slice(), output = [], sameTypeRun = 0, lastType = '', lastTarget = '';
    while (remaining.length) {
      var bestIndex = 0, bestScore = Infinity;
      remaining.forEach(function (task, index) {
        var score = index / 100, target = taskTarget(task);
        if (target && target === lastTarget) score += 7;
        if (task.type === lastType) score += sameTypeRun >= 2 ? 10 : 2;
        if (output.length === 0) score += task.domain === 'comprehension' ? -6 : 6;
        if (output.length >= 1 && !output.some(function (row) { return row.domain === 'production'; }) && task.domain === 'production') score -= 5;
        if (task.isRepair) score -= 3;
        if (task.type === 'guidedProduction') score += output.length < Math.floor(tasks.length * 0.55) ? 4 : -2;
        if (score < bestScore) { bestScore = score; bestIndex = index; }
      });
      var chosen = remaining.splice(bestIndex, 1)[0];
      output.push(chosen);
      sameTypeRun = chosen.type === lastType ? sameTypeRun + 1 : 1;
      lastType = chosen.type; lastTarget = taskTarget(chosen);
    }
    return output;
  }
  function firstPracticeAt(completion) {
    var times = (completion.allAttempts || []).filter(function (row) { return row && !row.isRepair && !row.isBenchmark; }).map(function (row) {
      return new Date(row.firstSubmittedAt || row.submittedAt || row.startedAt || 0).getTime();
    }).filter(function (value) { return Number.isFinite(value) && value > 0; });
    return times.length ? new Date(Math.min.apply(Math, times)).toISOString() : null;
  }
  async function unitState(record) {
    var rows = await Promise.all([progress.completionForUnit(record), progress.benchmarkStateForUnit(record)]);
    var completion = rows[0], benchmarks = rows[1], startedAt = firstPracticeAt(completion);
    return {
      record: record,
      completion: completion,
      benchmarks: benchmarks,
      courseId: record.courseId || record.unit.courseId || ('custom:' + record.unitId),
      sequence: Number(record.sequence || record.unit.courseOrder || record.unit.sequence || 0),
      prerequisiteUnitIds: (record.prerequisiteUnitIds || record.unit.prerequisiteUnitIds || []).slice(),
      started: !!startedAt,
      startedAt: startedAt,
      startedDayKey: startedAt ? progress.dayKey(startedAt) : null,
      complete: completion.complete === true,
      unlocked: true,
      lockedReason: null,
      prerequisitesComplete: true
    };
  }
  async function listUnitStates(language) {
    var units = await progress.listUnits(language), states = [];
    for (var i = 0; i < units.length; i += 1) states.push(await unitState(units[i]));
    var byId = new Map(states.map(function (state) { return [state.record.unitId, state]; }));
    states.forEach(function (state) {
      state.prerequisitesComplete = state.prerequisiteUnitIds.every(function (id) {
        var prerequisite = byId.get(id); return !!prerequisite && prerequisite.complete;
      });
      state.unlocked = state.started || state.prerequisitesComplete;
      if (!state.prerequisitesComplete) state.lockedReason = '앞 단원을 먼저 완료하세요.';
    });
    return states.sort(function (a, b) {
      var course = text(a.courseId).localeCompare(text(b.courseId));
      if (course) return course;
      var sequence = Number(a.sequence || 0) - Number(b.sequence || 0);
      return sequence || text(a.record.unitId).localeCompare(text(b.record.unitId));
    });
  }
  function repairTasksForUnit(record, repairs) {
    var map = new Map((record.unit.repairPlan || []).map(function (task) { return [task.taskId, task]; }));
    return (repairs || []).filter(function (repair) { return repair.unitId === record.unitId; }).map(function (repair) {
      var original = map.get(repair.repairTaskId);
      if (!original) return null;
      var task = clone(original);
      task.isRepair = true;
      task._repairId = repair.repairId;
      task._repairErrorCode = repair.errorCode;
      return task;
    }).filter(Boolean);
  }
  async function queueForUnit(record, repairs, onlyRepairs) {
    var completion = await progress.completionForUnit(record);
    var benchmarkState = await progress.benchmarkStateForUnit(record);
    var repairTasks = repairTasksForUnit(record, repairs);
    if (onlyRepairs) return interleave(repairTasks).slice(0, 2);
    if (!benchmarkState.baselineSatisfied && !completion.allAttempts.length) return [];
    /* 완료한 단원의 지연 평가가 남아 있으면 정답 재노출을 막는다. 오류 보충만 허용한다. */
    if (completion.complete && benchmarkState.scheduled.some(function (row) { return row.phase !== 'baseline'; })) return interleave(repairTasks).slice(0, 2);
    var normal = (record.unit.practicePlan || []).filter(function (task) { return !completion.completedTaskIds.has(task.taskId); });
    if (!normal.length && !repairTasks.length && !benchmarkState.scheduled.length) normal = (record.unit.practicePlan || []).slice();
    var queue = repairTasks.concat(normal);
    if (queue.length > 8) queue = queue.slice(0, 8);
    if (normal.length && !queue.some(function (task) { return task.domain === 'production'; })) {
      var production = normal.find(function (task) { return task.domain === 'production'; });
      if (production) queue[queue.length ? queue.length - 1 : 0] = production;
    }
    if (normal.length && !queue.some(function (task) { return task.type === 'guidedProduction'; })) {
      var guided = normal.find(function (task) { return task.type === 'guidedProduction'; });
      if (guided) queue[queue.length ? queue.length - 1 : 0] = guided;
    }
    return interleave(Array.from(new Map(queue.map(function (task) { return [task.taskId + ':' + text(task._repairId), task]; })).values()));
  }
  function queueForBenchmarks(record, benchmarkRows) {
    return (benchmarkRows || []).filter(function (row) { return row && row.unitId === record.unitId; }).slice(0, 2).map(function (row) {
      var task = clone(row.taskSnapshot || {});
      task.isBenchmark = true;
      task.domain = 'transfer';
      task.hints = [];
      task._benchmarkId = row.benchmarkId;
      task._benchmarkPhase = row.phase;
      task._benchmarkDueAt = row.effectiveDueAt || row.dueAt;
      return task;
    });
  }
  async function dueBenchmarksForUnit(record, maxCount) {
    var due = await progress.dueBenchmarks(record.language, 100);
    return due.filter(function (row) { return row.unitId === record.unitId; }).slice(0, Number(maxCount || 2));
  }
  function estimatePlanMinutes(input) {
    input = input || {};
    var delayed = Number(input.delayedCount || 0) * 1.2;
    var repairs = Number(input.repairCount || 0) * 1.3;
    var legacy = Number(input.reviewCount || 0) * 0.3;
    var course = input.inProgress ? 7 : input.newUnit ? 8 : 0;
    var total = delayed + repairs + legacy + course;
    return total ? Math.max(2, Math.min(18, Math.ceil(total))) : 0;
  }
  function planSteps(input) {
    input = input || {};
    var steps = [];
    if (input.delayedCount) steps.push({ id: 'delayed', label: '지연 확인', count: Number(input.delayedCount), detail: '새 문맥·유지', priority: 1 });
    if (input.repairCount) steps.push({ id: 'repair', label: '오류 보완', count: Number(input.repairCount), detail: '다른 문장 재확인', priority: 2 });
    if (input.inProgress) steps.push({ id: 'course', label: '진행 단원', count: 1, detail: '문맥→산출 이어가기', priority: 3 });
    if (input.reviewCount) steps.push({ id: 'review', label: '카드 복습', count: Number(input.reviewCount), detail: input.reviewDetail || '복습 예정 + 신규', priority: 4 });
    if (!input.inProgress && input.newUnit) steps.push({ id: 'course', label: '새 단원', count: 1, detail: input.baselineCount ? '기준선부터' : '생활 기능 1개', priority: 5 });
    return steps;
  }
  async function buildTodayPlan(language) {
    var rows = await Promise.all([progress.dueBenchmarks(language, 100), progress.dueRepairs(language, 2), legacyDueSummary(language), listUnitStates(language)]);
    var allDue = rows[0], repairs = rows[1], legacy = rows[2], states = rows[3];
    var activeCourseId = getActiveCourseId(language, states);
    var activeStates = states.filter(function (state) { return state.courseId === activeCourseId; });
    /* 지연 평가와 오류 보충은 비활성 코스도 놓치지 않는다. 새 학습은 활성 코스에만 배정한다. */
    var delayed = allDue.filter(function (row) { return row.phase === 'transfer' || row.phase === 'retention'; }).slice(0, 2);
    var inProgress = activeStates.find(function (state) { return state.started && !state.complete; }) || null;
    var today = progress.dayKey(progress.nowMs());
    var newUnitsStartedToday = states.filter(function (state) { return state.startedDayKey === today; }).length;
    var dailyNewLimitReached = newUnitsStartedToday >= NEW_UNIT_DAILY_LIMIT;
    var untouched = activeStates.find(function (state) { return !state.started && state.unlocked; }) || null;
    var reviewLoadHigh = legacy.total > 8;
    var unitStateSelected = inProgress || (!reviewLoadHigh && !dailyNewLimitReached ? untouched : null);
    var candidateBaseline = unitStateSelected && !unitStateSelected.started
      ? (unitStateSelected.benchmarks.baselineDue || []).slice(0, 1)
      : [];
    var actions = [];
    if (delayed.length) {
      var delayedState = states.find(function (state) { return state.record.unitId === delayed[0].unitId; });
      if (delayedState) actions.push({ kind: 'benchmark', state: delayedState, benchmarks: delayed.filter(function (row) { return row.unitId === delayedState.record.unitId; }) });
    }
    if (repairs.length) {
      var repairState = states.find(function (state) { return state.record.unitId === repairs[0].unitId; });
      if (repairState) actions.push({ kind: 'repair', state: repairState, repairs: repairs.filter(function (repair) { return repair.unitId === repairState.record.unitId; }) });
    }
    /* 끊긴 문맥 단원은 카드 복습보다 먼저 마친다. 단, 새 단원은 카드 부하가 높으면 보류한다. */
    if (inProgress) actions.push({ kind: 'continueUnit', state: inProgress, repairs: [] });
    if (legacy.total > 0) actions.push({ kind: 'legacy', legacy: legacy });
    if (!inProgress && unitStateSelected && !unitStateSelected.started && candidateBaseline.length) actions.push({ kind: 'baseline', state: unitStateSelected, benchmarks: candidateBaseline });
    if (!inProgress && unitStateSelected && !unitStateSelected.started && unitStateSelected.benchmarks.baselineSatisfied) actions.push({ kind: 'newUnit', state: unitStateSelected, repairs: [] });
    var input = {
      delayedCount: delayed.length,
      repairCount: repairs.length,
      reviewCount: legacy.sessionCount,
      reviewDetail: '복습 ' + legacy.dueTotal + ' · 신규 ' + legacy.freshTotal,
      baselineCount: candidateBaseline.length,
      inProgress: !!inProgress,
      newUnit: !!(unitStateSelected && !unitStateSelected.started)
    };
    return {
      language: language,
      benchmarks: allDue,
      benchmarkCount: delayed.length,
      baselineCount: candidateBaseline.length,
      transferCount: delayed.filter(function (row) { return row.phase === 'transfer'; }).length,
      retentionCount: delayed.filter(function (row) { return row.phase === 'retention'; }).length,
      repairs: repairs,
      repairCount: repairs.length,
      legacy: legacy,
      reviewCount: legacy.sessionCount,
      reviewDueCount: legacy.dueTotal,
      reviewFreshCount: legacy.freshTotal,
      newUnitCount: unitStateSelected && !unitStateSelected.started ? 1 : 0,
      courseBlockCount: inProgress || (unitStateSelected && !unitStateSelected.started) ? 1 : 0,
      dailyNewLimitReached: dailyNewLimitReached,
      newUnitsStartedToday: newUnitsStartedToday,
      inProgressUnitCount: activeStates.filter(function (state) { return state.started && !state.complete; }).length,
      lockedUnitCount: activeStates.filter(function (state) { return !state.started && !state.unlocked; }).length,
      unitStates: activeStates,
      allUnitStates: states,
      activeCourseId: activeCourseId,
      courses: summarizeCourses(states, activeCourseId),
      reviewLoadHigh: reviewLoadHigh,
      estimatedMinutes: estimatePlanMinutes(input),
      steps: planSteps(input),
      actions: actions,
      action: actions[0] || null
    };
  }
  function launchLegacy(legacy) {
    if (!legacy || !legacy.selected || !legacy.selected.available) return false;
    var selected = legacy.selected, count = Math.min(8, Math.max(1, selected.available));
    var inputIds = selected.type === 'phrasal' ? ['pv-study-count', 'study-count'] : selected.type === 'expr' ? ['expr-study-count', 'study-count'] : ['study-count'];
    inputIds.forEach(function (id) { var input = document.getElementById(id); if (input) input.value = String(count); });
    /* v9.5: localStorage.setItem('defaultCount', ...) 제거.
       index.html 이 이 키를 학습 개수의 전역 기본값으로 42곳에서 읽는다.
       Lean 실행 1회가 사용자의 설정을 최대 8로 영구히 덮어써서, 이후 모든 일반 학습이
       8개짜리로 줄어들었다. 이번 실행에만 쓰이는 값이므로 입력 필드만 세팅한다. */
    var starter = function () { return typeof quickStartMode === 'function' ? quickStartMode(selected.type, selected.mode) : false; };
    if (typeof safeStart === 'function') safeStart(starter); else starter();
    return true;
  }

  modules.scheduler = {
    NEW_UNIT_DAILY_LIMIT: NEW_UNIT_DAILY_LIMIT,
    legacyDueSummary: legacyDueSummary,
    interleave: interleave,
    listUnitStates: listUnitStates,
    queueForUnit: queueForUnit,
    queueForBenchmarks: queueForBenchmarks,
    dueBenchmarksForUnit: dueBenchmarksForUnit,
    buildTodayPlan: buildTodayPlan,
    estimatePlanMinutes: estimatePlanMinutes,
    planSteps: planSteps,
    getActiveCourseId: getActiveCourseId,
    setActiveCourseId: setActiveCourseId,
    summarizeCourses: summarizeCourses,
    launchLegacy: launchLegacy
  };
})();
