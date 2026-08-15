/* CEMS v9.2.3 Lean Stage 3 — deterministic practice and one-shot benchmark grading */
(function () {
  'use strict';

  var api = window.CEMS_LEAN = window.CEMS_LEAN || {};
  var modules = api._modules = api._modules || {};
  var schema = modules.schema;

  function text(value) { return String(value == null ? '' : value); }
  function normalizedSet(values, task, unit) {
    return (Array.isArray(values) ? values : []).map(function (value) {
      return schema.normalizeAnswer(value, task.normalization, unit.language);
    });
  }
  function orderedContains(haystack, needles) {
    var cursor = 0;
    for (var i = 0; i < needles.length; i += 1) {
      var needle = needles[i];
      var at = haystack.indexOf(needle, cursor);
      if (at < 0) return false;
      cursor = at + needle.length;
    }
    return true;
  }
  function optionGrade(task, response) {
    var option = (task.options || []).find(function (item) { return item.optionId === response.optionId; });
    var correct = !!(option && option.correct === true);
    var right = (task.options || []).find(function (item) { return item.correct === true; });
    return {
      correct: correct,
      normalized: text(response.optionId),
      answerDisplay: right ? right.text : '',
      details: { selectedText: option ? option.text : '' }
    };
  }
  function acceptedGrade(task, response, unit, acceptedValues) {
    var normalized = schema.normalizeAnswer(response.text, task.normalization, unit.language);
    var accepted = normalizedSet(acceptedValues, task, unit);
    return {
      correct: accepted.indexOf(normalized) >= 0,
      normalized: normalized,
      answerDisplay: (acceptedValues || [])[0] || '',
      details: { acceptedCount: accepted.length }
    };
  }
  function tokenGrade(task, response) {
    var actual = Array.isArray(response.tokenIds) ? response.tokenIds : [];
    var expected = task.correctTokenIds || [];
    var byId = new Map((task.tokens || []).map(function (token) { return [token.tokenId, token.text]; }));
    return {
      correct: expected.join('|') === actual.join('|'),
      normalized: actual.join('|'),
      answerDisplay: expected.map(function (id) { return byId.get(id) || ''; }).join(task.joinWithoutSpace ? '' : ' '),
      details: { expectedTokenIds: expected.slice(), actualTokenIds: actual.slice() }
    };
  }
  function guidedGrade(task, response, unit) {
    var normalized = schema.normalizeAnswer(response.text, task.normalization, unit.language);
    var accepted = normalizedSet(task.acceptedVariants || [], task, unit);
    var required = normalizedSet(task.requiredSlots || [], task, unit).filter(Boolean);
    var anchors = normalizedSet(task.requiredAnchors || [], task, unit).filter(Boolean);
    var forbidden = normalizedSet(task.forbiddenForms || [], task, unit).filter(Boolean);
    var exact = accepted.indexOf(normalized) >= 0;
    var missing = required.filter(function (value) { return normalized.indexOf(value) < 0; });
    var missingAnchors = anchors.filter(function (value) { return normalized.indexOf(value) < 0; });
    var presentForbidden = forbidden.filter(function (value) { return normalized.indexOf(value) >= 0; });
    var ordered = task.orderedSlots ? normalizedSet(task.orderedSlots, task, unit) : [];
    var orderOk = !ordered.length || orderedContains(normalized, ordered);
    var constrained = !!task.allowConstrainedMatch && !missing.length && !missingAnchors.length && !presentForbidden.length && orderOk;
    return {
      correct: exact || constrained,
      normalized: normalized,
      answerDisplay: (task.acceptedVariants || [])[0] || text(task.feedback && task.feedback.correctAnswer),
      details: {
        exact: exact,
        missingRequired: missing,
        missingAnchors: missingAnchors,
        forbiddenPresent: presentForbidden,
        orderedSlotsOk: orderOk
      }
    };
  }
  function grade(task, response, unit) {
    response = response || {};
    var result;
    if (task.type === 'contextChoice') result = optionGrade(task, response);
    else if (task.type === 'listenChoiceOrDictation') {
      result = task.listenMode === 'choice'
        ? optionGrade(task, response)
        : acceptedGrade(task, response, unit, task.acceptedSet || []);
    }
    else if (task.type === 'cloze') result = acceptedGrade(task, response, unit, task.acceptedSet || []);
    else if (task.type === 'tokenOrder') result = tokenGrade(task, response);
    else if (task.type === 'transform') result = acceptedGrade(task, response, unit, task.acceptedSet || []);
    else if (task.type === 'guidedProduction') result = guidedGrade(task, response, unit);
    else result = { correct: false, normalized: '', answerDisplay: '', details: { unsupported: task.type } };
    result.errorCode = result.correct ? null : text(task.feedback && task.feedback.errorCode) || null;
    return result;
  }
  function classifyResult(firstAttemptCorrect, eventuallyCorrect, hintsUsed) {
    if (eventuallyCorrect && firstAttemptCorrect && Number(hintsUsed || 0) === 0) return 'independent';
    if (eventuallyCorrect) return 'assisted';
    return 'failed';
  }
  function ttsText(task, unit) {
    if (unit.language === 'zh') {
      if (unit.primaryScript === 'simplified') return text(task.ttsSimplified || task.ttsTraditional || task.ttsText);
      return text(task.ttsTraditional || task.ttsSimplified || task.ttsText);
    }
    return text(task.ttsText);
  }
  function hasResponse(task, response) {
    response = response || {};
    if (task.type === 'contextChoice' || (task.type === 'listenChoiceOrDictation' && task.listenMode === 'choice')) return !!response.optionId;
    if (task.type === 'tokenOrder') return Array.isArray(response.tokenIds) && response.tokenIds.length === (task.tokens || []).length;
    return !!text(response.text).trim();
  }

  modules.exercise = {
    grade: grade,
    classifyResult: classifyResult,
    ttsText: ttsText,
    hasResponse: hasResponse,
    orderedContains: orderedContains
  };
})();
