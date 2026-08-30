/* CEMS Chinese PWA 9.4.4 — lossless JSON library importer.
 * Large files are parsed off the UI thread. Every source row is retained in
 * `raw`; study-facing fields are additionally normalised into a complete
 * detail model so vocabulary, expressions, grammar and examples can use all
 * available information without destructively merging source files.
 */
'use strict';

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

let active = null;
let cancelled = false;
let waitingAck = null;

/* 9.4.4: TYPE_ALIASES / SUPERSCRIPT_DIGITS 는 공통 코어(CEMS_TYPE_PATH_PATTERNS,
   CEMS_SUPERSCRIPT_DIGITS)로 옮겨 폴백 파서와 하나만 남겼다. */

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function first(obj, keys) {
  if (!isObject(obj)) return '';
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  const lower = new Map(Object.keys(obj).map((key) => [key.toLowerCase(), key]));
  for (const key of keys) {
    const actual = lower.get(String(key).toLowerCase());
    if (actual && obj[actual] !== undefined && obj[actual] !== null && obj[actual] !== '') return obj[actual];
  }
  return '';
}

function textValue(value) {
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(' / ');
  if (isObject(value)) {
    for (const key of ['ko','korean','text','value','meaning','translation','definition','zh','traditional']) {
      if (value[key] !== undefined && value[key] !== null && value[key] !== '') return textValue(value[key]);
    }
    return Object.values(value).filter((item) => typeof item === 'string').map(clean).filter(Boolean).slice(0, 4).join(' / ');
  }
  return clean(value);
}

function listValue(value, preserveObjects = false) {
  if (Array.isArray(value)) {
    if (preserveObjects) return value.filter((item) => item != null);
    return value.flatMap((item) => listValue(item, false));
  }
  if (isObject(value)) return preserveObjects ? [value] : Object.values(value).flatMap((item) => listValue(item, false));
  /* 9.4.4: 구분자를 공통 코어로 통일했다(전각 ， ； 、 포함).
     예전에는 Worker 가 반각만 잘라 폴백과 리스트가 달라졌다. */
  return cemsImportSplitList(value);
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const key = typeof value === 'string' ? clean(value) : JSON.stringify(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(typeof value === 'string' ? clean(value) : value);
  }
  return out;
}

/* 9.4.4: 해시·정규화는 공통 코어 하나만 쓴다(폴백 파서와 반드시 같아야 한다). */
function fnv1a(input) { return cemsImportHash(input); }

function normalizeSenseText(value) { return cemsImportSenseText(value); }

/* 9.4.4: 타입 판정은 공통 코어 하나만 쓴다. 예전에는 Worker 가
   word→expression→grammar→example, 폴백이 grammar→expression→example→word
   순서로 봐서 같은 배열이 다른 타입으로 저장됐다. */
function classifyArray(path, records) {
  return cemsImportTypeOf(Array.isArray(path) ? path.join('.') : path, records);
}

function discoverCollections(root) {
  const found = [];
  const seenArrays = new Set();
  const seenObjects = new WeakSet();
  function visit(value, path, depth) {
    if (value == null || depth > 7) return;
    if (Array.isArray(value)) {
      if (seenArrays.has(value)) return;
      seenArrays.add(value);
      const type = classifyArray(path, value);
      if (type && value.some(isObject)) {
        found.push({type, path: path.join('.'), records: value});
        return;
      }
      if (depth < 5) value.slice(0, 32).forEach((item, index) => visit(item, path.concat(String(index)), depth + 1));
      return;
    }
    if (!isObject(value) || seenObjects.has(value)) return;
    seenObjects.add(value);
    for (const [key, child] of Object.entries(value)) visit(child, path.concat(key), depth + 1);
  }
  /* 9.4.4: 최상위가 배열인 JSON 을 폴백 파서와 같은 규칙으로 처리한다.
     예전 Worker 는 여기서 컬렉션을 못 찾고 "가져올 수 있는 배열이 없습니다" 로
     실패했는데, 같은 파일이 폴백 경로에서는 word 로 들어갔다. */
  if (Array.isArray(root)) {
    if (!root.some(isObject)) return [];
    return [{type: cemsImportRootArrayType(root), path: 'root', records: root}];
  }
  visit(root, [], 0);
  const uniqueCollections = [];
  const signatures = new Set();
  for (const collection of found.sort((a, b) => b.records.length - a.records.length)) {
    const signature = `${collection.type}:${collection.records.length}:${collection.path.split('.').slice(-1)[0]}`;
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    uniqueCollections.push(collection);
  }
  return uniqueCollections;
}

function detectMetadata(root, fileName, collections) {
  const meta = isObject(root?.meta) ? root.meta : isObject(root?.metadata) ? root.metadata : {};
  const source = isObject(root?.source) ? root.source : {};
  /* 9.4.4: schema/buildId/title/description/generatedAt 은 공통 코어로 뽑는다.
     sourceId 조합에 쓰이므로 폴백 파서와 반드시 같은 값이어야 한다. */
  const basics = cemsImportMetaBasics(root, fileName);
  const schema = basics.schema;
  const buildId = basics.buildId;
  const title = basics.title;
  const description = basics.description;
  const policyText = JSON.stringify({source, meta, provenance: root?.provenance, notes: root?.notes}).toLowerCase();
  const filenameText = fileName.toLowerCase();
  const curatedText = JSON.stringify({
    sourceOfTruth: source?.policy?.sourceOfTruth,
    sourceRecoveryPolicy: source?.policy?.sourceRecoveryPolicy,
    files: source?.files,
    textbook: source?.textbook,
  }).toLowerCase();
  let quality = '일반 외부 자료';
  let qualityRank = 1;
  if (/acc[1-6].*master|acc\s*\*_master|當代中文課程|sourceoftruth[^}]*acc|교과서|정합/.test(curatedText + ' ' + filenameText)) {
    quality = '교과서 정합형';
    qualityRank = 3;
  } else if (/fully[_ -]?populated|dictionary|editorial|auto|generated|heuristic|rule-based|자동|보강/.test(policyText + ' ' + filenameText)) {
    quality = '자동 보강형';
    qualityRank = 2;
  }
  const counts = {word: 0, expression: 0, grammar: 0, example: 0};
  for (const collection of collections) counts[collection.type] += collection.records.length;
  return {
    schema,
    buildId,
    title,
    description,
    quality,
    qualityRank,
    counts,
    generatedAt: basics.generatedAt,
    policy: source?.policy || null,
    files: source?.files || null,
  };
}

function deriveAcc(tags, raw) {
  const lessons = unique([
    ...listValue(raw.lessons),
    ...listValue(raw.sourceLessons),
    ...listValue(raw.lesson),
    ...listValue(raw.Lesson),
  ]);
  const allParts = [...tags, ...lessons, textValue(raw.book), textValue(raw.textbook), textValue(raw.course), textValue(raw.volume)].filter(Boolean);
  const all = allParts.join(' ');
  const lessonMatch = all.match(/ACC\s*([1-6])\s*[-_: ]?\s*L(?:ESSON)?\s*0*([0-9]{1,2})/i);
  const bookMatch = lessonMatch || all.match(/ACC\s*([1-6])/i);
  const rawBook = textValue(first(raw, ['book','textbook','course','volume','sourceBook','source_book']));
  const rawLesson = textValue(first(raw, ['lesson','unit','chapter','lessonNo','lesson_no','unitNo','unit_no'])) || lessons[0] || '';
  const rawLessonMatch = rawLesson.match(/ACC\s*([1-6])\s*[-_: ]?\s*L(?:ESSON)?\s*0*([0-9]{1,2})/i);
  const book = bookMatch ? `ACC ${bookMatch[1]}` : rawBook;
  const lessonNumber = lessonMatch?.[2] || rawLessonMatch?.[2];
  const lesson = lessonNumber ? `L${String(Number(lessonNumber)).padStart(2, '0')}` : rawLesson;
  return {book, lesson, lessons};
}

function exampleObject(zh, pinyin, ko, en, simplified = '') {
  const item = {
    zh: textValue(zh),
    simplified: textValue(simplified),
    pinyin: textValue(pinyin),
    ko: textValue(ko),
    en: textValue(en),
  };
  return item.zh || item.ko || item.en ? item : null;
}

function buildExamples(raw, type) {
  const examples = [];
  if (type === 'word') {
    examples.push(exampleObject(raw.Example_CHT || raw.Example || raw.example, raw.Example_Pinyin, raw.Example_KO, raw.Example_EN));
  } else if (type === 'expression') {
    examples.push(exampleObject(raw.Example1, raw.Example1_Pinyin, raw.Example1_KO, raw.Example1_EN));
    examples.push(exampleObject(raw.Example2, raw.Example2_Pinyin, raw.Example2_KO, raw.Example2_EN));
  } else if (type === 'grammar') {
    examples.push(exampleObject(raw.Example1, raw.Example1_Pinyin, raw.Example1_KO, raw.Example1_EN));
    examples.push(exampleObject(raw.Example2, raw.Example2_Pinyin, raw.Example2_KO, raw.Example2_EN));
    const zh = Array.isArray(raw.grammarExamples) ? raw.grammarExamples : listValue(raw.grammarExamples);
    const py = Array.isArray(raw.grammarExamplePinyin) ? raw.grammarExamplePinyin : listValue(raw.grammarExamplePinyin);
    const ko = Array.isArray(raw.grammarExampleTranslationsKO) ? raw.grammarExampleTranslationsKO : listValue(raw.grammarExampleTranslationsKO);
    const en = Array.isArray(raw.grammarExampleTranslationsEN) ? raw.grammarExampleTranslationsEN : listValue(raw.grammarExampleTranslationsEN);
    zh.forEach((sentence, index) => examples.push(exampleObject(sentence, py[index], ko[index], en[index])));
  } else if (type === 'example') {
    examples.push(exampleObject(
      raw.textTraditional || raw.targetText || raw.text || raw.zh,
      raw.pinyin,
      raw.translationKo || raw.ko,
      raw.translationEn || raw.en,
      raw.textSimplified,
    ));
  }
  const out = [];
  const seen = new Set();
  for (const item of examples.filter(Boolean)) {
    const key = clean(item.zh || item.ko || item.en);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizeRecord(record, type, index, sourceInfo) {
  const raw = isObject(record) ? record : {value: record};
  /* 9.4.4: mergeKey 에 들어가는 필드 후보는 공통 코어(CEMS_FIELD_KEYS)를 쓴다. */
  const front = textValue(type === 'word'
    ? first(raw, CEMS_FIELD_KEYS.wordFront)
    : type === 'example'
      ? first(raw, CEMS_FIELD_KEYS.exampleFront)
      : first(raw, CEMS_FIELD_KEYS.otherFront));
  const simplified = textValue(first(raw, ['Simplified_CH','Simplified','textSimplified','simplified','simp']));
  /* 9.4.4: 'Example_Pinyin' 을 뺐다. Pinyin 이 없는 행에서 예문의 병음이
     단어 병음으로 저장돼, 타이핑/받아쓰기 정답이 예문 병음이 되는 문제가 있었다.
     (폴백 파서도 같은 후보 목록을 쓴다.) */
  const pinyin = textValue(first(raw, CEMS_FIELD_KEYS.pinyin));
  const meaning = textValue(first(raw, CEMS_FIELD_KEYS.meaningKo));
  const meaningEn = textValue(first(raw, ['Meaning_EN','meaningEn','translationEn','english','en']));
  const tags = unique([
    ...listValue(first(raw, ['tags','tag','labels','categories','groups'])),
    ...listValue(raw.Style_Tags),
    ...listValue(raw.sourceTypes),
    ...listValue(raw.lessons),
  ]);
  const acc = deriveAcc(tags, raw);
  const pos = textValue(first(raw, CEMS_FIELD_KEYS.pos));
  const functionText = textValue(first(raw, ['Function','function','usage','explanation','description']));
  const structure = textValue(first(raw, CEMS_FIELD_KEYS.structure));
  const grammarPoint = textValue(first(raw, CEMS_FIELD_KEYS.grammarPoint));
  const examples = buildExamples(raw, type);
  const relations = {
    synonyms: unique(listValue(first(raw, ['Synonym_CHT','Synonyms','synonyms']))),
    antonyms: unique(listValue(first(raw, ['Antonym_CHT','Antonyms','antonyms']))),
    collocations: unique(listValue(first(raw, ['Collocation_CHT','Key_Collocation','Collocation','collocations']))),
    variants: unique(listValue(first(raw, ['Variants_CHT','Variants','variants']))),
    measures: unique(listValue(first(raw, ['Measure_CHT','Classifier','Measure','classifiers']))),
    similar: unique(listValue(first(raw, ['Similar_Expr','Alternatives','Formal_Equivalent','similar']))),
  };
  const levels = {
    hsk: textValue(first(raw, ['HSK','HSK_Level','HSK_Exact'])),
    tocfl: textValue(first(raw, ['TOCFL','TOCFL_Level'])),
    tbcl: textValue(first(raw, ['TBCL_Level','TBCL','TBCL_Grammar_Level'])),
    tbclBand: textValue(raw.TBCL_Band),
    tbclSequence: raw.TBCL_Sequence ?? '',
    cefr: textValue(raw.CEFR),
    register: textValue(first(raw, ['Register','Formality'])),
    formality: textValue(first(raw, ['Formality','Register'])),
    medium: textValue(raw.Medium),
    frequency: textValue(raw.Frequency),
    priority: textValue(raw.Priority),
    currency: textValue(raw.Currency),
    topic: textValue(first(raw, ['Topic_Primary','Topic','topic'])),
    l1: textValue(raw.L1),
    l2: textValue(raw.L2),
    l3: textValue(raw.L3),
  };
  const notes = {
    styleTags: textValue(raw.Style_Tags),
    commonError: textValue(raw.Common_Error),
    note: textValue(first(raw, ['비고','Notes','Note','Source_Note'])),
  };
  const acceptedAnswers = unique(listValue(raw.acceptedAnswers).concat([front, simplified].filter(Boolean)));
  const sourceRefs = listValue(raw.sourceRefs, true);
  const sourceTypes = unique(listValue(raw.sourceTypes));
  const audioRefs = unique(listValue(raw.audioRefs));
  /* 9.4.4(항목 27): 예전 `keySeed || fnv1a(...)` 는 keySeed 가 최악의 경우에도
     "||" (truthy) 여서 해시 폴백이 절대 실행되지 않았고, front/pinyin/pos 가 전부
     빈 행이 모두 `word:||` 하나로 병합돼 사라졌다.
     공통 코어가 "시드가 실제로 비었는지"를 판정한다. */
  const mergeKey = cemsImportMergeKey(type, {front, pinyin, pos, structure, grammarPoint}, raw);
  const originalId = textValue(first(raw, CEMS_FIELD_KEYS.originalId));
  const id = cemsImportItemId(sourceInfo.id, type, originalId, mergeKey, index);
  const safeFront = front || examples[0]?.zh || `(내용 ${index + 1})`;
  const safeMeaning = meaning || examples[0]?.ko || functionText || meaningEn;
  return {
    id,
    sourceId: sourceInfo.id,
    sourceTitle: sourceInfo.title,
    sourceQuality: sourceInfo.quality,
    qualityRank: sourceInfo.qualityRank,
    type,
    mergeKey,
    front: safeFront,
    simplified,
    pinyin,
    meaning: safeMeaning,
    meaningEn,
    pos,
    function: functionText,
    structure,
    grammarPoint,
    examples,
    relations,
    levels,
    notes,
    tags,
    book: acc.book,
    lesson: acc.lesson,
    lessons: acc.lessons,
    acceptedAnswers,
    sourceRefs,
    sourceTypes,
    audioRefs,
    importedAt: Date.now(),
    raw,
  };
}

async function analyzeFile(file) {
  cancelled = false;
  const text = await file.text();
  if (cancelled) return;
  let root;
  try { root = JSON.parse(text); }
  catch (error) { throw new Error(`JSON 문법 오류: ${error.message}`); }

  const schemaText = textValue(root?.schemaVersion || root?.schema || root?.format || root?.meta?.schema || root?.metadata?.schema);
  if (/cems-routine-1/i.test(schemaText) || (Array.isArray(root?.stages) && /routine/i.test(schemaText + file.name))) {
    active = {kind: 'routine', root, file, meta: {schema: schemaText || 'cems-routine-1', title: textValue(root.title || root.name || file.name)}};
    postMessage({action: 'analyzed', kind: 'routine', fileName: file.name, fileSize: file.size, meta: active.meta, counts: {word:0,expression:0,grammar:0,example:0}, total: Array.isArray(root.stages) ? root.stages.length : 1});
    return;
  }

  const collections = discoverCollections(root);
  if (!collections.length) throw new Error('가져올 수 있는 단어·표현·문법·예문 배열을 찾지 못했습니다.');
  const meta = detectMetadata(root, file.name, collections);
  /* 자료 id 조합도 공통 코어. 같은 파일이면 폴백 경로와 같은 id 가 나온다. */
  const sourceId = cemsImportSourceId({fileName: file.name, fileSize: file.size, schema: meta.schema, buildId: meta.buildId, generatedAt: meta.generatedAt, title: meta.title});
  const source = {
    id: sourceId,
    title: meta.title,
    description: meta.description,
    schema: meta.schema,
    buildId: meta.buildId,
    quality: meta.quality,
    qualityRank: meta.qualityRank,
    fileName: file.name,
    fileSize: file.size,
    counts: meta.counts,
    generatedAt: meta.generatedAt,
    policy: meta.policy,
    files: meta.files,
    importedAt: Date.now(),
    importerVersion: '9.4.4',
  };
  active = {kind: 'library', root, file, collections, meta, source};
  postMessage({
    action: 'analyzed',
    kind: 'library',
    sourceId,
    fileName: file.name,
    fileSize: file.size,
    meta,
    counts: meta.counts,
    total: Object.values(meta.counts).reduce((sum, value) => sum + Number(value || 0), 0),
    paths: collections.map((collection) => ({type: collection.type, path: collection.path, count: collection.records.length})),
  });
}

/* 9.4.4(항목 29): ack 데드락 방지.
   메인이 saveBatch 중 throw 하면 예전에는 ack 가 오지 않아 여기서 영구 정지했다.
   이제 메인은 실패해도 ok:false 로 ack 를 보내고, 그마저 못 보내는 상황(탭 정지,
   메인 예외)에 대비해 타임아웃을 둔다. */
const ACK_TIMEOUT_MS = 30000;

function waitForAck(batchId) {
  return new Promise((resolve) => {
    let timer = 0;
    const settle = (result) => {
      if (timer) { clearTimeout(timer); timer = 0; }
      if (waitingAck && waitingAck.batchId === batchId) waitingAck = null;
      resolve(result);
    };
    waitingAck = {batchId, resolve: settle};
    timer = setTimeout(() => settle({timedOut: true}), ACK_TIMEOUT_MS);
  });
}

async function streamImport() {
  if (!active) throw new Error('먼저 JSON 파일을 분석해야 합니다.');
  cancelled = false;
  if (active.kind === 'routine') {
    postMessage({action: 'routine', routine: active.root, fileName: active.file.name});
    return;
  }
  const total = Object.values(active.meta.counts).reduce((sum, value) => sum + Number(value || 0), 0);
  let processed = 0;
  let batchNo = 0;
  const batchSize = 120;
  postMessage({action: 'source', source: active.source});
  for (const collection of active.collections) {
    for (let start = 0; start < collection.records.length; start += batchSize) {
      if (cancelled) {
        postMessage({action: 'cancelled', processed, total});
        return;
      }
      const items = collection.records.slice(start, start + batchSize).map((record, offset) => normalizeRecord(record, collection.type, start + offset, active.source));
      const batchId = `${active.source.id}:${batchNo++}`;
      postMessage({action: 'batch', batchId, items, processed, total});
      const ack = await waitForAck(batchId);
      if (ack && ack.timedOut) {
        postMessage({action: 'error', message: '저장 응답이 없어 가져오기를 중단했습니다.', stack: ''});
        return;
      }
      if (ack && ack.ok === false) {
        postMessage({action: 'cancelled', processed, total, reason: ack.reason || '저장 실패'});
        return;
      }
      if (cancelled) {
        postMessage({action: 'cancelled', processed, total});
        return;
      }
      processed += items.length;
      postMessage({action: 'progress', processed, total});
    }
  }
  postMessage({action: 'complete', sourceId: active.source.id, processed, total});
}

self.addEventListener('message', async (event) => {
  const message = event.data || {};
  try {
    if (message.action === 'analyze') await analyzeFile(message.file);
    else if (message.action === 'import') await streamImport();
    else if (message.action === 'ack' && waitingAck && waitingAck.batchId === message.batchId) {
      const {resolve} = waitingAck;
      waitingAck = null;
      /* ok:false 는 "저장 실패했으니 중단하라"는 신호다(예전에는 이 경로가 없어
         메인이 실패하면 Worker 가 그대로 멈춰 있었다). */
      resolve({ok: message.ok !== false, reason: message.reason || ''});
    } else if (message.action === 'cancel') {
      cancelled = true;
      if (waitingAck) {
        const {resolve} = waitingAck;
        waitingAck = null;
        resolve({ok: true, cancelled: true});
      }
    }
  } catch (error) {
    postMessage({action: 'error', message: error?.message || String(error), stack: error?.stack || ''});
  }
});
