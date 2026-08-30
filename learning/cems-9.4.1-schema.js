/* CEMS v9.4.1 — Canonical content schema (cems-seed-3)
 * ---------------------------------------------------------------------------
 * 이 파일이 "데이터를 받는 열 이름"의 유일한 기준입니다.
 * 데이터셋을 새로 만들 때는 FIELDS.vocabulary / FIELDS.expression / FIELDS.grammar
 * / FIELDS.example 의 canonical 이름을 그대로 사용하십시오.
 *
 * 설계 원칙
 *  1) 저장소 키는 절대 변경하지 않는다 (words=Traditional_CH, expressions=Expression).
 *  2) 문법은 expressions 스토어를 공유하되 contentKind='grammar' 로 반드시 구분한다.
 *  3) 학습 진행 상태(FSRS 등)는 콘텐츠 데이터에 포함하지 않는다. 앱이 생성한다.
 *  4) 별칭(alias)은 읽기 전용 호환용이며, 정규화 시 canonical 로 접힌다.
 * ==========================================================================*/
(function () {
  'use strict';

  var VERSION = '9.4.1';
  var SEED_SCHEMA = 'cems-seed-3';

  function text(v) { return String(v == null ? '' : v).trim(); }
  function arr(v) {
    if (Array.isArray(v)) return v.map(text).filter(Boolean);
    var s = text(v);
    if (!s) return [];
    return s.split(/\s*[;,|]\s*/).map(text).filter(Boolean);
  }
  function unique(list) {
    var seen = Object.create(null), out = [];
    (list || []).forEach(function (v) { var k = text(v); if (k && !seen[k]) { seen[k] = 1; out.push(k); } });
    return out;
  }

  /* ---- 필드 등급 -----------------------------------------------------------
   * required : 없으면 행이 버려진다
   * core     : 학습 화면이 직접 읽는다. 비면 해당 모드가 출제되지 않는다
   * meta     : 필터/분류에 쓰인다
   * extra    : 보관용. 앱은 읽지 않지만 유지된다
   * -------------------------------------------------------------------------*/
  var FIELDS = {
    vocabulary: {
      store: 'words',
      keyPath: 'Traditional_CH',
      contentKind: 'vocab',
      required: ['Traditional_CH', 'Meaning_KO'],
      core: [
        'Simplified_CH', 'Pinyin', 'POS', 'Meaning_KO', 'Meaning_EN',
        'Example_CHT', 'Example_Pinyin', 'Example_KO', 'Example_EN',
        'Collocation_CHT', 'Synonym_CHT', 'Antonym_CHT', 'Measure_CHT', 'Variants_CHT'
      ],
      meta: [
        'HSK', 'TOCFL', 'TBCL_Level', 'CEFR',
        'Register', 'Medium', 'Frequency', 'Priority',
        'Topic_Primary', 'Style_Tags', 'Common_Error', '비고', 'tags',
        'sourceVolumes', 'sourceLessons'
      ],
      extra: ['Freq_Overall_Rank', 'Freq_Written_Rank', 'Freq_Spoken_Rank', 'Source_Ref'],
      alias: {
        Headword_CHT: 'Traditional_CH', Word: 'Traditional_CH', word: 'Traditional_CH',
        Traditional: 'Traditional_CH', Simplified: 'Simplified_CH',
        Pinyin_Source: 'Pinyin', POS_KO: 'POS',
        Definition_KO: 'Meaning_KO', Translation_KO: 'Meaning_KO',
        Example_Sentence: 'Example_CHT', Short_Example_CHT: 'Example_CHT',
        Short_Example_KO: 'Example_KO', Example_Gloss_KO: 'Example_KO',
        Short_Example_Pinyin: 'Example_Pinyin', Pinyin_Example: 'Example_Pinyin',
        Sentence_Pinyin: 'Example_Pinyin',
        HSK_Level: 'HSK', HSK_Exact: 'HSK', TOCFL_Level: 'TOCFL',
        TBCL: 'TBCL_Level', TBCL_Grammar_Level: 'TBCL_Level',
        Key_Collocation: 'Collocation_CHT',
        Register_Class: 'Register', Frequency_Band: 'Frequency', Study_Priority: 'Priority',
        sourceVolume: 'sourceVolumes', sourceLesson: 'sourceLessons', Volume: 'sourceVolumes', Lesson: 'sourceLessons'
      }
    },

    expression: {
      store: 'expressions',
      keyPath: 'Expression',
      contentKind: 'expression',
      required: ['Expression', 'Meaning_KO'],
      core: [
        'Meaning_KO', 'Meaning_EN', 'Function',
        'Example1', 'Example1_Pinyin', 'Example1_KO',
        'Example2', 'Example2_Pinyin', 'Example2_KO',
        'Similar_Expr'
      ],
      meta: [
        'L1', 'L2', 'L3',
        'Formality', 'Currency', 'Medium', 'Register',
        'HSK', 'Frequency', 'Priority',
        'Style_Tags', 'Common_Error', 'tags',
        'sourceVolumes', 'sourceLessons'
      ],
      extra: ['Source_Ref'],
      alias: {
        Expr: 'Expression', Title_CHT: 'Expression',
        Function_KO: 'Function', Definition_KO: 'Meaning_KO',
        Example: 'Example1', Example_CHT: 'Example1', Example_KO: 'Example1_KO',
        Example_Pinyin: 'Example1_Pinyin',
        Alternatives: 'Similar_Expr', Formal_Equivalent: 'Similar_Expr',
        HSK_Level: 'HSK', HSK_Exact: 'HSK',
        Register_Class: 'Register', Frequency_Band: 'Frequency', Study_Priority: 'Priority',
        sourceVolume: 'sourceVolumes', sourceLesson: 'sourceLessons', Volume: 'sourceVolumes', Lesson: 'sourceLessons'
      }
    },

    /* 문법은 expressions 스토어를 공유한다. Expression 이 키이며 문형 원문이 들어간다. */
    grammar: {
      store: 'expressions',
      keyPath: 'Expression',
      contentKind: 'grammar',
      required: ['Expression', 'Meaning_KO'],
      core: [
        'Grammar_Point', 'Structure_CHT',
        'Meaning_KO', 'Meaning_EN', 'Function',
        'Example1', 'Example1_Pinyin', 'Example1_KO',
        'Example2', 'Example2_Pinyin', 'Example2_KO',
        'grammarExamples', 'grammarExamplePinyin',
        'grammarExampleTranslationsKO', 'grammarExampleTranslationsEN'
      ],
      meta: [
        'L1', 'L2', 'L3',
        'TBCL_Level', 'TBCL_Band', 'TBCL_Sequence', 'HSK', 'CEFR',
        'Formality', 'Currency', 'Medium', 'Register',
        'Frequency', 'Priority', 'Style_Tags', 'Common_Error', 'tags',
        'sourceVolumes', 'sourceLessons'
      ],
      extra: ['Source_Ref', 'Source_Note'],
      alias: {
        Grammar: 'Grammar_Point', Pattern_CHT: 'Structure_CHT', Structure: 'Structure_CHT',
        Title_CHT: 'Expression', Function_KO: 'Function',
        Example: 'Example1', Example_CHT: 'Example1', Example_KO: 'Example1_KO',
        Example_Pinyin: 'Example1_Pinyin',
        TBCL: 'TBCL_Level', TBCL_Grammar_Level: 'TBCL_Level',
        HSK_Level: 'HSK', HSK_Exact: 'HSK',
        sourceVolume: 'sourceVolumes', sourceLesson: 'sourceLessons'
      }
    },

    example: {
      store: 'examples',
      keyPath: 'id',
      required: ['id', 'targetText'],
      core: ['textTraditional', 'textSimplified', 'pinyin', 'translationKo', 'translationEn', 'acceptedAnswers'],
      meta: ['sourceTypes', 'sourceRefs', 'lessons', 'tags', 'audioRefs', 'updatedAt'],
      extra: [],
      alias: {
        cht: 'textTraditional', chs: 'textSimplified',
        ko: 'translationKo', en: 'translationEn'
      }
    }
  };

  /* 배열로 저장되는 필드 */
  var ARRAY_FIELDS = {
    tags: 1, userExamples: 1, userCollocations: 1, sourceOccurrences: 1,
    sourceVolumes: 1, sourceLessons: 1,
    grammarExamples: 1, grammarExamplePinyin: 1,
    grammarExampleTranslationsKO: 1, grammarExampleTranslationsEN: 1,
    acceptedAnswers: 1, sourceTypes: 1, sourceRefs: 1, lessons: 1, audioRefs: 1, speakers: 1
  };

  /* 앱이 생성하고 관리하는 진행 상태. 데이터셋에 넣지 말 것. */
  var PROGRESS_FIELDS = [
    'starred', 'needsProduction', 'reviewCount', 'correctCount', 'mastery',
    'wrongCount', 'consecutiveWrong', 'lastWrongDate', 'stability', 'difficulty',
    'interval', 'nextReview', 'lastReview', 'fsrsState', 'lapses', 'reps',
    'leitnerBox', 'ease', 'addedDate', 'addSource', 'userExamples', 'userCollocations',
    'skillStates', 'productionStats', 'lastSeenAt', 'lastModifiedDate'
  ];

  function progressDefaults(now) {
    return {
      starred: false, needsProduction: false,
      reviewCount: 0, correctCount: 0, mastery: 0,
      wrongCount: 0, consecutiveWrong: 0, lastWrongDate: null,
      stability: null, difficulty: null, interval: 0,
      nextReview: null, lastReview: null, fsrsState: 0,
      lapses: 0, reps: 0, leitnerBox: 1, ease: 2.5,
      addedDate: now, addSource: 'seed',
      userExamples: [], userCollocations: []
    };
  }

  function allowedSet(kind) {
    var d = FIELDS[kind];
    if (!d) return null;
    var set = Object.create(null);
    ['required', 'core', 'meta', 'extra'].forEach(function (g) {
      (d[g] || []).forEach(function (f) { set[f] = 1; });
    });
    return set;
  }

  /**
   * 한 행을 canonical 스키마로 정규화한다.
   * @param {object} row  원본 행
   * @param {string} kind 'vocabulary' | 'expression' | 'grammar' | 'example'
   * @param {object} opts { keepUnknown:boolean, withProgress:boolean, now:string }
   */
  function normalizeRow(row, kind, opts) {
    opts = opts || {};
    var def = FIELDS[kind];
    if (!def || !row || typeof row !== 'object') return null;
    var alias = def.alias || {}, allow = allowedSet(kind), out = {};

    Object.keys(row).forEach(function (raw) {
      var key = Object.prototype.hasOwnProperty.call(alias, raw) ? alias[raw] : raw;
      var value = row[raw];
      if (ARRAY_FIELDS[key]) {
        out[key] = unique((out[key] || []).concat(arr(value)));
        return;
      }
      if (value === '' || value == null) return;
      if (out[key] !== undefined && text(out[key])) return; // canonical 우선, alias 는 보조
      if (typeof value === 'object') { out[key] = value; return; }
      out[key] = typeof value === 'number' || typeof value === 'boolean' ? value : text(value);
    });

    if (!opts.keepUnknown && allow) {
      Object.keys(out).forEach(function (k) {
        if (!allow[k] && !ARRAY_FIELDS[k] && k !== 'contentKind') delete out[k];
      });
    }

    if (kind !== 'example') out.contentKind = def.contentKind;

    if (opts.withProgress && kind !== 'example') {
      var base = progressDefaults(opts.now || new Date().toISOString());
      Object.keys(base).forEach(function (k) { if (out[k] === undefined) out[k] = base[k]; });
    }

    var missing = (def.required || []).filter(function (f) { return !text(out[f]); });
    if (missing.length) { out.__missing = missing; return out; }
    return out;
  }

  /** 행 배열 전체를 정규화하고 리포트를 돌려준다. */
  function normalizeAll(rows, kind, opts) {
    var ok = [], dropped = [], seen = Object.create(null);
    var keyPath = (FIELDS[kind] || {}).keyPath;
    (rows || []).forEach(function (row, index) {
      var out = normalizeRow(row, kind, opts);
      if (!out) { dropped.push({ index: index, reason: 'not-an-object' }); return; }
      if (out.__missing) { dropped.push({ index: index, reason: 'missing:' + out.__missing.join(',') }); return; }
      var key = text(out[keyPath]);
      if (key && seen[key]) { dropped.push({ index: index, key: key, reason: 'duplicate-key' }); return; }
      if (key) seen[key] = 1;
      ok.push(out);
    });
    return { rows: ok, dropped: dropped, kind: kind };
  }

  /* ---- 값 도메인 검사 (경고만, 행을 버리지 않음) ---------------------------*/
  var DOMAIN = {
    HSK: /^(?:[1-6]|7-9)$/,
    Register: /^(?:중립|구어체|문어체|격식)$/,
    Formality: /^(?:중립|구어체|문어체|격식)$/,
    Medium: /^(?:Spoken|Written|Both)$/i,
    Currency: /^(?:Current|Dated|Archaic)$/i,
    Frequency: /^K[1-6]$/i,
    Priority: /^P[1-3]$/i,
    TBCL_Level: /^[1-7]$/
  };
  function checkDomains(rows) {
    var bad = {};
    (rows || []).forEach(function (row) {
      Object.keys(DOMAIN).forEach(function (f) {
        var v = text(row[f]);
        if (v && !DOMAIN[f].test(v)) {
          bad[f] = bad[f] || {};
          bad[f][v] = (bad[f][v] || 0) + 1;
        }
      });
    });
    return bad;
  }

  /* ---- 문법 예문 접근자 -----------------------------------------------------
   * 기존 빌드는 grammarExamples 를 데이터에만 넣어두고 전혀 읽지 않았다.
   * 여기서 Example1/2 와 grammarExamples 를 하나의 목록으로 합쳐 노출한다.
   * -------------------------------------------------------------------------*/
  function grammarExampleList(row) {
    if (!row) return [];
    var cht = arr(row.grammarExamples);
    var ko = arr(row.grammarExampleTranslationsKO);
    var py = arr(row.grammarExamplePinyin);
    var en = arr(row.grammarExampleTranslationsEN);
    var out = [];
    [[row.Example1, row.Example1_Pinyin, row.Example1_KO],
     [row.Example2, row.Example2_Pinyin, row.Example2_KO]].forEach(function (t) {
      if (text(t[0])) out.push({ cht: text(t[0]), pinyin: text(t[1]), ko: text(t[2]), en: '', origin: 'example' });
    });
    cht.forEach(function (line, i) {
      if (!text(line)) return;
      out.push({ cht: text(line), pinyin: text(py[i]), ko: text(ko[i]), en: text(en[i]), origin: 'grammar' });
    });
    var seen = Object.create(null);
    return out.filter(function (x) { if (seen[x.cht]) return false; seen[x.cht] = 1; return true; });
  }

  function isGrammarRow(row) {
    if (!row) return false;
    if (row.contentKind === 'grammar') return true;
    if (text(row.Grammar_Point)) return true;
    if (text(row.L1) === '문법') return true;
    return arr(row.tags).some(function (t) { return /^(문법|grammar|tbcl문법)$/i.test(t); });
  }

  window.CEMS941Schema = {
    VERSION: VERSION,
    SEED_SCHEMA: SEED_SCHEMA,
    FIELDS: FIELDS,
    ARRAY_FIELDS: ARRAY_FIELDS,
    PROGRESS_FIELDS: PROGRESS_FIELDS,
    DOMAIN: DOMAIN,
    normalizeRow: normalizeRow,
    normalizeAll: normalizeAll,
    checkDomains: checkDomains,
    progressDefaults: progressDefaults,
    grammarExampleList: grammarExampleList,
    isGrammarRow: isGrammarRow,
    columns: function (kind) {
      var d = FIELDS[kind];
      if (!d) return [];
      return [].concat(d.required, d.core, d.meta).filter(function (v, i, a) { return a.indexOf(v) === i; });
    }
  };
})();
