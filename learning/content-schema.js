/* CEMS v9.2.3 Lean Stage 3 — unit packs, cold baseline, transfer and retention validation */
(function () {
  'use strict';

  var api = window.CEMS_LEAN = window.CEMS_LEAN || {};
  var modules = api._modules = api._modules || {};
  var TYPES = new Set(['contextChoice', 'listenChoiceOrDictation', 'cloze', 'tokenOrder', 'transform', 'guidedProduction']);
  var DOMAINS = new Set(['comprehension', 'production', 'transfer']);
  var BENCHMARK_TYPES = new Set(['contextChoice', 'cloze', 'tokenOrder', 'transform', 'guidedProduction']);

  function clone(value) {
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }
  function text(value) { return String(value == null ? '' : value); }
  function issue(severity, code, path, message) {
    return { severity: severity, code: code, path: path, message: message };
  }
  function uniqueStrings(list) {
    var seen = new Set();
    return (Array.isArray(list) ? list : []).map(function (x) { return text(x).trim(); }).filter(function (x) {
      if (!x || seen.has(x)) return false;
      seen.add(x); return true;
    });
  }
  function defaultNormalization(language, task) {
    var rules = ['trim', 'collapseSpaces', 'normalizeApostrophe'];
    if (language === 'en') rules.push('caseFold');
    if (task && task.stripPunctuation) rules.push('stripPunctuation');
    return rules;
  }
  function normalizeAnswer(value, rules, language) {
    var out = text(value).normalize('NFKC');
    (Array.isArray(rules) && rules.length ? rules : defaultNormalization(language)).forEach(function (rule) {
      if (rule === 'trim') out = out.trim();
      else if (rule === 'collapseSpaces') out = out.replace(/\s+/g, ' ');
      else if (rule === 'caseFold') out = out.toLocaleLowerCase(language === 'en' ? 'en' : undefined);
      else if (rule === 'normalizeApostrophe') out = out.replace(/[’‘`]/g, "'");
      else if (rule === 'normalizeDash') out = out.replace(/[–—]/g, '-');
      else if (rule === 'stripPunctuation') out = out.replace(/[\p{P}\p{S}]/gu, '').replace(/\s+/g, language === 'zh' ? '' : ' ').trim();
    });
    return out;
  }
  function getSlots(template) {
    var result = [], match, rx = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
    while ((match = rx.exec(text(template)))) if (result.indexOf(match[1]) < 0) result.push(match[1]);
    return result;
  }
  function surfaceAnswer(task) {
    if (!task) return '';
    if (task.feedback && task.feedback.correctAnswer) return text(task.feedback.correctAnswer);
    if (Array.isArray(task.acceptedVariants) && task.acceptedVariants.length) return text(task.acceptedVariants[0]);
    if (Array.isArray(task.acceptedSet) && task.acceptedSet.length) return text(task.acceptedSet[0]);
    if (Array.isArray(task.options)) {
      var right = task.options.find(function (option) { return option.correct === true; });
      if (right) return text(right.text);
    }
    return '';
  }
  function taskVariantFingerprint(task, unit) {
    if (!task) return '';
    var contextLines = Array.isArray(task.contextLines) ? task.contextLines.map(function (line) {
      return unit.language === 'zh' ? (unit.primaryScript === 'simplified' ? line.simplified || line.traditional : line.traditional || line.simplified) : line.text;
    }).join('|') : '';
    return normalizeAnswer([
      task.promptKo, task.contextKo, task.context, task.clozeText,
      contextLines, surfaceAnswer(task)
    ].map(text).join('|'), task.normalization, unit.language);
  }
  function taskAnswerValues(task, unit) {
    if (!task) return [];
    var values = [];
    ['acceptedSet', 'acceptedVariants'].forEach(function (field) {
      if (Array.isArray(task[field])) values = values.concat(task[field]);
    });
    if (Array.isArray(task.options)) task.options.forEach(function (option) { if (option && option.correct === true) values.push(option.text); });
    if (task.feedback && task.feedback.correctAnswer) values.push(task.feedback.correctAnswer);
    return uniqueStrings(values.map(function (value) { return normalizeAnswer(value, task.normalization, unit.language); })).sort();
  }
  function taskAnswerFingerprint(task, unit) { return taskAnswerValues(task, unit).join('||'); }
  function taskAnswerOverlap(taskA, unitA, taskB, unitB) {
    var right = new Set(taskAnswerValues(taskB, unitB));
    return taskAnswerValues(taskA, unitA).filter(function (value) { return right.has(value); });
  }
  function runnableBenchmark(item) {
    return !!(item && typeof item === 'object' && item.type && (item.benchmarkId || item.transferId || item.taskId));
  }
  function scriptDifferenceChars(unit) {
    var pairs = [];
    (unit.targets || []).forEach(function (target) { if (target && target.traditional && target.simplified) pairs.push([text(target.traditional), text(target.simplified)]); });
    Object.keys(unit.slotBanks || {}).forEach(function (key) {
      (unit.slotBanks[key] || []).forEach(function (value) { if (value && typeof value === 'object' && value.traditional && value.simplified) pairs.push([text(value.traditional), text(value.simplified)]); });
    });
    var primaryIndex = unit.primaryScript === 'simplified' ? 1 : 0;
    var opposite = new Set(), allPrimary = new Set();
    pairs.forEach(function (pair) { Array.from(pair[primaryIndex]).forEach(function (char) { allPrimary.add(char); }); });
    pairs.forEach(function (pair) {
      var primary = Array.from(pair[primaryIndex]), other = Array.from(pair[1 - primaryIndex]);
      if (primary.length === other.length) other.forEach(function (char, index) { if (char !== primary[index] && !allPrimary.has(char)) opposite.add(char); });
      else other.forEach(function (char) { if (primary.indexOf(char) < 0 && !allPrimary.has(char)) opposite.add(char); });
    });
    return opposite;
  }
  function productionSurfaces(task) {
    var values = [];
    ['acceptedSet', 'acceptedVariants'].forEach(function (field) { if (Array.isArray(task[field])) values = values.concat(task[field]); });
    if (Array.isArray(task.tokens)) values = values.concat(task.tokens.map(function (token) { return token && token.text; }));
    ['clozeText', 'context'].forEach(function (field) { if (task[field]) values.push(task[field]); });
    if (task.feedback && task.feedback.correctAnswer) values.push(task.feedback.correctAnswer);
    return uniqueStrings(values);
  }
  function valueForLanguage(value, language, primaryScript) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return text(value);
    if (language === 'zh') {
      return primaryScript === 'simplified'
        ? text(value.simplified || value.traditional || value.text)
        : text(value.traditional || value.simplified || value.text);
    }
    return text(value.text || value.form || value.value);
  }
  function templateList(task, unit) {
    var source = task.answerTemplates || task.answerTemplate || [];
    if (source && !Array.isArray(source) && typeof source === 'object') {
      source = unit.language === 'zh'
        ? source[unit.primaryScript || 'traditional'] || source.traditional || source.simplified || []
        : source.en || source.default || [];
    }
    return uniqueStrings(Array.isArray(source) ? source : [source]);
  }
  function cartesian(names, banks, limit) {
    var rows = [[]];
    names.forEach(function (name) {
      var values = banks[name] || [];
      var next = [];
      rows.forEach(function (row) {
        values.forEach(function (value) {
          if (next.length < limit) next.push(row.concat([value]));
        });
      });
      rows = next;
    });
    return rows;
  }
  function generateAcceptedSet(task, unit, issues, path) {
    var generated = uniqueStrings(task.acceptedSet || task.acceptedVariants || []);
    var templates = templateList(task, unit);
    if (!templates.length) return generated;
    var firstSlots = getSlots(templates[0]);
    var slotValues = task.slotValues || {};
    firstSlots.forEach(function (slot) {
      if (!Array.isArray(slotValues[slot]) || !slotValues[slot].length) {
        issues.push(issue('error', 'task.slot.empty', path + '.slotValues.' + slot, '변형 문장의 슬롯 값이 비어 있습니다.'));
      }
    });
    if (issues.some(function (x) { return x.severity === 'error' && x.path.indexOf(path + '.slotValues') === 0; })) return generated;
    var combos = Array.isArray(task.allowedCombinations) && task.allowedCombinations.length
      ? task.allowedCombinations
      : cartesian(firstSlots, slotValues, 100);
    if (combos.length > 100) issues.push(issue('error', 'task.slot.limit', path + '.allowedCombinations', '한 문항의 생성 조합은 100개를 넘을 수 없습니다.'));
    templates.forEach(function (template) {
      var slots = getSlots(template);
      if (slots.join('|') !== firstSlots.join('|')) {
        issues.push(issue('error', 'task.slot.templateMismatch', path + '.answerTemplates', '답안 템플릿의 슬롯 순서가 서로 다릅니다.'));
        return;
      }
      combos.slice(0, 100).forEach(function (combo) {
        if (!Array.isArray(combo) || combo.length !== slots.length) {
          issues.push(issue('error', 'task.slot.combination', path + '.allowedCombinations', '허용 조합의 슬롯 수가 템플릿과 다릅니다.'));
          return;
        }
        var answer = template;
        slots.forEach(function (slot, index) {
          var rendered = valueForLanguage(combo[index], unit.language, unit.primaryScript);
          answer = answer.replace(new RegExp('\\{' + slot + '\\}', 'g'), rendered);
        });
        if (/\{[A-Za-z][A-Za-z0-9_]*\}/.test(answer)) {
          issues.push(issue('error', 'task.slot.unresolved', path + '.answerTemplates', '생성 답안에 해결되지 않은 슬롯이 남았습니다.'));
        } else generated.push(answer);
      });
    });
    return uniqueStrings(generated);
  }
  function validateTarget(target, index, unit, issues, targetIds) {
    var path = '$.targets[' + index + ']';
    if (!target || typeof target !== 'object') { issues.push(issue('error', 'target.type', path, 'target은 객체여야 합니다.')); return; }
    if (!text(target.targetId).trim()) issues.push(issue('error', 'target.id', path + '.targetId', 'targetId가 필요합니다.'));
    else if (targetIds.has(target.targetId)) issues.push(issue('error', 'target.duplicate', path + '.targetId', '중복 targetId입니다.'));
    else targetIds.add(target.targetId);
    if (!text(target.kind).trim()) issues.push(issue('error', 'target.kind', path + '.kind', 'kind가 필요합니다.'));
    if (!text(target.meaningKo).trim()) issues.push(issue('error', 'target.meaning', path + '.meaningKo', '한국어 의미가 필요합니다.'));
    if (unit.language === 'en') {
      if (!text(target.form).trim()) issues.push(issue('error', 'en.target.form', path + '.form', '영어 form이 필요합니다.'));
      target.acceptedVariants = uniqueStrings(target.acceptedVariants || []);
      if (target.kind === 'phrasalVerb') {
        if (!['separable', 'inseparable', 'both'].includes(target.separability)) issues.push(issue('error', 'en.phrasal.separability', path + '.separability', '구동사의 분리 가능성을 명시해야 합니다.'));
        if (!text(target.pronounPosition).trim()) issues.push(issue('error', 'en.phrasal.pronoun', path + '.pronounPosition', '대명사 목적어 위치가 필요합니다.'));
      }
    } else {
      ['traditional', 'simplified', 'pinyinMarked'].forEach(function (field) {
        if (!text(target[field]).trim()) issues.push(issue('error', 'zh.target.' + field, path + '.' + field, '중국어 ' + field + ' 필드가 필요합니다.'));
      });
      if (/[1-5]/.test(text(target.pinyinMarked))) issues.push(issue('error', 'zh.target.pinyinMarked', path + '.pinyinMarked', 'pinyinMarked에는 숫자 성조 대신 성조 부호를 사용해야 합니다.'));
      if (!Array.isArray(target.segmentation) || !Array.isArray(target.pinyinSegments) || !target.segmentation.length || target.segmentation.length !== target.pinyinSegments.length) {
        issues.push(issue('error', 'zh.target.alignment', path, 'segmentation과 pinyinSegments를 같은 길이로 제공해야 합니다.'));
      }
      if (target.kind === 'construction') {
        if (!Array.isArray(target.patternTokens) || !target.patternTokens.length) issues.push(issue('error', 'zh.construction.patternTokens', path + '.patternTokens', 'construction에는 patternTokens가 필요합니다.'));
      }
      if (target.kind === 'classifier' && (!target.measureWordRules || !Array.isArray(target.measureWordRules.nouns) || !target.measureWordRules.nouns.length)) {
        issues.push(issue('error', 'zh.classifier.rules', path + '.measureWordRules', '양사의 연결 명사 범위가 필요합니다.'));
      }
    }
  }
  function validateOptions(options, path, issues) {
    if (!Array.isArray(options) || options.length < 2) {
      issues.push(issue('error', 'task.options', path, '선택지는 두 개 이상이어야 합니다.')); return;
    }
    var ids = new Set(), correct = 0;
    options.forEach(function (option, index) {
      if (!option || !text(option.optionId).trim()) issues.push(issue('error', 'task.option.id', path + '[' + index + '].optionId', 'optionId가 필요합니다.'));
      else if (ids.has(option.optionId)) issues.push(issue('error', 'task.option.duplicate', path + '[' + index + '].optionId', '중복 optionId입니다.'));
      else ids.add(option.optionId);
      if (!text(option.text).trim()) issues.push(issue('error', 'task.option.text', path + '[' + index + '].text', '선택지 문구가 필요합니다.'));
      if (option.correct === true) correct += 1;
    });
    if (correct !== 1) issues.push(issue('error', 'task.option.correct', path, '선택형 정답은 정확히 하나여야 합니다.'));
  }
  function validateTask(task, index, unit, issues, targetIds, taskIds, section) {
    var path = '$.' + section + '[' + index + ']';
    if (!task || typeof task !== 'object') { issues.push(issue('error', 'task.typeObject', path, '문항은 객체여야 합니다.')); return null; }
    if (!text(task.taskId).trim()) issues.push(issue('error', 'task.id', path + '.taskId', 'taskId가 필요합니다.'));
    else if (taskIds.has(task.taskId)) issues.push(issue('error', 'task.duplicate', path + '.taskId', '중복 taskId입니다.'));
    else taskIds.add(task.taskId);
    if (!TYPES.has(task.type)) issues.push(issue('error', 'task.type', path + '.type', '지원하지 않는 문제 유형입니다: ' + text(task.type)));
    if (!DOMAINS.has(task.domain)) issues.push(issue('error', 'task.domain', path + '.domain', 'domain은 comprehension, production 또는 transfer여야 합니다.'));
    var benchmarkSection = section === 'transferItems' || section === 'baselineItems';
    if (benchmarkSection && task.domain !== 'transfer') issues.push(issue('error', 'benchmark.domain', path + '.domain', '기준선·전이·유지 문항의 domain은 transfer여야 합니다.'));
    if (!benchmarkSection && task.domain === 'transfer') issues.push(issue('error', 'benchmark.section', path + '.domain', 'transfer domain 문항은 baselineItems 또는 transferItems에만 둘 수 있습니다.'));
    if (benchmarkSection && !BENCHMARK_TYPES.has(task.type)) issues.push(issue('error', 'benchmark.type', path + '.type', '기준선·전이·유지 확인은 음성 대체 위험이 없는 지원 유형만 사용할 수 있습니다.'));
    if (!text(task.promptKo).trim()) issues.push(issue('error', 'task.prompt', path + '.promptKo', '한국어 지시문이 필요합니다.'));
    if (!Array.isArray(task.targetRefs) || !task.targetRefs.length) issues.push(issue('error', 'task.targets', path + '.targetRefs', 'targetRefs가 필요합니다.'));
    else task.targetRefs.forEach(function (ref) { if (!targetIds.has(ref)) issues.push(issue('error', 'task.targetRef', path + '.targetRefs', '존재하지 않는 target 참조입니다: ' + ref)); });
    task.hints = uniqueStrings(task.hints || []);
    task.normalization = uniqueStrings(task.normalization || defaultNormalization(unit.language, task));
    task.variantKey = text(task.variantKey || task.taskId).trim();
    if (task.type === 'contextChoice') validateOptions(task.options, path + '.options', issues);
    if (task.type === 'listenChoiceOrDictation') {
      if (!['choice', 'dictation'].includes(task.listenMode)) issues.push(issue('error', 'task.listenMode', path + '.listenMode', 'listenMode는 choice 또는 dictation이어야 합니다.'));
      if (!text(task.ttsText || task.ttsTraditional || task.ttsSimplified).trim()) issues.push(issue('error', 'task.tts', path, 'TTS용 문장이 필요합니다.'));
      if (task.listenMode === 'choice') validateOptions(task.options, path + '.options', issues);
      else {
        task.acceptedSet = uniqueStrings(task.acceptedSet || []);
        if (!task.acceptedSet.length) issues.push(issue('error', 'task.accepted', path + '.acceptedSet', '받아쓰기 허용 답안이 필요합니다.'));
      }
    }
    if (task.type === 'cloze') {
      task.acceptedSet = uniqueStrings(task.acceptedSet || []);
      if (!task.acceptedSet.length) issues.push(issue('error', 'task.accepted', path + '.acceptedSet', '빈칸 허용 답안이 필요합니다.'));
      if (!text(task.clozeText).trim()) issues.push(issue('error', 'task.clozeText', path + '.clozeText', '빈칸 문장이 필요합니다.'));
    }
    if (task.type === 'tokenOrder') {
      var tokenIds = new Set();
      if (!Array.isArray(task.tokens) || !task.tokens.length) issues.push(issue('error', 'task.tokens', path + '.tokens', '배열 토큰이 필요합니다.'));
      else task.tokens.forEach(function (token, ti) {
        if (!text(token.tokenId).trim() || !text(token.text).trim()) issues.push(issue('error', 'task.token', path + '.tokens[' + ti + ']', 'tokenId와 text가 필요합니다.'));
        else if (tokenIds.has(token.tokenId)) issues.push(issue('error', 'task.token.duplicate', path + '.tokens[' + ti + '].tokenId', '중복 tokenId입니다.'));
        else tokenIds.add(token.tokenId);
      });
      if (!Array.isArray(task.correctTokenIds) || task.correctTokenIds.length !== tokenIds.size || task.correctTokenIds.some(function (id) { return !tokenIds.has(id); }) || new Set(task.correctTokenIds).size !== task.correctTokenIds.length) {
        issues.push(issue('error', 'task.token.answer', path + '.correctTokenIds', '정답 토큰 순서는 모든 토큰 ID를 정확히 한 번 포함해야 합니다.'));
      }
    }
    if (task.type === 'transform') {
      task.acceptedSet = generateAcceptedSet(task, unit, issues, path);
      if (!task.acceptedSet.length) issues.push(issue('error', 'task.transform.answers', path, '변형 문장의 생성 답안이 없습니다.'));
    }
    if (task.type === 'guidedProduction') {
      task.acceptedVariants = uniqueStrings(task.acceptedVariants || []);
      task.requiredSlots = uniqueStrings(task.requiredSlots || []);
      task.requiredAnchors = uniqueStrings(task.requiredAnchors || []);
      task.forbiddenForms = uniqueStrings(task.forbiddenForms || []);
      if (!task.acceptedVariants.length && !task.requiredSlots.length) issues.push(issue('error', 'task.guided.answers', path, '허용 문장 또는 필수 슬롯이 필요합니다.'));
      var acceptedNorm = new Set(task.acceptedVariants.map(function (x) { return normalizeAnswer(x, task.normalization, unit.language); }));
      task.forbiddenForms.forEach(function (form) {
        if (acceptedNorm.has(normalizeAnswer(form, task.normalization, unit.language))) issues.push(issue('error', 'task.answer.conflict', path + '.forbiddenForms', '허용 답안과 금지 답안이 충돌합니다: ' + form));
      });
    }
    if (!task.feedback || typeof task.feedback !== 'object') task.feedback = {};
    if (!benchmarkSection && !text(task.feedback.errorCode).trim()) issues.push(issue('warning', 'task.errorCode', path + '.feedback.errorCode', '오류 보충을 위해 errorCode를 권장합니다.'));
    return task;
  }
  function validateAndNormalize(raw, expectedLanguage) {
    var issues = [], unit;
    try { unit = clone(raw); } catch (error) {
      return { valid: false, issues: [issue('error', 'document.clone', '$', 'JSON을 복제할 수 없습니다: ' + error.message)], unit: null };
    }
    if (!unit || typeof unit !== 'object' || Array.isArray(unit)) return { valid: false, issues: [issue('error', 'document.type', '$', '최상위 JSON은 단원 객체여야 합니다.')], unit: null };
    if (unit.schemaVersion !== 'cems-lean-unit-1') issues.push(issue('error', 'schema.version', '$.schemaVersion', 'schemaVersion은 cems-lean-unit-1이어야 합니다.'));
    if (!['en', 'zh'].includes(unit.language)) issues.push(issue('error', 'language.value', '$.language', 'language는 en 또는 zh여야 합니다.'));
    if (expectedLanguage && unit.language !== expectedLanguage) issues.push(issue('error', 'language.mismatch', '$.language', '현재 앱 언어와 단원 언어가 다릅니다.'));
    if (!text(unit.unitId).trim()) issues.push(issue('error', 'unit.id', '$.unitId', 'unitId가 필요합니다.'));
    if (!Number.isInteger(Number(unit.version)) || Number(unit.version) < 1) issues.push(issue('error', 'unit.version', '$.version', 'version은 1 이상의 정수여야 합니다.'));
    unit.version = Number(unit.version || 1);
    if (!text(unit.functionKo).trim()) issues.push(issue('error', 'unit.function', '$.functionKo', '기능 중심 목표가 필요합니다.'));
    if (!text(unit.situationKo).trim()) issues.push(issue('error', 'unit.situation', '$.situationKo', '상황 설명이 필요합니다.'));
    if (unit.version >= 3) {
      if (!text(unit.courseId).trim()) issues.push(issue('error', 'course.id', '$.courseId', 'v3 이상 단원에는 courseId가 필요합니다.'));
      if (!Number.isInteger(Number(unit.courseOrder)) || Number(unit.courseOrder) < 1) issues.push(issue('error', 'course.order', '$.courseOrder', 'courseOrder는 1 이상의 정수여야 합니다.'));
      unit.courseOrder = Number(unit.courseOrder || 0);
      if (!text(unit.courseTitleKo).trim()) issues.push(issue('error', 'course.title', '$.courseTitleKo', 'courseTitleKo가 필요합니다.'));
      unit.prerequisiteUnitIds = uniqueStrings(unit.prerequisiteUnitIds || []);
      if (unit.prerequisiteUnitIds.indexOf(unit.unitId) >= 0) issues.push(issue('error', 'course.prerequisite.self', '$.prerequisiteUnitIds', '단원은 자기 자신을 선행 단원으로 참조할 수 없습니다.'));
    }
    if (!Array.isArray(unit.targets) || !unit.targets.length) issues.push(issue('error', 'targets.empty', '$.targets', 'target이 하나 이상 필요합니다.'));
    if (!Array.isArray(unit.practicePlan) || !unit.practicePlan.length) issues.push(issue('error', 'tasks.empty', '$.practicePlan', 'practicePlan이 필요합니다.'));
    if (unit.language === 'zh' && !['traditional', 'simplified'].includes(unit.primaryScript)) issues.push(issue('error', 'zh.primaryScript', '$.primaryScript', 'primaryScript를 명시해야 합니다.'));
    if (unit.language === 'zh' && !/^zh-(TW|CN)$/.test(text(unit.targetVariety))) issues.push(issue('error', 'zh.variety', '$.targetVariety', 'targetVariety는 zh-TW 또는 zh-CN이어야 합니다.'));
    var slotBanks = unit.slotBanks || {};
    var targetIds = new Set();
    (unit.targets || []).forEach(function (target, index) { validateTarget(target, index, unit, issues, targetIds); });
    Object.keys(slotBanks).forEach(function (key) {
      if (!Array.isArray(slotBanks[key]) || !slotBanks[key].length) issues.push(issue('error', 'slotBank.empty', '$.slotBanks.' + key, '슬롯 뱅크가 비어 있습니다.'));
      if (unit.language === 'zh') (slotBanks[key] || []).forEach(function (value, index) {
        if (!value || typeof value !== 'object' || !text(value.traditional).trim() || !text(value.simplified).trim() || !text(value.pinyinMarked).trim()) {
          issues.push(issue('error', 'zh.slot.value', '$.slotBanks.' + key + '[' + index + ']', '중국어 슬롯은 번체·간체·병음을 모두 포함해야 합니다.'));
        }
      });
    });
    (unit.targets || []).forEach(function (target, index) {
      if (!target || typeof target !== 'object') return;
      var path = '$.targets[' + index + ']';
      var templates = unit.language === 'zh' ? [target.traditional, target.simplified] : [target.form];
      var slots = uniqueStrings([].concat.apply([], templates.map(getSlots)));
      var declaredPatternSlots = Array.isArray(target.patternTokens) ? target.patternTokens.map(function (token) { return token && typeof token === 'object' ? text(token.slot).trim() : ''; }).filter(Boolean) : [];
      if (target.kind === 'construction' && !slots.length && !declaredPatternSlots.length) issues.push(issue('error', (unit.language === 'zh' ? 'zh' : 'en') + '.construction.slots', path, 'construction에는 하나 이상의 명시적 슬롯이 필요합니다.'));
      slots.forEach(function (slot) {
        var base = /Pinyin$/.test(slot) ? slot.replace(/Pinyin$/, '') : slot;
        if (!Array.isArray(slotBanks[slot]) && !Array.isArray(slotBanks[base])) issues.push(issue('error', 'target.slot.missing', path, 'target 슬롯에 대응하는 slotBanks 항목이 없습니다: ' + slot));
      });
      if (unit.language === 'zh' && target.kind === 'construction' && Array.isArray(target.patternTokens)) {
        var patternSlots = new Set(target.patternTokens.map(function (token) { return token && typeof token === 'object' ? text(token.slot).trim() : ''; }).filter(Boolean));
        slots.filter(function (slot) { return !/Pinyin$/.test(slot); }).forEach(function (slot) { if (!patternSlots.has(slot)) issues.push(issue('error', 'zh.construction.patternSlot', path + '.patternTokens', 'patternTokens가 슬롯을 포함하지 않습니다: ' + slot)); });
      }
    });
    var taskIds = new Set(), guided = 0;
    unit.practicePlan = (unit.practicePlan || []).map(function (task, index) {
      var normalized = validateTask(task, index, unit, issues, targetIds, taskIds, 'practicePlan');
      if (normalized && normalized.type === 'guidedProduction') guided += 1;
      return normalized;
    }).filter(Boolean);
    unit.repairPlan = (unit.repairPlan || []).map(function (task, index) {
      var normalized = validateTask(task, index, unit, issues, targetIds, taskIds, 'repairPlan');
      if (normalized) normalized.isRepair = true;
      return normalized;
    }).filter(Boolean);
    var benchmarkIds = new Set(), runnableBaseline = 0, baselineProduction = 0, runnableTransfer = 0, runnableRetention = 0, transferProduction = 0, retentionProduction = 0;
    function normalizeBenchmarkList(list, section, allowedPhases) {
      return (list || []).map(function (source, index) {
        var path = '$.' + section + '[' + index + ']';
        if (!source || typeof source !== 'object') {
          issues.push(issue('error', 'benchmark.object', path, '기준선·전이·유지 항목은 객체여야 합니다.'));
          return null;
        }
        if (!runnableBenchmark(source)) {
          if (source.reserved === true && text(source.transferId).trim()) {
            issues.push(issue('warning', 'benchmark.placeholder', path, '예약 항목은 실행되지 않습니다. type·phase·정답을 포함한 평가 문항으로 갱신하십시오.'));
            return source;
          }
          issues.push(issue('error', 'benchmark.incomplete', path, 'benchmarkId, phase, type을 포함한 실행 가능한 문항이 필요합니다.'));
          return null;
        }
        var benchmarkId = text(source.benchmarkId || source.transferId || source.taskId).trim();
        if (!benchmarkId) issues.push(issue('error', 'benchmark.id', path + '.benchmarkId', 'benchmarkId가 필요합니다.'));
        else if (benchmarkIds.has(benchmarkId)) issues.push(issue('error', 'benchmark.duplicate', path + '.benchmarkId', '중복 benchmarkId입니다.'));
        else benchmarkIds.add(benchmarkId);
        source.benchmarkId = benchmarkId;
        source.taskId = text(source.taskId || benchmarkId).trim();
        source.phase = text(source.phase).trim();
        source.domain = 'transfer';
        source.measurementKey = text(source.measurementKey).trim();
        if (unit.version >= 3 && !source.measurementKey) issues.push(issue('error', 'benchmark.measurementKey', path + '.measurementKey', 'v3 이상 기준선·전이·유지 문항에는 동일 수행을 나타내는 measurementKey가 필요합니다.'));
        var minimum = Number(source.minimumDelayDays);
        if (allowedPhases.indexOf(source.phase) < 0) issues.push(issue('error', 'benchmark.phase', path + '.phase', '허용되지 않는 phase입니다: ' + source.phase));
        if (!Number.isInteger(minimum)) issues.push(issue('error', 'benchmark.delay', path + '.minimumDelayDays', 'minimumDelayDays는 정수여야 합니다.'));
        if (source.phase === 'baseline') {
          runnableBaseline += 1;
          if (source.type === 'guidedProduction' || source.type === 'transform') baselineProduction += 1;
          if (minimum !== 0) issues.push(issue('error', 'benchmark.baseline.delay', path + '.minimumDelayDays', '학습 전 기준선의 minimumDelayDays는 0이어야 합니다.'));
        }
        if (source.phase === 'transfer') {
          runnableTransfer += 1;
          if (source.type === 'guidedProduction' || source.type === 'transform') transferProduction += 1;
          if (minimum < 3) issues.push(issue('error', 'benchmark.transfer.delay', path + '.minimumDelayDays', '전이 확인은 단원 완료 최소 3일 뒤여야 합니다.'));
        }
        if (source.phase === 'retention') {
          runnableRetention += 1;
          if (source.type === 'guidedProduction' || source.type === 'transform') retentionProduction += 1;
          if (minimum < 14) issues.push(issue('error', 'benchmark.retention.delay', path + '.minimumDelayDays', '유지 확인은 단원 완료 최소 14일 뒤여야 합니다.'));
        }
        var normalized = validateTask(source, index, unit, issues, targetIds, taskIds, section);
        if (!normalized) return null;
        normalized.benchmarkId = benchmarkId;
        normalized.measurementKey = source.measurementKey;
        normalized.minimumDelayDays = minimum;
        normalized.isBenchmark = true;
        normalized.noFeedback = source.phase === 'baseline';
        if (normalized.hints && normalized.hints.length) issues.push(issue('error', 'benchmark.hints', path + '.hints', '기준선·전이·유지 확인에는 힌트를 둘 수 없습니다.'));
        normalized.hints = [];
        return normalized;
      }).filter(Boolean);
    }
    unit.baselineItems = normalizeBenchmarkList(unit.baselineItems || [], 'baselineItems', ['baseline']);
    unit.transferItems = normalizeBenchmarkList(unit.transferItems || [], 'transferItems', ['transfer', 'retention']);
    if (unit.version >= 3) {
      if (runnableBaseline !== 1) issues.push(issue('error', 'benchmark.baseline.count', '$.baselineItems', 'v3 이상 단원에는 실행 가능한 학습 전 기준선 문항이 정확히 1개 필요합니다.'));
      if (baselineProduction !== 1) issues.push(issue('error', 'benchmark.baseline.production', '$.baselineItems', '학습 전 기준선은 guidedProduction 또는 transform 산출 문항 1개여야 합니다.'));
      if (!unit.qa || unit.qa.baselineLeakChecked !== true) issues.push(issue('error', 'qa.baselineLeak', '$.qa.baselineLeakChecked', '학습 전 기준선을 포함하려면 기준선 누출 검사를 완료해야 합니다.'));
      var parallelBenchmarks = unit.baselineItems.filter(runnableBenchmark).concat(unit.transferItems.filter(runnableBenchmark));
      var measurementKeys = uniqueStrings(parallelBenchmarks.map(function (task) { return task.measurementKey; }));
      var measurementTypes = uniqueStrings(parallelBenchmarks.map(function (task) { return task.type; }));
      if (measurementKeys.length !== 1) issues.push(issue('error', 'benchmark.parallel.measurementKey', '$.baselineItems', '기준선·3일 전이·14일 유지는 하나의 동일한 measurementKey를 사용해야 합니다.'));
      if (measurementTypes.length !== 1) issues.push(issue('error', 'benchmark.parallel.type', '$.baselineItems', '기준선·3일 전이·14일 유지는 같은 응답 유형으로 구성해야 합니다.'));
      if (!unit.qa || unit.qa.parallelConstructChecked !== true) issues.push(issue('error', 'qa.parallelConstruct', '$.qa.parallelConstructChecked', '기준선·전이·유지의 동일 수행 구성을 확인해야 합니다.'));
    }
    if (unit.version >= 2) {
      if (!runnableTransfer) issues.push(issue('error', 'benchmark.transfer.missing', '$.transferItems', 'v2 이상 단원에는 실행 가능한 3일 전이 문항이 필요합니다.'));
      if (!runnableRetention) issues.push(issue('error', 'benchmark.retention.missing', '$.transferItems', 'v2 이상 단원에는 실행 가능한 14일 유지 문항이 필요합니다.'));
      if (!transferProduction) issues.push(issue('error', 'benchmark.transfer.production', '$.transferItems', '3일 전이 확인에는 guidedProduction 또는 transform 산출 문항이 필요합니다.'));
      if (!retentionProduction) issues.push(issue('error', 'benchmark.retention.production', '$.transferItems', '14일 유지 확인에는 guidedProduction 또는 transform 산출 문항이 필요합니다.'));
      if (!unit.qa || unit.qa.assessmentLeakChecked !== true) issues.push(issue('error', 'qa.assessmentLeak', '$.qa.assessmentLeakChecked', '실행 가능한 지연 평가를 포함하려면 평가 누출 검사를 완료해야 합니다.'));
    } else if (!runnableTransfer || !runnableRetention) {
      issues.push(issue('warning', 'benchmark.coverage', '$.transferItems', '이 단원은 지연 전이·유지 측정을 완전히 지원하지 않습니다.'));
    }
    if (unit.language === 'zh') {
      var oppositeChars = scriptDifferenceChars(unit);
      unit.practicePlan.concat(unit.repairPlan).concat(unit.baselineItems.filter(runnableBenchmark)).concat(unit.transferItems.filter(runnableBenchmark)).forEach(function (task, index) {
        if (!task || (task.domain !== 'production' && task.domain !== 'transfer')) return;
        productionSurfaces(task).forEach(function (surface) {
          var found = Array.from(oppositeChars).find(function (char) { return surface.indexOf(char) >= 0; });
          var sectionName = task.phase === 'baseline' ? 'baselineItems' : task.isBenchmark ? 'transferItems' : task.isRepair ? 'repairPlan' : 'practicePlan';
          if (found) issues.push(issue('error', 'zh.production.primaryScript', '$.' + sectionName + '[' + index + ']', '문자 산출 문항에 기본 스크립트와 다른 글자가 포함되어 있습니다: ' + found));
        });
      });
    }
    var practiceAndRepair = unit.practicePlan.concat(unit.repairPlan);
    var benchmarkTasks = unit.baselineItems.filter(runnableBenchmark).concat(unit.transferItems.filter(runnableBenchmark));
    benchmarkTasks.forEach(function (benchmark, index) {
      var path = benchmark.phase === 'baseline' ? '$.baselineItems[' + index + ']' : '$.transferItems[' + index + ']';
      var fingerprint = taskVariantFingerprint(benchmark, unit);
      var answerFingerprint = taskAnswerFingerprint(benchmark, unit);
      var visibleBeforeAnswer = normalizeAnswer([
        benchmark.promptKo, benchmark.contextKo, benchmark.context,
        Array.isArray(benchmark.contextLines) ? benchmark.contextLines.map(function (line) {
          return unit.language === 'zh' ? (unit.primaryScript === 'simplified' ? line.simplified || line.traditional : line.traditional || line.simplified) : line.text;
        }).join('|') : ''
      ].map(text).join('|'), benchmark.normalization, unit.language);
      var benchmarkAnswers = answerFingerprint ? answerFingerprint.split('||').filter(Boolean) : [];
      benchmarkAnswers.forEach(function (answer) {
        if (answer.length >= 4 && visibleBeforeAnswer.indexOf(answer) >= 0) issues.push(issue('error', 'benchmark.answer.visible', path, '제출 전 화면에 평가 정답 문장이 그대로 노출됩니다.'));
      });
      practiceAndRepair.forEach(function (source) {
        if (benchmark.variantKey && source.variantKey && benchmark.variantKey === source.variantKey) issues.push(issue('error', 'benchmark.variant.leak', path + '.variantKey', '평가 variantKey가 연습·보충 문항과 같습니다: ' + source.taskId));
        if (fingerprint && fingerprint === taskVariantFingerprint(source, unit)) issues.push(issue('error', 'benchmark.content.leak', path, '기준선·전이·유지 문항이 연습·보충 문항과 동일합니다: ' + source.taskId));
        var sourceOverlap = taskAnswerOverlap(benchmark, unit, source, unit);
        if (sourceOverlap.length) issues.push(issue('error', 'benchmark.answer.leak', path, '기준선·전이·유지 정답 중 연습·보충 정답과 같은 문장이 있습니다: ' + source.taskId + ' · ' + sourceOverlap[0]));
      });
      benchmarkTasks.slice(index + 1).forEach(function (other) {
        if (benchmark.variantKey && other.variantKey && benchmark.variantKey === other.variantKey) issues.push(issue('error', 'benchmark.parallel.variant', path + '.variantKey', '기준선·전이·유지 문항은 서로 다른 variantKey를 사용해야 합니다.'));
        if (fingerprint && fingerprint === taskVariantFingerprint(other, unit)) issues.push(issue('error', 'benchmark.parallel.content', path, '기준선·전이·유지 문항의 문맥·정답이 동일합니다.'));
        var parallelOverlap = taskAnswerOverlap(benchmark, unit, other, unit);
        if (parallelOverlap.length) issues.push(issue('error', 'benchmark.parallel.answer', path, '기준선·전이·유지 문항은 서로 다른 정답 문장을 사용해야 합니다: ' + parallelOverlap[0]));
      });
    });
    if (!guided) issues.push(issue('error', 'unit.guidedProduction', '$.practicePlan', '각 단원에는 guidedProduction이 최소 1개 필요합니다.'));
    var repairTaskIds = new Set(unit.repairPlan.map(function (task) { return task.taskId; }));
    var ruleCodes = new Set();
    unit.repairRules = (unit.repairRules || []).map(function (rule, index) {
      var path = '$.repairRules[' + index + ']';
      if (!rule || !text(rule.errorCode).trim()) issues.push(issue('error', 'repair.errorCode', path + '.errorCode', 'errorCode가 필요합니다.'));
      else if (ruleCodes.has(rule.errorCode)) issues.push(issue('error', 'repair.duplicate', path + '.errorCode', '중복 errorCode입니다.'));
      else ruleCodes.add(rule.errorCode);
      if (!Array.isArray(rule.targetRefs) || !rule.targetRefs.length || rule.targetRefs.some(function (ref) { return !targetIds.has(ref); })) issues.push(issue('error', 'repair.targetRef', path + '.targetRefs', '유효한 targetRefs가 필요합니다.'));
      if (!Array.isArray(rule.repairTaskRefs) || !rule.repairTaskRefs.length || rule.repairTaskRefs.some(function (ref) { return !repairTaskIds.has(ref); })) issues.push(issue('error', 'repair.taskRef', path + '.repairTaskRefs', '존재하는 repair task를 참조해야 합니다.'));
      return rule;
    });
    var repairMap = new Map(unit.repairPlan.map(function (task) { return [task.taskId, task]; }));
    unit.repairRules.forEach(function (rule, index) {
      if (!rule || !rule.errorCode) return;
      var sources = unit.practicePlan.filter(function (task) { return task.feedback && task.feedback.errorCode === rule.errorCode; });
      var candidates = (rule.repairTaskRefs || []).map(function (id) { return repairMap.get(id); }).filter(Boolean);
      sources.forEach(function (source) {
        var sourceFingerprint = taskVariantFingerprint(source, unit);
        var hasDifferent = candidates.some(function (candidate) {
          var variantDifferent = !source.variantKey || candidate.variantKey !== source.variantKey;
          var candidateFingerprint = taskVariantFingerprint(candidate, unit);
          var contentDifferent = !sourceFingerprint || !candidateFingerprint || sourceFingerprint !== candidateFingerprint;
          return variantDifferent && contentDifferent;
        });
        if (!hasDifferent) issues.push(issue('error', 'repair.variant.same', '$.repairRules[' + index + '].repairTaskRefs', '오류 보충은 원문항과 다른 variantKey와 정답 문장을 사용해야 합니다: ' + source.taskId));
      });
    });
    unit.practicePlan.concat(unit.transferItems.filter(runnableBenchmark)).forEach(function (task, index) {
      var code = task.feedback && task.feedback.errorCode;
      if (code && !ruleCodes.has(code)) issues.push(issue('warning', 'repair.ruleMissing', '$.task[' + index + '].feedback.errorCode', '해당 오류 코드의 보충 규칙이 없습니다: ' + code));
    });
    if (!unit.qa || unit.qa.languageReviewed !== true) issues.push(issue('warning', 'qa.language', '$.qa.languageReviewed', '언어 검수 완료 전 샘플은 구조 검증용 콘텐츠입니다.'));
    unit.importedSchemaVersion = unit.schemaVersion;
    return { valid: !issues.some(function (x) { return x.severity === 'error'; }), issues: issues, unit: unit };
  }

  function validateCourseAndNormalize(rawCourse, rawUnits, expectedLanguage) {
    var issues = [], course;
    try { course = clone(rawCourse); } catch (error) {
      return { valid: false, issues: [issue('error', 'course.clone', '$', '코스 JSON을 복제할 수 없습니다: ' + error.message)], course: null, units: [] };
    }
    if (!course || typeof course !== 'object' || Array.isArray(course)) return { valid: false, issues: [issue('error', 'course.type', '$', '최상위 JSON은 코스 객체여야 합니다.')], course: null, units: [] };
    if (course.schemaVersion !== 'cems-lean-course-1') issues.push(issue('error', 'course.schema', '$.schemaVersion', 'schemaVersion은 cems-lean-course-1이어야 합니다.'));
    if (!text(course.courseId).trim()) issues.push(issue('error', 'course.id', '$.courseId', 'courseId가 필요합니다.'));
    if (!Number.isInteger(Number(course.version)) || Number(course.version) < 1) issues.push(issue('error', 'course.version', '$.version', '코스 version은 1 이상의 정수여야 합니다.'));
    course.version = Number(course.version || 1);
    if (!['en', 'zh'].includes(course.language)) issues.push(issue('error', 'course.language', '$.language', '코스 language는 en 또는 zh여야 합니다.'));
    if (expectedLanguage && course.language !== expectedLanguage) issues.push(issue('error', 'course.language.mismatch', '$.language', '현재 앱 언어와 코스 언어가 다릅니다.'));
    if (!text(course.titleKo).trim()) issues.push(issue('error', 'course.title', '$.titleKo', '코스 한국어 제목이 필요합니다.'));
    if (!Array.isArray(course.unitFiles) || !course.unitFiles.length) issues.push(issue('error', 'course.files.empty', '$.unitFiles', 'unitFiles가 필요합니다.'));
    var files = uniqueStrings(course.unitFiles || []);
    if (files.length !== (course.unitFiles || []).length) issues.push(issue('error', 'course.files.duplicate', '$.unitFiles', 'unitFiles에 중복 경로가 있습니다.'));
    if (!Number.isInteger(Number(course.newUnitsPerDayMax)) || Number(course.newUnitsPerDayMax) !== 1) issues.push(issue('error', 'course.newUnitLimit', '$.newUnitsPerDayMax', '파일럿 코스는 하루 새 단원 최대 1개여야 합니다.'));
    if (course.sequencePolicy !== 'linear') issues.push(issue('error', 'course.sequencePolicy', '$.sequencePolicy', 'Stage 3 파일럿 코스의 sequencePolicy는 linear여야 합니다.'));
    var unitIds = new Set(), orderIds = new Set(), normalizedUnits = [];
    var allPractice = [], allBenchmarks = [];
    (Array.isArray(rawUnits) ? rawUnits : []).forEach(function (rawUnit, index) {
      var report = validateAndNormalize(rawUnit, expectedLanguage || course.language);
      report.issues.forEach(function (item) {
        var copy = clone(item); copy.path = '$.units[' + index + ']' + (item.path === '$' ? '' : item.path.slice(1)); issues.push(copy);
      });
      if (!report.unit) return;
      var unit = report.unit;
      if (unitIds.has(unit.unitId)) issues.push(issue('error', 'course.unit.duplicate', '$.units[' + index + '].unitId', '코스 안에 중복 unitId가 있습니다.'));
      unitIds.add(unit.unitId);
      if (text(unit.courseId) !== text(course.courseId)) issues.push(issue('error', 'course.unit.courseId', '$.units[' + index + '].courseId', '단원의 courseId는 코스 courseId와 같아야 합니다.'));
      if (text(unit.courseTitleKo) !== text(course.titleKo)) issues.push(issue('warning', 'course.unit.title', '$.units[' + index + '].courseTitleKo', '단원의 courseTitleKo가 코스 제목과 다릅니다.'));
      if (!Number.isInteger(Number(unit.courseOrder)) || Number(unit.courseOrder) < 1) issues.push(issue('error', 'course.unit.order', '$.units[' + index + '].courseOrder', 'courseOrder는 1 이상의 정수여야 합니다.'));
      if (orderIds.has(Number(unit.courseOrder))) issues.push(issue('error', 'course.unit.order.duplicate', '$.units[' + index + '].courseOrder', 'courseOrder가 중복됩니다.'));
      orderIds.add(Number(unit.courseOrder));
      unit.courseVersion = course.version;
      normalizedUnits.push(unit);
      unit.practicePlan.concat(unit.repairPlan).forEach(function (task) { allPractice.push({ unit: unit, task: task }); });
      unit.baselineItems.concat(unit.transferItems).filter(runnableBenchmark).forEach(function (task) { allBenchmarks.push({ unit: unit, task: task }); });
    });
    if (normalizedUnits.length !== files.length) issues.push(issue('error', 'course.files.coverage', '$.unitFiles', '불러온 단원 수와 unitFiles 수가 다릅니다.'));
    normalizedUnits.sort(function (a, b) { return a.courseOrder - b.courseOrder || text(a.unitId).localeCompare(text(b.unitId)); });
    normalizedUnits.forEach(function (unit, index) {
      if (unit.courseOrder !== index + 1) issues.push(issue('error', 'course.order.contiguous', '$.units[' + index + '].courseOrder', 'courseOrder는 1부터 빈틈없이 이어져야 합니다.'));
      var file = files[index] || '';
      if (file && file.indexOf(unit.unitId + '.json') < 0) issues.push(issue('warning', 'course.file.order', '$.unitFiles[' + index + ']', 'unitFiles 순서 또는 파일명이 courseOrder/unitId와 다릅니다.'));
      var prerequisites = uniqueStrings(unit.prerequisiteUnitIds || []);
      unit.prerequisiteUnitIds = prerequisites;
      prerequisites.forEach(function (id) {
        var prerequisite = normalizedUnits.find(function (candidate) { return candidate.unitId === id; });
        if (!prerequisite) issues.push(issue('error', 'course.prerequisite.missing', '$.units[' + index + '].prerequisiteUnitIds', '존재하지 않는 선행 단원입니다: ' + id));
        else if (prerequisite.courseOrder >= unit.courseOrder) issues.push(issue('error', 'course.prerequisite.order', '$.units[' + index + '].prerequisiteUnitIds', '선행 단원은 현재 단원보다 앞 순서여야 합니다: ' + id));
      });
      if (course.sequencePolicy === 'linear') {
        var expected = index === 0 ? [] : [normalizedUnits[index - 1].unitId];
        if (prerequisites.length !== expected.length || prerequisites.some(function (id, position) { return id !== expected[position]; })) {
          issues.push(issue('error', 'course.prerequisite.linear', '$.units[' + index + '].prerequisiteUnitIds', index === 0 ? '첫 단원은 선행 단원이 없어야 합니다.' : '선형 코스는 바로 앞 단원만 선행 단원으로 참조해야 합니다: ' + expected[0]));
        }
      }
    });
    var variantMap = new Map(), priorBenchmarks = [];
    allBenchmarks.forEach(function (entry, index) {
      var unit = entry.unit, task = entry.task;
      var path = '$.units[' + Math.max(0, normalizedUnits.indexOf(unit)) + '].' + (task.phase === 'baseline' ? 'baselineItems' : 'transferItems');
      var variant = text(task.variantKey).trim();
      if (variant && variantMap.has(variant)) issues.push(issue('error', 'course.benchmark.variant', path, '다른 단원의 기준선·전이·유지 variantKey와 중복됩니다: ' + variant));
      if (variant) variantMap.set(variant, unit.unitId + ':' + task.taskId);
      priorBenchmarks.forEach(function (previousEntry) {
        if (previousEntry.unit.unitId === unit.unitId) return; /* 단원 내부 평행형은 validateAndNormalize에서 검사 */
        var benchmarkOverlap = taskAnswerOverlap(task, unit, previousEntry.task, previousEntry.unit);
        if (benchmarkOverlap.length) issues.push(issue('error', 'course.benchmark.answer', path, '다른 단원의 기준선·전이·유지 정답 문장이 겹칩니다: ' + previousEntry.unit.unitId + '/' + previousEntry.task.taskId + ' · ' + benchmarkOverlap[0]));
      });
      priorBenchmarks.push(entry);
      allPractice.forEach(function (practiceEntry) {
        if (practiceEntry.unit.unitId === unit.unitId) return; /* 단원 내부 누출은 validateAndNormalize에서 검사 */
        var practiceOverlap = taskAnswerOverlap(task, unit, practiceEntry.task, practiceEntry.unit);
        if (practiceOverlap.length) issues.push(issue('error', 'course.benchmark.practiceLeak', path, '다른 단원의 연습·보충 정답과 평가 정답이 같습니다: ' + practiceEntry.unit.unitId + '/' + practiceEntry.task.taskId + ' · ' + practiceOverlap[0]));
        if (variant && practiceEntry.task.variantKey && variant === practiceEntry.task.variantKey) issues.push(issue('error', 'course.benchmark.variantLeak', path, '다른 단원의 연습·보충 variantKey와 평가 variantKey가 같습니다: ' + practiceEntry.unit.unitId + '/' + practiceEntry.task.taskId));
      });
    });
    if (!course.qa || course.qa.parallelFormLeakChecked !== true) issues.push(issue('error', 'course.qa.leak', '$.qa.parallelFormLeakChecked', '코스 전체의 평행형 누출 검사를 완료해야 합니다.'));
    if (!course.qa || course.qa.nativeLanguageReviewed !== true) issues.push(issue('warning', 'course.qa.language', '$.qa.nativeLanguageReviewed', '이 코스는 원어민·교육 전문가 검수 전 파일럿 초안입니다.'));
    course.units = normalizedUnits;
    course.unitIds = normalizedUnits.map(function (unit) { return unit.unitId; });
    return { valid: !issues.some(function (item) { return item.severity === 'error'; }), issues: issues, course: course, units: normalizedUnits };
  }

  function validatePackAndNormalize(raw, expectedLanguage) {
    var issues = [], pack;
    try { pack = clone(raw); } catch (error) {
      return { valid: false, issues: [issue('error', 'pack.clone', '$', '콘텐츠 팩 JSON을 복제할 수 없습니다: ' + error.message)], pack: null };
    }
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return { valid: false, issues: [issue('error', 'pack.type', '$', '최상위 JSON은 콘텐츠 팩 객체여야 합니다.')], pack: null };
    if (pack.schemaVersion !== 'cems-lean-pack-1') issues.push(issue('error', 'pack.schema', '$.schemaVersion', 'schemaVersion은 cems-lean-pack-1이어야 합니다.'));
    if (!text(pack.packId).trim()) issues.push(issue('error', 'pack.id', '$.packId', 'packId가 필요합니다.'));
    if (!Array.isArray(pack.units) || !pack.units.length) issues.push(issue('error', 'pack.units', '$.units', '단원이 하나 이상 필요합니다.'));
    var order = uniqueStrings(pack.unitOrder || []);
    if (!order.length) issues.push(issue('error', 'pack.order', '$.unitOrder', 'unitOrder가 필요합니다.'));
    if (order.length !== (pack.unitOrder || []).length) issues.push(issue('error', 'pack.order.duplicate', '$.unitOrder', 'unitOrder에 중복 ID가 있습니다.'));
    var unitFiles = Array.isArray(pack.unitFiles) && pack.unitFiles.length === (pack.units || []).length
      ? pack.unitFiles.slice()
      : (pack.units || []).map(function (unit, index) { return 'units/' + String(index + 1).padStart(2, '0') + '_' + text(unit && unit.unitId) + '.json'; });
    var course = {
      schemaVersion: 'cems-lean-course-1',
      version: Number(pack.version || 1),
      language: pack.language,
      courseId: pack.packId,
      titleKo: pack.titleKo,
      descriptionKo: pack.descriptionKo,
      expectedWeeks: Number(pack.expectedWeeks || 4),
      newUnitsPerDayMax: Number(pack.newUnitsPerDayMax || 1),
      sequencePolicy: pack.sequencePolicy || 'linear',
      unitFiles: unitFiles,
      qa: {
        status: pack.qa && pack.qa.status,
        nativeLanguageReviewed: !!(pack.qa && pack.qa.languageReviewed),
        parallelFormLeakChecked: !!(pack.qa && pack.qa.crossUnitLeakChecked)
      }
    };
    var courseReport = validateCourseAndNormalize(course, pack.units || [], expectedLanguage);
    courseReport.issues.forEach(function (item) { issues.push(item); });
    var normalizedUnits = courseReport.units || [];
    var normalizedOrder = normalizedUnits.map(function (unit) { return unit.unitId; });
    if (order.length && (order.length !== normalizedOrder.length || order.some(function (id, index) { return id !== normalizedOrder[index]; }))) {
      issues.push(issue('error', 'pack.order.coverage', '$.unitOrder', 'unitOrder는 courseOrder 순서의 모든 단원을 정확히 한 번 포함해야 합니다.'));
    }
    pack.version = Number(pack.version || 1);
    pack.units = normalizedUnits;
    pack.unitOrder = normalizedOrder;
    pack.unitFiles = unitFiles;
    pack.course = courseReport.course || course;
    return { valid: !issues.some(function (item) { return item.severity === 'error'; }), issues: issues, pack: pack, course: courseReport.course || course };
  }

  modules.schema = {
    TYPES: TYPES,
    clone: clone,
    issue: issue,
    normalizeAnswer: normalizeAnswer,
    defaultNormalization: defaultNormalization,
    validateAndNormalize: validateAndNormalize,
    validateCourseAndNormalize: validateCourseAndNormalize,
    validatePackAndNormalize: validatePackAndNormalize,
    valueForLanguage: valueForLanguage,
    taskVariantFingerprint: taskVariantFingerprint,
    taskAnswerFingerprint: taskAnswerFingerprint,
    taskAnswerValues: taskAnswerValues,
    taskAnswerOverlap: taskAnswerOverlap,
    runnableBenchmark: runnableBenchmark
  };
})();
