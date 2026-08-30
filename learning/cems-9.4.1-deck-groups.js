/* CEMS v9.3.2-r4 — fixed study groups inside the legacy learning shell.
 *
 * Design rules for this build:
 * - no shared deck panel above every tab;
 * - the original home/study/flashcard layouts remain the primary UI;
 * - study groups are opt-in through one compact range button and one modal;
 * - the original flashcard renderer is always used, so previous/next,
 *   bookmark, edit, production and tag controls remain available;
 * - grammar is a first-class logical content type while reusing the proven
 *   expression storage and study pages underneath.
 */
(function () {
  'use strict';

  var VERSION = '9.4.4';
  var BUILD = '9.4.4-final2';
  var LANG = (window.CEMS_LANG === 'zh' ||
    (window.CEMS9 && window.CEMS9.LANG === 'zh') ||
    (typeof DB_NAME !== 'undefined' && /Chinese/i.test(String(DB_NAME)))) ? 'zh' : 'en';
  var STORAGE_KEY = 'cems932.deckStore.' + LANG;
  var MODAL_ID = 'cems932-manager-overlay';
  var STRICT_PRESETS = new Set(['weak', 'due', 'new', 'starred']);

  var state = {
    store: null,
    installed: false,
    sessionDeck: null,
    sessionKind: '',
    catalog: null,
    bases: {},
    /* v9.5: 재설치 타이머가 사라졌고, 남은 전역 가로채기는 이 모듈 스코프 플래그로만
       1회 설치한다(함수 프로퍼티 플래그 금지). */
    overridesInstalled: false,
    /* activateKind 가 유도한 switchGlobalType 호출인지 표시한다.
       (afterTypeSwitch 훅이 uiKind 를 되돌려 놓는 것을 막는다) */
    kindRelay: false,
    uiKind: 'vocab',
    managerKind: 'vocab',
    dockObserver: null,
    renderToken: 0,
    dockToken: 0,
    launchPromise: null
  };

  function text(value) { return String(value == null ? '' : value).trim(); }
  function esc(value) {
    return text(value).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c];
    });
  }
  function unique(values) {
    var out = [], seen = new Set();
    (values || []).forEach(function (value) {
      var v = text(value);
      if (!v || seen.has(v)) return;
      seen.add(v); out.push(v);
    });
    return out;
  }
  function shuffle(input) {
    var a = (input || []).slice();
    for (var i = a.length - 1; i > 0; i--) {
      var r = new Uint32Array(1);
      try { crypto.getRandomValues(r); } catch (_) { r[0] = Math.floor(Math.random() * 4294967295); }
      var j = r[0] % (i + 1), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function uid() { return 'deck-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function nowIso() { return new Date().toISOString(); }
  function toast(message) {
    try { if (typeof showToast === 'function') showToast(message); else console.log(message); } catch (_) {}
  }
  function tags(row) {
    var value = row && row.tags;
    if (Array.isArray(value)) return value.map(text);
    return text(value).split(/[,;|，；]/).map(text).filter(Boolean);
  }
  function underlying(kind) { return kind === 'grammar' ? 'expr' : kind; }
  function kindLabel(kind) {
    return ({ vocab: LANG === 'zh' ? '단어' : '어휘', phrasal:'구동사', expr:'표현', grammar:'문법' })[kind] || kind;
  }
  function presetLabel(preset) {
    return ({ random:'랜덤', exam:'시험', conversation:'회화', level:'점수대·레벨', textbook:'교재·과', weak:'취약', due:'오늘 복습', new:'새 항목', starred:'북마크' })[preset] || preset;
  }
  function masteryLabel(value) {
    return ({ unseen:'미학습', low:'0–39 취약', mid:'40–69 학습 중', high:'70–89 안정', mastered:'90–100 숙달' })[value] || value;
  }
  function schema() { return window.CEMS941Schema || null; }
  function isGrammar(row) {
    if (!row) return false;
    var s = schema();
    if (s) return s.isGrammarRow(row);
    var blob = [row.contentKind, row.Grammar_Point, row.L1, tags(row).join('|')].join('|').toLowerCase();
    return row.contentKind === 'grammar' || !!row.Grammar_Point || text(row.L1) === '문법' || /(^|\|)(문법|grammar|tbcl문법)(\||$)/i.test(blob);
  }
  /* v9.4.1: grammarExamples 계열은 시드에만 있고 어디서도 읽히지 않았다.
     문법 행은 스키마 접근자를 통해 예문 목록을 그대로 사용한다. */
  function grammarLines(row) {
    var s = schema();
    return (s && isGrammar(row)) ? s.grammarExampleList(row) : [];
  }
  function keyOf(row, kind) {
    if (!row) return '';
    if (kind === 'vocab') return text(row.Traditional_CH || row.Headword_CHT || row.Word || row.word);
    if (kind === 'phrasal') return text(row.Phrasal_Verb);
    return text(row.Expression || row.Grammar_Point || row.Title_CHT);
  }
  function exampleText(row) {
    var direct = text(row && (row.Example_CHT || row.Short_Example_CHT || row.Example1 || row.Example || row.Subjective_Answer_CHT || row.Example_Sentence));
    if (direct) return direct;
    var lines = grammarLines(row);
    return lines.length ? text(lines[0].cht) : '';
  }
  function exampleTranslation(row) {
    var direct = text(row && (row.Example_KO || row.Short_Example_KO || row.Example1_KO || row.Example_Gloss_KO || row.Translation_KO || row.Subjective_Prompt_KO));
    if (direct) return direct;
    var lines = grammarLines(row);
    return lines.length ? text(lines[0].ko) : '';
  }
  function examplePinyin(row) {
    var direct = text(row && (row.Example_Pinyin || row.Short_Example_Pinyin || row.Example1_Pinyin || row.Pinyin_Example || row.Sentence_Pinyin));
    if (direct) return direct;
    var lines = grammarLines(row);
    return lines.length ? text(lines[0].pinyin) : '';
  }
  function hasExample(row) { return !!exampleText(row); }
  function meaningOf(row) {
    if (!row) return '';
    try { if (typeof getMKO === 'function') return text(getMKO(row)); } catch (_) {}
    return text(row.Meaning_KO || row.Meaning1_KO || row.MeaningKO || row.meaning || row.definition || row.gloss || row.Function);
  }
  function pinyinOf(row) {
    if (!row) return '';
    try { if (typeof getPinyin === 'function') return text(getPinyin(row)); } catch (_) {}
    return text(row.Pinyin || row.pinyin || row.Romanization || row.romanization);
  }
  function clozeEligible(row, kind) {
    var key = keyOf(row, kind);
    if (!key) return false;
    var candidates = [exampleText(row)].concat(Array.isArray(row && row.userExamples) ? row.userExamples : []);
    return candidates.some(function (value) { return text(value).indexOf(key) >= 0; });
  }
  function collocationEligible(row) {
    if (!row) return false;
    var value = row.Collocation_CHT || row.Key_Collocation || row.Collocation || row.collocations || '';
    return Array.isArray(value) ? value.some(function (item) { return !!text(item); }) : !!text(value);
  }

  function defaultStore() {
    return {
      version: 2,
      build: BUILD,
      activeId: '',
      activeByKind: {},
      scopeByKind: { vocab:'filter', phrasal:'filter', expr:'filter', grammar:'filter' },
      uiKind: 'vocab',
      decks: [],
      updatedAt: nowIso()
    };
  }
  function loadStore() {
    if (state.store) return state.store;
    var raw = {};
    try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (_) { raw = {}; }
    state.store = Object.assign(defaultStore(), raw || {});
    if (!Array.isArray(state.store.decks)) state.store.decks = [];
    if (!state.store.activeByKind || typeof state.store.activeByKind !== 'object') state.store.activeByKind = {};
    if (!state.store.scopeByKind || typeof state.store.scopeByKind !== 'object') state.store.scopeByKind = {};
    ['vocab','phrasal','expr','grammar'].forEach(function (kind) {
      if (state.store.scopeByKind[kind] !== 'deck') state.store.scopeByKind[kind] = 'filter';
    });
    if (!['vocab','phrasal','expr','grammar'].includes(state.store.uiKind)) state.store.uiKind = 'vocab';
    state.uiKind = state.store.uiKind;
    return state.store;
  }
  function saveStore() {
    var store = loadStore();
    store.version = 2;
    store.build = BUILD;
    store.uiKind = state.uiKind;
    store.updatedAt = nowIso();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }
    catch (_) { toast('⚠️ 카드덱 저장 공간이 부족합니다.'); }
  }
  function getDeck(id) { return loadStore().decks.find(function (deck) { return deck.id === id; }) || null; }
  function activeDeck(kind) {
    var store = loadStore();
    var id = kind ? store.activeByKind[kind] : store.activeId;
    var deck = getDeck(id);
    if (deck && (!kind || deck.kind === kind)) return deck;
    if (kind) {
      deck = store.decks.slice().reverse().find(function (item) { return item.kind === kind; }) || null;
      if (deck) store.activeByKind[kind] = deck.id;
    }
    return deck;
  }
  function scopeFor(kind) { return loadStore().scopeByKind[kind] === 'deck' ? 'deck' : 'filter'; }
  function setScope(kind, scope, silent) {
    kind = kind || state.uiKind;
    loadStore().scopeByKind[kind] = scope === 'deck' ? 'deck' : 'filter';
    saveStore();
    renderAll();
    if (!silent) toast(scope === 'deck' ? '🗂 카드덱으로 전환했습니다.' : '🎯 현재 필터로 전환했습니다.');
  }
  function setActive(id, options) {
    options = options || {};
    var deck = getDeck(id);
    if (!deck) return null;
    var store = loadStore();
    store.activeId = id;
    store.activeByKind[deck.kind] = id;
    if (options.activateScope !== false) store.scopeByKind[deck.kind] = 'deck';
    saveStore();
    if (options.switchKind !== false) activateKind(deck.kind, true);
    renderAll();
    return deck;
  }

  function masteryMatches(row, band) {
    if (!band) return true;
    var reviews = Number(row && (row.reviewCount || row.reps) || 0);
    var mastery = Number(row && row.mastery || 0);
    if (band === 'unseen') return reviews === 0;
    if (!reviews) return false;
    if (band === 'low') return mastery < 40;
    if (band === 'mid') return mastery >= 40 && mastery < 70;
    if (band === 'high') return mastery >= 70 && mastery < 90;
    if (band === 'mastered') return mastery >= 90;
    return true;
  }
  function cleanLevel(value) {
    return text(value).replace(/^(HSK|TOCFL|CEFR|TBCL|TOEFL)[:\s_-]*/i, '').replace(/^第(\d+)級$/, '$1');
  }
  function levelLabel(value) {
    value = text(value);
    var match = value.match(/^([A-Z]+)(?:_RANGE)?:([^:]+)$/i);
    if (!match) return value;
    var prefix = match[1].toUpperCase(), val = match[2].replace('-', '–');
    if (/_RANGE:/.test(value)) return prefix + ' ' + val + ' 범위';
    if (prefix === 'TBCL') return 'TBCL ' + val + '급';
    return prefix + ' ' + val;
  }
  function valuesFrom(row) {
    var values = [];
    if (!row) return values;
    function add(prefix, value) { value = cleanLevel(value); if (value) values.push(prefix + ':' + value.toUpperCase()); }
    add('HSK', row.HSK || row.HSK_Level);
    add('TOCFL', row.TOCFL || row.TOCFL_Level);
    add('CEFR', row.CEFR);
    add('TBCL', row.TBCL_Level || row.TBCL_Grammar_Level || row.TBCL || row.TBCL_Band);
    add('TOEFL', row.TOEFL_Rel || row.TOEFL);
    add('TOEIC', row.TOEIC_Rel || row.TOEIC_Score || row.TOEIC);
    add('IELTS', row.IELTS_Band || row.IELTS);
    if (row.Level || row.level) values.push('LEVEL:' + text(row.Level || row.level).toUpperCase());
    tags(row).forEach(function (tag) {
      var t = text(tag), match;
      match = t.match(/^HSK[\s:_-]?(\d+(?:-\d+)?)$/i); if (match) return add('HSK', match[1]);
      match = t.match(/^TOCFL[\s:_-]?([NL]\d)$/i); if (match) return add('TOCFL', match[1]);
      match = t.match(/^CEFR[\s:_-]?([ABC][12])$/i); if (match) return add('CEFR', match[1]);
      match = t.match(/^TBCL[-_:]?(?:第)?(\d+)(?:級)?$/i); if (match) return add('TBCL', match[1]);
      if (/^[ABC][12]$/i.test(t)) return add('CEFR', t);
      if (/^[NL][1-5]$/i.test(t)) return add('TOCFL', t);
    });
    return unique(values);
  }
  function levelRank(prefix, value) {
    value = cleanLevel(value).toUpperCase();
    if (prefix === 'HSK' || prefix === 'TBCL') return Number((value.match(/\d+/) || [])[0]);
    if (prefix === 'CEFR') return ['A1','A2','B1','B2','C1','C2'].indexOf(value) + 1;
    if (prefix === 'TOCFL') return ['N1','N2','L1','L2','L3','L4','L5'].indexOf(value) + 1;
    return NaN;
  }
  function levelMatches(row, selected) {
    selected = text(selected);
    if (!selected) return true;
    var rowValues = valuesFrom(row);
    if (rowValues.indexOf(selected) >= 0) return true;
    var match = selected.match(/^([A-Z]+)_RANGE:([^-]+)-(.+)$/i);
    if (!match) return rowValues.some(function (value) { return value === selected || value.endsWith(':' + selected); });
    var prefix = match[1].toUpperCase(), low = levelRank(prefix, match[2]), high = levelRank(prefix, match[3]);
    if (!Number.isFinite(low) || !Number.isFinite(high)) return false;
    return rowValues.some(function (value) {
      var parts = value.match(/^([A-Z]+):(.+)$/i);
      if (!parts || parts[1].toUpperCase() !== prefix) return false;
      var range = parts[2].split('-'), a = levelRank(prefix, range[0]), b = levelRank(prefix, range[1] || range[0]);
      return Number.isFinite(a) && Number.isFinite(b) && Math.max(a, low) <= Math.min(b, high);
    });
  }
  function levelOptions(levels) {
    var out = levels.slice();
    function has(prefix) { return levels.some(function (value) { return value.indexOf(prefix + ':') === 0; }); }
    if (has('HSK')) out.push('HSK_RANGE:1-2','HSK_RANGE:3-4','HSK_RANGE:5-6','HSK_RANGE:7-9');
    if (has('TOCFL')) out.push('TOCFL_RANGE:N1-N2','TOCFL_RANGE:L1-L2','TOCFL_RANGE:L3-L4');
    if (has('CEFR')) out.push('CEFR_RANGE:A1-A2','CEFR_RANGE:B1-B2','CEFR_RANGE:C1-C2');
    if (has('TBCL')) out.push('TBCL_RANGE:1-2','TBCL_RANGE:3-4','TBCL_RANGE:5-7');
    return unique(out);
  }
  function sourceValues(row) {
    var out = [], volumes = [], lessons = [];
    if (!row) return out;
    var directVolume = text(row.sourceVolume || row.Volume), directLesson = text(row.sourceLesson || row.Lesson || row.Lessons);
    if (directVolume) volumes.push(directVolume);
    (row.sourceVolumes || []).forEach(function (value) { volumes.push(text(value)); });
    if (directLesson) directLesson.split(/[,;|]/).forEach(function (value) { lessons.push(text(value)); });
    (row.sourceLessons || []).forEach(function (value) { lessons.push(text(value)); });
    volumes = unique(volumes); lessons = unique(lessons);
    volumes.forEach(function (volume) { out.push('ACC' + volume); });
    lessons.forEach(function (lesson) { out.push('L' + String(lesson).padStart(2, '0')); });
    if (directVolume && lessons.length === 1) out.push('ACC' + directVolume + '-L' + String(lessons[0]).padStart(2, '0'));
    tags(row).forEach(function (tag) {
      if (/^ACC\d(?:-L\d+)?$/i.test(tag)) out.push(tag.toUpperCase().replace(/-L(\d)$/, '-L0$1'));
    });
    (row.sourceOccurrences || []).forEach(function (value) {
      var match = text(value).match(/ACC(\d+)[-_]L(\d+)/i);
      if (match) out.push('ACC' + match[1] + '-L' + String(match[2]).padStart(2, '0'));
    });
    return unique(out);
  }
  function isDue(row) {
    var date = row && row.nextReview ? new Date(row.nextReview) : null;
    return !!(date && Number.isFinite(date.getTime()) && date <= new Date());
  }
  function accuracy(row) {
    var reviews = Number(row && row.reviewCount || 0), correct = Number(row && row.correctCount || 0);
    return reviews ? Math.round(correct / reviews * 100) : null;
  }
  function weak(row) {
    try { if (typeof isWeak === 'function') return !!isWeak(row); } catch (_) {}
    var acc = accuracy(row);
    return Number(row && row.wrongCount || 0) > 0 || (Number(row && row.reviewCount || 0) >= 2 && acc !== null && acc < 70);
  }
  function needScore(row) {
    var score = 0;
    if (isDue(row)) score += 100;
    if (weak(row)) score += 50;
    score += Number(row && row.wrongCount || 0) * 6;
    score += Math.max(0, 80 - Number(row && row.mastery || 0));
    if (!Number(row && (row.reviewCount || row.reps) || 0)) score += 15;
    return score;
  }

  async function waitForData() {
    try {
      if (window.CEMS932DataReady && window.CEMS932DataReadyState !== 'ready') {
        await Promise.race([window.CEMS932DataReady, new Promise(function (resolve) { setTimeout(resolve, 20000); })]);
      }
    } catch (_) {}
  }
  async function allFor(kind) {
    try {
      await waitForData();
      if (kind === 'vocab') return (await getAllWords()) || [];
      if (kind === 'phrasal' && typeof getAllPV === 'function') return (await getAllPV()) || [];
      var expressions = (await getAllExpr()) || [];
      return kind === 'grammar' ? expressions.filter(isGrammar) : expressions.filter(function (row) { return !isGrammar(row); });
    } catch (error) {
      console.error('[CEMS932 allFor]', kind, error);
      return [];
    }
  }
  async function fullStoreFor(kind) {
    await waitForData();
    if (kind === 'vocab') return (await getAllWords()) || [];
    if (kind === 'phrasal' && typeof getAllPV === 'function') return (await getAllPV()) || [];
    return (await getAllExpr()) || [];
  }

  function matchesConfig(row, kind, config) {
    if (kind === 'grammar' && !isGrammar(row)) return false;
    if (kind === 'expr' && isGrammar(row)) return false;
    if (config.level && !levelMatches(row, config.level)) return false;
    if (config.source) {
      var sources = sourceValues(row);
      if (!sources.some(function (value) { return value === config.source || value.indexOf(config.source + '-') === 0; })) return false;
    }
    if (config.frequency && config.frequency !== 'all' && text(row.Frequency || row.Frequency_Band) !== config.frequency) return false;
    if (config.masteryBand && !masteryMatches(row, config.masteryBand)) return false;

    var preset = config.preset || 'random';
    var blob = [row.Medium, row.Register || row.Formality, row.Register_Class, row.Usage_Profile, tags(row).join('|'), row.Function, row.Function_KO].join('|').toLowerCase();
    if (preset === 'conversation') {
      var sourceBlob = sourceValues(row).join('|').toLowerCase();
      return (/spoken|구어|회화|생활|conversation|dialog/.test(blob) || (/acc\d/.test(sourceBlob) && hasExample(row))) && (hasExample(row) || kind === 'vocab');
    }
    if (preset === 'exam') return valuesFrom(row).length > 0 || /P[12]/.test(text(row.Priority || row.Study_Priority)) || /exam|시험|hsk|tocfl|toefl|ielts/.test(blob);
    if (preset === 'weak') return weak(row);
    if (preset === 'due') return isDue(row);
    if (preset === 'new') return !Number(row.reviewCount || row.reps || 0);
    if (preset === 'starred') return !!row.starred;
    return true;
  }
  function purposeScore(row, kind, config) {
    var preset = config.preset || 'random', score = Math.random() * 8;
    if (preset === 'exam') {
      score += text(row.Priority || row.Study_Priority) === 'P1' ? 40 : text(row.Priority || row.Study_Priority) === 'P2' ? 20 : 0;
      score += /K1|A 핵심/.test(text(row.Frequency || row.Frequency_Band)) ? 24 : /K2|B 매우/.test(text(row.Frequency || row.Frequency_Band)) ? 16 : 8;
      score += valuesFrom(row).length * 3;
    }
    if (preset === 'conversation') {
      var blob = [row.Medium, row.Register, row.Register_Class, row.Usage_Profile, tags(row).join('|')].join('|');
      if (/Spoken|구어|회화/i.test(blob)) score += 50;
      if (hasExample(row)) score += 25;
    }
    if (preset === 'weak' || preset === 'due') score += needScore(row);
    if (preset === 'new') score += !Number(row.reviewCount || 0) ? 40 : 0;
    return score;
  }
  async function candidatePool(kind, config, sourceRows) {
    var all = Array.isArray(sourceRows) ? sourceRows : await allFor(kind);
    var scopeConfig = Object.assign({}, config, { preset:'random' });
    var scope = all.filter(function (row) { return matchesConfig(row, kind, scopeConfig); });
    var exact = scope.filter(function (row) { return matchesConfig(row, kind, config); });
    var target = Math.min(Number(config.size || 50), scope.length);
    if (!scope.length) return { all:all, scope:scope, pool:[], exactCount:0, relaxed:false };
    if (STRICT_PRESETS.has(config.preset)) return { all:all, scope:scope, pool:exact, exactCount:exact.length, relaxed:false };
    if (exact.length >= target) return { all:all, scope:scope, pool:exact, exactCount:exact.length, relaxed:false };
    var exactKeys = new Set(exact.map(function (row) { return keyOf(row, kind); }));
    var supplement = scope.filter(function (row) { return !exactKeys.has(keyOf(row, kind)); });
    return { all:all, scope:scope, pool:exact.concat(supplement), exactCount:exact.length, relaxed:true };
  }
  function nextName(config) {
    var core = presetLabel(config.preset) + ' · ' + kindLabel(config.kind) +
      (config.level ? ' ' + levelLabel(config.level) : '') +
      (config.masteryBand ? ' ' + masteryLabel(config.masteryBand) : '') +
      (config.source ? ' ' + config.source : '') + ' ' + config.size;
    var names = new Set(loadStore().decks.map(function (deck) { return deck.name; }));
    if (!names.has(core)) return core;
    var index = 2;
    while (names.has(core + ' #' + index)) index++;
    return core + ' #' + index;
  }
  async function createDeck(config) {
    config = Object.assign({ kind:state.managerKind || state.uiKind || 'vocab', preset:'random', size:50, sessionSize:50, level:'', source:'', frequency:'all', masteryBand:'' }, config || {});
    config.size = Math.max(5, Math.min(200, Number(config.size || 50)));
    config.sessionSize = Math.max(5, Math.min(config.size, Number(config.sessionSize || config.size)));
    var result = await candidatePool(config.kind, config);
    if (!result.pool.length) { toast('⚠️ 조건에 맞는 항목이 없습니다.'); return null; }

    var avoid = new Set();
    loadStore().decks.filter(function (deck) { return deck.kind === config.kind; }).slice(-5).forEach(function (deck) {
      (deck.memberKeys || []).forEach(function (key) { avoid.add(key); });
    });
    var ranked = shuffle(result.pool).sort(function (a, b) { return purposeScore(b, config.kind, config) - purposeScore(a, config.kind, config); });
    var fresh = ranked.filter(function (row) { return !avoid.has(keyOf(row, config.kind)); });
    var reused = ranked.filter(function (row) { return avoid.has(keyOf(row, config.kind)); });
    var members = unique(fresh.concat(reused).map(function (row) { return keyOf(row, config.kind); })).slice(0, config.size);

    var deck = {
      id: uid(),
      name: config.name || nextName(config),
      kind: config.kind,
      preset: config.preset,
      size: members.length,
      requestedSize: config.size,
      sessionSize: Math.min(config.sessionSize, members.length),
      level: config.level || '',
      source: config.source || '',
      frequency: config.frequency || 'all',
      masteryBand: config.masteryBand || '',
      matchedCount: Number(result.exactCount || 0),
      memberKeys: members,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      generation: 1,
      recentFirstKeys: [],
      lastUsedAt: null,
      relaxed: result.relaxed
    };
    var store = loadStore();
    store.decks.push(deck);
    store.activeId = deck.id;
    store.activeByKind[deck.kind] = deck.id;
    store.scopeByKind[deck.kind] = 'deck';
    saveStore();
    activateKind(deck.kind, true);
    await renderAll();
    toast('✅ ' + deck.name + ' 카드덱을 만들었습니다.');
    return deck;
  }
  async function resolveDeck(deck) {
    if (!deck) return { deck:null, all:[], items:[] };
    var all = await allFor(deck.kind), map = new Map(all.map(function (row) { return [keyOf(row, deck.kind), row]; }));
    var items = (deck.memberKeys || []).map(function (key) { return map.get(key); }).filter(Boolean);
    var result = await candidatePool(deck.kind, deck, all);
    var desired = Math.min(deck.requestedSize || deck.size, result.pool.length);
    if (items.length < desired) {
      var missing = desired - items.length, used = new Set(items.map(function (row) { return keyOf(row, deck.kind); }));
      var add = shuffle(result.pool).filter(function (row) { return !used.has(keyOf(row, deck.kind)); }).slice(0, missing);
      items = items.concat(add);
      deck.memberKeys = items.map(function (row) { return keyOf(row, deck.kind); });
      deck.size = items.length;
      deck.matchedCount = Number(result.exactCount || 0);
      deck.updatedAt = nowIso();
      saveStore();
    }
    return { deck:deck, all:all, items:items };
  }
  async function rotateDeck(id, ratio) {
    var deck = getDeck(id); if (!deck) return;
    var resolved = await resolveDeck(deck);
    var count = Math.max(1, Math.ceil(resolved.items.length * (ratio || 0.25)));
    var sorted = resolved.items.slice().sort(function (a, b) { return needScore(a) - needScore(b); });
    var removeKeys = new Set(sorted.slice(0, count).map(function (row) { return keyOf(row, deck.kind); }));
    var keep = resolved.items.filter(function (row) { return !removeKeys.has(keyOf(row, deck.kind)); });
    var used = new Set(keep.map(function (row) { return keyOf(row, deck.kind); }));
    var result = await candidatePool(deck.kind, deck), old = new Set(deck.memberKeys || []);
    var fresh = shuffle(result.pool).filter(function (row) { var key = keyOf(row, deck.kind); return !used.has(key) && !old.has(key); });
    var fallback = shuffle(result.pool).filter(function (row) { return !used.has(keyOf(row, deck.kind)); });
    var add = unique(fresh.concat(fallback).map(function (row) { return keyOf(row, deck.kind); })).slice(0, count);
    deck.memberKeys = keep.map(function (row) { return keyOf(row, deck.kind); }).concat(add);
    deck.size = deck.memberKeys.length;
    deck.updatedAt = nowIso();
    deck.generation = Number(deck.generation || 1) + 1;
    saveStore();
    await renderAll();
    toast('🔄 ' + add.length + '개를 새 항목으로 교체했습니다.');
  }
  async function rebuildDeck(id) {
    var deck = getDeck(id); if (!deck) return;
    var result = await candidatePool(deck.kind, deck), oldKeys = new Set(deck.memberKeys || []);
    var fresh = shuffle(result.pool).filter(function (row) { return !oldKeys.has(keyOf(row, deck.kind)); });
    var fallback = shuffle(result.pool);
    var members = unique(fresh.concat(fallback).map(function (row) { return keyOf(row, deck.kind); })).slice(0, deck.requestedSize || deck.size || 50);
    deck.memberKeys = members;
    deck.size = members.length;
    deck.sessionSize = Math.min(deck.sessionSize || members.length, members.length);
    deck.updatedAt = nowIso();
    deck.generation = Number(deck.generation || 1) + 1;
    deck.recentFirstKeys = [];
    saveStore();
    await renderAll();
    toast('🎲 카드덱 전체를 새로 구성했습니다.');
  }
  function deleteDeck(id) {
    var store = loadStore(), deck = getDeck(id);
    store.decks = store.decks.filter(function (item) { return item.id !== id; });
    if (store.activeId === id) store.activeId = store.decks.length ? store.decks[store.decks.length - 1].id : '';
    if (deck && store.activeByKind[deck.kind] === id) {
      var previous = store.decks.slice().reverse().find(function (item) { return item.kind === deck.kind; });
      store.activeByKind[deck.kind] = previous ? previous.id : '';
      if (!previous) store.scopeByKind[deck.kind] = 'filter';
    }
    saveStore();
    renderAll();
  }

  function activeMode(kind, passed) {
    if (passed) return passed;
    var root = kind === 'vocab' ? '#study-vocab' : kind === 'phrasal' ? '#study-phrasal' : '#study-expr';
    var active = document.querySelector(root + ' .mode-card.active');
    return active && active.dataset.mode || (kind === 'vocab' ? 'flashcard' : kind === 'phrasal' ? 'pv-flashcard' : 'expr-fc');
  }
  function poolSignature(keys) {
    var sorted = (keys || []).slice().sort();
    var hash = 2166136261;
    for (var i = 0; i < sorted.length; i++) {
      var value = sorted[i] + '\u001f';
      for (var j = 0; j < value.length; j++) {
        hash ^= value.charCodeAt(j);
        hash = Math.imul(hash, 16777619);
      }
    }
    return (hash >>> 0).toString(36) + ':' + sorted.length;
  }
  function uniqueRowsByKey(items, kind) {
    var map = new Map();
    (items || []).forEach(function (row) {
      var key = keyOf(row, kind);
      if (key && !map.has(key)) map.set(key, row);
    });
    return map;
  }
  function randomRotation(items, count, kind, record) {
    var map = uniqueRowsByKey(items, kind), keys = Array.from(map.keys());
    var signature = poolSignature(keys), valid = new Set(keys);
    record = record && typeof record === 'object' ? record : {};
    var queue = Array.isArray(record.queue) ? unique(record.queue).filter(function (key) { return valid.has(key); }) : [];
    var queued = new Set(queue);
    var missing = keys.filter(function (key) { return !queued.has(key); });
    if (record.signature !== signature) {
      queue = shuffle(keys);
      record.cycle = 1;
    } else if (missing.length) {
      queue = queue.concat(shuffle(missing));
    }
    var limit = Math.min(Math.max(0, Number(count) || 0), keys.length);
    var selected = [], selectedSet = new Set(), guard = 0;
    while (selected.length < limit && guard++ < Math.max(20, keys.length * 4)) {
      if (!queue.length) {
        var previous = new Set(record.lastSession || []);
        var nextCycle = shuffle(keys);
        if (keys.length > previous.size) {
          nextCycle = nextCycle.filter(function (key) { return !previous.has(key); })
            .concat(nextCycle.filter(function (key) { return previous.has(key); }));
        }
        queue = nextCycle;
        record.cycle = Number(record.cycle || 1) + 1;
      }
      var key = queue.shift();
      if (!valid.has(key) || selectedSet.has(key)) continue;
      selected.push(key); selectedSet.add(key);
    }
    record.signature = signature;
    record.queue = queue;
    record.lastSession = selected.slice();
    record.updatedAt = nowIso();
    return { rows:selected.map(function (key) { return map.get(key); }).filter(Boolean), record:record };
  }
  function orderedSession(items, deck) {
    var count = Math.min(items.length, Number(deck.sessionSize || deck.size || 50));
    var order = (document.getElementById('option-order') || {}).value || 'fsrs', output = [];
    /* A deck created with the Random preset must rotate even when the global
       order selector is still on FSRS. This matches the user's visible choice
       and prevents the same top cards from being returned every session. */
    if (deck && (deck.preset === 'random' || deck.randomizeEachSession === true)) order = 'random';
    if (order === 'random') {
      var rotated = randomRotation(items, count, deck.kind, deck.randomRotation || {});
      deck.randomRotation = rotated.record;
      output = rotated.rows;
    } else if (order === 'weak') output = items.slice().sort(function (a, b) { return needScore(b) - needScore(a) + Math.random() - 0.5; });
    else {
      var due = items.filter(isDue);
      var weakItems = items.filter(function (row) { return !isDue(row) && weak(row); });
      var fresh = items.filter(function (row) { return !isDue(row) && !weak(row) && !Number(row.reviewCount || row.reps || 0); });
      var rest = items.filter(function (row) { return due.indexOf(row) < 0 && weakItems.indexOf(row) < 0 && fresh.indexOf(row) < 0; });
      try {
        if (typeof sortByFSRSPriority === 'function') due = sortByFSRSPriority(due, new Date());
        else due.sort(function (a, b) { return new Date(a.nextReview) - new Date(b.nextReview); });
      } catch (_) {}
      output = due.concat(shuffle(weakItems), shuffle(fresh), shuffle(rest));
      output = unique(output.map(function (row) { return keyOf(row, deck.kind); }))
        .map(function (key) { return items.find(function (row) { return keyOf(row, deck.kind) === key; }); })
        .filter(Boolean).slice(0, count);
    }
    if (output[0]) deck.recentFirstKeys = unique([keyOf(output[0], deck.kind)].concat(deck.recentFirstKeys || [])).slice(0, 12);
    deck.lastUsedAt = nowIso(); deck.updatedAt = nowIso(); saveStore();
    return output;
  }
  function adHocRotationKey(kind, mode) {
    return 'cems944.final.random.' + LANG + '.' + (kind || 'vocab') + '.' + (mode || 'default');
  }
  function orderedAdHoc(items, count, kind, mode) {
    var order = (document.getElementById('option-order') || {}).value || 'fsrs';
    var rows = items.slice();
    if (order === 'random') {
      var storageKey = adHocRotationKey(kind, mode), record = {};
      try { record = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch (_) { record = {}; }
      var rotated = randomRotation(rows, count, kind, record);
      try { localStorage.setItem(storageKey, JSON.stringify(rotated.record)); } catch (_) {}
      return rotated.rows;
    }
    if (order === 'weak') rows.sort(function (a, b) { return needScore(b) - needScore(a) + Math.random() - 0.5; });
    else rows.sort(function (a, b) { return needScore(b) - needScore(a) + Math.random() - 0.5; });
    return rows.slice(0, Math.min(count, rows.length));
  }
  function currentCount(kind) {
    var id = underlying(kind) === 'expr' ? 'expr-study-count' : kind === 'phrasal' ? 'pv-study-count' : 'study-count';
    return Math.max(5, Number((document.getElementById(id) || {}).value || localStorage.getItem('defaultCount') || 20));
  }
  function hasHanziPrompt(row, kind) {
    var front = keyOf(row, kind);
    if (!/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(front)) return false;
    if (/(?:number|num|xxx|placeholder|example)/i.test(front)) return false;
    if (/[{}\[\]<>]/.test(front)) return false;
    return true;
  }
  function modeEligible(row, kind, mode) {
    mode = text(mode || activeMode(kind, '')).toLowerCase();
    var eligible = null;
    try {
      if(typeof PHASE5_MODES!=='undefined'&&PHASE5_MODES.has(mode)&&typeof phase5Eligible==='function') eligible = phase5Eligible(row,mode);
      else if(window.CEMS85&&typeof window.CEMS85.modeEligible==='function') eligible = window.CEMS85.modeEligible(row,underlying(kind),mode);
    } catch(_) {}
    if (eligible === false) return false;
    if (!keyOf(row, kind)) return false;

    /* Mode-specific capability checks happen before the session is sliced.
       Previously a 5-card session could select one card without a Korean
       meaning and the legacy quiz then rejected the whole session as
       "not enough words", despite thousands of valid cards in the deck. */
    if (kind === 'vocab') {
      if (mode === 'quiz' || mode === 'reverse' || mode === '5choice' || mode === 'meaning') return !!meaningOf(row);
      if (mode === 'typing' || mode === 'zh-pinyin') return hasHanziPrompt(row, kind) && !!pinyinOf(row) && !!meaningOf(row);
      if (mode === 'dictation') return hasHanziPrompt(row, kind);
      if (mode === 'cloze') return clozeEligible(row, kind);
      if (mode === 'collocation') return collocationEligible(row);
    } else if (kind === 'phrasal') {
      if (/meaning|reverse|quiz/.test(mode)) return !!meaningOf(row);
    } else {
      if (/quiz|typing/.test(mode)) return !!meaningOf(row);
    }
    if(/cloze/.test(mode)||mode==='zh-expr-sentence') return hasExample(row);
    return eligible === true || !!keyOf(row,kind);
  }
  function legacyFiltered(kind, rows) {
    try {
      if (window.CEMS85 && typeof window.CEMS85.filterItems === 'function') return window.CEMS85.filterItems(underlying(kind), rows);
    } catch (_) {}
    return rows.slice();
  }
  function sessionBadge(deck, kind, count) {
    state.sessionDeck = deck || null;
    state.sessionKind = kind;
    var name = deck ? deck.name : kindLabel(kind) + ' · 현재 필터';
    var meta = deck ? kindLabel(kind) + ' · 이번 ' + count + ' / 카드덱 ' + deck.size : kindLabel(kind) + ' · ' + count + '개';
    ['page-flashcard','page-expr-fc','page-quiz','page-expr-quiz','page-typing','page-expr-typing','page-cloze','page-expr-cloze','page-listening','page-dictation'].forEach(function (id) {
      var page = document.getElementById(id); if (!page) return;
      var sticky = page.querySelector(':scope > div[style*="position:sticky"]'); if (!sticky) return;
      var badge = sticky.querySelector('.cems932-session-badge');
      if (!badge) { badge = document.createElement('div'); badge.className = 'cems932-session-badge'; sticky.appendChild(badge); }
      badge.innerHTML = '<b>' + esc(name) + '</b><span>' + esc(meta) + '</span>';
    });
  }
  function preserveOrderOnce() {
    window.__CEMS932_PRESERVE_ORDER__ = true;
    setTimeout(function () { window.__CEMS932_PRESERVE_ORDER__ = false; }, 1000);
  }
  function runLaunch(task) {
    if (state.launchPromise) return state.launchPromise;
    state.launchPromise = Promise.resolve().then(task).finally(function () {
      setTimeout(function () { state.launchPromise = null; }, 420);
    });
    return state.launchPromise;
  }
  async function launchItems(kind, selected, all, mode, deck) {
    if (!selected || !selected.length) { toast('⚠️ 학습할 항목이 없습니다.'); return; }
    mode = activeMode(kind, mode);
    preserveOrderOnce();
    sessionBadge(deck || null, kind, selected.length);
    window.__cems932ActiveDeck = deck ? { id:deck.id, name:deck.name, kind:deck.kind, generation:deck.generation } : null;
    window.__CEMS932_ACTIVE_KIND__ = kind;
    var exprPage = document.getElementById('page-expr-fc');
    if (exprPage) exprPage.classList.toggle('cems932-grammar-session', kind === 'grammar');
    if(typeof PHASE5_MODES!=='undefined'&&PHASE5_MODES.has(mode)&&typeof startChineseModeWithItems==='function')return startChineseModeWithItems(mode,selected,all,mode==='zh-expr-sentence'?'expr':'vocab');

    if (kind === 'vocab') {
      if (mode === 'quiz' || mode === 'reverse') return startQuiz(selected, all, mode, 'vocab');
      if (mode === 'typing') return startTyping(selected);
      if (mode === 'cloze') return startCloze(selected, all);
      if (mode === 'collocation') return startColloc(selected, all);
      if (mode === 'listening') return startListening(selected, all, 'vocab');
      if (mode === 'dictation') return startDictation(selected, all, 'vocab');
      return startFC(selected, all, 'vocab');
    }
    if (kind === 'phrasal') {
      if (mode === 'pv-particle' && typeof startPVP === 'function') return startPVP(selected, all);
      if (mode === 'pv-meaning' && typeof startPVQ === 'function') return startPVQ(selected, all);
      if (mode === 'pv-reverse' && typeof startPVReverse === 'function') return startPVReverse(selected, all);
      if (mode === 'pv-listening') return startListening(selected, all, 'phrasal');
      if (mode === 'pv-dictation') return startDictation(selected, all, 'phrasal');
      return startFC(selected, all, 'phrasal');
    }
    if (mode === 'expr-quiz') return startExprQuiz(selected, all);
    if (mode === 'expr-cloze') return startExprClozeWithItems(selected, all);
    if (mode === 'expr-typing') return startExprTyping(selected, all);
    if (mode === 'expr-listening') return startListening(selected, all, 'expr');
    if (mode === 'expr-dictation') return startDictation(selected, all, 'expr');
    return startExprFCWithItems(selected, all);
  }
  async function startDeck(deck, mode) {
    return runLaunch(async function () {
      if (!deck) { openManager(state.uiKind); return; }
      var resolved = await resolveDeck(deck);
      if (!resolved.items.length) { toast('⚠️ 카드덱에서 사용할 항목을 찾지 못했습니다.'); return; }
      var launchModeName = activeMode(deck.kind, mode);
      var eligibleItems = resolved.items.filter(function (row) { return modeEligible(row, deck.kind, launchModeName); });
      if (!eligibleItems.length) {
        toast('⚠️ 이 카드덱에는 선택한 학습 모드에 필요한 정보가 없습니다.');
        return;
      }
      setActive(deck.id, { activateScope:true, switchKind:true });
      var selected = orderedSession(eligibleItems, deck);
      // resolveDeck에서 이미 읽은 동일 종류 데이터셋을 재사용한다.
      return launchItems(deck.kind, selected, resolved.all, launchModeName, deck);
    });
  }
  async function startFilteredKind(kind, mode, extraPreset) {
    return runLaunch(async function () {
      var all = await allFor(kind);
      var rows = legacyFiltered(kind, all);
      if (extraPreset) rows = rows.filter(function (row) { return matchesConfig(row, kind, { preset:extraPreset, level:'', source:'', frequency:'all', masteryBand:'' }); });
      rows = rows.filter(function (row) { return modeEligible(row, kind, mode); });
      if (!rows.length) { toast('⚠️ 현재 필터에서 사용할 ' + kindLabel(kind) + ' 카드가 없습니다.'); return; }
      var selected = orderedAdHoc(rows, currentCount(kind), kind, mode);
      /* 감사 H6: 예전에는 필터를 전혀 거치지 않은 all 을 그대로 넘겼다.
         퀴즈/보충 단계가 이 풀에서 카드를 더 끌어오기 때문에, 모드에 맞지 않는
         카드(뜻 없음·예문 없음·한자 프롬프트 없음 등)가 세션에 다시 섞였다.
         → 모드 적합성을 통과한 풀만 넘긴다. 같은 DB를 다시 읽지는 않는다. */
      var pool = all.filter(function (row) { return modeEligible(row, kind, mode); });
      return launchItems(kind, selected, pool.length ? pool : rows, mode, null);
    });
  }
  async function startByScope(kind, mode) {
    if (scopeFor(kind) === 'deck') {
      var deck = activeDeck(kind);
      if (!deck) { openManager(kind); toast('카드덱을 먼저 선택하거나 만드세요.'); return; }
      return startDeck(deck, mode);
    }
    if (kind === 'grammar') return startFilteredKind('grammar', mode);
    return null;
  }

  function updateLegacyNavButtons() {
    try {
      var vocabLength = (typeof fcState !== 'undefined' && fcState && Array.isArray(fcState.words)) ? fcState.words.length : 0;
      var vocabIndex = (typeof fcState !== 'undefined' && fcState) ? Number(fcState.idx || 0) : 0;
      var exprLength = (typeof exprState !== 'undefined' && exprState && Array.isArray(exprState.words)) ? exprState.words.length : 0;
      var exprIndex = (typeof exprState !== 'undefined' && exprState) ? Number(exprState.idx || 0) : 0;
      [['fc-prev-btn', !vocabLength || vocabIndex <= 0], ['fc-next-btn', !vocabLength || vocabIndex >= vocabLength - 1],
       ['expr-fc-prev-btn', !exprLength || exprIndex <= 0], ['expr-fc-next-btn', !exprLength || exprIndex >= exprLength - 1]].forEach(function (entry) {
        var button = document.getElementById(entry[0]);
        if (!button) return;
        button.disabled = !!entry[1];
        button.style.opacity = entry[1] ? '0.42' : '1';
        button.setAttribute('aria-disabled', entry[1] ? 'true' : 'false');
      });
    } catch (_) {}
  }

  function ensureControlButton(parent, id, label, handler, title, className) {
    if (!parent) return null;
    var button = document.getElementById(id);
    if (!button) {
      button = document.createElement('button');
      button.id = id;
      button.type = 'button';
      button.className = className || 'btn btn-secondary btn-sm';
      button.textContent = label;
      button.setAttribute('onclick', handler + '()');
      if (title) button.title = title;
      parent.appendChild(button);
    }
    button.classList.remove('hidden');
    button.removeAttribute('aria-hidden');
    if (button.style.display === 'none') button.style.display = '';
    if (!button.getAttribute('onclick')) button.setAttribute('onclick', handler + '()');
    return button;
  }

  function ensureFlashcardControlSet(config) {
    var page = document.getElementById(config.pageId);
    if (!page) return;
    var production = document.getElementById(config.productionId);
    var secondary = production && production.parentElement;
    if (!secondary || !page.contains(secondary)) {
      secondary = document.createElement('div');
      var rating = document.getElementById(config.alreadyRatedId) || document.getElementById(config.ratingId);
      if (rating && rating.parentNode) rating.insertAdjacentElement('afterend', secondary); else page.appendChild(secondary);
    }
    secondary.classList.add('cems932-flashcard-secondary');
    ensureControlButton(secondary, config.productionId, '🖊️ 쓰기 연습 필요', config.productionFn, '쓰기 연습 표시');
    ensureControlButton(secondary, config.tagId, '🏷️ 태그', config.tagFn, '태그 관리');

    var previous = document.getElementById(config.prevId);
    var toolbar = previous && previous.parentElement;
    if (!toolbar || !page.contains(toolbar)) {
      toolbar = document.createElement('div');
      secondary.insertAdjacentElement('afterend', toolbar);
    }
    toolbar.classList.add('cems932-flashcard-toolbar');
    ensureControlButton(toolbar, config.prevId, '←', config.prevFn, '이전 카드');
    ensureControlButton(toolbar, config.nextId, '→', config.nextFn, '다음 카드');
    ensureControlButton(toolbar, config.speakId, '🔊', config.speakFn, '발음 듣기');
    ensureControlButton(toolbar, config.bookmarkId, '☆', config.bookmarkFn, '북마크');
    ensureControlButton(toolbar, config.editId, '✏️', config.editFn, '카드 편집');
    var endButton = ensureControlButton(toolbar, config.endId, '학습 종료', config.endFn, '학습 종료');
    if (endButton) endButton.classList.add('cems932-flashcard-end');
  }

  function ensureLegacyFlashcardControls() {
    ensureFlashcardControlSet({
      pageId:'page-flashcard', ratingId:'rating-section', alreadyRatedId:'fc-already-rated',
      productionId:'fc-production-btn', productionFn:'toggleFCProduction', tagId:'fc-tag-btn', tagFn:'openFCTagMenu',
      prevId:'fc-prev-btn', prevFn:'prevCard', nextId:'fc-next-btn', nextFn:'nextCardNav',
      speakId:'fc-speak-btn', speakFn:'speakWord', bookmarkId:'fc-bookmark-btn', bookmarkFn:'toggleFCBookmark',
      editId:'fc-edit-btn', editFn:'openFCEdit', endId:'fc-exit-btn', endFn:'confirmEndFC'
    });
    ensureFlashcardControlSet({
      pageId:'page-expr-fc', ratingId:'expr-rating-section', alreadyRatedId:'expr-fc-already-rated',
      productionId:'expr-fc-production-btn', productionFn:'toggleExprFCProduction', tagId:'expr-fc-tag-btn', tagFn:'openExprFCTagMenu',
      prevId:'expr-fc-prev-btn', prevFn:'prevExprCard', nextId:'expr-fc-next-btn', nextFn:'nextExprCardNav',
      speakId:'expr-fc-speak-btn', speakFn:'speakExpr', bookmarkId:'expr-fc-bookmark-btn', bookmarkFn:'toggleExprFCBookmark',
      editId:'expr-fc-edit-btn', editFn:'openExprFCEdit', endId:'expr-fc-exit-btn', endFn:'confirmEndExprFC'
    });
    updateLegacyNavButtons();
  }

  function unwrapUxHomeTools() {
    var details = document.getElementById('cems-ux25-home-tools');
    if (!details || !details.parentNode) return;
    var parent = details.parentNode;
    Array.from(details.children).forEach(function (child) {
      if (child.tagName === 'SUMMARY') return;
      parent.insertBefore(child, details);
    });
    details.remove();
  }

  function compactLegacyHomeSection(id, label) {
    var root = document.getElementById(id);
    if (!root) return;
    var firstCard = Array.from(root.children).find(function (child) { return child.classList && child.classList.contains('card') && !child.classList.contains('cems932-home-more'); });
    if (!firstCard) return;
    var details = root.querySelector(':scope > .cems932-home-more');
    if (!details) {
      details = document.createElement('details');
      details.className = 'card cems932-home-more';
      details.innerHTML = '<summary><div><strong>＋ 추가 학습·관리</strong><span>' + esc(label || '현황·검색·개별 카드 관리') + '</span></div><b>열기</b></summary><div class="cems932-home-more-body"></div>';
      firstCard.insertAdjacentElement('afterend', details);
      details.addEventListener('toggle', function () {
        var marker = details.querySelector(':scope > summary > b');
        if (marker) marker.textContent = details.open ? '접기' : '열기';
      });
    }
    var body = details.querySelector('.cems932-home-more-body');
    if (!body) return;
    Array.from(root.children).forEach(function (child) {
      if (child === firstCard || child === details || !(child.classList && child.classList.contains('card'))) return;
      body.appendChild(child);
    });
  }

  function cleanupLegacyDeckPanels() {
    document.querySelectorAll('#cems932-deck-card,#cems932-home-deck,.cems932-home-deck,.cems932-deck-card,[data-cems932-legacy-deck]').forEach(function (element) { element.remove(); });
    ['cems-lean-home-card','zh-home-card','ai-home-vocab','ai-home-expr','cems932-home-deck'].forEach(function (id) {
      var element = document.getElementById(id); if (element) element.remove();
    });
    unwrapUxHomeTools();
    compactLegacyHomeSection('home-vocab', '신규·북마크·검색·단어 현황');
    compactLegacyHomeSection('home-expr', '신규·북마크·검색·표현 현황');
    compactLegacyHomeSection('home-grammar', '문법 현황과 복습 바로가기');
  }

  function rememberOriginal(element, key, value) {
    if (!element) return;
    if (!element.dataset[key]) element.dataset[key] = value == null ? element.textContent : value;
  }
  function installGrammarTabs() {
    if (LANG !== 'zh') return;
    var homeTabs = document.querySelector('#page-home > .type-tabs');
    if (homeTabs && !homeTabs.querySelector('[data-type="grammar"]')) {
      var homeTab = document.createElement('div');
      homeTab.className = 'type-tab grammar';
      homeTab.dataset.type = 'grammar';
      homeTab.textContent = '🧩 문법';
      homeTab.setAttribute('role', 'button'); homeTab.tabIndex = 0;
      /* v9.5: switchGlobalType('grammar') 는 index.html 본체가 모르는 값이다.
         예전에는 이 모듈이 switchGlobalType 을 감싸 인자를 'expr' 로 바꿔치기했다.
         래핑을 없앴으므로 activateKind 를 직접 부른다(내부에서 'expr' 로 전환). */
      homeTab.onclick = function () { activateKind('grammar', true); };
      homeTab.onkeydown = function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); homeTab.click(); } };
      homeTabs.appendChild(homeTab);
    }
    var studyTabs = document.getElementById('study-type-tabs');
    if (studyTabs && !studyTabs.querySelector('[data-type="grammar"]')) {
      var studyTab = document.createElement('div');
      studyTab.className = 'type-tab grammar';
      studyTab.dataset.type = 'grammar';
      studyTab.textContent = '🧩 문법';
      studyTab.setAttribute('role', 'button'); studyTab.tabIndex = 0;
      studyTab.onclick = function () { activateKind('grammar', true); };
      studyTab.onkeydown = function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); studyTab.click(); } };
      studyTabs.appendChild(studyTab);
    }
  }
  function installGrammarHome() {
    if (LANG !== 'zh' || document.getElementById('home-grammar')) return;
    var expressionHome = document.getElementById('home-expr');
    if (!expressionHome || !expressionHome.parentNode) return;
    var home = document.createElement('div');
    home.id = 'home-grammar';
    home.className = 'hidden';
    home.innerHTML =
      '<div class="card cems932-grammar-home-card">' +
        '<div class="card-title cems932-legacy-title"><span>⚡ 문법 빠른 시작</span><button class="cems932-home-scope" data-cems932-action="open-manager" data-kind="grammar" type="button"><span>🗂</span> 카드덱</button></div>' +
        '<div class="quick-actions">' +
          '<div class="quick-action" data-cems932-action="grammar-start" data-mode="expr-fc"><div class="quick-action-icon">🃏</div><div class="quick-action-label">플래시카드</div></div>' +
          '<div class="quick-action" data-cems932-action="grammar-start" data-mode="expr-quiz"><div class="quick-action-icon">❓</div><div class="quick-action-label">용법 선택</div></div>' +
          '<div class="quick-action" data-cems932-action="grammar-start" data-mode="expr-cloze"><div class="quick-action-icon">📝</div><div class="quick-action-label">예문 빈칸</div></div>' +
          '<div class="quick-action" data-cems932-action="grammar-start" data-mode="expr-fc" data-preset="weak"><div class="quick-action-icon">🧠</div><div class="quick-action-label">취약 문법</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="card"><div class="card-title">📊 문법 현황</div><div class="stat-grid">' +
        '<div class="stat-item"><div class="stat-value" id="grammar-stat-total">0</div><div class="stat-label">전체</div></div>' +
        '<div class="stat-item"><div class="stat-value success" id="grammar-stat-mastered">0</div><div class="stat-label">숙달</div></div>' +
        '<div class="stat-item" data-cems932-action="grammar-start" data-mode="expr-fc" data-preset="weak"><div class="stat-value warning" id="grammar-stat-weak">0</div><div class="stat-label">취약</div></div>' +
        '<div class="stat-item" data-cems932-action="grammar-start" data-mode="expr-fc" data-preset="due"><div class="stat-value danger" id="grammar-stat-due">0</div><div class="stat-label">복습</div></div>' +
      '</div></div>';
    expressionHome.insertAdjacentElement('afterend', home);
  }
  function installHomeScopeButtons() {
    [['vocab','#home-vocab'], ['expr','#home-expr']].forEach(function (entry) {
      var kind = entry[0], root = document.querySelector(entry[1]);
      if (!root) return;
      var title = root.querySelector(':scope > .card:first-child .card-title');
      if (!title || title.querySelector('[data-cems932-action="open-manager"]')) return;
      var controls = title.querySelector(':scope > div:last-child');
      if (!controls || controls === title) {
        controls = document.createElement('div'); controls.className = 'cems932-title-actions'; title.appendChild(controls);
      }
      var button = document.createElement('button');
      button.type = 'button'; button.className = 'cems932-home-scope';
      button.dataset.cems932Action = 'open-manager'; button.dataset.kind = kind;
      button.innerHTML = '<span>🗂</span> 카드덱';
      controls.insertBefore(button, controls.firstChild);
    });
  }
  function applyKindUi() {
    installGrammarTabs(); installGrammarHome(); installHomeScopeButtons();
    var kind = state.uiKind;
    var grammar = kind === 'grammar';
    var homeVocab = document.getElementById('home-vocab');
    var homeExpr = document.getElementById('home-expr');
    var homeGrammar = document.getElementById('home-grammar');
    var studyVocab = document.getElementById('study-vocab');
    var studyExpr = document.getElementById('study-expr');
    if (homeVocab) homeVocab.classList.toggle('hidden', kind !== 'vocab');
    if (homeExpr) homeExpr.classList.toggle('hidden', kind !== 'expr');
    if (homeGrammar) homeGrammar.classList.toggle('hidden', !grammar);
    if (studyVocab) studyVocab.classList.toggle('hidden', kind !== 'vocab');
    if (studyExpr) studyExpr.classList.toggle('hidden', !(kind === 'expr' || grammar));
    try { currentHomeType = underlying(kind); currentStudyType = underlying(kind); } catch (_) {}
    document.querySelectorAll('#page-home > .type-tabs .type-tab').forEach(function (tab) { tab.classList.toggle('active', tab.dataset.type === kind); });
    document.querySelectorAll('#study-type-tabs .type-tab').forEach(function (tab) { tab.classList.toggle('active', tab.dataset.type === kind); });

    var studyTitle = document.querySelector('#study-expr > .card:first-child .card-title');
    if (studyTitle) {
      rememberOriginal(studyTitle, 'cems932Original', studyTitle.textContent);
      studyTitle.textContent = grammar ? '🧩 문법 학습 모드' : (studyTitle.dataset.cems932Original || '🎮 표현 학습 모드');
    }
    var labels = grammar ? {
      'expr-fc':['문법 카드','문형·용법 확인'],
      'expr-quiz':['용법 선택','뜻·기능 맞추기'],
      'expr-cloze':['예문 빈칸','문법 문맥 학습'],
      'expr-typing':['문형 입력','구조 쓰기 연습'],
      'expr-listening':['예문 듣기','듣고 기능 확인'],
      'expr-dictation':['예문 받아쓰기','듣고 문형 입력']
    } : null;
    document.querySelectorAll('#study-expr .mode-card').forEach(function (card) {
      var title = card.querySelector('.mode-card-title'), desc = card.querySelector('.mode-card-desc');
      if (title) rememberOriginal(title, 'cems932Original', title.textContent);
      if (desc) rememberOriginal(desc, 'cems932Original', desc.textContent);
      if (grammar && labels[card.dataset.mode]) {
        if (title) title.textContent = labels[card.dataset.mode][0];
        if (desc) desc.textContent = labels[card.dataset.mode][1];
        card.classList.add('grammar');
      } else {
        if (title && title.dataset.cems932Original) title.textContent = title.dataset.cems932Original;
        if (desc && desc.dataset.cems932Original) desc.textContent = desc.dataset.cems932Original;
        card.classList.remove('grammar');
      }
    });
    var newChip = document.querySelector('#expr-filter-mastery .chip[data-value="new"]');
    if (newChip) {
      rememberOriginal(newChip, 'cems932Original', newChip.textContent);
      newChip.textContent = grammar ? '새 문법' : newChip.dataset.cems932Original;
    }
    renderScopeButtons();
  }
  /* v9.5: 예전에는 래핑해 둔 state.bases.switchGlobalType(원본)을 직접 불렀다.
     전역 래핑을 없앴으므로 index.html 의 switchGlobalType 을 그대로 부른다.
     그러면 afterTypeSwitch 훅이 같이 도는데, 그 훅이 방금 정한 uiKind('grammar')를
     인자값('expr')으로 되돌려 버리므로 kindRelay 플래그로 그 구간을 건너뛴다. */
  function activateKind(kind, doUnderlyingSwitch) {
    if (!['vocab','phrasal','expr','grammar'].includes(kind)) kind = 'vocab';
    state.uiKind = kind; loadStore().uiKind = kind; saveStore();
    if (doUnderlyingSwitch && typeof window.switchGlobalType === 'function') {
      state.kindRelay = true;
      try { window.switchGlobalType(underlying(kind)); }
      catch (_) {}
      finally { state.kindRelay = false; }
    }
    applyKindUi();
    renderAll();
  }

  function ensureManager() {
    var overlay = document.getElementById(MODAL_ID);
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay cems932-manager-overlay';
    overlay.id = MODAL_ID;
    overlay.innerHTML =
      '<div class="modal cems932-manager" role="dialog" aria-modal="true" aria-labelledby="cems932-manager-title">' +
        '<div class="modal-header"><div><h3 id="cems932-manager-title">🗂 카드덱</h3><p>현재 필터 또는 저장 카드덱을 선택합니다.</p></div><button class="modal-close" data-cems932-action="close-manager" type="button">✕</button></div>' +
        '<div class="cems932-manager-scroll">' +
          '<section class="cems932-scope-card">' +
            '<div class="cems932-scope-head"><div><strong id="cems932-manager-kind-label">단어 카드덱</strong><span>필터는 매번 새로 선별하고, 카드덱은 같은 구성으로 반복합니다.</span></div></div>' +
            '<div class="cems932-scope-switch"><button class="btn btn-secondary" id="cems932-scope-filter" data-cems932-action="scope-filter" type="button">🎯 현재 필터</button><select id="cems932-deck-select" aria-label="카드덱 선택"><option value="">카드덱 선택</option></select></div>' +
            '<div class="cems932-current" id="cems932-current"><strong>현재 필터</strong><span>기존 형식 학습 조건을 그대로 사용합니다.</span></div>' +
            '<div class="cems932-current-actions"><button class="btn btn-secondary" data-cems932-action="rotate" type="button">25% 교체</button><button class="btn btn-secondary" data-cems932-action="rebuild" type="button">전체 새로 뽑기</button><button class="btn btn-secondary danger" data-cems932-action="delete" type="button">삭제</button></div>' +
          '</section>' +
          '<section class="cems932-scope-card"><div class="cems932-quick-title">빠른 카드덱 만들기</div><div class="cems932-quick">' +
            '<button data-cems932-action="quick" data-preset="random" type="button">🎲<br>랜덤 50</button>' +
            '<button data-cems932-action="quick" data-preset="exam" type="button">📝<br>시험 50</button>' +
            '<button data-cems932-action="quick" data-preset="conversation" type="button">💬<br>회화 50</button>' +
            '<button data-cems932-action="quick" data-preset="weak" type="button">🧠<br>취약 50</button>' +
            '<button data-cems932-action="quick" data-preset="due" type="button">⏰<br>오늘 복습</button>' +
          '</div></section>' +
          '<details class="cems932-builder-card"><summary><div><strong>새 카드덱 만들기</strong><span>필요할 때만 상세 조건을 설정합니다.</span></div><em>펼치기</em></summary><div class="cems932-builder-body">' +
            '<div class="cems932-primary-grid">' +
              '<label><span>콘텐츠</span><select id="cems932-kind"><option value="vocab">단어</option><option value="expr">표현</option><option value="grammar">문법</option></select></label>' +
              '<label><span>목적</span><select id="cems932-preset"><option value="random">랜덤</option><option value="exam">시험용</option><option value="conversation">회화용</option><option value="level">점수대·레벨</option><option value="textbook">교재·과</option><option value="weak">취약</option><option value="due">오늘 복습</option><option value="new">새 항목</option><option value="starred">북마크</option></select></label>' +
              '<label><span>카드덱 크기</span><select id="cems932-size"><option>20</option><option>30</option><option selected>50</option><option>75</option><option>100</option></select></label>' +
            '</div>' +
            '<details class="cems932-advanced"><summary>상세 조건 · 레벨·교재·점수</summary><div class="cems932-advanced-grid">' +
              '<label><span>카드덱 이름</span><input id="cems932-name" maxlength="40" placeholder="예: HSK 4 시험 50"></label>' +
              '<label><span>한 번에 학습</span><select id="cems932-session-size"><option>10</option><option>20</option><option>30</option><option selected>50</option><option>75</option><option>100</option></select></label>' +
              '<label><span>점수대·레벨</span><select id="cems932-level"><option value="">전체</option></select></label>' +
              '<label><span>교재·과</span><select id="cems932-source"><option value="">전체</option></select></label>' +
              '<label><span>빈도</span><select id="cems932-frequency"><option value="all">전체</option><option>K1</option><option>K2</option><option>K3</option><option>K4</option><option>K5</option></select></label>' +
              '<label><span>학습 점수</span><select id="cems932-mastery"><option value="">전체</option><option value="unseen">미학습</option><option value="low">0–39 취약</option><option value="mid">40–69 학습 중</option><option value="high">70–89 안정</option><option value="mastered">90–100 숙달</option></select></label>' +
            '</div></details>' +
            '<div class="cems932-builder-actions"><button class="btn btn-primary" data-cems932-action="create" type="button">카드덱 생성</button><button class="btn btn-secondary" data-cems932-action="scope-filter" type="button">필터로 돌아가기</button></div>' +
            '<div class="cems932-pool" id="cems932-pool">후보 계산 중</div>' +
          '</div></details>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) closeManager();
    });
    return overlay;
  }
  function openManager(kind) {
    state.managerKind = kind || state.uiKind || 'vocab';
    var overlay = ensureManager();
    var select = overlay.querySelector('#cems932-kind');
    if (select) select.value = state.managerKind;
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
    renderManager();
    fillDynamicOptions(state.managerKind);
    setTimeout(function () { overlay.querySelector('.modal-close')?.focus(); }, 30);
  }
  function closeManager() {
    var overlay = document.getElementById(MODAL_ID);
    if (!overlay) return;
    overlay.classList.remove('show'); overlay.setAttribute('aria-hidden', 'true');
  }
  function deckOption(deck) {
    return '<option value="' + esc(deck.id) + '">' + esc(kindLabel(deck.kind) + ' · ' + deck.name + ' (' + deck.size + ')') + '</option>';
  }
  async function renderManager() {
    var overlay = document.getElementById(MODAL_ID); if (!overlay) return;
    var kind = state.managerKind || state.uiKind;
    var store = loadStore(), scope = scopeFor(kind), deck = activeDeck(kind);
    var label = overlay.querySelector('#cems932-manager-kind-label');
    if (label) label.textContent = kindLabel(kind) + ' 카드덱';
    var filterButton = overlay.querySelector('#cems932-scope-filter');
    if (filterButton) filterButton.classList.toggle('active', scope === 'filter');
    var select = overlay.querySelector('#cems932-deck-select');
    if (select) {
      select.innerHTML = '<option value="">카드덱 선택</option>' + store.decks.filter(function (item) { return item.kind === kind; }).map(deckOption).join('');
      if (deck && scope === 'deck') select.value = deck.id;
      else select.value = '';
    }
    var current = overlay.querySelector('#cems932-current');
    var actions = overlay.querySelector('.cems932-current-actions');
    if (scope !== 'deck' || !deck) {
      if (current) current.innerHTML = '<strong>🎯 현재 필터</strong><span>현재 필터·분량·순서를 그대로 사용합니다.</span><small>카드덱을 선택하면 고정 구성 반복으로 전환됩니다.</small>';
      if (actions) actions.classList.add('is-disabled');
    } else {
      var resolved = await resolveDeck(deck), due = resolved.items.filter(isDue).length, weakCount = resolved.items.filter(weak).length;
      var details = [presetLabel(deck.preset), kindLabel(deck.kind), deck.size + '개', '이번 ' + deck.sessionSize + '개', deck.level ? levelLabel(deck.level) : '', deck.source || ''].filter(Boolean).join(' · ');
      if (current) current.innerHTML = '<strong>🗂 ' + esc(deck.name) + '</strong><span>' + esc(details) + '</span><small>복습 ' + due + ' · 취약 ' + weakCount + ' · 구성 #' + Number(deck.generation || 1) + '</small>';
      if (actions) actions.classList.remove('is-disabled');
    }
    var builderKind = overlay.querySelector('#cems932-kind'); if (builderKind) builderKind.value = kind;
  }
  async function fillDynamicOptions(kind) {
    var overlay = document.getElementById(MODAL_ID); if (!overlay) return;
    kind = kind || overlay.querySelector('#cems932-kind')?.value || state.managerKind;
    var all = await allFor(kind);
    var levelSelect = overlay.querySelector('#cems932-level'), sourceSelect = overlay.querySelector('#cems932-source');
    if (!levelSelect || !sourceSelect) return;
    var oldLevel = levelSelect.value, oldSource = sourceSelect.value;
    var levels = levelOptions(unique(all.flatMap(valuesFrom))).sort(function (a, b) { return levelLabel(a).localeCompare(levelLabel(b), undefined, { numeric:true }); });
    var sources = unique(all.flatMap(sourceValues)).sort(function (a, b) { return a.localeCompare(b, undefined, { numeric:true }); });
    levelSelect.innerHTML = '<option value="">전체 점수대·레벨</option>' + levels.map(function (value) { return '<option value="' + esc(value) + '">' + esc(levelLabel(value)) + '</option>'; }).join('');
    sourceSelect.innerHTML = '<option value="">전체 교재·과</option>' + sources.map(function (value) { return '<option value="' + esc(value) + '">' + esc(value) + '</option>'; }).join('');
    if (levels.indexOf(oldLevel) >= 0) levelSelect.value = oldLevel;
    if (sources.indexOf(oldSource) >= 0) sourceSelect.value = oldSource;
    var pool = overlay.querySelector('#cems932-pool'); if (pool) pool.textContent = '현재 ' + kindLabel(kind) + ' 후보 ' + all.length + '개';
  }
  function managerConfig() {
    var overlay = document.getElementById(MODAL_ID); if (!overlay) return {};
    return {
      name: text(overlay.querySelector('#cems932-name')?.value),
      kind: overlay.querySelector('#cems932-kind')?.value || state.managerKind,
      preset: overlay.querySelector('#cems932-preset')?.value || 'random',
      size: Number(overlay.querySelector('#cems932-size')?.value || 50),
      sessionSize: Number(overlay.querySelector('#cems932-session-size')?.value || 50),
      level: overlay.querySelector('#cems932-level')?.value || '',
      source: overlay.querySelector('#cems932-source')?.value || '',
      frequency: overlay.querySelector('#cems932-frequency')?.value || 'all',
      masteryBand: overlay.querySelector('#cems932-mastery')?.value || ''
    };
  }

  function ensureDockIntegration() {
    var dock = document.getElementById('c86-study-dock');
    if (!dock) return false;
    var actions = dock.querySelector('.c86-dock-actions');
    if (actions && !actions.querySelector('#cems932-dock-scope')) {
      var button = document.createElement('button');
      button.id = 'cems932-dock-scope'; button.type = 'button';
      button.className = 'btn btn-secondary cems932-dock-button';
      button.dataset.cems932Action = 'open-manager';
      button.innerHTML = '<span class="cems932-dock-icon">🗂</span><span class="cems932-dock-label">카드덱</span>';
      actions.insertBefore(button, actions.firstChild);
    }
    if (!dock.dataset.cems932Capture) {
      dock.dataset.cems932Capture = '1';
      dock.addEventListener('click', function (event) {
        var step = event.target.closest && event.target.closest('[data-c86-count]');
        if (!step || scopeFor(state.uiKind) !== 'deck') return;
        var deck = activeDeck(state.uiKind); if (!deck) return;
        event.preventDefault(); event.stopImmediatePropagation();
        var delta = Number(step.dataset.c86Count || 0);
        deck.sessionSize = Math.max(5, Math.min(deck.size, Number(deck.sessionSize || deck.size) + delta));
        deck.updatedAt = nowIso(); saveStore(); renderAll();
      }, true);
    }
    /* v9.4.1: renderDock() 이 dock 내부 textContent 를 쓰기 때문에 이 옵저버가
       스스로를 20ms 주기로 영구 재발화시켰다. 자기 렌더 중에는 감시를 끊는다. */
    if (!state.dockObserver) {
      state.dockObserver = new MutationObserver(function () {
        if (state.dockRendering) return;
        clearTimeout(state.dockToken);
        state.dockToken = setTimeout(renderDock, 120);
      });
      state.dockNode = dock;
      state.dockObserveOpts = { childList:true, subtree:true, attributes:true, attributeFilter:['class','disabled'] };
      state.dockObserver.observe(dock, state.dockObserveOpts);
    }
    return true;
  }
  function setText(el, value) { if (el && el.textContent !== value) el.textContent = value; }
  async function renderDock() {
    if (state.dockRendering) return;
    state.dockRendering = true;
    try { return await renderDockInner(); }
    finally {
      state.dockRendering = false;
      if (state.dockObserver && state.dockNode) {
        state.dockObserver.takeRecords();
        state.dockObserver.disconnect();
        state.dockObserver.observe(state.dockNode, state.dockObserveOpts);
      }
    }
  }
  async function renderDockInner() {
    if (!ensureDockIntegration()) return;
    var kind = state.uiKind, scope = scopeFor(kind), deck = activeDeck(kind);
    var dock = document.getElementById('c86-study-dock'), button = document.getElementById('cems932-dock-scope');
    var title = document.getElementById('c86-dock-title'), meta = document.getElementById('c86-dock-meta'), output = document.getElementById('c86-dock-count'), start = document.getElementById('c86-start');
    if (!dock || !button || !title || !meta || !output || !start) return;
    button.classList.toggle('active', scope === 'deck');
    button.title = scope === 'deck' && deck ? '카드덱: ' + deck.name : '카드덱 선택';
    dock.classList.toggle('cems932-deck-active', scope === 'deck');
    dock.classList.toggle('cems932-grammar-active', kind === 'grammar');

    if (scope === 'deck') {
      if (!deck) {
        title.textContent = kindLabel(kind) + ' · 카드덱 없음';
        meta.textContent = '카드덱 버튼에서 카드덱을 선택하거나 만드세요.';
        output.textContent = '0';
        start.textContent = '카드덱 선택';
        start.disabled = false;
        return;
      }
      title.textContent = deck.name;
      meta.textContent = kindLabel(kind) + ' 고정 ' + deck.size + '개 · 구성 #' + Number(deck.generation || 1);
      output.textContent = String(deck.sessionSize || deck.size);
      start.textContent = '카드덱 학습'; start.disabled = !deck.size;
      return;
    }
    if (kind === 'grammar') {
      var all = legacyFiltered('grammar', await allFor('grammar'));
      var mode = activeMode('grammar');
      var eligible = all.filter(function (row) { return modeEligible(row, 'grammar', mode); });
      var desired = currentCount('grammar'), actual = Math.min(desired, eligible.length);
      title.textContent = '문법 · ' + (document.querySelector('#study-expr .mode-card.active .mode-card-title')?.textContent || '학습');
      meta.textContent = eligible.length ? actual + '개 진행 · 사용 가능 ' + eligible.length + '개' : '현재 필터에서 사용할 문법 카드가 없습니다.';
      output.textContent = String(desired);
      start.textContent = eligible.length ? '학습 시작' : '카드 없음';
      start.disabled = !eligible.length;
    }
  }
  function renderScopeButtons() {
    document.querySelectorAll('.cems932-home-scope').forEach(function (button) {
      var kind = button.dataset.kind || state.uiKind, deck = activeDeck(kind), scope = scopeFor(kind);
      button.classList.toggle('active', scope === 'deck');
      button.title = scope === 'deck' && deck ? '카드덱: ' + deck.name : '현재 필터 / 카드덱 선택';
    });
    renderDock();
  }
  async function updateGrammarStats() {
    if (LANG !== 'zh') return;
    var rows = await allFor('grammar');
    var mastered = rows.filter(function (row) { return Number(row.mastery || 0) >= 90; }).length;
    var weakCount = rows.filter(weak).length, due = rows.filter(isDue).length;
    var values = { 'grammar-stat-total':rows.length, 'grammar-stat-mastered':mastered, 'grammar-stat-weak':weakCount, 'grammar-stat-due':due };
    Object.keys(values).forEach(function (id) { var element = document.getElementById(id); if (element) element.textContent = String(values[id]); });
  }

  async function renderCatalog() {
    var page = document.getElementById('page-data'); if (!page) return;
    if (!state.catalog) {
      try { var response = await fetch('./content/data_catalog_v932.json', { cache:'no-store' }); if (response.ok) state.catalog = await response.json(); }
      catch (_) { state.catalog = null; }
    }
    if (!state.catalog) return;
    var host = document.getElementById('cems932-data-catalog');
    if (!host) { host = document.createElement('details'); host.id = 'cems932-data-catalog'; host.className = 'card cems932-data-catalog'; page.insertBefore(host, page.firstChild); }
    var summary = Object.assign({}, state.catalog.summary || state.catalog.kinds || {}), sources = state.catalog.sources || [];
    var metrics = '<span>단어<b>' + Number(summary.vocabulary || 0) + '</b></span><span>표현<b>' + Number(summary.expressions || summary.expression || 0) + '</b></span><span>문법<b>' + Number(summary.grammar || 0) + '</b></span><span>예문<b>' + Number(summary.examples || 0) + '</b></span>';
    host.innerHTML = '<summary><div><strong><span class="c943-icon c943-icon-database c943-catalog-icon" aria-hidden="true"></span><span>데이터 인식 현황</span></strong><span>' + sources.length + '개 원본 · v' + VERSION + '</span></div><b>펼치기</b></summary><div class="cems932-catalog-metrics">' + metrics + '</div><div class="cems932-source-list">' + sources.map(function (source) {
      var detail = (source.words || source.grammar || source.dialogues) ? ('단어 ' + Number(source.words || 0) + ' · 문법 ' + Number(source.grammar || 0) + (source.dialogues ? ' · 회화 ' + source.dialogues : '')) : text(source.description || '인식 가능한 데이터 원본');
      return '<div><strong>' + esc(source.file) + '</strong><span>' + esc(detail) + '</span></div>';
    }).join('') + '</div>';
  }

  async function renderAll() {
    cleanupLegacyDeckPanels();
    applyKindUi();
    renderScopeButtons();
    await Promise.all([renderManager(), updateGrammarStats(), renderCatalog()]);
    ensureLegacyFlashcardControls();
  }

  function assignGlobal(name, fn) {
    fn.__cems932Compat = true;   // selfTest 진단용 표식 (설치 가드가 아니다)
    window[name] = fn;
    /* v9.5: eval(name + ' = fn') 제거. 이 모듈은 IIFE 안이라 eval 이 전역 바인딩에
       닿지도 않았고, 위의 window[name] 대입과 완전히 중복이었다. */
  }
  function currentVocabRow() {
    try { return (typeof fcState !== 'undefined' && fcState && fcState.words) ? fcState.words[fcState.idx] : null; } catch (_) { return null; }
  }
  function currentExpressionRow() {
    try { return (typeof exprState !== 'undefined' && exprState && exprState.words) ? exprState.words[exprState.idx] : null; } catch (_) { return null; }
  }
  function callMaybe(name, args) {
    var fn = window[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn.apply(window, args || []); } catch (_) { return undefined; }
  }
  function resetCardInfo(prefix) {
    var info = document.getElementById(prefix + '-info-view');
    if (info) { info.classList.add('hidden'); info.replaceChildren(); }
  }
  function vocabMeaning(row) {
    var value = callMaybe('getMKO', [row]);
    return text(value || row.Meaning_KO || row.Meaning1_KO || row.Definition_KO || '(뜻 없음)');
  }
  function expressionMeaning(row) {
    var value = callMaybe('getMKO', [row]);
    return text(value || row.Meaning_KO || row.Meaning1_KO || row.Function_KO || row.Title_KO || '(뜻 없음)');
  }
  function flipCardCompat() {
    var row = currentVocabRow(), card = document.getElementById('flashcard'), inner = document.getElementById('fc-back-inner');
    if (!row || !card || !inner) return false;
    try { if (typeof fcState !== 'undefined' && fcState && fcState.transitioning) return false; } catch (_) {}
    var isBack = card.classList.contains('flipped');
    if (isBack) {
      card.classList.remove('flipped'); inner.classList.remove('visible'); card.setAttribute('aria-pressed', 'false');
      try { fcState.flipped = false; } catch (_) {}
      callMaybe('setRating', [false]);
      return true;
    }
    var meaningKo = document.getElementById('fc-meaning-ko');
    var meaningEn = document.getElementById('fc-meaning-en');
    var example = document.getElementById('fc-example');
    var collocation = document.getElementById('fc-collocation');
    if (meaningKo) meaningKo.textContent = vocabMeaning(row);
    var synonyms = text(callMaybe('getSynonym', [row]) || row.Synonym_CHT);
    var antonyms = text(callMaybe('getAntonym', [row]) || row.Antonym_CHT);
    var extra = [];
    if (synonyms) extra.push('近: ' + synonyms);
    if (antonyms) extra.push('反: ' + antonyms);
    if (meaningEn) meaningEn.textContent = extra.join(' / ');
    var sentence = exampleText(row), pinyin = examplePinyin(row), translation = exampleTranslation(row);
    if (example) {
      example.textContent = sentence ? sentence + (pinyin ? '\n' + pinyin : '') + (translation ? '\n→ ' + translation : '') : '연결된 예문 없음';
      example.style.display = 'block';
      example.classList.toggle('cems932-no-example', !sentence);
    }
    if (collocation) {
      var type = ''; try { type = fcState.type; } catch (_) {}
      if (type === 'phrasal') {
        collocation.textContent = row.Formal_Equivalent ? '📌 Formal: ' + row.Formal_Equivalent : '';
      } else {
        var coll = text(callMaybe('getCollocation', [row]) || row.Collocation_CHT || row.Key_Collocation);
        collocation.textContent = coll ? '📌 搭配: ' + coll : '';
      }
    }
    resetCardInfo('fc');
    inner.classList.add('visible'); card.classList.add('flipped'); card.setAttribute('aria-pressed', 'true');
    try { fcState.flipped = true; } catch (_) {}
    callMaybe('setRating', [true]); callMaybe('vibrate', [10]);
    return true;
  }
  function flipExprCardCompat() {
    var row = currentExpressionRow(), card = document.getElementById('expr-fc-card'), inner = document.getElementById('expr-fc-back-inner');
    if (!row || !card || !inner) return false;
    try { if (typeof exprState !== 'undefined' && exprState && exprState.transitioning) return false; } catch (_) {}
    var isBack = card.classList.contains('flipped');
    if (isBack) {
      card.classList.remove('flipped'); inner.classList.remove('visible'); card.setAttribute('aria-pressed', 'false');
      try { exprState.flipped = false; } catch (_) {}
      callMaybe('setExprRating', [false]);
      return true;
    }
    var functionElement = document.getElementById('expr-fc-func');
    var meaningElement = document.getElementById('expr-fc-meaning');
    var similarElement = document.getElementById('expr-fc-similar');
    var exampleElement = document.getElementById('expr-fc-example');
    var functionText = text(row.Function_KO || row.Function || row.Title_KO);
    if (functionElement) functionElement.textContent = functionText ? '[ ' + functionText + ' ]' : '';
    if (meaningElement) meaningElement.textContent = expressionMeaning(row);
    var similar = text(row.Similar_Expr || row.Similar_Expression);
    if (similarElement) {
      if (similar) {
        similarElement.innerHTML = '<div class="similar-title">💡 유사 표현</div>' + similar.split(/[,;]/).map(text).filter(Boolean).map(function (value) { return '<div class="similar-item">• ' + esc(value) + '</div>'; }).join('');
        similarElement.style.display = 'block';
      } else { similarElement.innerHTML = ''; similarElement.style.display = 'none'; }
    }
    var sentence = exampleText(row), pinyin = examplePinyin(row), translation = exampleTranslation(row);
    if (exampleElement) {
      exampleElement.textContent = sentence ? sentence + (pinyin ? '\n' + pinyin : '') + (translation ? '\n→ ' + translation : '') : '연결된 예문 없음';
      exampleElement.style.display = 'block';
      exampleElement.classList.toggle('cems932-no-example', !sentence);
    }
    resetCardInfo('expr-fc');
    inner.classList.add('visible'); card.classList.add('flipped'); card.setAttribute('aria-pressed', 'true');
    try { exprState.flipped = true; } catch (_) {}
    decorateExpressionBack();
    callMaybe('setExprRating', [true]); callMaybe('vibrate', [10]);
    return true;
  }
  function prevCardCompat() {
    try { if (!fcState || !Array.isArray(fcState.words) || fcState.idx <= 0) return false; fcState.idx--; callMaybe('showCard'); updateLegacyNavButtons(); return true; } catch (_) { return false; }
  }
  function nextCardCompat() {
    try { if (!fcState || !Array.isArray(fcState.words) || fcState.idx >= fcState.words.length - 1) return false; fcState.idx++; callMaybe('showCard'); updateLegacyNavButtons(); return true; } catch (_) { return false; }
  }
  function prevExprCardCompat() {
    try { if (!exprState || !Array.isArray(exprState.words) || exprState.idx <= 0) return false; exprState.idx--; callMaybe('showExprCard'); updateLegacyNavButtons(); return true; } catch (_) { return false; }
  }
  function nextExprCardCompat() {
    try { if (!exprState || !Array.isArray(exprState.words) || exprState.idx >= exprState.words.length - 1) return false; exprState.idx++; callMaybe('showExprCard'); updateLegacyNavButtons(); return true; } catch (_) { return false; }
  }
  function installCompatCardInput(containerId, cardId, flipName) {
    var container = document.getElementById(containerId), card = document.getElementById(cardId);
    if (!container || !card) return;
    card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-label', '카드 앞면과 뒷면 전환');
    if (card.dataset.cems932CompatKey !== '1') {
      card.dataset.cems932CompatKey = '1';
      card.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault(); var fn = window[flipName]; if (typeof fn === 'function') fn();
      });
    }
    if (container.dataset.cems932CompatClick !== '1') {
      container.dataset.cems932CompatClick = '1';
      container.addEventListener('click', function (event) {
        if (event.target && event.target.closest && event.target.closest('button,input,select,textarea,a,label,[role="button"]:not(#' + cardId + ')')) return;
        if (!card.contains(event.target) && event.target !== card) return;
        event.stopImmediatePropagation(); var fn = window[flipName]; if (typeof fn === 'function') fn();
      }, true);
    }
  }
  function installFlashcardCompatibility() {
    assignGlobal('flipCard', flipCardCompat);
    assignGlobal('flipExprCard', flipExprCardCompat);
    assignGlobal('prevCard', prevCardCompat);
    assignGlobal('nextCardNav', nextCardCompat);
    assignGlobal('prevExprCard', prevExprCardCompat);
    assignGlobal('nextExprCardNav', nextExprCardCompat);
    ensureLegacyFlashcardControls();
    installCompatCardInput('fc-container', 'flashcard', 'flipCard');
    installCompatCardInput('expr-fc-container', 'expr-fc-card', 'flipExprCard');
    updateLegacyNavButtons();
  }

  function decorateExpressionBack() {
    var kind = state.sessionKind || window.__CEMS932_ACTIVE_KIND__ || (state.uiKind === 'grammar' ? 'grammar' : 'expr');
    if (underlying(kind) !== 'expr') return;
    var row = null;
    try { row = exprState && exprState.words && exprState.words[exprState.idx]; } catch (_) { row = null; }
    if (!row) return;
    var exprPage = document.getElementById('page-expr-fc');
    if (exprPage) exprPage.classList.toggle('cems932-grammar-session', kind === 'grammar');
    var tag = document.getElementById('expr-fc-formality');
    if (tag && kind === 'grammar') tag.textContent = '문법' + (row.HSK ? ' · HSK' + row.HSK : '');
    var example = exampleText(row), pinyin = examplePinyin(row), translation = exampleTranslation(row), exampleElement = document.getElementById('expr-fc-example');
    if (exampleElement && example) {
      exampleElement.textContent = example + (pinyin ? '\n' + pinyin : '') + (translation ? '\n→ ' + translation : '');
      exampleElement.style.display = 'block';
    }
    var inner = document.getElementById('expr-fc-back-inner'); if (!inner) return;
    inner.querySelector('.cems932-expr-details')?.remove();
    var fields = [];
    var func = text(row.Function_KO || row.Function || row.Title_KO);
    var structure = text(row.Structure || row.L2);
    var usage = text(row.Usage_KO || row.L3);
    if (func) fields.push('<div><b>기능</b><span>' + esc(func) + '</span></div>');
    if (structure) fields.push('<div><b>구조</b><span>' + esc(structure) + '</span></div>');
    if (usage) fields.push('<div><b>용법</b><span>' + esc(usage) + '</span></div>');
    if (translation && exampleElement && !exampleElement.textContent.includes(translation)) fields.push('<div><b>예문 뜻</b><span>' + esc(translation) + '</span></div>');
    if (row.Example2) fields.push('<div><b>추가 예문</b><span>' + esc(row.Example2) + (row.Example2_KO ? '<small>' + esc(row.Example2_KO) + '</small>' : '') + '</span></div>');
    if (row.Common_Error) fields.push('<div class="warn"><b>주의</b><span>' + esc(row.Common_Error) + '</span></div>');
    if (!fields.length) return;
    var box = document.createElement('section'); box.className = 'cems932-expr-details'; box.innerHTML = fields.join(''); inner.appendChild(box);
  }

  /* ==========================================================================
   * v9.5 — 전역 몽키패칭 정리
   *
   * 예전에는 wrap(name, factory) 로 전역 10개를 통째로 감쌌다. 가드가 함수
   * 프로퍼티 플래그(__cems932r3)여서, 다른 모듈이 같은 전역을 다시 감싸면
   * 플래그가 사라지고 [900,2200]ms 재설치 타이머가 돌 때마다 또 감싸졌다.
   * (showPage 13겹, 탭 전환 1회에 updateWordTable 5회)
   *
   * 이번 정리:
   *   - showPage / switchGlobalType → index.html 이 발행하는 훅으로 이동. 전역을
   *     건드리지 않고, 같은 키로 멱등 등록되므로 절대 중첩되지 않는다.
   *   - eval(name + ' = wrapped') 제거.
   *   - 남은 가로채기(아래 overrideOnce)는 "본 함수를 대신 실행할지" 결정하는
   *     분기라서 후처리 훅으로 표현할 수 없다. 해당 채널이 index.html 에 아직
   *     없으므로 이번에는 유지하되, 모듈 스코프 플래그로 딱 1회만 설치한다.
   *     → 보고서의 "채널 추가 필요" 목록 참고.
   * ========================================================================*/
  function overrideOnce(name, factory) {
    var current = window[name];
    if (typeof current !== 'function') return;
    if (state.bases[name]) return;          // 모듈 스코프 1회 가드 (함수 프로퍼티 플래그 금지)
    state.bases[name] = current;
    window[name] = factory(current);
  }

  function installHooks() {
    if (!window.CEMSHooks) return;

    /* showPage 래퍼 → afterPageShow 훅 (순수 후처리라 그대로 옮겨진다) */
    window.CEMSHooks.on('afterPageShow', 'deck-groups', function (name) {
      setTimeout(function () {
        cleanupLegacyDeckPanels(); applyKindUi(); ensureDockIntegration();
        renderScopeButtons(); installFlashcardCompatibility();
        if (name === 'study') renderDock();
      }, 0);
    });

    /* switchGlobalType 래퍼 → afterTypeSwitch 훅.
       원래 래퍼는 kind === 'grammar' 일 때 인자를 'expr' 로 바꿔 본 함수를 불렀다.
       후처리 훅은 인자를 바꿀 수 없으므로, 문법 진입은 activateKind 가 담당하고
       (탭 onclick 을 그쪽으로 돌렸다) 여기서는 나머지 후처리만 한다. */
    window.CEMSHooks.on('afterTypeSwitch', 'deck-groups', function (kind) {
      if (state.kindRelay) return;          // activateKind 가 유도한 전환 — 그쪽에서 마무리한다
      if (kind === 'grammar') {             // 외부(구버전 호출부)가 직접 부른 경우의 안전망
        activateKind('grammar', true);
        return;
      }
      if (['vocab','phrasal','expr'].includes(kind)) {
        state.uiKind = kind; loadStore().uiKind = kind; saveStore();
      }
      applyKindUi();
      renderAll();
    });
  }

  function installWrappers() {
    installHooks();
    if (state.overridesInstalled) return;
    state.overridesInstalled = true;

    /* --- 학습 시작 가로채기 -------------------------------------------------
       카드덱 범위가 켜져 있으면 본 함수 대신 startByScope 로 보낸다. 후처리가
       아니라 "본 함수를 부를지 말지"를 정하는 분기이고, 호출부가 index.html 의
       onclick 과 v944 (window.startExprStudyWithMode?.(mode)) 양쪽이라 이벤트
       위임으로도 대체할 수 없다. → 채널 추가 필요. */
    overrideOnce('startStudySession', function (base) {
      return async function () {
        var kind = state.uiKind;
        var handled = await startByScope(kind, activeMode(kind));
        if (handled !== null && handled !== undefined) return handled;
        if (scopeFor(kind) === 'deck' || kind === 'grammar') return handled;
        return base.apply(this, arguments);
      };
    });
    overrideOnce('startVocabStudyWithMode', function (base) {
      return async function (mode) {
        if (state.uiKind === 'vocab' && scopeFor('vocab') === 'deck') return startByScope('vocab', mode);
        return base.apply(this, arguments);
      };
    });
    overrideOnce('startExprStudyWithMode', function (base) {
      return async function (mode) {
        if (state.uiKind === 'grammar') return startByScope('grammar', mode);
        if (state.uiKind === 'expr' && scopeFor('expr') === 'deck') return startByScope('expr', mode);
        return base.apply(this, arguments);
      };
    });
    overrideOnce('startPVStudyWithMode', function (base) {
      return async function (mode) {
        if (state.uiKind === 'phrasal' && scopeFor('phrasal') === 'deck') return startByScope('phrasal', mode);
        return base.apply(this, arguments);
      };
    });
    overrideOnce('quickStartMode', function (base) {
      return async function (type, mode) {
        var kind = (state.uiKind === 'grammar' && type === 'expr') ? 'grammar' : type;
        if (kind === 'grammar') return startByScope('grammar', mode);
        if (scopeFor(kind) === 'deck') return startByScope(kind, mode);
        return base.apply(this, arguments);
      };
    });

    /* --- 세션 기록에 카드덱 정보 덧붙이기 -----------------------------------
       본 함수 호출 "전"에 인자를 보강하는 전처리라 후처리 훅으로 옮길 수 없다.
       → 채널 추가 필요 (beforeSaveSession transform). */
    overrideOnce('saveSession', function (base) {
      return async function (record) {
        record = record || {};
        if (state.sessionDeck) {
          record.deckId = state.sessionDeck.id; record.deckName = state.sessionDeck.name;
          record.deckKind = state.sessionDeck.kind; record.deckGeneration = state.sessionDeck.generation;
        }
        if (state.sessionKind) record.contentKind = state.sessionKind;
        return base.call(this, record);
      };
    });

    /* --- 플래시카드 후처리 ---------------------------------------------------
       순수 후처리지만 index.html 에 대응 채널이 없다. → 채널 추가 필요
       (afterShowCard / afterShowExprCard). */
    overrideOnce('showExprCard', function (base) {
      return function () { var result = base.apply(this, arguments); setTimeout(function () { ensureLegacyFlashcardControls(); updateLegacyNavButtons(); decorateExpressionBack(); }, 0); return result; };
    });
    overrideOnce('showCard', function (base) {
      return function () { var result = base.apply(this, arguments); setTimeout(function () { ensureLegacyFlashcardControls(); updateLegacyNavButtons(); }, 0); return result; };
    });
  }

  function bindEvents() {
    if (document.documentElement.dataset.cems932r3Bound === '1') return;
    document.documentElement.dataset.cems932r3Bound = '1';
    document.addEventListener('change', function (event) {
      var target = event.target;
      if (!target) return;
      if (target.id === 'cems932-kind') {
        state.managerKind = target.value; fillDynamicOptions(target.value); renderManager();
      } else if (target.id === 'cems932-deck-select') {
        if (target.value) { var deck = setActive(target.value, { activateScope:true, switchKind:true }); if (deck) state.managerKind = deck.kind; }
        else setScope(state.managerKind, 'filter', true);
      }
    });
    document.addEventListener('click', async function (event) {
      var button = event.target.closest && event.target.closest('[data-cems932-action]');
      if (!button) return;
      var action = button.dataset.cems932Action;
      if (action === 'open-manager') { event.preventDefault(); openManager(button.dataset.kind || state.uiKind); return; }
      if (action === 'close-manager') { closeManager(); return; }
      if (action === 'scope-filter') { setScope(state.managerKind || state.uiKind, 'filter', true); renderManager(); return; }
      if (action === 'quick') {
        var quick = managerConfig();
        quick.kind = state.managerKind || state.uiKind; quick.preset = button.dataset.preset || 'random';
        quick.name = ''; quick.level = ''; quick.source = ''; quick.frequency = 'all'; quick.masteryBand = ''; quick.size = 50; quick.sessionSize = 50;
        var deck = await createDeck(quick); if (deck) { state.managerKind = deck.kind; renderManager(); }
        return;
      }
      if (action === 'create') { var created = await createDeck(managerConfig()); if (created) { state.managerKind = created.kind; renderManager(); } return; }
      if (action === 'rotate') { var rotate = activeDeck(state.managerKind); if (rotate && scopeFor(state.managerKind) === 'deck') await rotateDeck(rotate.id, 0.25); else toast('먼저 카드덱을 선택하세요.'); return; }
      if (action === 'rebuild') { var rebuild = activeDeck(state.managerKind); if (rebuild && scopeFor(state.managerKind) === 'deck') await rebuildDeck(rebuild.id); else toast('먼저 카드덱을 선택하세요.'); return; }
      if (action === 'delete') {
        var remove = activeDeck(state.managerKind);
        if (remove && scopeFor(state.managerKind) === 'deck') {
          if (typeof showConfirm === 'function') showConfirm('카드덱 삭제', '"' + remove.name + '" 카드덱을 삭제할까요?\n카드 학습 기록은 유지됩니다.', function () { deleteDeck(remove.id); renderManager(); });
          else if (confirm(remove.name + ' 카드덱을 삭제할까요?')) { deleteDeck(remove.id); renderManager(); }
        } else toast('삭제할 카드덱이 없습니다.');
        return;
      }
      if (action === 'grammar-start') {
        event.preventDefault();
        var mode = button.dataset.mode || 'expr-fc', preset = button.dataset.preset || '';
        if (scopeFor('grammar') === 'deck' && !preset) return startByScope('grammar', mode);
        return startFilteredKind('grammar', mode, preset);
      }
    });
  }

  async function selfTest() {
    var report = { version:VERSION, build:BUILD, language:LANG, decks:loadStore().decks.length, checks:[] };
    for (var deck of loadStore().decks) {
      var resolved = await resolveDeck(deck), keys = resolved.items.map(function (row) { return keyOf(row, deck.kind); });
      report.checks.push({
        id:deck.id, kind:deck.kind, size:deck.size, resolved:resolved.items.length,
        unique:new Set(keys).size,
        validKind:deck.kind === 'grammar' ? resolved.items.every(isGrammar) : deck.kind === 'expr' ? resolved.items.every(function (row) { return !isGrammar(row); }) : true,
        ok:resolved.items.length === new Set(keys).size && resolved.items.length > 0
      });
    }
    report.dom = {
      legacyTopDeckPanel: !!document.querySelector('#cems932-deck-card,.cems932-deck-card'),
      legacyHomeDeckCard: !!document.querySelector('#cems932-home-deck,.cems932-home-deck'),
      injectedHomeDashboard: !!document.querySelector('#cems-lean-home-card,#zh-home-card,#cems-ux25-home-tools'),
      manager: !!document.getElementById(MODAL_ID),
      grammarHome: !!document.getElementById('home-grammar'),
      compactHome: !!document.querySelector('#home-vocab > .cems932-home-more'),
      flashcardControls: ['fc-prev-btn','fc-next-btn','fc-speak-btn','fc-bookmark-btn','fc-edit-btn','fc-exit-btn','fc-production-btn','fc-tag-btn'].every(function (id) { return !!document.getElementById(id); }),
      expressionControls: ['expr-fc-prev-btn','expr-fc-next-btn','expr-fc-speak-btn','expr-fc-bookmark-btn','expr-fc-edit-btn','expr-fc-exit-btn','expr-fc-production-btn','expr-fc-tag-btn'].every(function (id) { return !!document.getElementById(id); }),
      flipCompatibility: !!(window.flipCard && window.flipCard.__cems932Compat && window.flipExprCard && window.flipExprCard.__cems932Compat)
    };
    report.ok = report.checks.every(function (check) { return check.ok && check.validKind; }) && !report.dom.legacyTopDeckPanel && !report.dom.legacyHomeDeckCard && !report.dom.injectedHomeDashboard && report.dom.manager && report.dom.compactHome && report.dom.flashcardControls && report.dom.expressionControls && report.dom.flipCompatibility;
    return report;
  }

  async function init() {
    if (state.installed) return;
    state.installed = true;
    loadStore();
    cleanupLegacyDeckPanels();
    ensureManager();
    bindEvents();
    installWrappers();
    installFlashcardCompatibility();
    installGrammarTabs(); installGrammarHome(); installHomeScopeButtons(); cleanupLegacyDeckPanels();
    applyKindUi();
    ensureLegacyFlashcardControls();
    await renderAll();
    document.documentElement.dataset.cemsVersion = BUILD;
    document.documentElement.dataset.cemsBuild = BUILD;
    var bodyObserverToken = 0;
    var bodyObserver = new MutationObserver(function (records) {
      if (!records.some(function (record) { return record.addedNodes && record.addedNodes.length; })) return;
      clearTimeout(bodyObserverToken);
      bodyObserverToken = setTimeout(function () {
        cleanupLegacyDeckPanels();
        installGrammarTabs(); installGrammarHome(); installHomeScopeButtons();
        ensureDockIntegration(); installFlashcardCompatibility();
      }, 140);
    });
    bodyObserver.observe(document.body, { childList:true, subtree:true });
  }

  window.CEMS932Decks = {
    VERSION:VERSION, BUILD:BUILD,
    loadStore:loadStore, createDeck:createDeck, rotateDeck:rotateDeck, rebuildDeck:rebuildDeck,
    deleteDeck:deleteDeck, setActive:setActive, setScope:setScope, scopeFor:scopeFor,
    startDeck:startDeck, startFilteredKind:startFilteredKind, activeDeck:activeDeck,
    isGrammar:isGrammar, openManager:openManager, closeManager:closeManager,
    activateKind:activateKind, selfTest:selfTest, refresh:renderAll, _finalRandomRotation:randomRotation,
    /* v9.5: 다른 모듈(cems-9.4.1-ui.js)이 "지금 문법 탭인가"를 알아야 하는데,
       deck-groups 가 문법을 'expr' 전환으로 바꿔 실행하므로 훅 인자만으로는 알 수 없다.
       전역 함수를 감싸는 대신 현재 표시 종류를 읽을 수 있게 노출한다. */
    uiKind: function () { return state.uiKind; },
    installFlashcardCompatibility:installFlashcardCompatibility, flipCardCompat:flipCardCompat, flipExprCardCompat:flipExprCardCompat
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 360); });
  else setTimeout(init, 360);
  /* v9.5: [900, 2200]ms 재설치 루프 제거.
     이 루프의 목적은 "다른 모듈이 내 래퍼를 덮어썼을 때 다시 감싸기"였는데,
     그 덮어쓰기 자체가 재설치 루프 때문에 생긴 문제였다(showPage 13겹).
     이제 훅은 멱등이고 나머지 가로채기는 모듈 스코프 플래그로 1회만 설치되므로
     반복이 필요 없다. DOM 재삽입은 init 의 MutationObserver 가 계속 지켜본다. */
})();
