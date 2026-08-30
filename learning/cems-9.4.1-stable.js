/* CEMS v9.3.2-r4 integrated hub
 * Exact-ID integration, non-destructive content repair, example repository,
 * local-first sentence grading, Gemini proxy client, and robust tone targeting.
 */
(function () {
  'use strict';

  var VERSION = '9.4.1';
  var BUILD = '9.4.1';
  var DATA_SCHEMA = 'cems-zh-940-schema3';
  var SEED_FINGERPRINT = 'sha256:b013f4f5a965aa5cc54f3c6df7a17c3bf98e388574c054d30b3fced38b8dd86f';
  var LANG = (window.CEMS_LANG === 'zh' || (window.CEMS9 && window.CEMS9.LANG === 'zh') || (typeof DB_NAME !== 'undefined' && /Chinese/i.test(String(DB_NAME)))) ? 'zh' : 'en';
  var AUX_DB_NAME = 'CEMS_Aux_v931_' + LANG;
  var AUX_DB_VERSION = 1;
  var DEFAULT_MODEL = 'gemini-3.1-flash-lite';
  /* 치명 C1: Worker(worker/src/index.mjs)는 'sentence-grader-v3' 만 받고, 값이 다르면
     409 grader_version_mismatch 로 전부 거절한다. 즉 AI 문장 판독이 100% 실패하고 있었다. */
  var GRADER_VERSION = 'sentence-grader-v3';
  var DAY_MS = 86400000;
  var dataReadyResolve;
  if (!window.CEMS932DataReady) window.CEMS932DataReady = new Promise(function(resolve){ dataReadyResolve = resolve; });
  else dataReadyResolve = function(){};
  window.CEMS932DataReadyState = 'loading';
  var state = {
    aux: null,
    auxOpening: null,          // 진행 중인 openAuxDB 프로미스 (중복 open 방지)
    overridesInstalled: false, // 전역 교체 1회 가드 (함수 프로퍼티 플래그 대체)
    toneInstalled: false,
    distractorsInstalled: false,
    auditedRenderers: {},
    exprLensId: null,          // CEMS_LENS 에 등록한 격리 필터 id
    initialized: false,
    modalBundle: null,
    homeToken: 0,
    exampleToken: 0,
    examples: [],
    sentencePool: [],
    sentenceIndex: 0,
    sentenceFilter: 'all',
    sentenceReturnPage: 'home',
    currentSentence: null,
    sentenceGradeToken: 0,
    aiInFlight: null,
    aiFailures: [],
    circuitUntil: 0,
    rawGetAllExpr: typeof getAllExpr === 'function' ? getAllExpr : null,
    rawGetAllWords: typeof getAllWords === 'function' ? getAllWords : null,
    rawGetAllPV: typeof getAllPV === 'function' ? getAllPV : null
  };

  function qs(selector, root) { return (root || document).querySelector(selector); }
  function qsa(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function esc(value) { return text(value).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function normHeader(value) { return text(value).toLowerCase().normalize('NFKC').replace(/[\s_\-./()\[\]{}:]+/g, '').replace(/[^a-z0-9가-힣一-龥]/g, ''); }
  function unique(values) {
    var out = [], seen = new Set();
    (values || []).forEach(function (value) {
      if (value && typeof value === 'object') {
        var key = JSON.stringify(value);
        if (!seen.has(key)) { seen.add(key); out.push(value); }
        return;
      }
      var v = text(value); if (!v || seen.has(v)) return; seen.add(v); out.push(v);
    });
    return out;
  }
  function splitList(value, examples) {
    if (Array.isArray(value)) return unique(value);
    var source = text(value); if (!source) return [];
    return unique(source.split(examples ? /\s*\|\s*|\r?\n+/ : /\s*[,;|，；]\s*|\r?\n+/));
  }
  function num(value, fallback) { var n = Number(value); return Number.isFinite(n) ? n : fallback; }
  function bool(value) { return /^(1|true|yes|y|on|checked|starred)$/i.test(text(value)); }
  function cjk(value) { return /[\u3400-\u9fff]/.test(text(value)); }
  function callToast(message) { if (typeof showToast === 'function') showToast(message); }
  function dayKey(value) {
    var d = value instanceof Date ? value : new Date(value || Date.now());
    if (!Number.isFinite(d.getTime())) return '';
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }
  function fnv1a(value) {
    var h = 2166136261;
    for (var ch of String(value || '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  async function sha256(value) {
    try {
      var data = new TextEncoder().encode(String(value || ''));
      var digest = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    } catch (_) { return fnv1a(value); }
  }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function timeoutPromise(ms, controller) {
    return new Promise(function (_, reject) {
      setTimeout(function () { if (controller) controller.abort(); var e = new Error('timeout'); e.code = 'timeout'; reject(e); }, ms);
    });
  }

  /* ---------- Auxiliary IndexedDB: examples, settings, AI cache, audit ---------- */
  /* v9.5: 진행 중인 open 프로미스를 캐싱한다.
     예전에는 state.aux 가 채워지기 전에 auxGet/auxPut 이 겹쳐 들어오면 그때마다
     indexedDB.open 을 새로 냈다. 열린 커넥션이 여러 개 생겨 onversionchange 처리와
     업그레이드가 서로를 막았다. 이제 첫 호출의 프로미스를 재사용하고,
     실패하면 캐시를 비워 다음 호출이 다시 시도할 수 있게 한다. */
  function openAuxDB() {
    if (state.aux) return Promise.resolve(state.aux);
    if (state.auxOpening) return state.auxOpening;
    state.auxOpening = new Promise(function (resolve, reject) {
      var req = indexedDB.open(AUX_DB_NAME, AUX_DB_VERSION);
      req.onerror = function () { reject(req.error || new Error('보조 DB를 열지 못했습니다.')); };
      /* 다른 탭이 옛 버전 커넥션을 붙잡고 있으면 업그레이드가 멈춘 채 영원히
         응답이 없다. 예전에는 핸들러가 없어 조용히 멈췄다. */
      req.onblocked = function () {
        var e = new Error('다른 탭에서 이 앱이 열려 있어 보조 DB를 갱신하지 못했습니다. 다른 탭을 닫고 새로고침하세요.');
        e.code = 'blocked';
        try { console.warn('[CEMS 9.3.2 aux] ' + e.message); } catch (_) {}
        reject(e);
      };
      req.onupgradeneeded = function (event) {
        var d = event.target.result;
        if (!d.objectStoreNames.contains('examples')) {
          var ex = d.createObjectStore('examples', { keyPath:'id' });
          ex.createIndex('updatedAt', 'updatedAt');
        }
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath:'key' });
        if (!d.objectStoreNames.contains('aiCache')) {
          var cache = d.createObjectStore('aiCache', { keyPath:'key' });
          cache.createIndex('expiresAt', 'expiresAt');
        }
        if (!d.objectStoreNames.contains('audits')) {
          var audits = d.createObjectStore('audits', { keyPath:'id' });
          audits.createIndex('createdAt', 'createdAt');
        }
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath:'key' });
      };
      req.onsuccess = function () {
        state.aux = req.result;
        state.aux.onversionchange = function () { try { state.aux.close(); } catch (_) {} state.aux = null; state.auxOpening = null; };
        state.aux.onclose = function () { state.aux = null; state.auxOpening = null; };
        resolve(state.aux);
      };
    });
    /* 실패한 open 은 캐시에 남기지 않는다 — 남기면 이후 호출이 전부 같은 오류를 되받는다. */
    state.auxOpening.catch(function () { state.auxOpening = null; });
    return state.auxOpening;
  }
  async function auxGet(store, key) {
    var d = await openAuxDB();
    return new Promise(function (resolve) {
      try {
        var req = d.transaction(store, 'readonly').objectStore(store).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { resolve(null); };
      } catch (_) { resolve(null); }
    });
  }
  async function auxAll(store) {
    var d = await openAuxDB();
    return new Promise(function (resolve) {
      try {
        var req = d.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { resolve([]); };
      } catch (_) { resolve([]); }
    });
  }
  async function auxPut(store, row) {
    var d = await openAuxDB();
    return new Promise(function (resolve, reject) {
      try {
        var tx = d.transaction(store, 'readwrite');
        tx.objectStore(store).put(row);
        tx.oncomplete = function () { resolve(row); };
        tx.onerror = function () { reject(tx.error || new Error(store + ' 저장 실패')); };
        tx.onabort = function () { reject(tx.error || new Error(store + ' 저장 중단')); };
      } catch (error) { reject(error); }
    });
  }
  async function auxBulkPut(store, rows) {
    if (!rows || !rows.length) return 0;
    var d = await openAuxDB();
    return new Promise(function (resolve, reject) {
      try {
        var tx = d.transaction(store, 'readwrite'), os = tx.objectStore(store);
        rows.forEach(function (row) { os.put(row); });
        tx.oncomplete = function () { resolve(rows.length); };
        tx.onerror = function () { reject(tx.error || new Error(store + ' 일괄 저장 실패')); };
        tx.onabort = function () { reject(tx.error || new Error(store + ' 일괄 저장 중단')); };
      } catch (error) { reject(error); }
    });
  }
  async function settingGet(key, fallback) {
    var row = await auxGet('settings', key);
    return row && row.value !== undefined ? row.value : fallback;
  }
  async function settingSet(key, value) { return auxPut('settings', { key:key, value:value, updatedAt:new Date().toISOString() }); }
  async function metaGet(key, fallback) { var row = await auxGet('meta', key); return row && row.value !== undefined ? row.value : fallback; }
  async function metaSet(key, value) { return auxPut('meta', { key:key, value:value, updatedAt:new Date().toISOString() }); }
  async function addAudit(kind, details) {
    var createdAt = new Date().toISOString();
    return auxPut('audits', { id:createdAt + ':' + fnv1a(kind + JSON.stringify(details || {})), kind:kind, createdAt:createdAt, details:details || {} });
  }

  async function ensureMainDB() {
    try {
      if (typeof db !== 'undefined' && db) return db;
      if (typeof openDB === 'function') return await openDB();
    } catch (error) { console.warn('[CEMS 9.3.2] main DB', error); }
    return null;
  }

  var PROGRESS_KEYS = [
    'stability','difficulty','interval','fsrsState','reps','lapses','reviewCount','correctCount','mastery',
    'wrongCount','consecutiveWrong','nextReview','lastReview','lastWrongDate','ease','leitnerBox','addedDate',
    'skillStates','productionStats','lastSeenAt','lastModifiedDate'
  ];
  function mergeCard(existing, incoming) {
    if (!existing) return Object.assign({}, incoming);
    var merged = Object.assign({}, existing);
    Object.keys(incoming || {}).forEach(function (key) {
      var value = incoming[key];
      if (Array.isArray(value)) merged[key] = unique((Array.isArray(merged[key]) ? merged[key] : []).concat(value));
      else if (value !== '' && value != null) merged[key] = value;
    });
    merged.tags = unique((existing.tags || []).concat(incoming.tags || []));
    merged.userExamples = unique((existing.userExamples || []).concat(incoming.userExamples || []));
    merged.userCollocations = unique((existing.userCollocations || []).concat(incoming.userCollocations || []));
    merged.sourceOccurrences = unique((existing.sourceOccurrences || []).concat(incoming.sourceOccurrences || []));
    merged.starred = !!(existing.starred || incoming.starred);
    merged.needsProduction = !!(existing.needsProduction || incoming.needsProduction);
    var hasProgress = Number(existing.reviewCount || existing.reps || 0) > 0 || !!existing.lastReview;
    if (hasProgress) PROGRESS_KEYS.forEach(function (key) { if (existing[key] !== undefined) merged[key] = existing[key]; });
    if (existing.cemsQuarantined) {
      merged.cemsQuarantined = existing.cemsQuarantined;
      merged.cemsQuarantineReason = existing.cemsQuarantineReason;
    }
    return merged;
  }
  function mergeExample(existing, incoming) {
    if (!existing) return Object.assign({ updatedAt:new Date().toISOString() }, incoming);
    var merged = Object.assign({}, existing);
    ['targetText','textTraditional','textSimplified','pinyin','translationEn','translationKo'].forEach(function (key) {
      if (!merged[key] && incoming[key]) merged[key] = incoming[key];
    });
    ['sourceTypes','sourceRefs','linkedVocabulary','linkedExpressions','lessons','speakers','audioRefs','qaStatuses','acceptedAnswers'].forEach(function (key) {
      merged[key] = unique((existing[key] || []).concat(incoming[key] || []));
    });
    merged.updatedAt = new Date().toISOString();
    return merged;
  }
  function exampleIdentity(row) {
    row = row || {};
    var target = text(row.targetText || (LANG === 'zh' ? row.textTraditional : row.translationEn) || row.textTraditional || row.translationEn || row.textSimplified);
    if (!target) return '';
    return text(row.language || LANG) + '|' + target.normalize('NFKC').replace(/[\s\u3000]+/g, '');
  }
  function exampleIdentityMap(rows) {
    var map = new Map();
    (rows || []).forEach(function (row) {
      var key = exampleIdentity(row);
      if (key && !map.has(key)) map.set(key, row);
    });
    return map;
  }
  /* "raw" 는 말 그대로 격리(cemsQuarantined) 항목까지 포함한 원본이어야 한다.
     가져오기·복구 경로가 격리된 행을 못 보면 같은 행을 다시 만들어 중복이 생긴다.
     v9.5: 격리 필터가 전역 교체에서 CEMS_LENS 로 옮겨졌고, 렌즈는 getAllExpr 안에서
     적용되므로 예전처럼 "감싸기 전의 getAllExpr" 을 들고 있어도 우회가 되지 않는다.
     → 렌즈를 타지 않는 getAllFromStore 로 직접 읽는다. */
  var RAW_STORES = { vocab:'words', phrasal:'phrasal_verbs', expression:'expressions' };
  function rawMainRows(type) {
    if (typeof getAllFromStore === 'function' && RAW_STORES[type]) {
      return Promise.resolve(getAllFromStore(RAW_STORES[type])).catch(function () { return []; });
    }
    if (type === 'vocab' && state.rawGetAllWords) return state.rawGetAllWords();
    if (type === 'phrasal' && state.rawGetAllPV) return state.rawGetAllPV();
    if (type === 'expression' && state.rawGetAllExpr) return state.rawGetAllExpr();
    return Promise.resolve([]);
  }
  async function putMainRows(vocabRows, phrasalRows, expressionRows) {
    var d = await ensureMainDB(); if (!d) throw new Error('학습 DB를 열지 못했습니다.');
    var stores = [];
    if (vocabRows && vocabRows.length) stores.push('words');
    if (phrasalRows && phrasalRows.length && d.objectStoreNames.contains('phrasal_verbs')) stores.push('phrasal_verbs');
    if (expressionRows && expressionRows.length) stores.push('expressions');
    if (!stores.length) return;
    return new Promise(function (resolve, reject) {
      try {
        var tx = d.transaction(stores, 'readwrite');
        if (vocabRows && vocabRows.length) { var w = tx.objectStore('words'); vocabRows.forEach(function (row) { w.put(row); }); }
        if (phrasalRows && phrasalRows.length && stores.indexOf('phrasal_verbs') >= 0) { var p = tx.objectStore('phrasal_verbs'); phrasalRows.forEach(function (row) { p.put(row); }); }
        if (expressionRows && expressionRows.length) { var e = tx.objectStore('expressions'); expressionRows.forEach(function (row) { e.put(row); }); }
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error || new Error('카드 일괄 저장 실패')); };
        tx.onabort = function () { reject(tx.error || new Error('카드 일괄 저장 중단')); };
      } catch (error) { reject(error); }
    });
  }

  /* ---------- Seed import and non-destructive legacy repair ---------- */
  var SEED_URL = './content/cems_zh_seed_v940.json';
  /* v9.5: SEED_URL_LEGACY('./content/cems_zh_full_seed_v932.json') 폴백을 제거했다.
     그 파일은 이 빌드에 존재하지 않아 404 를 부르고, 원래 실패 원인(SEED_URL 쪽)이
     404 메시지에 가려져 진단이 어려웠다. 이제 실패하면 원인을 그대로 남긴다. */
  var ACCEPTED_SEED_SCHEMAS = ['cems-seed-3', 'cems-seed-2'];

  async function fetchSeed(url) {
    var response = await fetch(url, { cache:'default' });
    if (!response.ok) throw new Error('내장 학습 데이터를 불러오지 못했습니다 (' + response.status + ').');
    return response.json();
  }
  async function loadSeed() {
    if (LANG !== 'zh') return null;
    var seed = null;
    try { seed = await fetchSeed(SEED_URL); }
    catch (error) {
      try { console.warn('[CEMS 9.3.2 seed] ' + SEED_URL + ' 로드 실패:', error && error.message ? error.message : error); } catch (_) {}
      throw error;
    }
    if (!seed || ACCEPTED_SEED_SCHEMAS.indexOf(seed.schemaVersion) < 0) {
      throw new Error('내장 학습 데이터 형식이 올바르지 않습니다 (' + (seed && seed.schemaVersion) + ').');
    }
    return seed;
  }
  /* v9.4.1: seed-3 은 expressions 와 grammar 를 분리해 담는다.
     seed-2 는 expressions 안에 문법이 섞여 있고 grammar 배열이 그 사본이었다.
     두 형식 모두 여기서 하나의 expressions 스토어 입력으로 접는다. */
  function seedExpressionRows(seed) {
    var schema = window.CEMS941Schema;
    var pure = (seed.expressions || []).slice();
    var grammar = (seed.grammar || []).slice();
    if (seed.schemaVersion === 'cems-seed-2') {
      var isG = schema ? schema.isGrammarRow : function (row) { return row && row.contentKind === 'grammar'; };
      grammar = pure.filter(isG);
      pure = pure.filter(function (row) { return !isG(row); });
    }
    var rows = [];
    pure.forEach(function (row) {
      var out = schema ? schema.normalizeRow(row, 'expression', { withProgress:true }) : Object.assign({ contentKind:'expression' }, row);
      if (out && !out.__missing) rows.push(out);
    });
    grammar.forEach(function (row) {
      var out = schema ? schema.normalizeRow(row, 'grammar', { withProgress:true }) : Object.assign({ contentKind:'grammar' }, row);
      if (out && !out.__missing) rows.push(out);
    });
    var seen = new Map();
    rows.forEach(function (row) { var k = text(row.Expression); if (k && !seen.has(k)) seen.set(k, row); });
    return Array.from(seen.values());
  }
  function seedVocabularyRows(seed) {
    var schema = window.CEMS941Schema;
    var rows = [];
    (seed.vocabulary || []).forEach(function (row) {
      var out = schema ? schema.normalizeRow(row, 'vocabulary', { withProgress:true }) : Object.assign({ contentKind:'vocab' }, row);
      if (out && !out.__missing) rows.push(out);
    });
    return rows;
  }
  async function importSeedIfNeeded(force) {
    if (LANG !== 'zh') return { skipped:true };
    var appliedFingerprint = await metaGet('seedFingerprint', '');
    var appliedSchema = await metaGet('dataSchema', '');
    if (!force && appliedFingerprint === SEED_FINGERPRINT && appliedSchema === DATA_SCHEMA) {
      return { skipped:true, fingerprint:appliedFingerprint, schema:appliedSchema };
    }
    var seed = await loadSeed();
    var currentWords = await rawMainRows('vocab'), currentExpr = await rawMainRows('expression');
    var wordMap = new Map((currentWords || []).map(function (row) { return [text(row.Traditional_CH || row.word), row]; }));
    var exprMap = new Map((currentExpr || []).map(function (row) { return [text(row.Expression), row]; }));
    var mergedWords = seedVocabularyRows(seed).map(function (row) { return mergeCard(wordMap.get(text(row.Traditional_CH)), row); });
    var mergedExpr = seedExpressionRows(seed).map(function (row) { return mergeCard(exprMap.get(text(row.Expression)), row); });
    await putMainRows(mergedWords, [], mergedExpr);
    var oldExamples = await auxAll('examples'), exampleMap = new Map(oldExamples.map(function (row) { return [row.id, row]; })), exampleByIdentity = exampleIdentityMap(oldExamples);
    var mergedExamples = (seed.examples || []).map(function (row) {
      var normalized = Object.assign({}, row, {
        targetText: row.targetText || row.textTraditional || row.translationEn || '',
        acceptedAnswers: unique((row.acceptedAnswers || []).concat([row.textTraditional, row.textSimplified, row.translationEn].filter(Boolean)))
      });
      var old = exampleMap.get(normalized.id) || exampleByIdentity.get(exampleIdentity(normalized));
      if (old && old.id) normalized.id = old.id;
      return mergeExample(old, normalized);
    });
    await auxBulkPut('examples', mergedExamples);
    await metaSet('seedVersion', VERSION);
    await metaSet('seedBuildId', BUILD);
    await metaSet('seedFingerprint', SEED_FINGERPRINT);
    await metaSet('dataSchema', DATA_SCHEMA);
    var grammarCount = mergedExpr.filter(function (row) { return row && row.contentKind === 'grammar'; }).length;
    var expressionCount = mergedExpr.length - grammarCount;
    await addAudit('seed-import', {
      version:VERSION,
      build:BUILD,
      schema:DATA_SCHEMA,
      fingerprint:SEED_FINGERPRINT,
      vocabulary:mergedWords.length,
      expressions:expressionCount,
      grammar:grammarCount,
      examples:mergedExamples.length,
      policy:seed.source && seed.source.policy
    });
    state.examples = [];
    return { vocabulary:mergedWords.length, expressions:expressionCount, grammar:grammarCount, examples:mergedExamples.length, fingerprint:SEED_FINGERPRINT, schema:DATA_SCHEMA };
  }
  async function reindexIntegratedData() {
    var result = await importSeedIfNeeded(true);
    try { await quarantineLegacyDialogues(); } catch (_) {}
    try { installExpressionFilter(); } catch (_) {}
    try { await refreshViews(); } catch (_) {}
    callToast('✅ 내장 데이터를 다시 인식했습니다. 학습 기록은 유지됩니다.');
    return result;
  }
  function isLegacyDialogueCard(row) {
    if (!row) return false;
    var tags = (row.tags || []).map(function (v) { return text(v).toLowerCase(); });
    return row.sourceType === 'Dialogue' || row.Function === '대화 문장' || tags.indexOf('dialogue') >= 0 || tags.indexOf('대화') >= 0 || (Array.isArray(row.dialogueRefs) && row.dialogueRefs.length > 0);
  }
  function legacyCardToExample(row) {
    var target = LANG === 'zh' ? text(row.Original_CHT || row.Expression) : text(row.Expression);
    var simp = text(row.Original_Simplified || row.Example2);
    var ref = unique(row.dialogueRefs || []);
    return {
      id:'legacy_dialogue_' + fnv1a(target + '|' + ref.join('|')),
      targetText:target,
      textTraditional:LANG === 'zh' ? target : '',
      textSimplified:LANG === 'zh' ? simp : '',
      translationEn:LANG === 'zh' ? text(row.Meaning_EN) : target,
      translationKo:text(row.Meaning_KO),
      pinyin:text(row.Pinyin),
      sourceTypes:['LegacyDialogueCard'],
      sourceRefs:ref.map(function (v) { return { type:'LegacyDialogueCard', id:v }; }),
      lessons:unique([row.L3, row.L2]),
      audioRefs:unique(row.audioRefs || (row.audio ? [row.audio] : [])),
      acceptedAnswers:unique([target, simp]),
      updatedAt:new Date().toISOString()
    };
  }
  async function quarantineLegacyDialogues() {
    var done = await metaGet('legacyDialogueAuditVersion', '');
    if (done === VERSION) return { skipped:true };
    var rows = await rawMainRows('expression');
    var candidates = (rows || []).filter(isLegacyDialogueCard);
    if (!candidates.length) { await metaSet('legacyDialogueAuditVersion', VERSION); return { count:0 }; }
    var existingExamples = await auxAll('examples'), exMap = new Map(existingExamples.map(function (row) { return [row.id, row]; })), exByIdentity = exampleIdentityMap(existingExamples);
    var examples = [], changed = [];
    candidates.forEach(function (row) {
      var ex = legacyCardToExample(row), old = exMap.get(ex.id) || exByIdentity.get(exampleIdentity(ex));
      if (old && old.id) ex.id = old.id;
      examples.push(mergeExample(old, ex));
      changed.push(Object.assign({}, row, {
        cemsQuarantined:true,
        cemsQuarantineReason:'legacy_dialogue_card_moved_to_examples',
        cemsQuarantinedAt:new Date().toISOString()
      }));
    });
    await putMainRows([], [], changed);
    await auxBulkPut('examples', examples);
    await metaSet('legacyDialogueAuditVersion', VERSION);
    await addAudit('legacy-dialogue-quarantine', { count:candidates.length, keys:candidates.map(function (row) { return row.Expression; }) });
    state.examples = [];
    return { count:candidates.length };
  }
  /* v9.5: getAllExpr 전역 교체를 없애고 데이터 렌즈에 영구 등록한다.
     예전에는 window.getAllExpr 을 통째로 갈아끼웠는데, 다른 모듈도 같은 전역을
     감싸고 있어서 설치 순서에 따라 격리 필터가 통째로 사라지거나 두 겹으로 걸렸다.
     렌즈는 전역을 건드리지 않고 조회 결과에만 필터를 겹치므로 순서와 무관하다.
     이 필터는 세션 내내 유지돼야 하므로 with() 가 아니라 push() 로 한 번 등록한다. */
  function installExpressionFilter() {
    if (state.exprLensId != null || !window.CEMS_LENS) return;   // 모듈 스코프 1회 가드
    state.exprLensId = window.CEMS_LENS.push(function (rows, kind) {
      if (kind !== 'expr') return rows;                          // 표현 조회에만 적용
      return (rows || []).filter(function (row) { return !row.cemsQuarantined; });
    });
  }

  /* ---------- Correct Excel parser ---------- */
  function getter(headers, row) {
    var index = new Map();
    (headers || []).forEach(function (header, i) { var key = normHeader(header); if (key && !index.has(key)) index.set(key, i); });
    return function () {
      for (var i = 0; i < arguments.length; i += 1) {
        var key = normHeader(arguments[i]);
        if (index.has(key)) {
          var value = row[index.get(key)];
          if (value != null && text(value) !== '') return value;
        }
      }
      return '';
    };
  }
  function findHeader(rows, keyAliases, supportAliases, minSupport) {
    var keys = new Set((keyAliases || []).map(normHeader)), support = new Set((supportAliases || []).map(normHeader));
    for (var i = 0; i < Math.min(25, (rows || []).length); i += 1) {
      var cells = (rows[i] || []).map(normHeader), hasKey = cells.some(function (v) { return keys.has(v); });
      if (!hasKey) continue;
      var found = new Set(); cells.forEach(function (v) { if (support.has(v)) found.add(v); });
      if (found.size >= Math.max(0, Number(minSupport || 0))) return i;
    }
    return -1;
  }
  function sheetByNames(sheets, names) {
    var map = new Map(Object.keys(sheets || {}).map(function (name) { return [normHeader(name), { name:name, rows:sheets[name] }]; }));
    for (var i = 0; i < names.length; i += 1) { var hit = map.get(normHeader(names[i])); if (hit) return hit; }
    return null;
  }
  function learningDefaults(g) {
    return {
      starred:bool(g('starred','bookmark','북마크')),
      needsProduction:bool(g('needsProduction','production','산출필요')),
      stability:num(g('stability'), null), difficulty:num(g('difficulty'), null), interval:num(g('interval'), 1),
      fsrsState:text(g('fsrsState')) || 'New', reps:num(g('reps'), 0), lapses:num(g('lapses'), 0),
      reviewCount:num(g('reviewCount'), 0), correctCount:num(g('correctCount'), 0), mastery:num(g('mastery'), 0),
      wrongCount:num(g('wrongCount'), 0), consecutiveWrong:num(g('consecutiveWrong'), 0),
      nextReview:text(g('nextReview')) || null, lastReview:text(g('lastReview')) || null,
      lastWrongDate:text(g('lastWrongDate')) || null, ease:num(g('ease'), 2.5), leitnerBox:num(g('leitnerBox'), 1),
      addedDate:text(g('addedDate')) || dayKey(new Date())
    };
  }
  function exampleAccumulator() {
    var map = new Map();
    return {
      add:function (row) {
        var target = text(row.targetText || row.textTraditional || row.translationEn);
        if (!target) return;
        var normalized = target.normalize('NFKC').replace(/[\s\u3000]+/g, '');
        var id = row.id || 'ex_' + fnv1a((row.language || LANG) + '|' + normalized);
        row.id = id; row.language = row.language || LANG; row.targetText = target;
        row.acceptedAnswers = unique((row.acceptedAnswers || []).concat([row.targetText, row.textTraditional, row.textSimplified, row.translationEn].filter(Boolean)));
        row.updatedAt = new Date().toISOString();
        map.set(id, mergeExample(map.get(id), row));
      },
      rows:function () { return Array.from(map.values()); }
    };
  }
  function parseWorkbookSheets(sheets) {
    sheets = sheets || {};
    var issues = [], examples = exampleAccumulator();
    var vocabSheet = sheetByNames(sheets, ['Vocabulary','Vocab','Words','어휘','단어']);
    var sourceSheet = sheetByNames(sheets, ['Vocabulary_Source','Vocabulary Source','Vocab_Source','어휘출처']);
    var pvSheet = sheetByNames(sheets, ['Phrasal_Verbs','Phrasal Verbs','Phrasal','구동사']);
    var exprSheet = sheetByNames(sheets, ['Expressions','Expression','표현']);
    var dialogueSheet = sheetByNames(sheets, ['Dialogues','Dialogue','대화']);
    var grammarSheet = sheetByNames(sheets, ['Grammar','문법']);
    var grammarExampleSheet = sheetByNames(sheets, ['Grammar_Examples','Grammar Examples','문법예문']);

    var sourceMap = new Map();
    if (sourceSheet) {
      var shr = findHeader(sourceSheet.rows, ['traditional','word','occurrence_id'], ['lesson','pinyin','meaning_ko'], 2);
      if (shr >= 0) {
        var sh = sourceSheet.rows[shr] || [];
        for (var si = shr + 1; si < sourceSheet.rows.length; si += 1) {
          var sg = getter(sh, sourceSheet.rows[si] || []), skey = text(sg('traditional','word','Traditional_CH'));
          if (!skey) continue;
          if (!sourceMap.has(skey)) sourceMap.set(skey, []);
          sourceMap.get(skey).push({
            occurrence_id:text(sg('occurrence_id')), volume:sg('volume'), lesson:sg('lesson'), vocab_set:text(sg('vocab_set')),
            seq:sg('seq'), category:text(sg('category')), traditional:skey, simplified:text(sg('simplified')),
            pinyin:text(sg('pinyin')), pos:text(sg('pos')), meaning_en:text(sg('meaning_en')), meaning_ko:text(sg('meaning_ko')),
            pdf_page:sg('pdf_page'), printed_page:sg('printed_page'), audio:text(sg('audio')), notes:text(sg('notes')), qa_status:text(sg('qa_status'))
          });
        }
      }
    }

    var vocabulary = [];
    if (vocabSheet) {
      var vhr = findHeader(vocabSheet.rows, LANG === 'zh' ? ['Traditional_CH','Traditional','번체','word'] : ['word','headword','Vocabulary'],
        LANG === 'zh' ? ['Simplified_CH','Pinyin','Meaning_KO','Example_CHT'] : ['Meaning1_KO','Meaning_KO','POS','Example1'], 2);
      if (vhr < 0) issues.push('Vocabulary 시트의 카드 헤더를 찾지 못했습니다. Vocabulary_Source는 카드로 대신 사용하지 않습니다.');
      else {
        var vh = vocabSheet.rows[vhr] || [];
        for (var vi = vhr + 1; vi < vocabSheet.rows.length; vi += 1) {
          var vg = getter(vh, vocabSheet.rows[vi] || []);
          var vkey = LANG === 'zh' ? text(vg('Traditional_CH','Traditional','번체','word')) : text(vg('word','headword','Vocabulary','term'));
          if (!vkey) continue;
          if (LANG === 'en' && cjk(vkey)) continue;
          var common = learningDefaults(vg), item;
          if (LANG === 'zh') {
            item = Object.assign(common, {
              Traditional_CH:vkey, Simplified_CH:text(vg('Simplified_CH','Simplified','간체')), Pinyin:text(vg('Pinyin','병음')),
              POS:text(vg('POS','품사')), Meaning_KO:text(vg('Meaning_KO','MeaningKO','뜻')), Meaning_EN:text(vg('Meaning_EN','MeaningEN')),
              Example_CHT:text(vg('Example_CHT','ExampleCHT','Example1','Example')), Example_KO:text(vg('Example_KO','ExampleKO')),
              Synonym_CHT:text(vg('Synonym_CHT','Synonyms')), Antonym_CHT:text(vg('Antonym_CHT','Antonyms')),
              Measure_CHT:text(vg('Measure_CHT','Measure','Classifier')), Collocation_CHT:text(vg('Collocation_CHT','Key_Collocation','Collocation')),
              HSK:text(vg('HSK','CEFR')), Register:text(vg('Register','Formality')) || '중립', Formality:text(vg('Formality','Register')) || '중립',
              Priority:text(vg('Priority')), 비고:text(vg('비고','Notes')), tags:unique(splitList(vg('tags')).concat(splitList(vg('Style_Tags')))),
              userExamples:splitList(vg('userExamples','User_Examples'), true), sourceVolume:vg('sourceVolume'), sourceLessons:text(vg('sourceLessons')),
              sourcePdfPages:text(vg('sourcePdfPages')), sourcePrintedPages:text(vg('sourcePrintedPages')), sourceCategory:text(vg('sourceCategory')),
              qa_status:text(vg('qa_status')), sourceOccurrences:sourceMap.get(vkey) || []
            });
            if (item.Example_CHT) examples.add({ targetText:item.Example_CHT, textTraditional:item.Example_CHT, translationKo:item.Example_KO, sourceTypes:['Vocabulary'], sourceRefs:[{type:'Vocabulary',id:vkey}], linkedVocabulary:[vkey] });
            (item.userExamples || []).forEach(function (sentence, idx) { examples.add({ targetText:sentence, textTraditional:sentence, sourceTypes:['VocabularyUserExample'], sourceRefs:[{type:'VocabularyUserExample',id:vkey + '#' + (idx + 1)}], linkedVocabulary:[vkey] }); });
          } else {
            item = Object.assign(common, {
              word:vkey, POS:text(vg('POS','품사')), Meaning1_KO:text(vg('Meaning1_KO','Meaning_KO','뜻')), Meaning1_EN:text(vg('Meaning1_EN','Meaning_EN','Definition')),
              Meaning2_KO:text(vg('Meaning2_KO')), Meaning2_EN:text(vg('Meaning2_EN')), Example1:text(vg('Example1','Example')), Example2:text(vg('Example2')),
              Key_Collocation:text(vg('Key_Collocation','Collocation')), Common_Error:text(vg('Common_Error')), Synonyms:splitList(vg('Synonyms')),
              Antonyms:splitList(vg('Antonyms')), L0:text(vg('L0')) || 'Academic', L1:text(vg('L1','Category')) || 'General', L2:text(vg('L2')),
              CEFR:text(vg('CEFR')) || 'B1', Frequency:text(vg('Frequency')) || 'K3', Priority:text(vg('Priority')) || 'P2',
              Formality:text(vg('Formality','Register')) || 'Neutral', Currency:text(vg('Currency')) || 'Current', Medium:text(vg('Medium')) || 'Both',
              tags:unique(splitList(vg('tags')).concat(splitList(vg('Style_Tags')))), userExamples:splitList(vg('userExamples'), true), userCollocations:splitList(vg('userCollocations'))
            });
            [item.Example1, item.Example2].concat(item.userExamples || []).filter(Boolean).forEach(function (sentence, idx) {
              examples.add({ targetText:sentence, translationKo:idx === 0 ? text(vg('Example_KO')) : '', sourceTypes:['VocabularyExample'], sourceRefs:[{type:'VocabularyExample',id:vkey + '#' + (idx + 1)}], linkedVocabulary:[vkey] });
            });
          }
          vocabulary.push(item);
        }
      }
    }

    var phrasal = [];
    if (pvSheet && LANG === 'en') {
      var phr = findHeader(pvSheet.rows, ['Phrasal_Verb','PhrasalVerb','구동사'], ['Particle','Meaning1_KO','Example1'], 1);
      if (phr >= 0) {
        var ph = pvSheet.rows[phr] || [];
        for (var pi = phr + 1; pi < pvSheet.rows.length; pi += 1) {
          var pg = getter(ph, pvSheet.rows[pi] || []), pkey = text(pg('Phrasal_Verb','PhrasalVerb','구동사')); if (!pkey) continue;
          var prow = Object.assign(learningDefaults(pg), {
            Phrasal_Verb:pkey, Base_Verb:text(pg('Base_Verb','BaseVerb')), Particle:text(pg('Particle')),
            Meaning1_KO:text(pg('Meaning1_KO','Meaning_KO')), Meaning1_EN:text(pg('Meaning1_EN','Meaning_EN')),
            Meaning2_KO:text(pg('Meaning2_KO')), Meaning2_EN:text(pg('Meaning2_EN')), Example1:text(pg('Example1','Example')), Example2:text(pg('Example2')),
            Category:text(pg('Category','L1')) || 'General', Formality:text(pg('Formality','Register')) || 'Neutral', Currency:text(pg('Currency')) || 'Current',
            Medium:text(pg('Medium')) || 'Both', Formal_Equivalent:text(pg('Formal_Equivalent')), Separable:text(pg('Separable')), Common_Error:text(pg('Common_Error')),
            CEFR:text(pg('CEFR')) || 'B1', Priority:text(pg('Priority')) || 'P2', Frequency:text(pg('Frequency')) || 'K3', tags:unique(splitList(pg('tags')).concat(splitList(pg('Style_Tags'))))
          });
          [prow.Example1, prow.Example2].filter(Boolean).forEach(function (sentence, idx) { examples.add({ targetText:sentence, sourceTypes:['PhrasalExample'], sourceRefs:[{type:'PhrasalExample',id:pkey + '#' + (idx + 1)}] }); });
          phrasal.push(prow);
        }
      }
    }

    var expressions = [], exprMap = new Map();
    if (exprSheet) {
      var ehr = findHeader(exprSheet.rows, ['Expression','표현','Phrase'], ['Meaning_KO','Function','Example1'], 1);
      if (ehr < 0) issues.push('Expressions 시트의 Expression 헤더를 찾지 못했습니다.');
      else {
        var eh = exprSheet.rows[ehr] || [];
        for (var ei = ehr + 1; ei < exprSheet.rows.length; ei += 1) {
          var eg = getter(eh, exprSheet.rows[ei] || []), ekey = text(eg('Expression','표현','Phrase')); if (!ekey) continue;
          if (LANG === 'en' && cjk(ekey)) continue;
          var erow = Object.assign(learningDefaults(eg), {
            Expression:ekey, Meaning_KO:text(eg('Meaning_KO','MeaningKO','뜻')), Meaning_EN:text(eg('Meaning_EN','MeaningEN')),
            Function:text(eg('Function','기능')), Formality:text(eg('Formality','Register')) || (LANG === 'zh' ? '중립' : 'Neutral'),
            Register:text(eg('Register','Formality')) || (LANG === 'zh' ? '중립' : 'Neutral'), Currency:text(eg('Currency')) || 'Current', Medium:text(eg('Medium')) || 'Both',
            HSK:text(eg('HSK')), CEFR:text(eg('CEFR')), Frequency:text(eg('Frequency')), Priority:text(eg('Priority')),
            Example1:text(eg('Example1','Example','Example_CHT')), Example2:text(eg('Example2')), Similar_Expr:text(eg('Similar_Expr')),
            Common_Error:text(eg('Common_Error')), L1:text(eg('L1')), L2:text(eg('L2')), L3:text(eg('L3')),
            tags:unique(splitList(eg('tags')).concat(splitList(eg('Style_Tags')))), sourceVolume:eg('sourceVolume'), sourceLesson:eg('sourceLesson'),
            sourcePdfPages:text(eg('sourcePdfPages')), sourcePrintedPages:text(eg('sourcePrintedPages')), qa_status:text(eg('qa_status'))
          });
          expressions.push(erow); exprMap.set(ekey, erow);
          [erow.Example1, erow.Example2].filter(Boolean).forEach(function (sentence, idx) {
            examples.add({ targetText:sentence, textTraditional:LANG === 'zh' ? sentence : '', sourceTypes:['ExpressionExample'], sourceRefs:[{type:'ExpressionExample',id:ekey + '#' + (idx + 1)}], linkedExpressions:[ekey] });
          });
        }
      }
    }

    var grammarById = new Map();
    if (grammarSheet) {
      var ghr = findHeader(grammarSheet.rows, ['grammar_id','expression','title_cht'], ['function_ko','usage_ko','structure'], 1);
      if (ghr >= 0) {
        var gh = grammarSheet.rows[ghr] || [];
        for (var gi = ghr + 1; gi < grammarSheet.rows.length; gi += 1) {
          var gg = getter(gh, grammarSheet.rows[gi] || []), gid = text(gg('grammar_id')), gexpr = text(gg('expression','title_cht'));
          if (!gid && !gexpr) continue;
          var meta = { grammarId:gid, expression:gexpr, simplifiedExpression:text(gg('simplified_expression')), functionKo:text(gg('function_ko')), structure:text(gg('structure')), usageKo:text(gg('usage_ko')), commonError:text(gg('common_error')), volume:gg('volume'), lesson:gg('lesson'), pdfPages:text(gg('pdf_pages')), printedPages:text(gg('printed_pages')), qaStatus:text(gg('qa_status')) };
          if (gid) grammarById.set(gid, meta);
          if (gexpr && (LANG === 'zh' || !cjk(gexpr))) {
            var existing = exprMap.get(gexpr);
            if (existing) {
              existing.Function = existing.Function || meta.functionKo; existing.L2 = existing.L2 || meta.structure; existing.L3 = existing.L3 || meta.usageKo; existing.Common_Error = existing.Common_Error || meta.commonError; existing.grammarId = gid;
            }
          }
        }
      }
    }

    function parseSentenceSheet(sheet, kind) {
      if (!sheet) return;
      var hr = findHeader(sheet.rows, kind === 'Dialogue' ? ['utterance_id','traditional','translation_en'] : ['example_id','traditional','grammar_id'], ['translation_ko','lesson'], 1);
      if (hr < 0) { issues.push((kind === 'Dialogue' ? 'Dialogues' : 'Grammar_Examples') + ' 시트의 문장 헤더를 찾지 못했습니다.'); return; }
      var h = sheet.rows[hr] || [];
      for (var ri = hr + 1; ri < sheet.rows.length; ri += 1) {
        var g = getter(h, sheet.rows[ri] || []);
        var trad = text(g('traditional','Traditional_CH')), simp = text(g('simplified','Simplified_CH'));
        var en = text(g('translation_en','translationen','English')), ko = text(g('translation_ko','translationko','Korean'));
        var target = LANG === 'zh' ? (trad || simp) : en; if (!target) continue;
        var id = text(g(kind === 'Dialogue' ? 'utterance_id' : 'example_id')) || kind + ':' + ri;
        var grammarId = text(g('grammar_id')), expression = grammarById.get(grammarId) && grammarById.get(grammarId).expression;
        var sourceRef = { type:kind, id:id, volume:g('volume'), lesson:g('lesson') };
        if (kind === 'Dialogue') { sourceRef.dialogueNo = g('dialogue_no'); sourceRef.lineNo = g('line_no'); sourceRef.pdfPage = g('pdf_page'); sourceRef.printedPage = g('printed_page'); }
        else { sourceRef.grammarId = grammarId; sourceRef.exampleType = text(g('example_type')); sourceRef.pdfPages = text(g('pdf_pages')); sourceRef.printedPages = text(g('printed_pages')); }
        examples.add({
          targetText:target, textTraditional:trad, textSimplified:simp, pinyin:text(g('pinyin')), translationEn:en, translationKo:ko,
          sourceTypes:[kind], sourceRefs:[sourceRef], linkedExpressions:expression ? [expression] : [], lessons:g('lesson') ? ['ACC' + (g('volume') || '') + '-L' + String(g('lesson')).padStart(2, '0')] : [],
          speakers:kind === 'Dialogue' ? [{ cht:text(g('speaker_cht')), en:text(g('speaker_en')), ko:text(g('speaker_ko')) }] : [],
          audioRefs:text(g('audio')) ? [text(g('audio'))] : [], qaStatuses:text(g('qa_status')) ? [text(g('qa_status'))] : [],
          acceptedAnswers:unique([target, trad, simp, en])
        });
      }
    }
    parseSentenceSheet(dialogueSheet, 'Dialogue');
    parseSentenceSheet(grammarExampleSheet, 'GrammarExample');

    if (sourceSheet && !vocabSheet) issues.push('Vocabulary_Source는 출처 메타데이터이므로 단어 카드로 가져오지 않았습니다. Vocabulary 시트가 필요합니다.');
    return {
      vocabulary:vocabulary, phrasal:phrasal, expressions:expressions, examples:examples.rows(), issues:unique(issues),
      sheets:{ vocabulary:vocabSheet && vocabSheet.name, vocabularySource:sourceSheet && sourceSheet.name, phrasal:pvSheet && pvSheet.name, expressions:exprSheet && exprSheet.name, dialogues:dialogueSheet && dialogueSheet.name, grammar:grammarSheet && grammarSheet.name, grammarExamples:grammarExampleSheet && grammarExampleSheet.name }
    };
  }
  function workbookToSheets(workbook) {
    var out = {};
    (workbook.SheetNames || []).forEach(function (name) { out[name] = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header:1, defval:'', raw:false, blankrows:false }); });
    return out;
  }
  var xlsxLoader931 = null;
  function loadClassicScript931(src) {
    return new Promise(function (resolve) {
      var selector='script[data-cems931-xlsx-src="'+src.replace(/"/g,'\"')+'"]', existing=qs(selector);
      if (existing) {
        if (window.XLSX && window.XLSX.read) { resolve(true); return; }
        existing.addEventListener('load', function () { resolve(!!(window.XLSX && window.XLSX.read)); }, { once:true });
        existing.addEventListener('error', function () { resolve(false); }, { once:true });
        return;
      }
      var script=document.createElement('script'); script.src=src; script.async=true; script.dataset.cems931XlsxSrc=src;
      var settled=false, timer=setTimeout(function(){ if(settled)return; settled=true; try{script.remove();}catch(_){} resolve(false); },12000);
      script.onload=function(){ if(settled)return; settled=true; clearTimeout(timer); resolve(!!(window.XLSX&&window.XLSX.read)); };
      script.onerror=function(){ if(settled)return; settled=true; clearTimeout(timer); resolve(false); };
      document.head.appendChild(script);
    });
  }
  function ensureXLSX931() {
    if (window.XLSX && window.XLSX.read) return Promise.resolve(true);
    if (xlsxLoader931) return xlsxLoader931;
    xlsxLoader931=(async function(){
      var candidates=['./vendor/xlsx.full.min.js','https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js','https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'];
      for(var src of candidates){ if(await loadClassicScript931(src)) return true; }
      return false;
    })().finally(function(){xlsxLoader931=null;});
    return xlsxLoader931;
  }
  async function parseExcelFile(file) {
    if (!file) throw new Error('파일이 선택되지 않았습니다.');
    if (!await ensureXLSX931()) throw new Error('내장 엑셀 엔진을 불러오지 못했습니다. 앱을 새로고침한 뒤 다시 시도하세요.');
    var buffer = await file.arrayBuffer();
    var workbook = XLSX.read(buffer, { cellDates:true });
    return parseWorkbookSheets(workbookToSheets(workbook));
  }
  async function importParsedBundle(bundle, sourceName) {
    var currentWords = await rawMainRows('vocab'), currentPV = await rawMainRows('phrasal'), currentExpr = await rawMainRows('expression');
    var wordMap = new Map((currentWords || []).map(function (row) { return [text(LANG === 'zh' ? row.Traditional_CH : row.word), row]; }));
    var pvMap = new Map((currentPV || []).map(function (row) { return [text(row.Phrasal_Verb), row]; }));
    var exprMap = new Map((currentExpr || []).map(function (row) { return [text(row.Expression), row]; }));
    var report = { vocabulary:{parsed:bundle.vocabulary.length,added:0,updated:0}, phrasal:{parsed:bundle.phrasal.length,added:0,updated:0}, expressions:{parsed:bundle.expressions.length,added:0,updated:0}, examples:{parsed:bundle.examples.length,added:0,updated:0}, issues:bundle.issues || [], source:sourceName || '' };
    var words = bundle.vocabulary.map(function (row) { var key = text(LANG === 'zh' ? row.Traditional_CH : row.word), old = wordMap.get(key); if (old) report.vocabulary.updated++; else report.vocabulary.added++; return mergeCard(old, row); });
    var pvs = bundle.phrasal.map(function (row) { var old = pvMap.get(text(row.Phrasal_Verb)); if (old) report.phrasal.updated++; else report.phrasal.added++; return mergeCard(old, row); });
    var expr = bundle.expressions.map(function (row) { var old = exprMap.get(text(row.Expression)); if (old) report.expressions.updated++; else report.expressions.added++; return mergeCard(old, row); });
    await putMainRows(words, pvs, expr);
    var oldExamples = await auxAll('examples'), exMap = new Map(oldExamples.map(function (row) { return [row.id, row]; })), exByIdentity = exampleIdentityMap(oldExamples);
    var mergedExamples = bundle.examples.map(function (row) {
      var incoming = Object.assign({}, row), old = exMap.get(incoming.id) || exByIdentity.get(exampleIdentity(incoming));
      if (old) { report.examples.updated++; if (old.id) incoming.id = old.id; } else report.examples.added++;
      return mergeExample(old, incoming);
    });
    await auxBulkPut('examples', mergedExamples);
    await addAudit('excel-import', { source:sourceName || '', report:report, sheets:bundle.sheets });
    state.examples = [];
    await refreshViews();
    return report;
  }
  function reportHtml(report) {
    function line(icon, label, row) { return row && row.parsed ? '<div class="upload-result-item"><span>' + icon + ' ' + label + '</span><span>' + row.parsed + '개 · 새 ' + row.added + ' · 갱신 ' + row.updated + '</span></div>' : ''; }
    var html = line('📖', LANG === 'zh' ? '단어' : '어휘', report.vocabulary) + line('🔗','구동사',report.phrasal) + line('💬','표현',report.expressions) + line('📝','예문',report.examples);
    if (report.issues && report.issues.length) html += '<div class="upload-result-item"><span>확인 사항</span><span>' + report.issues.map(esc).join('<br>') + '</span></div>';
    return html || '<div class="upload-result-item"><span>인식된 데이터 없음</span><span>시트와 헤더를 확인하세요.</span></div>';
  }
  function previewHtml(bundle) {
    var rows = [];
    if (bundle.vocabulary.length) rows.push('📖 ' + (LANG === 'zh' ? '단어' : '어휘') + ' <strong>' + bundle.vocabulary.length + '개</strong>');
    if (bundle.phrasal.length) rows.push('🔗 구동사 <strong>' + bundle.phrasal.length + '개</strong>');
    if (bundle.expressions.length) rows.push('💬 표현 <strong>' + bundle.expressions.length + '개</strong>');
    if (bundle.examples.length) rows.push('📝 예문 <strong>' + bundle.examples.length + '개</strong> <small>(Dialogues·Grammar_Examples 포함, 카드로 변환하지 않음)</small>');
    if (bundle.sheets.vocabularySource) rows.push('ℹ️ Vocabulary_Source는 출처 메타데이터로만 병합');
    if (bundle.issues.length) rows.push('<span style="color:var(--warning)">' + bundle.issues.map(esc).join('<br>') + '</span>');
    return rows.join('<br>') || '⚠️ 인식된 데이터가 없습니다.';
  }
  async function processFile931(file) {
    callToast('📤 엑셀을 정밀 분석하는 중...');
    try {
      var bundle = await parseExcelFile(file);
      if (!bundle.vocabulary.length && !bundle.phrasal.length && !bundle.expressions.length && !bundle.examples.length) throw new Error(bundle.issues.join(' ') || '가져올 데이터를 찾지 못했습니다.');
      var report = await importParsedBundle(bundle, file.name);
      var result = qs('#upload-result'); if (result) { result.innerHTML = reportHtml(report); result.classList.remove('hidden'); }
      callToast('✅ 카드와 예문을 분리해 가져왔습니다.');
      return report;
    } catch (error) {
      console.error('[CEMS 9.3.2 Excel]', error);
      var box = qs('#upload-result'); if (box) { box.innerHTML = '<div class="upload-result-item"><span>❌ 가져오기 실패</span><span>' + esc(error.message) + '</span></div>'; box.classList.remove('hidden'); }
      callToast('❌ ' + error.message); return null;
    }
  }
  async function processModalExcel931(file) {
    try {
      state.modalBundle = await parseExcelFile(file);
      var info = qs('#modal-upload-info'), result = qs('#modal-upload-result'), actions = qs('#modal-upload-actions');
      if (info) info.innerHTML = previewHtml(state.modalBundle);
      if (result) result.style.display = 'block';
      if (actions) actions.style.display = (state.modalBundle.vocabulary.length || state.modalBundle.phrasal.length || state.modalBundle.expressions.length || state.modalBundle.examples.length) ? 'block' : 'none';
    } catch (error) { callToast('❌ ' + error.message); state.modalBundle = null; }
  }
  async function confirmModalExcel931() {
    if (!state.modalBundle) { callToast('먼저 엑셀을 선택하세요.'); return; }
    var report = await importParsedBundle(state.modalBundle, 'modal-upload');
    state.modalBundle = null;
    var info = qs('#modal-upload-info'); if (info) info.innerHTML = reportHtml(report);
    var actions = qs('#modal-upload-actions'); if (actions) actions.style.display = 'none';
    callToast('✅ 새 카드와 예문을 추가했습니다.');
  }

  /* ---------- Offline-native XLSX reader (modern .xlsx; no startup CDN) ---------- */
  function zipU16(view,offset){return view.getUint16(offset,true);}function zipU32(view,offset){return view.getUint32(offset,true);}
  async function inflateRaw931(bytes){
    if(typeof DecompressionStream==='undefined')throw new Error('이 Safari 버전은 오프라인 XLSX 압축 해제를 지원하지 않습니다. 네트워크 연결 후 다시 시도하세요.');
    var stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function unzipXlsx931(buffer){
    var bytes=new Uint8Array(buffer),view=new DataView(buffer),start=Math.max(0,bytes.length-65557),eocd=-1;
    for(var i=bytes.length-22;i>=start;i-=1){if(zipU32(view,i)===0x06054b50){eocd=i;break;}}
    if(eocd<0)throw new Error('올바른 XLSX ZIP 구조를 찾지 못했습니다.');
    var count=zipU16(view,eocd+10),offset=zipU32(view,eocd+16),decoder=new TextDecoder('utf-8'),entries=new Map();
    for(var n=0;n<count;n+=1){if(zipU32(view,offset)!==0x02014b50)throw new Error('XLSX 중앙 디렉터리가 손상되었습니다.');
      var method=zipU16(view,offset+10),compressed=zipU32(view,offset+20),nameLen=zipU16(view,offset+28),extraLen=zipU16(view,offset+30),commentLen=zipU16(view,offset+32),localOffset=zipU32(view,offset+42);
      var name=decoder.decode(bytes.slice(offset+46,offset+46+nameLen)).replace(/^\/+/,''),localNameLen=zipU16(view,localOffset+26),localExtraLen=zipU16(view,localOffset+28),dataStart=localOffset+30+localNameLen+localExtraLen;
      entries.set(name,{method:method,bytes:bytes.slice(dataStart,dataStart+compressed)});offset+=46+nameLen+extraLen+commentLen;
    }
    async function readBytes(name){var entry=entries.get(name.replace(/^\/+/,''));if(!entry)return null;if(entry.method===0)return entry.bytes;if(entry.method===8)return inflateRaw931(entry.bytes);throw new Error('지원하지 않는 XLSX 압축 방식입니다: '+entry.method);}
    async function readText(name){var data=await readBytes(name);return data?decoder.decode(data):'';}
    return{entries:entries,readBytes:readBytes,readText:readText};
  }
  function xmlDoc931(source,label){var doc=new DOMParser().parseFromString(source,'application/xml');if(doc.querySelector('parsererror'))throw new Error((label||'XML')+'을 읽지 못했습니다.');return doc;}
  function excelColumn931(ref){var letters=(String(ref||'').match(/^[A-Z]+/i)||[''])[0].toUpperCase(),value=0;for(var ch of letters)value=value*26+(ch.charCodeAt(0)-64);return Math.max(0,value-1);}
  function normalizeZipPath931(base,target){target=String(target||'').replace(/\\/g,'/');if(target.startsWith('/'))return target.replace(/^\/+/, '');var parts=(base+'/'+target).split('/'),out=[];parts.forEach(function(p){if(!p||p==='.')return;if(p==='..')out.pop();else out.push(p);});return out.join('/');}
  async function parseXlsxNative931(buffer){
    var zip=await unzipXlsx931(buffer),workbookText=await zip.readText('xl/workbook.xml'),relsText=await zip.readText('xl/_rels/workbook.xml.rels');
    if(!workbookText||!relsText)throw new Error('XLSX workbook 관계 파일이 없습니다.');
    var workbook=xmlDoc931(workbookText,'workbook.xml'),rels=xmlDoc931(relsText,'workbook.xml.rels'),relMap=new Map();
    Array.from(rels.getElementsByTagNameNS('*','Relationship')).forEach(function(node){relMap.set(node.getAttribute('Id'),node.getAttribute('Target'));});
    var shared=[];var sharedText=await zip.readText('xl/sharedStrings.xml');if(sharedText){var sharedDoc=xmlDoc931(sharedText,'sharedStrings.xml');Array.from(sharedDoc.getElementsByTagNameNS('*','si')).forEach(function(si){shared.push(Array.from(si.getElementsByTagNameNS('*','t')).map(function(t){return t.textContent||'';}).join(''));});}
    var result={};var sheets=Array.from(workbook.getElementsByTagNameNS('*','sheet'));
    for(var sheetNode of sheets){var name=sheetNode.getAttribute('name')||'Sheet',rid=sheetNode.getAttribute('r:id')||sheetNode.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id'),target=relMap.get(rid);if(!target)continue;
      var path=normalizeZipPath931('xl',target),sheetText=await zip.readText(path);if(!sheetText)continue;var sheetDoc=xmlDoc931(sheetText,name),rows=[];
      Array.from(sheetDoc.getElementsByTagNameNS('*','row')).forEach(function(rowNode){var rowIndex=Math.max(0,Number(rowNode.getAttribute('r')||rows.length+1)-1),row=rows[rowIndex]||[];
        Array.from(rowNode.getElementsByTagNameNS('*','c')).forEach(function(cell){var col=excelColumn931(cell.getAttribute('r')),type=cell.getAttribute('t')||'',value='';
          if(type==='inlineStr')value=Array.from(cell.getElementsByTagNameNS('*','t')).map(function(t){return t.textContent||'';}).join('');
          else{var values=cell.getElementsByTagNameNS('*','v'),raw=values.length?values[0].textContent||'':'';if(type==='s')value=shared[Number(raw)]==null?'':shared[Number(raw)];else if(type==='b')value=raw==='1'?'TRUE':'FALSE';else value=raw;}
          row[col]=value;
        });rows[rowIndex]=row;
      });
      for(var r=0;r<rows.length;r+=1)if(!rows[r])rows[r]=[];result[name]=rows;
    }
    return result;
  }
  async function parseExcelFileNativeFirst931(file){
    if(!file)throw new Error('파일이 선택되지 않았습니다.');var lower=text(file.name).toLowerCase();
    if(lower.endsWith('.xlsx')||lower.endsWith('.xlsm')){var buffer=await file.arrayBuffer();return parseWorkbookSheets(await parseXlsxNative931(buffer));}
    if(lower.endsWith('.xls')){
      var loader=typeof phase8EnsureXLSX==='function'?phase8EnsureXLSX:ensureXLSX931;if(!await loader())throw new Error('구형 .xls 파일은 네트워크 Excel 엔진이 필요합니다. 가능하면 .xlsx로 저장해 주세요.');
      var oldBuffer=await file.arrayBuffer(),workbook=XLSX.read(oldBuffer,{cellDates:true});return parseWorkbookSheets(workbookToSheets(workbook));
    }
    throw new Error('.xlsx 파일을 선택하세요.');
  }
  parseExcelFile=parseExcelFileNativeFirst931;

  /* ---------- Stable view refresh and compact motivation home ---------- */
  async function loadExamples(force) {
    if (!force && state.examples && state.examples.length) return state.examples;
    state.examples = (await auxAll('examples')).filter(function (row) { return row && row.targetText; });
    return state.examples;
  }
  async function getSessionRows() {
    try { return typeof getSessions === 'function' ? await getSessions() : []; } catch (_) { return []; }
  }
  function reviewed(row) { return Number(row && (row.reviewCount || row.reps) || 0) > 0 || !!(row && row.lastReview); }
  function dueNow(row, now) {
    if (!reviewed(row)) return false;
    if (!row.nextReview) return true;
    var d = new Date(row.nextReview); return !Number.isFinite(d.getTime()) || d <= now;
  }
  function sessionDate(row) { return dayKey(row && (row.date || row.endedAt || row.startedAt || row.start)); }
  function strictStreak(activeSet) {
    var streak = 0, cursor = new Date();
    if (!activeSet.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
    while (activeSet.has(dayKey(cursor))) { streak += 1; cursor.setDate(cursor.getDate() - 1); }
    return streak;
  }
  function weekWindow() {
    var now = new Date(), day = now.getDay(), mondayOffset = day === 0 ? -6 : 1 - day;
    var monday = new Date(now); monday.setHours(0,0,0,0); monday.setDate(now.getDate() + mondayOffset);
    var rows = [];
    for (var i = 0; i < 7; i += 1) { var d = new Date(monday); d.setDate(monday.getDate() + i); rows.push(d); }
    return rows;
  }
  async function collectHomeModel() {
    var values = await Promise.all([rawMainRows('vocab'), rawMainRows('phrasal'), typeof getAllExpr === 'function' ? getAllExpr() : [], getSessionRows(), settingGet('weeklyGoalDays', 4)]);
    var now = new Date(), groups = [
      { type:'vocab', label:LANG === 'zh' ? '단어' : '어휘', rows:values[0] || [] },
      { type:'phrasal', label:'구동사', rows:values[1] || [] },
      { type:'expr', label:LANG === 'zh' ? '표현·문법' : '표현', rows:values[2] || [] }
    ].filter(function (g) { return g.rows.length || g.type !== 'phrasal' || LANG === 'en'; });
    groups.forEach(function (g) {
      g.dueRows = g.rows.filter(function (row) { return dueNow(row, now); });
      g.newRows = g.rows.filter(function (row) { return !reviewed(row); });
      g.weak = g.rows.filter(function (row) { try { return typeof isWeak === 'function' && isWeak(row); } catch (_) { return false; } }).length;
    });
    var sessions = values[3] || [], today = dayKey(now), activeSet = new Set(sessions.map(sessionDate).filter(Boolean));
    var todayRows = sessions.filter(function (row) { return sessionDate(row) === today; });
    var todayDone = todayRows.reduce(function (sum, row) { return sum + Number(row.total || row.uniqueTotal || 0); }, 0);
    var days = weekWindow(), weekActive = days.filter(function (d) { return activeSet.has(dayKey(d)); }).length;
    var totalDue = groups.reduce(function (sum, g) { return sum + g.dueRows.length; }, 0);
    var totalNew = groups.reduce(function (sum, g) { return sum + g.newRows.length; }, 0);
    var totalCards = groups.reduce(function (sum, g) { return sum + g.rows.length; }, 0);
    var totalWeak = groups.reduce(function (sum, g) { return sum + g.weak; }, 0);
    var focus = groups.slice().sort(function (a,b) { return b.dueRows.length - a.dueRows.length || b.newRows.length - a.newRows.length; })[0] || null;
    var target = totalDue ? Math.max(5, Math.min(12, totalDue + Math.min(totalNew, 4))) : (totalNew ? Math.min(8, totalNew) : 5);
    return { groups:groups, sessions:sessions, activeSet:activeSet, todayDone:todayDone, weekDays:days, weekActive:weekActive, weeklyGoal:Math.max(1, Math.min(7, Number(values[4] || 4))), streak:strictStreak(activeSet), totalDue:totalDue, totalNew:totalNew, totalCards:totalCards, totalWeak:totalWeak, focus:focus, target:target };
  }
  function weekDotsHtml(model) {
    var labels = ['월','화','수','목','금','토','일'], today = dayKey(new Date());
    return model.weekDays.map(function (d, i) {
      var key = dayKey(d), cls = (model.activeSet.has(key) ? ' done' : '') + (key === today ? ' today' : '');
      return '<span class="cems931-week-day' + cls + '"><i></i><em>' + labels[i] + '</em></span>';
    }).join('');
  }
  function focusCopy(model) {
    if (!model.totalCards) return { title:'학습 데이터를 먼저 준비하세요', sub:'데이터 탭에서 엑셀을 가져오면 카드와 예문을 분리해 저장합니다.', button:'단어 DB 열기' };
    if (model.totalDue) return { title:model.totalDue + '개 복습이 준비되어 있어요', sub:(model.focus ? model.focus.label + '부터 ' : '') + '예정 복습을 먼저 끝내고 신규 카드를 소량 이어갑니다.', button:Math.max(3, Math.min(12, model.totalDue)) + '개 복습 시작' };
    if (model.totalNew) return { title:'오늘은 새 카드로 가볍게 시작해요', sub:'예정 복습은 없습니다. 신규 카드를 작은 묶음으로 시작합니다.', button:Math.min(8, model.totalNew) + '개 새 카드 시작' };
    return { title:'오늘 계획을 모두 마쳤어요', sub:'문장 예문을 한 번 직접 만들어 기억을 확인해 보세요.', button:'문장 연습 시작' };
  }
  async function renderStableHome() {
    /* The legacy daily-goal, content tabs and quick-start cards are the Home
       screen. Remove previously injected replacement dashboards instead of
       stacking another design system above them. */
    var card = qs('#cems-lean-home-card'); if (card) card.remove();
    var zhHome = qs('#zh-home-card'); if (zhHome) zhHome.remove();
    var deckHome = qs('#cems932-home-deck'); if (deckHome) deckHome.remove();
    return null;
  }

  async function startHomePrimary() {
    var model = state.homeModel || await collectHomeModel();
    if (!model.totalCards) { if (typeof showPage === 'function') showPage('data'); callToast('📤 엑셀 또는 백업 파일을 가져오세요.'); return; }
    if (!model.totalDue && !model.totalNew) { openSentenceChecker(); return; }
    var group = selectFocusGroup(model); if (!group) return;
    var pool = group.dueRows.length ? group.dueRows : group.newRows;
    var count = Math.min(group.dueRows.length ? 12 : 8, pool.length), chosen = typeof shuffle === 'function' ? shuffle(pool).slice(0,count) : pool.slice(0,count);
    try {
      if (group.type === 'expr' && typeof startExprFCWithItems === 'function') return startExprFCWithItems(chosen, group.rows);
      if ((group.type === 'vocab' || group.type === 'phrasal') && typeof startFC === 'function') return startFC(chosen, group.rows, group.type === 'phrasal' ? 'phrasal' : 'vocab');
      if (typeof showPage === 'function') showPage('study');
    } catch (error) { console.error('[CEMS 9.3.2 home start]', error); callToast('⚠️ 학습 시작에 실패했습니다. 학습 탭에서 다시 시도하세요.'); }
  }

  /* ---------- Example repository: sentences never become expression cards ---------- */
  function exampleType(row) {
    var types = row.sourceTypes || [];
    if (types.some(function (v) { return /dialogue/i.test(v); })) return 'dialogue';
    if (types.some(function (v) { return /grammar/i.test(v); })) return 'grammar';
    return 'example';
  }
  function ensureExampleRepository() {
    var page = qs('#page-data'); if (!page) return null;
    var card = qs('#cems931-example-card');
    if (!card) {
      card = document.createElement('details'); card.id = 'cems931-example-card'; card.className = 'card cems931-example-card'; card.open = false;
    }
    /* The legacy data polish converts the word-list card into a pane. Keep the
       repository directly after that pane instead of letting it cover the data tab. */
    var anchor = qs(':scope > .cems-ux25-data-pane', page) || qs(':scope > .card:not(#cems931-example-card)', page);
    if (anchor && card.previousElementSibling !== anchor) anchor.insertAdjacentElement('afterend', card);
    else if (!card.parentNode) page.appendChild(card);
    return card;
  }
  function renderExampleList(rows) {
    var host = qs('#cems931-example-list'); if (!host) return;
    if (!rows.length) { host.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><h3>조건에 맞는 예문이 없습니다</h3><p>엑셀의 Dialogues·Grammar_Examples·Example 열을 가져오면 여기에 저장됩니다.</p></div>'; return; }
    host.innerHTML = rows.slice(0,80).map(function (row) {
      var tags = unique((row.sourceTypes || []).concat(row.lessons || [])).slice(0,5);
      var target = row.targetText || row.textTraditional || row.translationEn, pinyin = LANG === 'zh' ? row.pinyin : '', trans = row.translationKo || (LANG === 'zh' ? row.translationEn : '');
      return '<article class="cems931-example-item"><strong>' + esc(target) + '</strong>' + (pinyin ? '<p>' + esc(pinyin) + '</p>' : '') + (trans ? '<p>' + esc(trans) + '</p>' : '') + '<div class="cems931-example-tags">' + tags.map(function (v) { return '<span>' + esc(v) + '</span>'; }).join('') + '</div><small>연결 단어 ' + Number((row.linkedVocabulary || []).length) + '개 · 연결 표현 ' + Number((row.linkedExpressions || []).length) + '개</small></article>';
    }).join('');
  }
  async function renderExampleRepository() {
    var card = ensureExampleRepository(); if (!card) return;
    var token = ++state.exampleToken, rows = await loadExamples(); if (token !== state.exampleToken) return;
    var dialogue = rows.filter(function (r) { return exampleType(r) === 'dialogue'; }).length, grammar = rows.filter(function (r) { return exampleType(r) === 'grammar'; }).length;
    if (!card.dataset.cems931Built) {
      card.innerHTML = '<summary class="cems931-example-toggle"><span><strong>📝 예문 보관함 <b id="cems931-example-count">0개</b></strong><small id="cems931-example-breakdown">대화 0 · 문법 0</small></span><em>열기</em></summary>' +
        '<div class="cems931-example-body"><div class="cems931-example-summary"><div><span>전체 예문</span><b id="cems931-ex-total">0</b></div><div><span>대화 발화</span><b id="cems931-ex-dialogue">0</b></div><div><span>문법 예문</span><b id="cems931-ex-grammar">0</b></div></div>' +
        '<div class="cems931-example-controls"><input id="cems931-example-search" class="form-input" type="search" placeholder="문장·번역·단원 검색"><select id="cems931-example-filter" class="form-select"><option value="all">전체 출처</option><option value="dialogue">대화</option><option value="grammar">문법</option><option value="example">단어·표현 예문</option></select></div>' +
        '<div id="cems931-example-list" class="cems931-example-list"></div></div>';
      card.addEventListener('toggle', function () { var label=qs(':scope > summary em',card);if(label)label.textContent=card.open?'접기':'열기';if(card.open)filterExampleRepository(); });
      card.dataset.cems931Built = '1';
    }
    qs('#cems931-example-count').textContent = rows.length + '개'; qs('#cems931-ex-total').textContent = rows.length; qs('#cems931-ex-dialogue').textContent = dialogue; qs('#cems931-ex-grammar').textContent = grammar;
    var breakdown=qs('#cems931-example-breakdown');if(breakdown)breakdown.textContent='대화 '+dialogue+' · 문법 '+grammar;
    if (card.open) filterExampleRepository(); else { var host=qs('#cems931-example-list');if(host)host.innerHTML=''; }
  }
  function filterExampleRepository() {
    var card = qs('#cems931-example-card');
    if (card && card.tagName === 'DETAILS' && !card.open) return;
    var query = text(qs('#cems931-example-search') && qs('#cems931-example-search').value).toLowerCase().normalize('NFKC');
    var filter = text(qs('#cems931-example-filter') && qs('#cems931-example-filter').value) || 'all';
    var rows = (state.examples || []).filter(function (row) {
      if (filter !== 'all' && exampleType(row) !== filter) return false;
      if (!query) return true;
      var hay = [row.targetText,row.textTraditional,row.textSimplified,row.translationKo,row.translationEn,row.pinyin].concat(row.lessons || [],row.linkedVocabulary || [],row.linkedExpressions || []).join(' ').toLowerCase().normalize('NFKC');
      return hay.indexOf(query) >= 0;
    });
    renderExampleList(rows);
  }

  async function refreshViews() {
    try {
      var jobs = [renderStableHome(), renderExampleRepository()];
      /* The legacy home remains the visible shell. After the built-in seed is
         merged, refresh its counters and DB summary instead of leaving the
         pre-import zero state on screen. */
      if (typeof updateHomeStats === 'function') jobs.push(Promise.resolve(updateHomeStats()));
      await Promise.all(jobs);
    } catch (error) { console.warn('[CEMS 9.3.2 refresh]', error); }
  }

  /* ---------- Gemini proxy settings for GitHub Pages PWA ---------- */
  function ensureAiSettingsCard() {
    var page = qs('#page-settings'); if (!page) return null;
    var card = qs('#cems931-ai-card');
    if (!card) {
      card = document.createElement('section'); card.id = 'cems931-ai-card'; card.className = 'card';
      card.innerHTML = '<div class="card-title">✨ 문장 의미 판독</div><div class="cems931-ai-grid">' +
        '<div class="toggle-row"><span class="toggle-label">애매한 문장만 Gemini 사용</span><label class="toggle-switch"><input id="cems931-ai-enabled" type="checkbox"><span class="toggle-slider"></span></label></div>' +
        '<label>Cloudflare Worker 주소<input id="cems931-proxy-url" class="form-input" type="url" inputmode="url" placeholder="https://cems-gemini-proxy.example.workers.dev"></label>' +
        '<label>개인용 프록시 접근 토큰<input id="cems931-proxy-token" class="form-input" type="password" autocomplete="off" placeholder="Gemini API 키가 아닌 별도 토큰"></label>' +
        '<div class="cems931-inline"><label>기기 일일 소프트 한도<input id="cems931-ai-daily-cap" class="form-input" type="number" min="1" max="200" value="25"></label><button class="btn btn-secondary" type="button" data-cems931-action="test-ai">연결 확인</button></div>' +
        '<label>주간 동기부여 목표<select id="cems931-weekly-goal" class="form-select"><option value="3">주 3일</option><option value="4">주 4일</option><option value="5">주 5일</option><option value="6">주 6일</option><option value="7">매일</option></select></label>' +
        '<div id="cems931-ai-state" class="cems931-ai-state">정확히 일치하는 답은 즉시 로컬 채점하고, 자연스러운 의역처럼 애매한 답만 프록시로 보냅니다.</div>' +
        '<p class="cems931-danger-note">Google API 키는 GitHub Pages나 이 화면에 입력하지 않습니다. 키는 Worker Secret에만 보관하고, 여기에는 교체 가능한 개인 접근 토큰만 저장합니다. 기본 모델 요청값: ' + esc(DEFAULT_MODEL) + '</p>' +
      '</div>';
      var version = qsa(':scope > .card', page).find(function (node) { return /버전 정보/.test(text(qs('.card-title', node) && qs('.card-title', node).textContent)); });
      if (version) version.insertAdjacentElement('beforebegin', card); else page.appendChild(card);
    }
    return card;
  }
  async function loadAiSettingsUi() {
    var card = ensureAiSettingsCard(); if (!card || card.dataset.cems931Loaded === '1') return;
    var values = await Promise.all([
      settingGet('aiEnabled', false), settingGet('proxyUrl', ''), settingGet('proxyToken', ''), settingGet('aiDailyCap', 25), settingGet('weeklyGoalDays', 4)
    ]);
    qs('#cems931-ai-enabled').checked = !!values[0]; qs('#cems931-proxy-url').value = values[1] || ''; qs('#cems931-proxy-token').value = values[2] || ''; qs('#cems931-ai-daily-cap').value = values[3] || 25; qs('#cems931-weekly-goal').value = String(values[4] || 4);
    card.dataset.cems931Loaded = '1';
  }
  async function saveAiSettingsUi() {
    var enabled = !!(qs('#cems931-ai-enabled') && qs('#cems931-ai-enabled').checked), url = text(qs('#cems931-proxy-url') && qs('#cems931-proxy-url').value).replace(/\/+$/, ''), token = text(qs('#cems931-proxy-token') && qs('#cems931-proxy-token').value);
    var cap = Math.max(1, Math.min(200, num(qs('#cems931-ai-daily-cap') && qs('#cems931-ai-daily-cap').value, 25))), weekly = Math.max(3, Math.min(7, num(qs('#cems931-weekly-goal') && qs('#cems931-weekly-goal').value, 4)));
    await Promise.all([settingSet('aiEnabled', enabled), settingSet('proxyUrl', url), settingSet('proxyToken', token), settingSet('aiDailyCap', cap), settingSet('weeklyGoalDays', weekly)]);
    state.homeModel = null; renderStableHome();
  }
  function setAiState(message, kind) { var el = qs('#cems931-ai-state'); if (!el) return; el.textContent = message; el.className = 'cems931-ai-state' + (kind ? ' ' + kind : ''); }
  async function aiConfig() {
    var values = await Promise.all([settingGet('aiEnabled', false), settingGet('proxyUrl', ''), settingGet('proxyToken', ''), settingGet('aiDailyCap', 25)]);
    return { enabled:!!values[0], url:text(values[1]).replace(/\/+$/, ''), token:text(values[2]), dailyCap:Math.max(1, Number(values[3] || 25)) };
  }
  async function testAiConnection() {
    await saveAiSettingsUi(); var cfg = await aiConfig();
    if (!cfg.url || !cfg.token) { setAiState('Worker 주소와 개인 접근 토큰을 모두 입력하세요.', 'error'); return; }
    setAiState('연결을 확인하는 중입니다…');
    var controller = new AbortController();
    try {
      var response = await Promise.race([
        fetch(cfg.url + '/health', { method:'GET', headers:{ 'Authorization':'Bearer ' + cfg.token }, cache:'no-store', signal:controller.signal }),
        timeoutPromise(7000, controller)
      ]);
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(body.message || body.error || 'HTTP ' + response.status);
      /* 9.5.1: 예전에는 /health 가 200 이기만 하면 "연결 성공" 이라고 했다.
         그런데 채점을 실제로 막는 조건은 /health 로 드러나는 다른 값들이다.
         채점기 버전이 다르면 모든 /grade-answer 가 409 로 거부되고, API 키가 없으면
         전부 실패한다. 실제로 v9.5.0 직전 배포가 이 상태였고 버튼은 계속 "연결 성공"
         이라고 답했다. 이제 채점을 막는 조건을 그대로 검사한다. */
      var remoteGrader = text(body.graderVersion);
      if (remoteGrader && remoteGrader !== GRADER_VERSION) {
        setAiState('연결됨 · 그러나 채점 불가 — Worker 채점기 ' + remoteGrader + ' ≠ 앱 ' + GRADER_VERSION + '. Worker 를 다시 배포하세요.', 'error');
        return;
      }
      if (body.configured === false) {
        setAiState('연결됨 · 그러나 채점 불가 — Worker 에 Gemini API 키가 없습니다.', 'error');
        return;
      }
      var warnings = Array.isArray(body.warnings) ? body.warnings.filter(Boolean) : [];
      if (warnings.length) {
        setAiState('연결 성공 · 요청 모델 ' + (body.model || DEFAULT_MODEL) + ' · 확인 필요: ' + warnings.join(' / '), 'warn');
        return;
      }
      setAiState('연결 성공 · 채점기 ' + (remoteGrader || GRADER_VERSION) + ' · 요청 모델 ' + (body.model || DEFAULT_MODEL), 'ok');
    } catch (error) { setAiState('연결 실패 · ' + (error.code === 'timeout' ? '7초 시간 초과' : aiErrorMessage(error)), 'error'); }
  }

  /* ---------- Local-first free sentence checker ---------- */
  function ensureSentencePage() {
    var page = qs('#page-sentence-check'); if (page) return page;
    page = document.createElement('div'); page.id = 'page-sentence-check'; page.className = 'page';
    page.innerHTML = '<div class="cems931-page-head"><div><h1 id="cems931-sentence-title">문장 연습</h1><p id="cems931-sentence-subtitle">정확한 답은 즉시, 애매한 의역만 AI로 확인합니다.</p></div><button type="button" class="btn btn-secondary cems931-icon-btn" data-cems931-action="sentence-back" aria-label="뒤로">←</button></div>' +
      '<section class="card cems931-sentence-card"><div class="cems931-sentence-meta"><span id="cems931-sentence-source">예문</span><span id="cems931-sentence-progress">0 / 0</span></div><div id="cems931-sentence-prompt" class="cems931-sentence-prompt">예문을 불러오는 중입니다.</div><div id="cems931-sentence-context" class="cems931-sentence-context"></div>' +
      '<textarea id="cems931-sentence-input" class="form-input cems931-textarea" rows="4" autocomplete="off" autocapitalize="off" placeholder="' + (LANG === 'zh' ? '중국어 문장을 입력하세요' : '영어 문장을 입력하세요') + '"></textarea>' +
      '<div id="cems931-grade-status" class="cems931-grade-status" aria-live="polite"></div>' +
      '<div id="cems931-manual-actions" class="cems931-grade-actions hidden"><button type="button" class="btn btn-secondary" data-cems931-action="manual-wrong">오답으로 기록</button><button type="button" class="btn btn-primary" data-cems931-action="manual-correct">정답으로 기록</button></div>' +
      '<div class="cems931-grade-actions"><button type="button" class="btn btn-secondary" data-cems931-action="sentence-skip">건너뛰기</button><button type="button" class="btn btn-primary" id="cems931-sentence-submit" data-cems931-action="sentence-submit">정답 확인</button></div></section>';
    var app = qs('.app'); if (app) app.appendChild(page); else document.body.appendChild(page);
    return page;
  }
  function normalizeEnglish(value) {
    var s = text(value).toLowerCase().normalize('NFKC').replace(/[‘’]/g,"'").replace(/[“”]/g,'"');
    var replacements = [[/\bi['’]?m\b/g,'i am'],[/\byou['’]?re\b/g,'you are'],[/\bwe['’]?re\b/g,'we are'],[/\bthey['’]?re\b/g,'they are'],[/\bhe['’]?s\b/g,'he is'],[/\bshe['’]?s\b/g,'she is'],[/\bit['’]?s\b/g,'it is'],[/\bcan['’]?t\b/g,'cannot'],[/\bwon['’]?t\b/g,'will not'],[/\bdon['’]?t\b/g,'do not'],[/\bdoesn['’]?t\b/g,'does not'],[/\bdidn['’]?t\b/g,'did not'],[/\bisn['’]?t\b/g,'is not'],[/\baren['’]?t\b/g,'are not'],[/\bwasn['’]?t\b/g,'was not'],[/\bweren['’]?t\b/g,'were not'],[/\bi['’]?ve\b/g,'i have'],[/\byou['’]?ve\b/g,'you have'],[/\bwe['’]?ve\b/g,'we have'],[/\bthey['’]?ve\b/g,'they have'],[/\bi['’]?ll\b/g,'i will'],[/\byou['’]?ll\b/g,'you will']];
    replacements.forEach(function (pair) { s = s.replace(pair[0], pair[1]); });
    return s.replace(/[^a-z0-9'\s]/g,' ').replace(/\s+/g,' ').trim();
  }
  function normalizeChinese(value) { return text(value).normalize('NFKC').replace(/[\s\u3000\p{P}\p{S}]/gu,''); }
  function normalizeSentence(value) { return LANG === 'zh' ? normalizeChinese(value) : normalizeEnglish(value); }
  function levenshtein(a,b) {
    a = String(a || ''); b = String(b || ''); if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
    var prev = Array.from({length:b.length+1}, function (_,i) { return i; });
    for (var i=1;i<=a.length;i+=1) { var cur=[i]; for(var j=1;j<=b.length;j+=1) cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1)); prev=cur; }
    return prev[b.length];
  }
  function numberSignature(value) { return (text(value).match(/\d+(?:[.,]\d+)?/g) || []).join('|'); }
  function negationSignature(value) {
    var s = LANG === 'zh' ? normalizeChinese(value) : normalizeEnglish(value);
    var words = LANG === 'zh' ? ['不','沒','没有','沒有','別','未','無'] : ['not','no','never','cannot','without','neither'];
    return words.filter(function (w) { return s.indexOf(w) >= 0; }).join('|');
  }
  function tokenOverlap(a,b) {
    if (LANG === 'zh') {
      var aa = new Set(Array.from(normalizeChinese(a))), bb = new Set(Array.from(normalizeChinese(b))); if (!aa.size || !bb.size) return 0;
      var common=0; aa.forEach(function (v) { if (bb.has(v)) common++; }); return common / Math.max(aa.size,bb.size);
    }
    var at = new Set(normalizeEnglish(a).split(' ').filter(Boolean)), bt = new Set(normalizeEnglish(b).split(' ').filter(Boolean)); if (!at.size || !bt.size) return 0;
    var hit=0; at.forEach(function (v) { if (bt.has(v)) hit++; }); return hit / Math.max(at.size,bt.size);
  }
  function sentenceAnswers(row) {
    var all = unique((row.acceptedAnswers || []).concat([row.targetText,row.textTraditional,row.textSimplified].filter(Boolean)));
    return all.filter(function (answer) { return LANG === 'zh' ? cjk(answer) : !cjk(answer); });
  }
  function localSentenceGrade(row, learner) {
    var answer = text(learner), accepted = sentenceAnswers(row), norm = normalizeSentence(answer);
    if (!norm) return { verdict:'incorrect', confidence:1, reason:'답을 입력하지 않았습니다.', source:'local' };
    var norms = accepted.map(normalizeSentence).filter(Boolean);
    if (norms.indexOf(norm) >= 0) return { verdict:'correct', confidence:1, reason:'등록된 정답과 일치합니다.', source:'local' };
    var closest = accepted.slice().sort(function (a,b) { return levenshtein(norm,normalizeSentence(a))-levenshtein(norm,normalizeSentence(b)); })[0] || row.targetText;
    var targetNorm = normalizeSentence(closest), distance = levenshtein(norm,targetNorm);
    if (targetNorm.length >= 12 && distance === 1 && numberSignature(answer) === numberSignature(closest) && negationSignature(answer) === negationSignature(closest)) return { verdict:'acceptable', confidence:.93, reason:'의미를 바꾸지 않는 한 글자 오타로 판단했습니다.', source:'local', correctedAnswer:closest };
    if (numberSignature(answer) !== numberSignature(closest) && (numberSignature(answer) || numberSignature(closest))) return { verdict:'incorrect', confidence:.98, reason:'숫자 정보가 기준 문장과 다릅니다.', source:'local' };
    if (negationSignature(answer) !== negationSignature(closest)) return { verdict:'uncertain', confidence:.55, reason:'부정 표현 차이가 의미를 바꿀 수 있어 확인이 필요합니다.', source:'local' };
    var overlap = tokenOverlap(answer,closest), lengthRatio = Math.min(norm.length,targetNorm.length) / Math.max(1,Math.max(norm.length,targetNorm.length));
    if (overlap < .18 && lengthRatio < .55) return { verdict:'incorrect', confidence:.92, reason:'핵심 어휘와 문장 정보가 기준 답과 크게 다릅니다.', source:'local' };
    return { verdict:'uncertain', confidence:.5, reason:'자연스러운 의역인지 로컬 규칙만으로 확정하기 어렵습니다.', source:'local' };
  }
  async function sentenceCacheKey(row, learner) { return sha256([GRADER_VERSION,LANG,row.id,normalizeSentence(learner),sentenceAnswers(row).map(normalizeSentence).sort().join('|')].join('::')); }
  async function cachedGrade(key) {
    var row = await auxGet('aiCache', key); if (!row) return null;
    if (Number(row.expiresAt || 0) < Date.now()) return null; return row.result || null;
  }
  async function cacheGrade(key, result) { return auxPut('aiCache', { key:key, result:result, createdAt:Date.now(), expiresAt:Date.now()+30*DAY_MS, graderVersion:GRADER_VERSION }); }
  async function usageToday(cap) {
    var key='aiUsage:' + dayKey(new Date()), row=await metaGet(key,{count:0}); if (!row || typeof row !== 'object') row={count:0}; return {key:key,count:Number(row.count||0),cap:Number(cap||25)};
  }
  async function incrementUsage(usage) { usage.count += 1; await metaSet(usage.key,{count:usage.count,updatedAt:new Date().toISOString()}); }
  function recordAiFailure(code) {
    var now=Date.now(); state.aiFailures=state.aiFailures.filter(function (v) { return now-v.at < 60000; }); state.aiFailures.push({at:now,code:code});
    if (state.aiFailures.length >= 3) state.circuitUntil = now + 120000;
  }
  function clearAiFailures() { state.aiFailures=[]; state.circuitUntil=0; }
  function enqueueAi(task) {
    var previous = state.aiInFlight || Promise.resolve();
    var next = previous.catch(function () {}).then(task);
    state.aiInFlight = next;
    /* 9.5.1: 예전에는 next.finally(...) 를 썼다. finally 는 파생 프로미스를 새로 만들고,
       그 프로미스는 next 의 거부를 그대로 물려받는데 아무도 받지 않는다. 호출자는
       next 를 받아 처리하므로, Worker 가 한 번 실패할 때마다 unhandledrejection 이
       하나씩 떠서 phase7LogCrash 가 앱 크래시로 기록했다(모의 Worker 로 실측).
       then(정리, 정리) 는 거부를 흡수하므로 파생 프로미스가 거부되지 않는다. */
    var settle = function () { if (state.aiInFlight === next) state.aiInFlight = null; };
    next.then(settle, settle);
    return next;
  }

  /* 9.5.1: Worker 는 오류를 기계용 코드로 돌려준다(upstream_error, gemini_timeout …).
     클라이언트가 body.error 를 그대로 화면에 붙여서 사용자가 "upstream_error" 를 봤다.
     아는 코드는 한국어로 옮기고, 모르는 코드는 원문을 괄호로 덧붙여 진단은 남긴다. */
  var AI_ERROR_KO = {
    grader_version_mismatch: '앱과 Worker 의 채점기 버전이 다릅니다. Worker 를 다시 배포하세요.',
    invalid_access_token: '접근 토큰이 올바르지 않습니다. 설정에서 토큰을 확인하세요.',
    worker_token_not_configured: 'Worker 에 접근 토큰이 설정되지 않았습니다.',
    gemini_key_not_configured: 'Worker 에 Gemini API 키가 설정되지 않았습니다.',
    gemini_auth_failed: 'Gemini 인증에 실패했습니다. Worker 의 API 키를 확인하세요.',
    gemini_rate_limited: 'Gemini 사용량 한도에 걸렸습니다. 잠시 뒤 다시 시도하세요.',
    gemini_timeout: 'Gemini 응답이 제한 시간을 넘었습니다.',
    gemini_network_error: 'Worker 가 Gemini 에 연결하지 못했습니다.',
    gemini_invalid_json: 'Gemini 응답을 해석하지 못했습니다.',
    gemini_schema_mismatch: 'Gemini 응답 형식이 계약과 다릅니다.',
    rate_limited: '요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요.',
    payload_too_large: '보낸 문장이 너무 깁니다.',
    accepted_answer_too_long: '정답 후보 문장이 너무 깁니다.',
    accepted_answers_too_large: '정답 후보가 너무 많습니다.',
    invalid_json_body: '요청 형식이 올바르지 않습니다.',
    not_found: 'Worker 주소가 올바르지 않습니다.',
    upstream_error: 'Worker 가 채점에 실패했습니다.',
    worker_error: 'Worker 가 채점에 실패했습니다.',
    timeout: 'AI 응답이 8초를 넘었습니다.',
    circuit_open: '일시 오류가 반복되어 2분간 AI 판독을 쉬고 있습니다.',
    disabled: 'AI 판독이 설정되지 않았습니다.',
    local_daily_cap: '이 기기의 오늘 AI 소프트 한도에 도달했습니다.'
  };
  function aiErrorMessage(error) {
    var code = text(error && error.code), raw = text(error && error.message);
    if (AI_ERROR_KO[code]) return AI_ERROR_KO[code];
    if (AI_ERROR_KO[raw]) return AI_ERROR_KO[raw];
    if (/^[a-z0-9_]+$/.test(raw)) return 'AI 판독에 실패했습니다. (' + raw + ')';
    return raw || 'AI 판독에 실패했습니다.';
  }
  async function callGeminiGrader(row, learner) {
    var cfg = await aiConfig();
    if (!cfg.enabled || !cfg.url || !cfg.token) { var disabled=new Error('AI 판독이 설정되지 않았습니다.'); disabled.code='disabled'; throw disabled; }
    /* 9.5.1: 캐시 조회를 한도·차단기보다 먼저 한다. 저장된 판독은 네트워크도 비용도
       들지 않는데, 예전에는 하루 한도(기본 25회)에 닿거나 2분 차단기가 걸린 동안
       이미 채점해 둔 같은 문장까지 거부했다. */
    var key=await sentenceCacheKey(row,learner), cached=await cachedGrade(key); if (cached) return Object.assign({},cached,{cached:true});
    if (Date.now() < state.circuitUntil) { var circuit=new Error('일시 오류가 반복되어 2분간 AI 판독을 쉬고 있습니다.'); circuit.code='circuit_open'; throw circuit; }
    var usage=await usageToday(cfg.dailyCap); if (usage.count >= usage.cap) { var quota=new Error('이 기기의 오늘 AI 소프트 한도에 도달했습니다.'); quota.code='local_daily_cap'; throw quota; }
    return enqueueAi(async function () {
      var secondCache=await cachedGrade(key); if(secondCache)return Object.assign({},secondCache,{cached:true});
      /* 9.5.1: 위 usage 는 큐에 들어가기 전에 읽은 값이라, 요청이 겹치면 둘 다 같은 N 을
         읽고 둘 다 N+1 을 써서 한 번치만 차감된다. 직렬화된 이 안에서 다시 읽는다. */
      var fresh=await usageToday(cfg.dailyCap);
      if (fresh.count >= fresh.cap) throw Object.assign(new Error('이 기기의 오늘 AI 소프트 한도에 도달했습니다.'),{code:'local_daily_cap'});
      /* C1 부수: incrementUsage 는 fetch 성공 뒤로 옮겼다(아래).
         예전에는 요청 전에 올려서, 실패한 요청(409·타임아웃·5xx)까지 일일 한도를
         갉아먹었다. 위 GRADER_VERSION 불일치와 겹치면 한 번도 성공하지 못한 채
         하루 한도가 소진된다. */
      var controller=new AbortController(), requestId='cems-' + Date.now().toString(36) + '-' + fnv1a(key).slice(0,6);
      var payload={ requestId:requestId, graderVersion:GRADER_VERSION, language:LANG==='zh'?'zh-TW':'en', promptKo:text(row.translationKo), targetAnswer:text(row.targetText), acceptedAnswers:sentenceAnswers(row).slice(0,8), learnerAnswer:text(learner), rubric:{ acceptNaturalParaphrase:true, preserveNegationNumbersPeopleTimePlace:true, learnerLevel:'A1-B1' } };
      try {
        var response=await Promise.race([
          fetch(cfg.url + '/grade-answer',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg.token},body:JSON.stringify(payload),cache:'no-store',signal:controller.signal}),
          timeoutPromise(8000,controller)
        ]);
        var body=await response.json().catch(function(){return{};});
        if(!response.ok){var e=new Error(body.message||body.error||('HTTP '+response.status));e.code=body.code||('http_'+response.status);e.status=response.status;throw e;}
        var result={verdict:text(body.verdict),confidence:Number(body.confidence||0),reason:text(body.feedbackKo||body.reason||''),correctedAnswer:text(body.correctedAnswer||''),modelUsed:text(body.modelUsed||body.model||DEFAULT_MODEL),source:'gemini'};
        /* C1 부수: Worker 는 correct|partial|incorrect 만 돌려주는데 클라이언트는
           correct|acceptable|incorrect|uncertain 을 기대해 'partial' 을 형식 오류로
           버렸다. 'partial' 을 받아들이고, 의미가 같은 기존 'acceptable' 로 정규화해
           아래 표시·채점 로직을 그대로 재사용한다. */
        if(result.verdict==='partial')result.verdict='acceptable';
        if(!['correct','acceptable','incorrect','uncertain'].includes(result.verdict))throw Object.assign(new Error('AI 응답 형식이 올바르지 않습니다.'),{code:'invalid_response'});
        /* 이미 비용이 발생한 채점 결과를 저장·집계 실패로 버리지 않는다. */
        try { await cacheGrade(key,result); } catch (_) {}
        try { await incrementUsage(fresh); } catch (_) {}   // 성공한 요청만 일일 한도에 반영한다
        clearAiFailures();return result;
      }catch(error){if(error.code==='timeout'||error.status===408||error.status===429||error.status>=500)recordAiFailure(error.code||String(error.status));throw error;}
    });
  }
  async function buildSentencePool(filter) {
    filter=['dialogue','grammar','example'].includes(filter)?filter:'all';
    var examples=await loadExamples();
    var pool=examples.filter(function(row){if(!text(row.translationKo)||!sentenceAnswers(row).length||normalizeSentence(row.targetText).length<(LANG==='zh'?2:5))return false;return filter==='all'||exampleType(row)===filter;});
    pool=pool.sort(function(a,b){return fnv1a(a.id+dayKey(new Date())+'|'+filter).localeCompare(fnv1a(b.id+dayKey(new Date())+'|'+filter));});
    state.sentenceFilter=filter;state.sentencePool=pool;return pool;
  }
  function sentenceSourceLabel(row) {
    var type=exampleType(row); return type==='dialogue'?'대화 예문':type==='grammar'?'문법 예문':'단어·표현 예문';
  }
  function showSentenceQuestion() {
    state.sentenceGradeToken = Number(state.sentenceGradeToken || 0) + 1;
    var page=ensureSentencePage(), pool=state.sentencePool||[];
    if(!pool.length){qs('#cems931-sentence-prompt').textContent='사용 가능한 문장 예문이 없습니다.';qs('#cems931-sentence-context').textContent='데이터 탭에서 Dialogues 또는 Grammar_Examples가 포함된 엑셀을 가져오세요.';qs('#cems931-sentence-input').disabled=true;qs('#cems931-sentence-submit').disabled=true;return;}
    if(state.sentenceIndex>=pool.length)state.sentenceIndex=0;
    var row=pool[state.sentenceIndex];state.currentSentence=row;state.currentSentenceScored=false;
    qs('#cems931-sentence-source').textContent=sentenceSourceLabel(row);qs('#cems931-sentence-progress').textContent=(state.sentenceIndex+1)+' / '+pool.length;qs('#cems931-sentence-prompt').textContent=row.translationKo;qs('#cems931-sentence-context').textContent=LANG==='zh'?(row.pinyin?'힌트 없이 먼저 작성하세요. 병음은 채점 대상이 아닙니다.':'번체·간체의 등록 답안을 모두 확인합니다.'):'문장부호·대소문자·일반 축약형은 유연하게 처리합니다.';
    var input=qs('#cems931-sentence-input');input.value='';input.disabled=false;qs('#cems931-sentence-submit').disabled=false;qs('#cems931-sentence-submit').textContent='정답 확인';
    var status=qs('#cems931-grade-status');status.className='cems931-grade-status';status.innerHTML='';qs('#cems931-manual-actions').classList.add('hidden');setTimeout(function(){input.focus();},80);
  }
  async function openSentenceChecker(filter) {
    filter=['dialogue','grammar','example'].includes(filter)?filter:'all';var active=qs('.page.active');if(active&&active.id!=='page-sentence-check')state.sentenceReturnPage=active.id.replace(/^page-/,'')||'home';ensureSentencePage();
    var titles={all:'문장 쓰기',dialogue:'대화 문장 쓰기',grammar:'문법 문장 쓰기',example:'단어·표현 문장 쓰기'},subs={all:'전체 예문에서 한국어를 보고 중국어 문장을 작성합니다.',dialogue:'ACC 대화 발화만 골라 실제 회화 문장을 산출합니다.',grammar:'문법 예문만 골라 문형과 용법을 작성합니다.',example:'단어·표현 예문을 문장으로 확장합니다.'};
    var title=qs('#cems931-sentence-title'),sub=qs('#cems931-sentence-subtitle');if(title)title.textContent=titles[filter];if(sub)sub.textContent=subs[filter];state.sentenceIndex=0;await buildSentencePool(filter);if(typeof showPage==='function')showPage('sentence-check',true);else{qsa('.page').forEach(function(p){p.classList.remove('active');});qs('#page-sentence-check').classList.add('active');}showSentenceQuestion();
  }
  function setGradeStatus(result, learner) {
    var status=qs('#cems931-grade-status'), uncertain=result.verdict==='uncertain', good=result.verdict==='correct'||result.verdict==='acceptable'||result.verdict==='partial';
    status.className='cems931-grade-status show '+(good?'correct':uncertain?'review':'wrong');
    var label=good?((result.verdict==='acceptable'||result.verdict==='partial')?'허용 정답':'정답'):uncertain?'확인 필요':'오답';
    var source=result.cached?'저장된 AI 판독':result.source==='gemini'?'Gemini 판독':'기기 판독';
    status.innerHTML='<strong>'+esc(label)+' · '+esc(source)+'</strong><p>'+esc(result.reason||'')+'</p>'+(result.correctedAnswer?'<p>권장 문장: <code>'+esc(result.correctedAnswer)+'</code></p>':'');
    qs('#cems931-manual-actions').classList.toggle('hidden',!uncertain);
    qs('#cems931-sentence-submit').textContent=uncertain?'다시 판독':'다음 문장';
    state.lastSentenceResult=result;state.lastSentenceLearner=learner;
  }
  async function recordSentenceOutcome(correct, source) {
    if(state.currentSentenceScored)return;state.currentSentenceScored=true;
    try { if(typeof saveSession==='function')await saveSession({total:1,correct:correct?1:0,wrong:correct?0:1,accuracy:correct?100:0,mode:'sentence-check',type:'expr',duration:0,graderSource:source||'manual'}); } catch(_){}
    renderStableHome();
  }
  async function submitSentence() {
    var row=state.currentSentence,input=qs('#cems931-sentence-input'),learner=text(input&&input.value);if(!row)return;
    if(state.lastSentenceResult&&!['uncertain'].includes(state.lastSentenceResult.verdict)&&qs('#cems931-sentence-submit').textContent==='다음 문장'){state.sentenceIndex++;showSentenceQuestion();return;}
    var local=localSentenceGrade(row,learner);
    if(local.verdict!=='uncertain'){setGradeStatus(local,learner);await recordSentenceOutcome(local.verdict!=='incorrect','local');return;}
    var cfg=await aiConfig();if(!cfg.enabled||!cfg.url||!cfg.token){setGradeStatus({verdict:'uncertain',reason:local.reason+' 설정 탭에서 Worker를 연결하거나 아래에서 직접 판정하세요.',source:'local'},learner);return;}
    if(navigator.onLine===false){setGradeStatus({verdict:'uncertain',reason:local.reason+' 현재 오프라인이므로 아래에서 직접 판정하세요.',source:'local'},learner);return;}
    var gradeToken=Number(state.sentenceGradeToken||0)+1;state.sentenceGradeToken=gradeToken;state.lastSentenceLearner=learner;
    var status=qs('#cems931-grade-status');status.className='cems931-grade-status show review';status.innerHTML='<strong><span class="cems931-loader"></span>의미를 확인하는 중</strong><p>기다리지 않고 아래에서 직접 판정해도 됩니다. 최대 8초 후 자동으로 직접 판정 상태로 전환합니다.</p>';
    qs('#cems931-manual-actions').classList.remove('hidden');qs('#cems931-sentence-submit').disabled=true;qs('#cems931-sentence-submit').textContent='AI 판독 중';
    try {
      var ai=await callGeminiGrader(row,learner);
      if(gradeToken!==state.sentenceGradeToken||state.currentSentence!==row||state.currentSentenceScored)return;
      var autoGood=(ai.verdict==='correct'||ai.verdict==='acceptable'||ai.verdict==='partial')&&ai.confidence>=.82,autoBad=ai.verdict==='incorrect'&&ai.confidence>=.88;
      if(autoGood){setGradeStatus(ai,learner);await recordSentenceOutcome(true,'gemini');}
      else if(autoBad){setGradeStatus(ai,learner);await recordSentenceOutcome(false,'gemini');}
      else setGradeStatus(Object.assign({},ai,{verdict:'uncertain',reason:(ai.reason||'')+' 신뢰도가 낮아 직접 판정이 필요합니다.'}),learner);
    } catch(error){
      if(gradeToken!==state.sentenceGradeToken||state.currentSentence!==row||state.currentSentenceScored)return;
      setGradeStatus({verdict:'uncertain',source:'local',reason:aiErrorMessage(error)+' 학습은 계속할 수 있으며, 이 답을 오답으로 자동 기록하지 않습니다.'},learner);
    } finally{
      /* 9.5.1: 예전에는 !state.currentSentenceScored 일 때만 버튼을 되살렸다.
         그런데 AI 판독이 성공하면 recordSentenceOutcome 이 그 플래그를 세우므로,
         채점에 성공할 때마다 "다음 문장" 버튼이 disabled 로 남아 다음 문장으로
         넘어갈 수 없었다(모의 Worker 로 실측 확인). 로컬 판정 경로는 애초에
         버튼을 끄지 않아서 이 막다른 길은 AI 경로에서만 났다.
         더 새 요청이 시작됐거나 문장이 바뀐 경우에만 손대지 않는다. */
      if(gradeToken===state.sentenceGradeToken&&state.currentSentence===row){qs('#cems931-sentence-submit').disabled=false;}
    }
  }
  async function manualSentence(correct) {
    state.sentenceGradeToken = Number(state.sentenceGradeToken || 0) + 1;
    setGradeStatus({verdict:correct?'acceptable':'incorrect',source:'manual',reason:correct?'사용자가 문맥상 허용 정답으로 확인했습니다.':'사용자가 의미 차이를 확인해 오답으로 기록했습니다.'},state.lastSentenceLearner||text(qs('#cems931-sentence-input').value));
    await recordSentenceOutcome(correct,'manual');qs('#cems931-manual-actions').classList.add('hidden');
  }


  /* ---------- Robust Chinese pinyin syllable alignment and tone targeting ---------- */
  var PINYIN_MARKS_931 = {
    'ā':['a',1],'á':['a',2],'ǎ':['a',3],'à':['a',4],'ē':['e',1],'é':['e',2],'ě':['e',3],'è':['e',4],
    'ī':['i',1],'í':['i',2],'ǐ':['i',3],'ì':['i',4],'ō':['o',1],'ó':['o',2],'ǒ':['o',3],'ò':['o',4],
    'ū':['u',1],'ú':['u',2],'ǔ':['u',3],'ù':['u',4],'ǖ':['v',1],'ǘ':['v',2],'ǚ':['v',3],'ǜ':['v',4],
    'ü':['v',0],'ń':['n',2],'ň':['n',3],'ǹ':['n',4],'ḿ':['m',2]
  };
  var PINYIN_SYLLABLES = new Set(('a ai an ang ao ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo da dai dan dang dao de dei den deng di dia dian diao die ding diu dong dou du duan dui dun duo e ei en eng er fa fan fang fei fen feng fo fou fu ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun ka kai kan kang kao ke ken keng kong kou ku kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu long lou lu luan lun luo lv lve ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nuo nv nve o ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun ran rang rao re ren reng ri rong rou ru rua ruan rui run ruo sa sai san sang sao se sen seng sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo ta tai tan tang tao te teng ti tian tiao tie ting tong tou tu tuan tui tun tuo wa wai wan wang wei wen weng wo wu xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo hm hng m n ng').split(/\s+/));
  function romanChunkInfo(value) {
    var source=text(value).toLowerCase().normalize('NFC').replace(/u:/g,'v'), base='', toneAt=[], originalAt=[];
    for(var ch of source){
      if(/[1-5]/.test(ch)){ if(toneAt.length) toneAt[toneAt.length-1]=Number(ch); continue; }
      var mark=PINYIN_MARKS_931[ch];
      if(mark){base+=mark[0];toneAt.push(mark[1]||0);originalAt.push(ch);}
      else if(/[a-zv]/.test(ch)){base+=ch;toneAt.push(0);originalAt.push(ch);}
    }
    return {source:source,base:base,toneAt:toneAt,originalAt:originalAt};
  }
  function segmentPinyinBase(base, exactCount) {
    base=text(base).toLowerCase().replace(/ü/g,'v'); if(!base)return[];
    var memo=new Map();
    function walk(pos,left){
      var key=pos+'|'+(left==null?'*':left);if(memo.has(key))return memo.get(key);
      if(pos===base.length){var done=(left==null||left===0)?{parts:[],score:0}:null;memo.set(key,done);return done;}
      if(left===0){memo.set(key,null);return null;}
      var best=null,max=Math.min(7,base.length-pos);
      for(var len=1;len<=max;len+=1){var part=base.slice(pos,pos+len);if(!PINYIN_SYLLABLES.has(part))continue;var next=walk(pos+len,left==null?null:left-1);if(!next)continue;var score=next.score+len*len-(part.length===1?1:0);var candidate={parts:[part].concat(next.parts),score:score};if(!best||candidate.score>best.score)best=candidate;}
      memo.set(key,best);return best;
    }
    var result=walk(0,Number.isFinite(exactCount)?exactCount:null);
    if(!result&&Number.isFinite(exactCount))result=walk(0,null);
    return result?result.parts:[];
  }
  function tokensFromChunk(chunk, exactCount) {
    var info=romanChunkInfo(chunk);if(!info.base)return[];
    var parts=PINYIN_SYLLABLES.has(info.base)&&(!exactCount||exactCount===1)?[info.base]:segmentPinyinBase(info.base,exactCount);
    if(!parts.length)parts=[info.base];
    var offset=0;return parts.map(function(part){var start=offset,end=offset+part.length,tones=info.toneAt.slice(start,end).filter(function(v){return v>0;}),tone=tones[0]||0;offset=end;return{base:part,tone:tone,display:info.originalAt.slice(start,end).join('')||part};});
  }
  function finalizeToneTokens931(tokens) {
    tokens = tokens || [];
    /* A mixed marked/unmarked pinyin string normally uses the unmarked syllables
       as neutral tone (e.g. xiānsheng). If the whole field has no tone evidence,
       keep zero so incomplete source data is excluded rather than guessed. */
    var hasExplicit = tokens.some(function (token) { return token.tone >= 1 && token.tone <= 5; });
    if (!hasExplicit) return tokens;
    return tokens.map(function (token) { return Object.assign({}, token, { tone:token.tone || 5 }); });
  }
  function robustPinyinTokens(value, expectedCount) {
    var raw=text(value).toLowerCase().normalize('NFC').replace(/u:/g,'v').replace(/[’'·•]/g,' ').replace(/[\-–—/／,，;；]+/g,' ').trim();if(!raw)return[];
    var chunks=raw.match(/[a-züvāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿ]+[1-5]?/g)||[];
    if(chunks.length===1&&/[1-5].*[a-züv]/.test(raw))chunks=raw.match(/[a-züv]+[1-5]?/g)||chunks;
    if(!chunks.length)return[];
    if(Number.isFinite(expectedCount)&&expectedCount>0){
      var parsed=chunks.map(function(c){return romanChunkInfo(c);}),joined=parsed.map(function(x){return x.base;}).join('');
      if(chunks.length!==expectedCount){
        var parts=segmentPinyinBase(joined,expectedCount);if(parts.length){
          var flatTone=[],flatDisplay=[];parsed.forEach(function(info){flatTone=flatTone.concat(info.toneAt);flatDisplay=flatDisplay.concat(info.originalAt);});var offset=0;
          return finalizeToneTokens931(parts.map(function(part){var start=offset,end=offset+part.length,tones=flatTone.slice(start,end).filter(function(v){return v>0;}),tone=tones[0]||0;offset=end;return{base:part,tone:tone,display:flatDisplay.slice(start,end).join('')||part};}));
        }
      }
    }
    var out=[];chunks.forEach(function(c){out=out.concat(tokensFromChunk(c));});return finalizeToneTokens931(out);
  }
  function hanziChars(value){return Array.from(text(value)).filter(function(ch){return /[\u3400-\u9fff]/.test(ch);});}
  function toneLabel931(tone){return Number(tone)===5?'경성':Number(tone)+'성';}
  function installToneEngine() {
    if(state.toneInstalled)return;                      // 모듈 스코프 1회 가드
    if(LANG!=='zh'||typeof phase5BuildQuestion!=='function')return;
    state.toneInstalled=true;
    try{
      phase5PinyinTokens=function(value){return robustPinyinTokens(value);};window.phase5PinyinTokens=phase5PinyinTokens;
      phase5ToneSequence=function(value){var tokens=robustPinyinTokens(value);if(!tokens.length||!tokens.some(function(t){return t.tone>0;}))return[];return tokens.map(function(t){return t.tone||5;});};window.phase5ToneSequence=phase5ToneSequence;
      phase5PinyinCanonical=function(value,strict){var tokens=robustPinyinTokens(value);if(!tokens.length)return'';return tokens.map(function(t){return strict===false?t.base:t.base+(t.tone||0);}).join('|');};window.phase5PinyinCanonical=phase5PinyinCanonical;
    }catch(_){}
    var baseBuild=phase5BuildQuestion;
    phase5BuildQuestion=function(item,mode,allItems,type){
      if(mode!=='zh-tone')return baseBuild.apply(this,arguments);
      var term=text(typeof getW==='function'?getW(item):(item.Traditional_CH||item.word)),chars=hanziChars(term),tokens=robustPinyinTokens(typeof getPinyin==='function'?getPinyin(item):item.Pinyin,chars.length);
      if(!chars.length||tokens.length!==chars.length)return null;
      var valid=[];tokens.forEach(function(t,i){if(t.tone>=1&&t.tone<=5)valid.push(i);});if(!valid.length)return null;
      if(!state.toneCursor)state.toneCursor=new Map();var key=term+'|'+text(item.Pinyin),last=Number(state.toneCursor.get(key));if(!Number.isFinite(last))last=-1;var target=valid.find(function(i){return i>last;});if(target===undefined)target=valid[0];state.toneCursor.set(key,target);
      var answer=tokens[target].tone||5,promptHtml=chars.map(function(ch,i){return i===target?'<mark class="cems931-tone-target">'+esc(ch)+'</mark>':esc(ch);}).join('');
      return{kind:'options',prompt:term,promptHtml:promptHtml,sub:(typeof getMKO==='function'?getMKO(item):item.Meaning_KO)+'\n강조한 '+(target+1)+'번째 글자의 성조를 고르세요.',accepted:[String(answer)],answerText:chars[target]+' · '+tokens[target].display+' · '+toneLabel931(answer),targetIndex:target,toneTokens:tokens,options:[1,2,3,4,5].map(function(n){return{value:String(n),label:toneLabel931(n)};})};
    };window.phase5BuildQuestion=phase5BuildQuestion;
    var baseEligible=typeof phase5Eligible==='function'?phase5Eligible:null;
    if(baseEligible){phase5Eligible=function(item,mode){if(mode==='zh-tone'){var chars=hanziChars(typeof getW==='function'?getW(item):item.Traditional_CH),tokens=robustPinyinTokens(typeof getPinyin==='function'?getPinyin(item):item.Pinyin,chars.length);return chars.length>0&&tokens.length===chars.length&&tokens.some(function(t){return t.tone>=1&&t.tone<=5;});}return baseEligible.apply(this,arguments);};window.phase5Eligible=phase5Eligible;}
    if(typeof phase5RenderCurrent==='function'){
      var baseRender=phase5RenderCurrent;phase5RenderCurrent=function(){var result=baseRender.apply(this,arguments);try{var q=window.zhState&&window.zhState.question,el=qs('#zh-main-prompt');if(q&&q.promptHtml&&el)el.innerHTML=q.promptHtml;}catch(_){}return result;};window.phase5RenderCurrent=phase5RenderCurrent;
    }
  }

  /* ---------- Safer distractors and post-render question audit ---------- */
  function semanticMeaning(value){return text(value).toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu,'').replace(/(하다|되다|이다|하는것|것)$/,'');}
  function meaningConflict(a,b){var x=semanticMeaning(a),y=semanticMeaning(b);if(!x||!y)return true;if(x===y)return true;if(Math.min(x.length,y.length)>=2&&(x.indexOf(y)>=0||y.indexOf(x)>=0))return true;return false;}
  function installSafeDistractors(){
    if(state.distractorsInstalled)return;               // 모듈 스코프 1회 가드
    if(typeof getDistractors!=='function')return;
    state.distractorsInstalled=true;var original=getDistractors;
    getDistractors=function(correct,pool,n){
      n=Number(n||4);var correctMeaning=typeof getMKO==='function'?getMKO(correct):'',correctWord=typeof getW==='function'?getW(correct):'';
      var seen=new Set(),filtered=(pool||[]).filter(function(row){var word=typeof getW==='function'?getW(row):'',meaning=typeof getMKO==='function'?getMKO(row):'';var key=semanticMeaning(meaning);if(!word||word===correctWord||!meaning||meaningConflict(meaning,correctMeaning)||seen.has(key))return false;seen.add(key);return true;});
      var ranked=[];try{ranked=original(correct,filtered,Math.min(n,filtered.length))||[];}catch(_){ranked=[];}
      var out=[],outSeen=new Set();ranked.concat(filtered).forEach(function(row){var meaning=typeof getMKO==='function'?getMKO(row):'',key=semanticMeaning(meaning);if(out.length>=n||!key||outSeen.has(key)||meaningConflict(meaning,correctMeaning))return;outSeen.add(key);out.push(row);});return out;
    };window.getDistractors=getDistractors;
  }
  function optionAudit(selector,correct){
    var buttons=qsa(selector),labels=buttons.map(function(b){return semanticMeaning(b.textContent);}).filter(Boolean),uniqueLabels=new Set(labels);if(buttons.length<2||labels.length!==buttons.length||uniqueLabels.size!==labels.length)return{ok:false,reason:'duplicate_or_missing_options'};
    if(correct){var key=semanticMeaning(correct),count=labels.filter(function(v){return v===key;}).length;if(count!==1)return{ok:false,reason:'correct_option_count_'+count};}
    return{ok:true};
  }
  function wrapQuestionRenderer(name,selector,correctGetter,stateGetter){
    var base=window[name];if(typeof base!=='function')return;
    if(state.auditedRenderers[name])return;             // 모듈 스코프 1회 가드
    state.auditedRenderers[name]=true;
    var wrapped=function(){var result=base.apply(this,arguments);setTimeout(function(){try{var st=stateGetter();if(!st||st.answered)return;var audit=optionAudit(selector,correctGetter(st));if(audit.ok)return;console.warn('[CEMS 9.3.2 question skipped]',name,audit);addAudit('question-skip',{renderer:name,reason:audit.reason,index:st.idx}).catch(function(){});st.idx=Number(st.idx||0)+1;if(Number(st.__cems931Skips||0)<8){st.__cems931Skips=Number(st.__cems931Skips||0)+1;wrapped();}else callToast('⚠️ 안전한 선택지를 만들 수 없어 이 모드를 중단했습니다.');}catch(error){console.warn('[CEMS question audit]',error);}},0);return result;};
    /* v9.5: eval(name+' = wrapped') 제거 — window[name] 대입과 중복이었다. */
    window[name]=wrapped;
  }
  function installQuestionAudits(){
    wrapQuestionRenderer('showQuizQ','#quiz-options .quiz-option',function(st){return st.correctAns;},function(){try{return typeof quizState!=='undefined'?quizState:null;}catch(_){return null;}});
    wrapQuestionRenderer('showClozeQ','#cloze-options .quiz-option',function(st){return st.correctAns;},function(){try{return typeof clozeState!=='undefined'?clozeState:null;}catch(_){return null;}});
    wrapQuestionRenderer('showCollocQ','#colloc-options .quiz-option',function(st){return st.correctAns;},function(){try{return typeof collocState!=='undefined'?collocState:null;}catch(_){return null;}});
    wrapQuestionRenderer('showPVPQ','#pvp-options .quiz-option',function(st){return st.correctAns;},function(){try{return typeof pvState!=='undefined'?pvState:null;}catch(_){return null;}});
    wrapQuestionRenderer('showPVQQ','#pvq-options .quiz-option',function(st){return st.correctAns;},function(){try{return typeof pvState!=='undefined'?pvState:null;}catch(_){return null;}});
    wrapQuestionRenderer('showExprQuizQ','#expr-quiz-options .quiz-option',function(st){var row=st.words&&st.words[st.idx];return row&&typeof getMKO==='function'?getMKO(row):'';},function(){try{return typeof exprState!=='undefined'?exprState:null;}catch(_){return null;}});
    wrapQuestionRenderer('showExprClozeQ','#expr-cloze-options .quiz-option',function(st){var row=st.words&&st.words[st.idx];return row&&row.Expression;},function(){try{return typeof exprState!=='undefined'?exprState:null;}catch(_){return null;}});
  }

  /* ---------- Exact-ID integration; no document-wide MutationObserver ---------- */
  function syncVersion931() {
    /* 9.5.1: 화면 버전 문자열의 출처는 <html data-cems-version> 하나다.
       CEMS943.VERSION 은 v944 레이어의 빌드 식별자여서 앱 버전과 다르다. */
    var visibleVersion = document.documentElement.dataset.cemsVersion || '9.5.1';
    document.title = (LANG === 'zh' ? '中文學習' : 'CEMS English') + ' v' + visibleVersion;
    var meta=qs('meta[name="app-version"]');if(meta)meta.content=visibleVersion;
    qsa('.splash-sub').forEach(function(node){node.textContent='v'+visibleVersion+' · 통합 학습 허브';});
    qsa('.cems82-brand-sub').forEach(function(node){node.textContent='학습 분석 · FSRS-6 · v'+visibleVersion;});
    var versionCard=qsa('#page-settings .card').find(function(card){return /버전 정보/.test(text(qs('.card-title',card)&&qs('.card-title',card).textContent));});
    if(versionCard){var strong=qs('strong',versionCard);if(strong)strong.textContent=(LANG==='zh'?'중국어 학습':'CEMS English')+' v'+visibleVersion+' · 통합 학습 허브';}
    var build=qs('#phase8-build-status');if(build)build.textContent='v'+visibleVersion;
  }
  function polishExactMobileControls() {
    var add = qs('#page-data button[onclick*="openAddWordModal"]');
    if (add) { add.textContent = '추가'; add.setAttribute('aria-label','새 카드 추가'); add.classList.add('cems931-data-add'); }
    if (LANG === 'zh') {
      var end = qs('#page-chinese-lab .zh-actions button[onclick*="confirmEndChineseMode"]');
      if (end) { end.textContent = '종료'; end.setAttribute('aria-label','학습 종료'); end.title = '학습 종료'; end.classList.add('cems931-zh-end'); }
    }
  }
  /* v9.5: 이 함수 전체를 모듈 스코프 플래그로 1회만 실행한다.
     예전에는 개별 전역마다 함수 프로퍼티 플래그(__cems931, __cems931LazyXlsx ...)로
     가드했는데, 다른 모듈이 같은 전역을 다시 감싸면 플래그가 사라져
     [450,1600,3600]ms 재설치 타이머가 돌 때마다 또 감싸졌다. */
  function installGlobalOverrides() {
    if(state.overridesInstalled)return;
    state.overridesInstalled=true;
    polishExactMobileControls();
    try{processFile=processFile931;window.processFile=processFile931;}catch(_){window.processFile=processFile931;}
    try{if(typeof processModalExcel==='function'){processModalExcel=processModalExcel931;window.processModalExcel=processModalExcel931;}}catch(_){}
    try{if(typeof confirmModalExcel==='function'){confirmModalExcel=confirmModalExcel931;window.confirmModalExcel=confirmModalExcel931;}}catch(_){}
    try{
      if(typeof exportWithStats==='function'){
        var baseExport931=exportWithStats;
        exportWithStats=async function(){if(!await ensureXLSX931()){callToast('❌ 엑셀 내보내기 엔진을 불러오지 못했습니다. 네트워크를 확인하세요.');return;}return baseExport931.apply(this,arguments);};
        window.exportWithStats=exportWithStats;
      }
    }catch(_){}
    /* v9.5: showPage 전역 재정의 → afterPageShow 훅.
       예전에는 이 모듈을 포함해 여러 확장이 showPage 를 감쌌고, 재설치 타이머가 돌 때마다
       남의 플래그가 사라져 다시 감싸져서 showPage 1회에 history.replaceState 가 5회 돌았다.
       훅은 'stable-home' 키로 멱등 등록되므로 몇 번 불러도 1겹이다. */
    if(window.CEMSHooks){
      window.CEMSHooks.on('afterPageShow','stable-home',function(name){
        setTimeout(function(){
          if(name==='home')renderStableHome();
          else if(name==='data')renderExampleRepository();
          else if(name==='settings')loadAiSettingsUi();
          if(name!=='home'){var zh=qs('#zh-home-card');if(zh)zh.remove();}
          syncVersion931();
        },0);
      });
    }
    try{
      if(typeof updateHomeStats==='function'){var baseHome=updateHomeStats;updateHomeStats=async function(){var result=await baseHome.apply(this,arguments);if(qs('#page-home.active'))renderStableHome();return result;};window.updateHomeStats=updateHomeStats;}
    }catch(_){}
    if(window.CEMS_LEAN&&typeof window.CEMS_LEAN.refresh==='function'){var leanRefresh=window.CEMS_LEAN.refresh;window.CEMS_LEAN.refresh=async function(){var result=await leanRefresh.apply(this,arguments);await renderStableHome();return result;};}
  }
  var settingsTimer=null;
  function bindStableEvents() {
    if(document.documentElement.dataset.cems931Bound==='1')return;document.documentElement.dataset.cems931Bound='1';
    document.addEventListener('click',function(event){var button=event.target&&event.target.closest&&event.target.closest('[data-cems931-action]');if(!button)return;var action=button.dataset.cems931Action;
      if(action==='home-primary')startHomePrimary();
      else if(action==='open-sentence')openSentenceChecker();
      else if(action==='sentence-back'){state.sentenceGradeToken=Number(state.sentenceGradeToken||0)+1;if(typeof showPage==='function')showPage(state.sentenceReturnPage||'home');}
      else if(action==='sentence-submit')submitSentence();
      else if(action==='sentence-skip'){state.sentenceIndex++;showSentenceQuestion();}
      else if(action==='manual-correct')manualSentence(true);
      else if(action==='manual-wrong')manualSentence(false);
      else if(action==='test-ai')testAiConnection();
    });
    document.addEventListener('input',function(event){if(event.target&&event.target.id==='cems931-example-search')filterExampleRepository();if(event.target&&/^cems931-(proxy|ai-|weekly)/.test(event.target.id)){clearTimeout(settingsTimer);settingsTimer=setTimeout(saveAiSettingsUi,500);}});
    /* 9.5.1: Worker 주소·토큰 입력칸이 이 목록에 없어서, 토글을 먼저 켜고 주소를 나중에
       입력하면 두 값이 저장되지 않았다. 그러면 aiConfig().url/token 이 비어 AI 채점이
       조용히 로컬 판정으로만 떨어진다("설정 탭에서 Worker를 연결하거나..."). 저장 경로가
       "연결 확인" 버튼 하나뿐이었던 셈이다. */
    document.addEventListener('change',function(event){if(event.target&&event.target.id==='cems931-example-filter')filterExampleRepository();if(event.target&&['cems931-ai-enabled','cems931-proxy-url','cems931-proxy-token','cems931-ai-daily-cap','cems931-weekly-goal'].includes(event.target.id))saveAiSettingsUi();});
    document.addEventListener('keydown',function(event){if(event.target&&event.target.id==='cems931-sentence-input'&&(event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();submitSentence();}});
  }
  async function initStable() {
    if(state.initialized)return;state.initialized=true;
    try{
      bindStableEvents();ensureSentencePage();ensureAiSettingsCard();syncVersion931();
      await Promise.all([ensureMainDB(),openAuxDB()]);
      await importSeedIfNeeded();
      await quarantineLegacyDialogues();installExpressionFilter();
      installGlobalOverrides();installSafeDistractors();installToneEngine();installQuestionAudits();
      /* v9.5: [450,1600,3600]ms 재설치 루프 제거.
         "늦게 뜨는 레거시 계층이 내 래퍼를 덮어쓴다"는 이유였지만, 실제로는 이 반복 자체가
         다른 모듈의 플래그를 지우며 서로를 계속 다시 감싸게 만든 원인이었다.
         이제 각 installer 가 모듈 스코프 플래그로 1회만 설치하고,
         페이지 후처리는 afterPageShow 훅이 담당하므로 반복이 필요 없다. */
      if(window.CEMS_LEAN&&typeof window.CEMS_LEAN.init==='function'){try{await window.CEMS_LEAN.init();}catch(error){console.warn('[CEMS 9.3.2 lean init]',error);}}
      if(window.CEMS_UX27&&typeof window.CEMS_UX27.polishAll==='function'){try{window.CEMS_UX27.polishAll();}catch(_) {}}
      var details=qs('#cems-ux25-home-tools');if(details){details.open=false;details.dataset.cems931Touched='1';var summary=qs(':scope > summary strong',details);if(summary)summary.textContent='추가 학습·카드 관리';var desc=qs(':scope > summary span',details);if(desc)desc.textContent='세부 모드·검색·개별 카드 관리가 필요할 때만 펼칩니다.';}
      var zhHome=qs('#zh-home-card');if(zhHome)zhHome.remove();
      await Promise.all([refreshViews(),loadAiSettingsUi()]);syncVersion931();
      setTimeout(function(){var injected=qs('#zh-home-card');if(injected)injected.remove();var d=qs('#cems-ux25-home-tools');if(d&&!d.dataset.cems931UserOpened)d.open=false;syncVersion931();},1200);
    }catch(error){console.error('[CEMS 9.3.2 init]',error);callToast('⚠️ 안정화 초기화 중 일부 기능을 불러오지 못했습니다.');}
    finally{window.CEMS932DataReadyState='ready';try{dataReadyResolve({version:VERSION,language:LANG});}catch(_){}}
  }

  window.CEMS931={
    VERSION:VERSION,BUILD:BUILD,LANG:LANG,DATA_SCHEMA:DATA_SCHEMA,SEED_FINGERPRINT:SEED_FINGERPRINT,
    refresh:refreshViews,openSentenceChecker:openSentenceChecker,loadExamples:loadExamples,parseExcelFile:parseExcelFile,
    metaGet:metaGet,metaSet:metaSet,reindexData:reindexIntegratedData,
    __test:{
      parseWorkbookSheets:parseWorkbookSheets,normalizeSentence:normalizeSentence,localSentenceGrade:localSentenceGrade,
      robustPinyinTokens:robustPinyinTokens,segmentPinyinBase:segmentPinyinBase,semanticMeaning:semanticMeaning,optionAudit:optionAudit,
      collectHomeModel:collectHomeModel,loadExamples:loadExamples,state:state
    }
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){setTimeout(initStable,180);});else setTimeout(initStable,180);
})();
