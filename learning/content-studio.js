/* CEMS v9.2.8 Learning-first — reviewerless small-course authoring and deterministic local audit */
(function () {
  'use strict';

  var root = window.CEMS_LEAN = window.CEMS_LEAN || {};
  var modules = root._modules = root._modules || {};
  var schema = modules.schema;
  var exercise = modules.exercise;
  var SAFE_TYPES = ['contextChoice', 'listenChoiceOrDictation', 'cloze', 'tokenOrder', 'transform', 'guidedProduction'];
  var MAX_SELF_SERVICE_UNITS = 4;
  var MAX_JSON_BYTES = 2 * 1024 * 1024;
  var PROMPT_VERSION = 'cems-safe-core-2';

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function text(value) { return String(value == null ? '' : value); }
  function byteLength(value) {
    var source = text(value);
    try { return new TextEncoder().encode(source).length; }
    catch (_) { try { return new Blob([source]).size; } catch (__) { return source.length * 2; } }
  }
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + canonical(value[key]); }).join(',') + '}';
    return JSON.stringify(value);
  }
  function unique(values) { return Array.from(new Set((values || []).filter(Boolean))); }
  function comparableUnit(value) {
    var copy = clone(value || {});
    delete copy.qa;
    delete copy.courseVersion;
    return canonical(copy);
  }
  function makeIssue(severity, code, path, message) { return { severity: severity, code: code, path: path, message: message }; }
  function isBenchmark(task) { return !!(task && (task.phase === 'baseline' || task.phase === 'transfer' || task.phase === 'retention' || task.benchmarkId || task.transferId)); }
  function allTasks(unit) {
    var rows = [];
    (unit.practicePlan || []).forEach(function (task) { rows.push({ unit: unit, task: task, kind: 'practice' }); });
    (unit.repairPlan || []).forEach(function (task) { rows.push({ unit: unit, task: task, kind: 'repair' }); });
    (unit.baselineItems || []).forEach(function (task) { rows.push({ unit: unit, task: task, kind: 'benchmark' }); });
    (unit.transferItems || []).forEach(function (task) { rows.push({ unit: unit, task: task, kind: 'benchmark' }); });
    return rows;
  }
  function issueKey(language) { return 'cemsLeanContentIssues:' + language; }
  function nowIso() { return new Date().toISOString(); }
  function expectedInputError(message) {
    var error = new Error(message);
    error.name = 'CEMSInputError';
    error.cemsExpected = true;
    return error;
  }
  function safeParse(textValue) {
    var source = text(textValue).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (!source) throw expectedInputError('JSON이 비어 있습니다.');
    if (byteLength(source) > MAX_JSON_BYTES) throw expectedInputError('JSON은 2MB 이하만 검사할 수 있습니다.');
    try { return JSON.parse(source); }
    catch (error) { throw expectedInputError('JSON 문법을 확인하십시오: ' + error.message); }
  }
  function stampUnit(unit) {
    unit.qa = Object.assign({}, unit.qa || {}, {
      status: 'machine_validated_unreviewed',
      languageReviewed: false,
      machineAudited: true,
      assessmentLeakChecked: true,
      baselineLeakChecked: true,
      machineValidated: true,
      parallelConstructChecked: true
    });
    return unit;
  }
  function stampPack(pack) {
    pack.qa = Object.assign({}, pack.qa || {}, {
      status: 'machine_validated_unreviewed',
      languageReviewed: false,
      crossUnitLeakChecked: true,
      promptVersion: PROMPT_VERSION
    });
    (pack.units || []).forEach(stampUnit);
    return pack;
  }
  function wrapUnit(unit) {
    var courseId = text(unit.courseId || ('custom-' + unit.unitId)).trim();
    if (!unit.courseId) unit.courseId = courseId;
    if (!unit.courseTitleKo) unit.courseTitleKo = unit.functionKo || unit.unitId;
    unit.courseOrder = Number(unit.courseOrder || 1);
    unit.prerequisiteUnitIds = Array.isArray(unit.prerequisiteUnitIds) ? unit.prerequisiteUnitIds : [];
    return {
      schemaVersion: 'cems-lean-pack-1', version: Number(unit.version || 1), language: unit.language,
      packId: courseId, titleKo: unit.courseTitleKo, descriptionKo: unit.situationKo || unit.functionKo,
      expectedWeeks: 1, newUnitsPerDayMax: 1, sequencePolicy: 'linear',
      unitOrder: [unit.unitId], unitFiles: ['units/01_' + unit.unitId + '.json'], units: [unit],
      qa: { status: 'machine_validated_unreviewed', languageReviewed: false, crossUnitLeakChecked: true }
    };
  }
  function coercePack(raw) {
    var value = clone(raw);
    if (value && value.schemaVersion === 'cems-lean-unit-1') value = wrapUnit(value);
    return stampPack(value);
  }
  function responseFor(task, good) {
    if (task.type === 'contextChoice' || (task.type === 'listenChoiceOrDictation' && task.listenMode === 'choice')) {
      var option = (task.options || []).find(function (row) { return good ? row.correct === true : row.correct !== true; });
      return { optionId: option ? option.optionId : '__missing__' };
    }
    if (task.type === 'tokenOrder') {
      var ids = (task.correctTokenIds || []).slice();
      if (!good) ids = ids.length > 1 ? ids.slice().reverse() : ['__wrong__'];
      return { tokenIds: ids };
    }
    var values = task.acceptedSet || task.acceptedVariants || [];
    var answer = values[0] || (task.feedback && task.feedback.correctAnswer) || '';
    return { text: good ? answer : '__cems_obvious_wrong_9f4c__' };
  }
  function engineAudit(unit, task, path, issues) {
    if (!exercise || typeof exercise.grade !== 'function') return;
    var gold = exercise.grade(task, responseFor(task, true), unit);
    var wrong = exercise.grade(task, responseFor(task, false), unit);
    if (!gold.correct) issues.push(makeIssue('error', 'engine.goldRejected', path, '실제 채점기가 지정 정답을 정답으로 인정하지 않습니다.'));
    if (wrong.correct) issues.push(makeIssue('error', 'engine.wrongAccepted', path, '실제 채점기가 명백한 오답을 정답으로 인정합니다.'));
    var expected = task.feedback && task.feedback.correctAnswer;
    if (expected && !exercise.grade(task, { text: expected, optionId: responseFor(task, true).optionId, tokenIds: responseFor(task, true).tokenIds }, unit).correct && task.type !== 'tokenOrder' && task.type !== 'contextChoice' && !(task.type === 'listenChoiceOrDictation' && task.listenMode === 'choice')) {
      issues.push(makeIssue('error', 'feedback.answerRejected', path + '.feedback.correctAnswer', '피드백 정답이 실제 허용 답안과 일치하지 않습니다.'));
    }
  }
  function targetLanguageStrings(unit) {
    var values = [];
    (unit.targets || []).forEach(function (target) {
      ['form', 'lemma', 'expression', 'traditional', 'simplified', 'pinyin', 'pinyinMarked'].forEach(function (key) { if (target && target[key]) values.push(text(target[key])); });
      (target && target.pinyinSegments || []).forEach(function (row) { values.push(text(row)); });
    });
    allTasks(unit).forEach(function (entry) {
      values = values.concat(schema.taskAnswerValues(entry.task, unit));
      if (entry.task.ttsText) values.push(text(entry.task.ttsText));
      if (entry.task.ttsTraditional) values.push(text(entry.task.ttsTraditional));
      if (entry.task.ttsSimplified) values.push(text(entry.task.ttsSimplified));
    });
    (unit.model && unit.model.lines || []).forEach(function (line) {
      if (typeof line === 'string') values.push(line);
      else if (line) values.push(text(unit.language === 'zh' ? (unit.primaryScript === 'simplified' ? line.simplified || line.traditional : line.traditional || line.simplified) : line.text));
    });
    return values.filter(Boolean);
  }
  function scanArtifacts(value, path, issues) {
    if (typeof value === 'string') {
      if (/\b(?:TODO|TBD|Lorem ipsum|placeholder)\b|As an AI|여기에\s*(?:내용|문장|정답).*입력/iu.test(value)) issues.push(makeIssue('error', 'content.placeholder', path, '임시 문구 또는 AI 작업 흔적이 남아 있습니다.'));
      return;
    }
    if (Array.isArray(value)) return value.forEach(function (item, index) { scanArtifacts(item, path + '[' + index + ']', issues); });
    if (value && typeof value === 'object') Object.keys(value).forEach(function (key) { scanArtifacts(value[key], path + '.' + key, issues); });
  }
  function modelSurfaces(unit) {
    return (unit.model && unit.model.lines || []).map(function (line) {
      if (typeof line === 'string') return line;
      if (!line) return '';
      return unit.language === 'zh'
        ? (unit.primaryScript === 'simplified' ? line.simplified || line.traditional : line.traditional || line.simplified)
        : line.text;
    }).filter(Boolean).map(function (value) { return schema.normalizeAnswer(value, null, unit.language); });
  }
  function crossInstalledAudit(pack, installedRecords, issues) {
    var incomingUnits = pack.units || [];
    var incomingIds = new Set(incomingUnits.map(function (unit) { return unit.unitId; }));
    var allExisting = (installedRecords || []).filter(Boolean);
    var existingById = new Map(allExisting.map(function (record) { return [record.unitId || (record.unit && record.unit.unitId), record]; }));
    var sameCourse = allExisting.filter(function (record) { return text(record.courseId || (record.unit && record.unit.courseId)) === text(pack.packId); });
    var incomingPackVersion = Number(pack.version || 0);
    var knownPackVersions = sameCourse.map(function (record) { return Number(record.packVersion || record.source && record.source.packVersion || 0); }).filter(function (value) { return Number.isInteger(value) && value > 0; });
    var existingPackVersion = knownPackVersions.length ? Math.max.apply(Math, knownPackVersions) : 0;
    var existingOrder = sameCourse.slice().sort(function (a, b) { return Number(a.sequence || a.unit && a.unit.courseOrder || 0) - Number(b.sequence || b.unit && b.unit.courseOrder || 0) || text(a.unitId || a.unit && a.unit.unitId).localeCompare(text(b.unitId || b.unit && b.unit.unitId)); }).map(function (record) { return record.unitId || record.unit && record.unit.unitId; });
    var incomingOrder = (pack.unitOrder || incomingUnits.slice().sort(function (a, b) { return Number(a.courseOrder || 0) - Number(b.courseOrder || 0); }).map(function (unit) { return unit.unitId; })).slice();
    var compositionErrorAdded = false;
    function compositionError(message) {
      if (compositionErrorAdded) return;
      compositionErrorAdded = true;
      issues.push(makeIssue('error', 'installed.courseCompositionChanged', '$.unitOrder', message));
    }
    var courseChanged = sameCourse.length > 0 && incomingOrder.length !== existingOrder.length;
    if (existingOrder.some(function (id, index) { return incomingOrder[index] !== id; })) {
      courseChanged = true;
      compositionError('기존 단원의 순서·구성을 바꿀 수 없습니다. 새 단원은 기존 마지막 단원 뒤에만 추가하세요.');
    }
    var existingTitle = sameCourse.map(function (record) { return text(record.courseTitleKo || record.unit && record.unit.courseTitleKo); }).find(Boolean);
    if (existingTitle && text(pack.titleKo).trim() && existingTitle !== text(pack.titleKo).trim()) courseChanged = true;
    if (existingPackVersion && incomingPackVersion < existingPackVersion) {
      issues.push(makeIssue('error', 'installed.packVersionLower', '$.version', '설치된 코스 팩 v' + existingPackVersion + '보다 낮은 version은 가져올 수 없습니다.'));
    }
    if (sameCourse.some(function (record) { return record.source && /^built_in_/.test(text(record.source.type)); })) {
      issues.push(makeIssue('error', 'installed.builtInCourseReserved', '$.packId', '내장 시작 코스 ID는 자체 생성 코스로 덮어쓸 수 없습니다. 새 packId와 unitId를 사용하세요.'));
    }
    sameCourse.forEach(function (record) {
      var id = record.unitId || (record.unit && record.unit.unitId);
      if (id && !incomingIds.has(id)) issues.push(makeIssue('error', 'installed.courseUnitRemoval', '$.units', '기존 코스 업데이트는 설치된 단원을 누락하거나 삭제할 수 없습니다: ' + id));
    });
    incomingUnits.forEach(function (unit, unitIndex) {
      var base = '$.units[' + unitIndex + ']';
      var same = existingById.get(unit.unitId);
      if (same) {
        var existingUnit = same.unit || same;
        var builtIn = same.source && /^built_in_/.test(text(same.source.type));
        if (builtIn) issues.push(makeIssue('error', 'installed.unitIdReserved', base + '.unitId', '내장 단원 ID는 자체 생성 콘텐츠가 사용할 수 없습니다: ' + unit.unitId));
        if (text(same.courseId || existingUnit.courseId) !== text(unit.courseId)) issues.push(makeIssue('error', 'installed.unitCourseConflict', base + '.courseId', '기존 unitId를 다른 코스로 이동할 수 없습니다: ' + unit.unitId));
        var contentChanged = comparableUnit(unit) !== comparableUnit(existingUnit);
        if (contentChanged) courseChanged = true;
        var existingSequence = Number(same.sequence || existingUnit.courseOrder || existingUnit.sequence || 0);
        var incomingSequence = Number(unit.courseOrder || unit.sequence || 0);
        var existingPrerequisites = (existingUnit.prerequisiteUnitIds || existingUnit.prerequisites || []).slice();
        var incomingPrerequisites = (unit.prerequisiteUnitIds || unit.prerequisites || []).slice();
        if (existingSequence !== incomingSequence || canonical(existingPrerequisites) !== canonical(incomingPrerequisites)) {
          courseChanged = true;
          compositionError('기존 단원의 courseOrder와 prerequisiteUnitIds는 유지해야 합니다. 새 단원은 마지막에만 추가하세요.');
        }
        var incomingVersion = Number(unit.version || 0), existingVersion = Number(same.version || existingUnit.version || 0);
        if (incomingVersion < existingVersion) issues.push(makeIssue('error', 'installed.versionLower', base + '.version', '설치된 v' + existingVersion + '보다 낮은 단원은 가져올 수 없습니다.'));
        else if (incomingVersion === existingVersion) {
          if (contentChanged) issues.push(makeIssue('error', 'installed.versionNotIncremented', base + '.version', '기존 내용과 달라졌다면 단원 version을 ' + (existingVersion + 1) + ' 이상으로 올려야 합니다.'));
          else issues.push(makeIssue('warning', 'installed.duplicateUnit', base + '.unitId', '같은 버전과 내용의 단원이 이미 설치되어 있습니다: ' + unit.unitId));
        }
        var oldTargets = new Set((existingUnit.targets || []).map(function (row) { return row.targetId; }));
        var newTargets = new Set((unit.targets || []).map(function (row) { return row.targetId; }));
        oldTargets.forEach(function (id) { if (!newTargets.has(id)) issues.push(makeIssue('error', 'installed.targetIdChanged', base + '.targets', '기존 targetId를 삭제하거나 이름을 바꿀 수 없습니다: ' + id)); });
        var oldTaskIds = allTasks(existingUnit).map(function (row) { return row.task.taskId; }).sort();
        var newTaskIds = allTasks(unit).map(function (row) { return row.task.taskId; }).sort();
        if (oldTaskIds.join('|') !== newTaskIds.join('|')) issues.push(makeIssue('error', 'installed.taskIdentityChanged', base, '기존 학습 기록과 연결되는 taskId 집합을 변경할 수 없습니다. 기존 ID를 유지한 채 내용만 고치세요.'));
        function benchmarkIdentity(sourceUnit) {
          return allTasks(sourceUnit).filter(function (row) { return row.kind === 'benchmark'; }).map(function (row) {
            var task = row.task; return [task.phase, task.benchmarkId || task.transferId || task.taskId, task.measurementKey || ''].join('|');
          }).sort().join('||');
        }
        if (benchmarkIdentity(existingUnit) !== benchmarkIdentity(unit)) issues.push(makeIssue('error', 'installed.benchmarkIdentityChanged', base, '기준선·전이·유지의 benchmarkId·phase·measurementKey는 업데이트에서도 유지해야 합니다.'));
      }
    });
    if (sameCourse.length && existingPackVersion && courseChanged && incomingPackVersion <= existingPackVersion) {
      issues.push(makeIssue('error', 'installed.packVersionNotIncremented', '$.version', '코스 내용이나 단원 구성이 바뀌었다면 팩 version을 ' + (existingPackVersion + 1) + ' 이상으로 올려야 합니다.'));
    }
    var existingUnits = allExisting.filter(function (record) {
      var id = record.unitId || (record.unit && record.unit.unitId);
      return !incomingIds.has(id);
    }).map(function (record) { return record.unit || record; }).filter(Boolean);
    incomingUnits.forEach(function (unit, unitIndex) {
      existingUnits.forEach(function (existing) {
        if (!existing || existing.language !== unit.language) return;
        if (text(existing.functionKo).trim() && text(existing.functionKo).trim() === text(unit.functionKo).trim()) {
          issues.push(makeIssue('warning', 'installed.functionDuplicate', '$.units[' + unitIndex + '].functionKo', '이미 설치된 단원과 기능명이 같습니다: ' + existing.unitId));
        }
        var incoming = allTasks(unit), old = allTasks(existing);
        incoming.forEach(function (left) {
          old.forEach(function (right) {
            if (!(left.kind === 'benchmark' || right.kind === 'benchmark')) return;
            var overlap = schema.taskAnswerOverlap(left.task, unit, right.task, existing);
            if (overlap.length) issues.push(makeIssue('error', 'installed.answerLeak', '$.units[' + unitIndex + ']', '설치된 콘텐츠의 평가·연습 정답과 겹칩니다: ' + existing.unitId + '/' + right.task.taskId + ' · ' + overlap[0]));
            if (left.task.variantKey && right.task.variantKey && left.task.variantKey === right.task.variantKey) issues.push(makeIssue('error', 'installed.variantLeak', '$.units[' + unitIndex + ']', '설치된 콘텐츠와 평가 variantKey가 겹칩니다: ' + left.task.variantKey));
          });
        });
        var incomingModels = modelSurfaces(unit), oldModels = modelSurfaces(existing);
        var incomingBench = incoming.filter(function (row) { return row.kind === 'benchmark'; }).flatMap(function (row) { return schema.taskAnswerValues(row.task, unit); });
        var oldBench = old.filter(function (row) { return row.kind === 'benchmark'; }).flatMap(function (row) { return schema.taskAnswerValues(row.task, existing); });
        incomingBench.forEach(function (answer) { if (oldModels.indexOf(answer) >= 0) issues.push(makeIssue('error', 'installed.modelLeak', '$.units[' + unitIndex + '].model', '새 평가 정답이 설치된 모델 문장에 노출되어 있습니다: ' + answer)); });
        oldBench.forEach(function (answer) { if (incomingModels.indexOf(answer) >= 0) issues.push(makeIssue('error', 'installed.modelLeakReverse', '$.units[' + unitIndex + '].model', '설치된 평가 정답을 새 모델 문장이 노출합니다: ' + answer)); });
      });
    });
  }
  function auditPack(raw, expectedLanguage, options) {
    options = options || {};
    var issues = [], pack;
    try { pack = coercePack(raw); }
    catch (error) { return { valid: false, issues: [makeIssue('error', 'json.clone', '$', error.message)], pack: null, preview: null }; }
    var report = schema.validatePackAndNormalize(pack, expectedLanguage);
    (report.issues || []).forEach(function (item) {
      if (item.code === 'qa.language' || item.code === 'course.qa.language') return;
      issues.push(item);
    });
    pack = report.pack || pack;
    if (options.selfService !== false && (pack.units || []).length > MAX_SELF_SERVICE_UNITS) issues.push(makeIssue('error', 'studio.unitLimit', '$.units', '자체 생성 코스는 한 번에 1~4단원만 추가할 수 있습니다.'));
    if (!(pack.units || []).length) issues.push(makeIssue('error', 'studio.empty', '$.units', '단원이 없습니다.'));
    (pack.units || []).forEach(function (unit, index) {
      var base = '$.units[' + index + ']';
      var practice = unit.practicePlan || [], repairs = unit.repairPlan || [];
      if (practice.length !== 6) issues.push(makeIssue('error', 'studio.practiceCount', base + '.practicePlan', '본 학습은 정확히 6문항이어야 합니다.'));
      SAFE_TYPES.forEach(function (type) {
        var count = practice.filter(function (task) { return task.type === type; }).length;
        if (count !== 1) issues.push(makeIssue('error', 'studio.typeCoverage', base + '.practicePlan', type + ' 문항은 정확히 1개여야 합니다.'));
      });
      if (repairs.length !== 3) issues.push(makeIssue('error', 'studio.repairCount', base + '.repairPlan', '오류 보충 문항은 정확히 3개여야 합니다.'));
      var targetRefs = new Set();
      practice.forEach(function (task) { (task.targetRefs || []).forEach(function (id) { targetRefs.add(id); }); });
      (unit.targets || []).forEach(function (target) { if (!targetRefs.has(target.targetId)) issues.push(makeIssue('error', 'studio.targetUnused', base + '.targets', '본 학습에서 사용하지 않는 target이 있습니다: ' + target.targetId)); });
      allTasks(unit).forEach(function (entry, taskIndex) { engineAudit(unit, entry.task, base + '.' + entry.kind + '[' + taskIndex + ']', issues); });
      scanArtifacts(unit, base, issues);
      var surfaces = targetLanguageStrings(unit);
      if (unit.language === 'en') {
        surfaces.forEach(function (value) { if (/\p{Script=Han}/u.test(value)) issues.push(makeIssue('error', 'en.answer.han', base, '영어 정답·모델 표면형에 한자가 포함되어 있습니다: ' + value)); });
      } else {
        if (unit.targetVariety !== 'zh-TW' || unit.primaryScript !== 'traditional') issues.push(makeIssue('error', 'zh.profile', base, '중국어 자체 생성 코스는 zh-TW·번체를 기준으로 합니다.'));
        surfaces.filter(function (value) { return /\d/.test(value) && /[A-Za-z]/.test(value); }).forEach(function (value) { issues.push(makeIssue('error', 'zh.pinyin.numeric', base, '숫자 성조 병음 대신 성조 부호 병음을 사용하세요: ' + value)); });
      }
    });
    crossInstalledAudit(pack, options.installedRecords || [], issues);
    var dedup = [], seen = new Set();
    issues.forEach(function (item) { var key = item.severity + '|' + item.code + '|' + item.path + '|' + item.message; if (!seen.has(key)) { seen.add(key); dedup.push(item); } });
    issues = dedup;
    var levels = unique((pack.units || []).map(function (unit) { return unit.level; }));
    return {
      valid: !issues.some(function (item) { return item.severity === 'error'; }),
      issues: issues,
      pack: pack,
      preview: { packId: pack.packId || '', titleKo: pack.titleKo || '', unitCount: (pack.units || []).length, levels: levels, functions: (pack.units || []).map(function (unit) { return unit.functionKo; }) },
      engineChecked: true,
      qaStatus: 'machine_validated_unreviewed'
    };
  }
  function sampleShape(language) {
    var target = language === 'zh'
      ? { targetId: 'course-u1-frame', kind: 'pragmaticFrame', traditional: '<自然스러운 번체 문형>', simplified: '<대응 간체>', pinyinMarked: '<성조 부호 병음>', meaningKo: '<한국어 기능 의미>', segmentation: ['<번체 문형>'], pinyinSegments: ['<정렬된 병음>'], usageNoteKo: '<사용 조건>' }
      : { targetId: 'course-u1-frame', kind: 'pragmaticFrame', form: '<자연스러운 영어 문형>', meaningKo: '<한국어 기능 의미>', usageNoteKo: '<사용 조건>', register: 'polite-neutral' };
    var listen = language === 'zh'
      ? { taskId: 'course-u1-listen', type: 'listenChoiceOrDictation', listenMode: 'choice', domain: 'comprehension', targetRefs: ['course-u1-frame'], variantKey: 'u1-listen-distinct', promptKo: '<듣기 지시>', ttsTraditional: '<번체 음성 문장>', ttsSimplified: '<간체 대응>', options: [{ optionId: 'a', text: '<정답 선택지>', correct: true }, { optionId: 'b', text: '<오답>', correct: false }], hints: ['<힌트>'], feedback: { correctAnswer: '<정답>', contrastKo: '<대조>', explanationKo: '<한 줄 규칙>', errorCode: 'u1.listening' } }
      : { taskId: 'course-u1-listen', type: 'listenChoiceOrDictation', listenMode: 'choice', domain: 'comprehension', targetRefs: ['course-u1-frame'], variantKey: 'u1-listen-distinct', promptKo: '<듣기 지시>', ttsText: '<영어 음성 문장>', options: [{ optionId: 'a', text: '<정답 선택지>', correct: true }, { optionId: 'b', text: '<오답>', correct: false }], hints: ['<힌트>'], feedback: { correctAnswer: '<정답>', contrastKo: '<대조>', explanationKo: '<한 줄 규칙>', errorCode: 'u1.listening' } };
    var unit = {
      schemaVersion: 'cems-lean-unit-1', version: 1, language: language, unitId: 'course-u1', level: 'A2', courseId: 'unique-course-id', courseOrder: 1, courseTitleKo: '<코스 제목>', prerequisiteUnitIds: [], estimatedMinutes: 10,
      functionKo: '<한 가지 실제 기능>', situationKo: '<구체적인 상황>', targets: [target], slotBanks: { item: ['<검수된 슬롯 1>', '<검수된 슬롯 2>'] },
      model: { lines: language === 'zh' ? [{ speaker: 'A', traditional: '<번체 모델 문장>', simplified: '<간체 대응>', pinyin: '<성조 부호 병음>', translationKo: '<한국어>' }] : [{ speaker: 'A', text: '<영어 모델 문장>', translationKo: '<한국어>' }] },
      practicePlan: [
        { taskId: 'course-u1-context', type: 'contextChoice', domain: 'comprehension', targetRefs: ['course-u1-frame'], variantKey: 'u1-context-distinct', promptKo: '<문맥 의도 지시>', context: '<목표어 문맥>', options: [{ optionId: 'a', text: '<정답>', correct: true }, { optionId: 'b', text: '<오답>', correct: false }], hints: ['<힌트>'], feedback: { correctAnswer: '<정답>', contrastKo: '<대조>', explanationKo: '<한 줄 규칙>', errorCode: 'u1.comprehension' } },
        listen,
        { taskId: 'course-u1-cloze', type: 'cloze', domain: 'production', targetRefs: ['course-u1-frame'], variantKey: 'u1-cloze-distinct', promptKo: '<빈칸 지시>', clozeText: '<목표어 ____ 문장>', acceptedSet: ['<짧은 정답>'], hints: ['<힌트>'], feedback: { correctAnswer: '<짧은 정답>', contrastKo: '<대조>', explanationKo: '<한 줄 규칙>', errorCode: 'u1.form' } },
        { taskId: 'course-u1-order', type: 'tokenOrder', domain: 'production', targetRefs: ['course-u1-frame'], variantKey: 'u1-order-distinct', promptKo: '<어순 지시>', tokens: [{ tokenId: 't1', text: '<토큰 1>' }, { tokenId: 't2', text: '<토큰 2>' }], correctTokenIds: ['t1', 't2'], hints: ['<힌트>'], feedback: { correctAnswer: '<완성 문장>', contrastKo: '<대조>', explanationKo: '<한 줄 규칙>', errorCode: 'u1.order' } },
        { taskId: 'course-u1-transform', type: 'transform', domain: 'production', targetRefs: ['course-u1-frame'], variantKey: 'u1-transform-distinct', promptKo: '<변형 지시>', contextKo: '<변형할 조건>', acceptedSet: ['<완전한 목표어 문장>'], hints: ['<힌트>'], feedback: { correctAnswer: '<허용 답안 중 하나>', contrastKo: '<대조>', explanationKo: '<한 줄 규칙>', errorCode: 'u1.transform' } },
        { taskId: 'course-u1-guided', type: 'guidedProduction', domain: 'production', targetRefs: ['course-u1-frame'], variantKey: 'u1-guided-distinct', promptKo: '<목표어 한 문장 산출 지시>', contextKo: '<구체적인 새 조건>', acceptedVariants: ['<자연스러운 완전 문장>'], hints: ['<의미 힌트>', '<첫 요소 힌트>'], feedback: { correctAnswer: '<허용 답안 중 하나>', contrastKo: '<대조>', explanationKo: '<한 줄 규칙>', errorCode: 'u1.production' } }
      ],
      repairPlan: ['form', 'order', 'production'].map(function (kind, index) { return { taskId: 'course-u1-repair-' + (index + 1), type: index === 1 ? 'tokenOrder' : (index === 0 ? 'cloze' : 'guidedProduction'), domain: 'production', targetRefs: ['course-u1-frame'], variantKey: 'u1-repair-' + (index + 1) + '-distinct', promptKo: '<다른 소재의 오류 보충>', clozeText: index === 0 ? '<다른 ____ 문장>' : undefined, acceptedSet: index === 0 ? ['<짧은 정답>'] : undefined, tokens: index === 1 ? [{ tokenId: 'r1', text: '<토큰 1>' }, { tokenId: 'r2', text: '<토큰 2>' }] : undefined, correctTokenIds: index === 1 ? ['r1', 'r2'] : undefined, acceptedVariants: index === 2 ? ['<다른 완전 문장>'] : undefined, hints: ['<힌트>'], feedback: { correctAnswer: '<실제 허용 답안>', contrastKo: '<대조>', explanationKo: '<한 줄 규칙>', errorCode: 'u1.' + kind } }; }),
      repairRules: [{ errorCode: 'u1.comprehension', targetRefs: ['course-u1-frame'], repairTaskRefs: ['course-u1-repair-1'], contrastKo: '<보충 목적>' }],
      baselineItems: [{ taskId: 'course-u1-baseline-task', benchmarkId: 'course-u1-baseline', phase: 'baseline', minimumDelayDays: 0, measurementKey: 'language.function.construct', type: 'guidedProduction', domain: 'transfer', targetRefs: ['course-u1-frame'], variantKey: 'u1-baseline-distinct', promptKo: '<학습 전 산출 지시>', contextKo: '<연습과 다른 소재>', acceptedVariants: ['<연습과 겹치지 않는 완전 문장>'], hints: [], noFeedback: true }],
      transferItems: [
        { taskId: 'course-u1-transfer-task', benchmarkId: 'course-u1-transfer', transferId: 'course-u1-transfer', phase: 'transfer', minimumDelayDays: 3, measurementKey: 'language.function.construct', type: 'guidedProduction', domain: 'transfer', targetRefs: ['course-u1-frame'], variantKey: 'u1-transfer-distinct', promptKo: '<3일 전이 지시>', contextKo: '<새 소재>', acceptedVariants: ['<고유한 완전 문장>'], hints: [], feedback: { correctAnswer: '<허용 답안 중 하나>', contrastKo: '<대조>', explanationKo: '<한 줄 규칙>', errorCode: 'u1.production' } },
        { taskId: 'course-u1-retention-task', benchmarkId: 'course-u1-retention', transferId: 'course-u1-retention', phase: 'retention', minimumDelayDays: 14, measurementKey: 'language.function.construct', type: 'guidedProduction', domain: 'transfer', targetRefs: ['course-u1-frame'], variantKey: 'u1-retention-distinct', promptKo: '<14일 유지 지시>', contextKo: '<또 다른 소재>', acceptedVariants: ['<고유한 완전 문장>'], hints: [], feedback: { correctAnswer: '<허용 답안 중 하나>', contrastKo: '<대조>', explanationKo: '<한 줄 규칙>', errorCode: 'u1.production' } }
      ],
      qa: { status: 'machine_validated_unreviewed', languageReviewed: false, assessmentLeakChecked: true, baselineLeakChecked: true, parallelConstructChecked: true }
    };
    if (language === 'zh') { unit.targetVariety = 'zh-TW'; unit.primaryScript = 'traditional'; }
    return JSON.stringify(unit, function (key, value) { return value === undefined ? undefined : value; }, 2);
  }
  function buildGenerationPrompt(language, config) {
    config = config || {};
    var count = Math.max(1, Math.min(MAX_SELF_SERVICE_UNITS, Number(config.unitCount || 1)));
    var langRules = language === 'zh'
      ? [
        '대상은 대만에서 자연스러운 현대 표준 중국어(zh-TW)다. 영어 문장을 직역해서 만들지 않는다.',
        'primaryScript는 traditional, targetVariety는 zh-TW로 고정한다. 모든 핵심 표면형은 번체를 기준으로 쓰고 간체 대응과 성조 부호 병음을 보존한다.',
        '숫자 성조 병음은 쓰지 않는다. segmentation과 pinyinSegments는 같은 토큰 수로 정확히 정렬한다. 把/被/了/過/著, 양사, 시간·장소·부사 어순은 실제 기능에 필요할 때만 사용한다.',
        '한국어 번역은 직역보다 기능과 맥락을 정확히 전달한다.'
      ]
      : [
        '대상은 현대의 중립적이고 고빈도인 일상 영어다. 한국어를 직역한 어색한 문장을 만들지 않는다.',
        '청크·연어·정중도·전치사·관사·시제·구동사 대명사 위치를 실제 용법에 맞게 쓴다.',
        '미국식/영국식 차이가 있으면 하나를 일관되게 선택하고 필요한 경우 target 메모에 밝힌다.',
        '허용 답안은 실제로 자연스럽고 같은 기능을 수행하는 문장만 넣는다. 단순히 문법적으로 가능하다는 이유로 과도하게 넓히지 않는다.'
      ];
    var avoid = text(config.avoidKo || '').trim();
    var prompt = [
      '당신은 CEMS 오프라인 독학 앱의 ' + (language === 'zh' ? '대만 중국어' : '영어') + ' 마이크로 코스 저자이자 보수적 품질 검사자다.',
      '아래 조건을 한 번에 수행하고 최종 JSON 객체 하나만 출력하라. 설명, 마크다운, 코드펜스, 생성 과정은 출력하지 마라.',
      '',
      '## 요청',
      '- 코스 제목: ' + text(config.titleKo || '실생활 기능 코스'),
      '- 목표 수준: ' + text(config.level || 'A2'),
      '- 단원 수: 정확히 ' + count + '개',
      '- 집중할 생활 기능: ' + text(config.focusKo || '일상에서 자주 필요한 짧은 문제 해결'),
      avoid ? '- 피할 주제·어휘: ' + avoid : '- 피할 주제·어휘: 과도하게 전문적이거나 민감한 소재, 드문 관용구',
      '',
      '## 제품 목표',
      '각 단원은 한 가지 실제 기능을 8~12분 동안 훈련한다. 문맥 이해 → 듣기/형태 회상 → 어순 → 변형 → 선택지 없는 짧은 산출로 이어지고, 서로 다른 문장으로 오류 보충 3개, 비공개 기준선 1개, 3일 전이 1개, 14일 유지 1개를 제공한다.',
      '자유 회화·장문 작문·발음 점수를 흉내 내지 않는다. 자동 채점 가능한 통제된 짧은 수행만 만든다.',
      '',
      '## 언어 규칙',
      langRules.map(function (row) { return '- ' + row; }).join('\n'),
      '',
      '## 필수 구조 및 검사 규칙',
      '- 최상위 schemaVersion은 cems-lean-pack-1, language는 ' + language + ', version은 1 이상의 정수다.',
      '- packId와 모든 unitId/taskId/targetId/variantKey/measurementKey는 영문 소문자·숫자·하이픈 중심의 전역 고유 ID로 만든다.',
      '- sequencePolicy=linear, newUnitsPerDayMax=1, unitOrder와 courseOrder가 정확히 일치한다. 첫 단원 prerequisiteUnitIds=[], 이후 단원은 바로 앞 단원만 참조한다.',
      '- 각 단원 practicePlan은 정확히 6개이며 contextChoice, listenChoiceOrDictation, cloze, tokenOrder, transform, guidedProduction을 각각 정확히 1개 포함한다.',
      '- 각 단원 repairPlan은 정확히 3개다. 원문항과 다른 variantKey·슬롯·표면 문장을 사용한다.',
      '- baselineItems 1개, transferItems 안에 phase=transfer 1개와 phase=retention 1개를 둔다. 세 문항은 measurementKey가 같고 표면 문장·소재·accepted answer·variantKey는 서로 달라야 한다.',
      '- 평가 문항에는 hints가 없어야 하며 practicePlan/repairPlan/model/다른 단원의 평가 정답과 어떤 허용 답안도 겹치면 안 된다.',
      '- guidedProduction은 과도한 부분 일치 채점을 피한다. acceptedVariants는 확실히 자연스럽고 같은 기능을 수행하는 완전 문장 1~3개만 넣는다. 확신이 없으면 가장 단순한 고빈도 답안 1개만 둔다. requiredSlots/requiredAnchors/orderedSlots/forbiddenForms는 필요할 때만 보수적으로 설정한다.',
      '- options 정답은 정확히 1개다. tokenOrder의 tokens와 correctTokenIds는 누락·중복 없이 일치한다.',
      '- feedback.correctAnswer는 실제 채점 허용 답안 중 하나여야 한다. 오답 설명은 한 줄 규칙과 구체적 대조를 제공한다.',
      '- TODO, placeholder, 꺾쇠 자리표시자, 선택지 번호만 바꾼 복제, 동일 정답 반복, 학습 전 정답 노출을 금지한다. 각 단원과 각 단계의 소재·핵심 명사·표면 문장을 실제로 다르게 만든다.',
      '- qa.status=machine_validated_unreviewed, qa.languageReviewed=false로 둔다. 사람 검수 완료라고 주장하지 않으며 humanReviewed·nativeReviewed 같은 임의 승인 필드를 만들지 않는다.',
      '',
      '## 출력 전 자체 점검',
      '모든 ID 참조, 정답 유일성, 실제 허용 답안, 연습-평가 누출, 단원 간 누출, 평가 평행성, 언어·문자·병음 규칙을 다시 확인하고 문제가 있으면 출력 전에 고친다.',
      '',
      '## 출력 형식',
      '{"schemaVersion":"cems-lean-pack-1", ... , "units":[...]} 형식의 완전한 JSON 객체 하나만 출력한다.',
      '\n## 축약 구조 예시\n다음은 필드 계약만 보여 주는 축약 예시다. 꺾쇠 자리표시자를 실제 검수된 값으로 모두 치환하고, 예시 문구·ID를 그대로 출력하지 마라.\n' + sampleShape(language)
    ].join('\n');
    return prompt;
  }
  function buildRepairPrompt(language, pack, auditIssues, reportedIssues) {
    var issues = (auditIssues || []).concat(reportedIssues || []);
    return [
      '당신은 CEMS ' + (language === 'zh' ? '대만 중국어' : '영어') + ' 코스의 보수적 수리 담당자다.',
      '아래 JSON을 최소 수정하여 모든 문제를 해결하고, 완전한 JSON 객체 하나만 출력하라. 설명·마크다운·코드펜스는 출력하지 마라.',
      '학습자 응답을 무조건 허용 답안에 추가하지 말고, 문장이 실제로 자연스럽고 같은 기능을 수행할 때만 허용하라.',
      '기존 학습 기록과 연결되므로 변경할 필요가 없는 unitId/taskId/targetId/measurementKey는 유지한다. 내용이 바뀐 단원과 팩의 version은 1 올린다.',
      'qa.status는 machine_validated_unreviewed, languageReviewed는 false로 유지한다.',
      '',
      '## 발견된 문제',
      JSON.stringify(issues, null, 2),
      '',
      '## 수정할 JSON',
      JSON.stringify(pack, null, 2)
    ].join('\n');
  }
  function readIssues(language) {
    try { var parsed = JSON.parse(localStorage.getItem(issueKey(language)) || '[]'); return Array.isArray(parsed) ? parsed : []; }
    catch (_) { return []; }
  }
  function recordIssue(raw) {
    raw = raw || {};
    var language = raw.language || 'en';
    var rows = readIssues(language);
    var safe = {
      language: language,
      courseId: text(raw.courseId),
      unitId: text(raw.unitId),
      taskId: text(raw.taskId),
      contentVersion: Number(raw.contentVersion || 0) || null,
      taskType: text(raw.taskType),
      kind: text(raw.kind),
      note: text(raw.note).trim().slice(0, 500),
      appVersion: text(raw.appVersion),
      learnerResponseIncluded: false
    };
    var fingerprint = [safe.courseId, safe.unitId, safe.taskId, safe.kind, safe.note].join('|');
    var existing = rows.find(function (row) { return row.fingerprint === fingerprint; });
    if (existing) return existing;
    var issue = Object.assign(safe, { issueId: 'issue-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), createdAt: nowIso(), fingerprint: fingerprint });
    rows.push(issue);
    try { localStorage.setItem(issueKey(language), JSON.stringify(rows.slice(-200))); } catch (_) {}
    return issue;
  }
  function clearIssues(language) { try { localStorage.removeItem(issueKey(language)); } catch (_) {} }
  function issueBundle(language) {
    return {
      schemaVersion: 'cems-content-issues-1', language: language, generatedAt: nowIso(),
      privacy: { containsRawLearnerResponses: false, containsAnswerKeys: false, learnerResponseIncluded: false },
      issues: readIssues(language).map(function (row) { var copy = Object.assign({}, row); delete copy.fingerprint; delete copy.learnerResponse; delete copy.expectedAnswer; return copy; })
    };
  }

  modules.studio = {
    PROMPT_VERSION: PROMPT_VERSION,
    MAX_SELF_SERVICE_UNITS: MAX_SELF_SERVICE_UNITS,
    MAX_JSON_BYTES: MAX_JSON_BYTES,
    parseJson: safeParse,
    stampPack: stampPack,
    stampUnit: stampUnit,
    auditPack: auditPack,
    buildGenerationPrompt: buildGenerationPrompt,
    buildRepairPrompt: buildRepairPrompt,
    readIssues: readIssues,
    recordIssue: recordIssue,
    clearIssues: clearIssues,
    issueBundle: issueBundle
  };
})();
