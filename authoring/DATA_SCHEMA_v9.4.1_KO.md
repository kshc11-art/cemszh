# CEMS v9.4.1 데이터 스키마 (cems-seed-3)

이 문서의 열 이름이 앱이 실제로 읽는 유일한 기준입니다.
코드상의 정의는 `learning/cems-9.4.1-schema.js` 의 `FIELDS` 이며, 이 문서와 1:1로 일치합니다.

---

## 0. 대원칙

- **저장소 키는 절대 바꾸지 않습니다.**
  - 어휘 → IndexedDB `words`, keyPath = `Traditional_CH`
  - 표현·문법 → IndexedDB `expressions`, keyPath = `Expression`
  - 예문 → IndexedDB `examples`, keyPath = `id`
- **표현과 문법은 같은 스토어를 공유합니다.** 따라서 `Expression` 값이 겹치면 하나가 사라집니다. 반드시 `contentKind` 로 구분하십시오.
- **학습 진행 상태는 데이터셋에 넣지 마십시오.** `stability`, `nextReview`, `reviewCount`, `mastery`, `fsrsState`, `lapses`, `reps`, `leitnerBox`, `ease`, `starred`, `needsProduction` 등은 앱이 생성·관리합니다. v9.3.2 시드는 이것을 전부 담아 3.5MB를 낭비했습니다.
- 배열 필드는 JSON 배열로 넣거나 `;` `,` `|` 로 구분된 문자열로 넣으면 자동 분해됩니다.
- 빈 값은 열을 아예 생략하거나 `""` 로 두면 됩니다.

---

## 1. 어휘 (vocabulary) — `contentKind: "vocab"`

### 필수 (없으면 행이 버려짐)

| 열 | 설명 |
|---|---|
| `Traditional_CH` | **키.** 번체 표제어. 동형이의어는 뒤에 1, 2를 붙여 분리 |
| `Meaning_KO` | 한국어 뜻. 여러 뜻은 `;` 로 구분 |

### 핵심 (학습 화면이 직접 읽음)

| 열 | 없으면 생기는 일 |
|---|---|
| `Simplified_CH` | 간체↔번체 모드 미출제 |
| `Pinyin` | 타이핑·받아쓰기 모드 미출제 |
| `POS` | 품사 표시 없음. `noun`/`verb`/`adjective`/`adverb`/`measure`/`conjunction`/`preposition`/`particle` |
| `Meaning_EN` | 영어 뜻 미표시 |
| `Example_CHT` | 빈칸채우기 미출제 |
| `Example_Pinyin` | 예문 병음 미표시 |
| `Example_KO` | 예문 해석 미표시 |
| `Example_EN` | (선택) |
| `Collocation_CHT` | 연어 학습 모드 미출제. 2~4개를 `,` 로 구분 |
| `Synonym_CHT` / `Antonym_CHT` | 카드 세부정보에 미표시 |
| `Measure_CHT` | 양사 선택 모드 미출제 |
| `Variants_CHT` | 이표기 미표시 |

### 메타 (필터·분류)

| 열 | 허용 값 |
|---|---|
| `HSK` | `1` `2` `3` `4` `5` `6` `7-9` |
| `TOCFL` | `L1`~`L6` 또는 `N1`~ |
| `TBCL_Level` | `1`~`7` **(숫자만. `第5級` 같은 표기는 필터에 안 잡힙니다)** |
| `CEFR` | `A1` `A2` `B1` `B2` `C1` `C2` |
| `Register` | `중립` `구어체` `문어체` `격식` |
| `Medium` | `Spoken` `Written` `Both` |
| `Frequency` | `K1`~`K6` |
| `Priority` | `P1` `P2` `P3` |
| `Topic_Primary` | 자유 문자열 |
| `Style_Tags` | 자유. `,` 구분 |
| `Common_Error` | 한국인 학습자 오류 설명 |
| `비고` | 자유 메모 |
| `tags` | **배열.** 홈 태그 드롭다운·덱 필터에 그대로 노출 |
| `sourceVolumes` | **배열.** 교재 권. 예: `["1"]`, `["ACC4"]` |
| `sourceLessons` | **배열.** 교재 과. 예: `["10"]` |

### TSV 헤더 (복사용)

```
Traditional_CH	Meaning_KO	Simplified_CH	Pinyin	POS	Meaning_EN	Example_CHT	Example_Pinyin	Example_KO	Example_EN	Collocation_CHT	Synonym_CHT	Antonym_CHT	Measure_CHT	Variants_CHT	HSK	TOCFL	TBCL_Level	CEFR	Register	Medium	Frequency	Priority	Topic_Primary	Style_Tags	Common_Error	비고	tags	sourceVolumes	sourceLessons
```

---

## 2. 표현 (expressions) — `contentKind: "expression"`

### 필수

| 열 | 설명 |
|---|---|
| `Expression` | **키.** 번체 표현 원형 |
| `Meaning_KO` | 뜻과 사용 조건 |

### 핵심

| 열 | 설명 |
|---|---|
| `Function` | 화용 기능을 한국어로 짧게 |
| `Meaning_EN` | 영어 뜻 |
| `Example1` / `Example1_Pinyin` / `Example1_KO` | 예문 1 (빈칸채우기·표현 쓰기가 이걸 씁니다) |
| `Example2` / `Example2_Pinyin` / `Example2_KO` | 예문 2. 예문1과 다른 상황으로 |
| `Similar_Expr` | 유사 표현. `,` 구분, 뉘앙스 차이는 괄호로 |

### 메타

| 열 | 허용 값 |
|---|---|
| `L1` / `L2` / `L3` | 기능 중심 3단 분류. 예: `담화` / `대조·양보` / `그럼에도` |
| `Formality` | `중립` `구어체` `문어체` `격식` |
| `Currency` | `Current` `Dated` `Archaic` |
| `Medium` | `Spoken` `Written` `Both` |
| `Register` | `중립` `구어체` `문어체` `격식` |
| `HSK` | `1`~`6`, `7-9` |
| `Frequency` | `K1`~`K6` |
| `Priority` | `P1`~`P3` |
| `Style_Tags` | 자유 |
| `Common_Error` | 오류 설명 |
| `tags` | 배열 |
| `sourceVolumes` / `sourceLessons` | **배열.** 교재 권·과 |

### TSV 헤더

```
Expression	Meaning_KO	Function	Meaning_EN	Example1	Example1_Pinyin	Example1_KO	Example2	Example2_Pinyin	Example2_KO	Similar_Expr	L1	L2	L3	Formality	Currency	Medium	Register	HSK	Frequency	Priority	Style_Tags	Common_Error	tags	sourceVolumes	sourceLessons
```

---

## 3. 문법 (grammar) — `contentKind: "grammar"` ★ 여기가 가장 까다롭습니다

문법은 v9.3.x에서 새로 추가되면서 구조가 어정쩡하게 남아 있습니다. v9.4.1에서 다음과 같이 정리했습니다.

- 문법은 **`expressions` 스토어를 공유**합니다. 별도 스토어가 아닙니다.
- 따라서 키는 `Expression` 이며, **문형 자체**를 넣습니다. 예: `VV看`, `不但……而且……`, `之所以……是因為……`
- `Grammar_Point` 는 교재상 항목 ID/명칭이며 키가 아닙니다. 예: `ACC4-L10-G05`
- `contentKind: "grammar"` 를 **반드시 명시**하십시오. 이것이 없으면 홈의 문법 탭·문법 덱에 잡히지 않습니다.

### 필수

| 열 | 설명 |
|---|---|
| `Expression` | **키.** 문형 원형. 표현(expressions)의 키와 겹치면 안 됩니다 |
| `Meaning_KO` | 문형의 의미·기능 |

### 핵심

| 열 | 설명 |
|---|---|
| `Grammar_Point` | 교재 항목 ID/명칭. 문법 판정의 1순위 신호 |
| `Structure_CHT` | **v9.4.1 신규.** 문형 구조 표기. 예: `S + 不但 + VP1，而且 + VP2` |
| `Function` | 기능 설명 |
| `Meaning_EN` | 영어 설명 |
| `Example1` / `Example1_Pinyin` / `Example1_KO` | 대표 예문 |
| `Example2` / `Example2_Pinyin` / `Example2_KO` | 보조 예문 |
| `grammarExamples` | **배열.** 추가 예문(번체) |
| `grammarExamplePinyin` | **배열.** 위와 같은 인덱스의 병음 |
| `grammarExampleTranslationsKO` | **배열.** 위와 같은 인덱스의 한국어 |
| `grammarExampleTranslationsEN` | **배열.** 위와 같은 인덱스의 영어 |

> **인덱스 계약**
> `grammarExamples[i]` ↔ `grammarExamplePinyin[i]` ↔ `grammarExampleTranslationsKO[i]` 는 **같은 문장의 짝**입니다.
> 세 배열의 길이가 다르면 짝이 어긋납니다. 번역이 없으면 빈 문자열 `""` 로 자리를 채워 길이를 맞추십시오.
> `Example1` 은 가급적 `grammarExamples[0]` 과 동일하게 두십시오. 목록 밖 문장을 넣으면 번역 짝이 틀어집니다.

v9.3.2에서는 이 세 배열이 시드에 들어 있기만 하고 **코드가 한 번도 읽지 않았습니다.**
v9.4.1에서 `CEMS941Schema.grammarExampleList(row)` 를 통해 실제로 학습 화면에 연결했습니다.

### 메타

| 열 | 허용 값 |
|---|---|
| `L1` | 문법은 `문법` 고정 권장 |
| `L2` / `L3` | 하위 분류 |
| `TBCL_Level` | `1`~`7` **숫자만** |
| `TBCL_Band` / `TBCL_Sequence` | 교재 배열 정보 |
| `HSK` | `1`~`6`, `7-9` |
| `CEFR` | `A1`~`C2` |
| `Formality` / `Register` | `중립` `구어체` `문어체` `격식` |
| `Currency` | `Current` `Dated` `Archaic` |
| `Medium` | `Spoken` `Written` `Both` |
| `Frequency` / `Priority` | `K1`~`K6` / `P1`~`P3` |
| `Style_Tags` / `Common_Error` | 자유 |
| `tags` | 배열. `문법` 태그를 넣으면 판정이 더 확실해집니다 |
| `sourceVolumes` / `sourceLessons` | **배열.** 교재 권·과. 덱 관리자의 「교재·과」 선택지가 이 값으로 만들어집니다 |

### TSV 헤더

```
Expression	Meaning_KO	Grammar_Point	Structure_CHT	Function	Meaning_EN	Example1	Example1_Pinyin	Example1_KO	Example2	Example2_Pinyin	Example2_KO	grammarExamples	grammarExamplePinyin	grammarExampleTranslationsKO	grammarExampleTranslationsEN	L1	L2	L3	TBCL_Level	TBCL_Band	TBCL_Sequence	HSK	CEFR	Formality	Currency	Medium	Register	Frequency	Priority	Style_Tags	Common_Error	tags	sourceVolumes	sourceLessons
```

TSV로 만들 때 배열 열은 `;` 로 구분하십시오. 예:
`這杯咖啡很香，你喝喝看。;那家餐廳的菜很好吃，我想去吃吃看。`

---

### 교재 연결 (v9.4.1)

덱 관리자의 「교재·과」 선택지는 어휘·표현·문법 행의 `sourceVolumes` / `sourceLessons` 로 만들어집니다.

- `sourceVolumes: ["4"]`, `sourceLessons: ["10"]` → 선택지에 `V4`, `L10`, `ACC4-L10` 생성
- 한 행이 여러 과에 나오면 배열에 모두 넣으십시오
- 이 두 열이 비면 **해당 교재는 덱 선택지에 나타나지 않습니다.** 문법·교재별 학습을 하시려면 반드시 채우십시오
- ACC 외 교재를 추가하실 때도 같은 열을 씁니다. 권 이름을 그대로 넣으면 됩니다 (예: `sourceVolumes: ["당대중문과정3"]`)

---

## 4. 예문 (examples) — 대화·쉐도잉의 원천

| 열 | 필수 | 설명 |
|---|---|---|
| `id` | ● | **키.** 전역 고유. 예: `ex-v940-8f2774119f02` |
| `targetText` | ● | 정답 판정 기준 문장 (보통 번체와 동일) |
| `textTraditional` | | 번체 |
| `textSimplified` | | 간체 |
| `pinyin` | | 병음 |
| `translationKo` | | 한국어 |
| `translationEn` | | 영어 |
| `acceptedAnswers` | | 배열. 정답으로 인정할 표기들 |
| `sourceTypes` | | 배열. `ACCDialogue` `ACCReading` `ACCGrammarExample` `TBCLGrammarExample` `VocabularyExample` |
| `sourceRefs` | | 배열의 객체. `{ "type": "...", "id": "...", "file": "..." }` |
| `lessons` | | 배열. 예: `["ACC4-L10"]` |
| `tags` / `audioRefs` | | 배열 |

### ★ 대화 학습이 동작하기 위한 계약

「대화 학습」 화면은 다음 두 조건을 **모두** 만족하는 예문만 묶습니다.

1. `sourceTypes` 중 하나가 `/dialog/i` 에 매치 (예: `ACCDialogue`)
2. `sourceRefs` 중 대화 항목의 `id` 가 정규식 `^(.+?-D\d+)-(?:U)?(\d+)$` 에 매치

예: `ACC1-L01-D01-U03`
- 그룹 키 = `ACC1-L01-D01`
- 발화 순서 = `3`
- 한 그룹에 **2문장 이상**이어야 대화로 성립합니다.
- 화자 A/B는 순서의 홀짝으로 자동 배정됩니다. 별도 열이 필요 없습니다.

이 형식을 벗어나면 해당 예문은 조용히 대화 목록에서 빠집니다.

---

## 5. 최상위 시드 구조

```json
{
  "schemaVersion": "cems-seed-3",
  "appVersion": "9.4.1",
  "language": "zh",
  "buildId": "9.4.1",
  "source": { "generatedAt": "...", "policy": {}, "files": [] },
  "counts": { "vocabulary": 0, "expressions": 0, "grammar": 0, "examples": 0 },
  "vocabulary": [],
  "expressions": [],
  "grammar": [],
  "examples": []
}
```

**v9.3.2 대비 변경점**

| | v9.3.2 (`cems-seed-2`) | v9.4.1 (`cems-seed-3`) |
|---|---|---|
| `expressions` | 표현 + 문법 혼재 (1,678) | 표현만 (686) |
| `grammar` | `expressions` 의 **완전 중복 사본** (992, 2.25MB 낭비) | 문법만 (992). 중복 없음 |
| `lessons` | 있으나 코드가 읽지 않음 | 제거 |
| 진행 상태 필드 | 전 행에 빈 기본값 (3.5MB) | 제거. 앱이 생성 |
| 출처 메타 | `Source_File`/`Data_Note` 등 (3.1MB) | 제거 |
| 용량 | 29.11 MB | **14.33 MB** (행 손실 0) |

v9.4.1 로더는 `cems-seed-2` 도 계속 읽습니다(자동으로 문법을 분리). 다만 신규 데이터셋은 `cems-seed-3` 로 만드십시오.

---

## 6. 작업 순서

```bash
# 1) 데이터셋 생성 후 검증
python3 authoring/validate_seed_v940.py content/cems_zh_seed_v940.json

# 2) FAIL 이 0이 될 때까지 수정

# 3) 출력된 SEED_FINGERPRINT 를 코드에 반영
#    learning/cems-9.4.1-stable.js 의 SEED_FINGERPRINT

# 4) 배포
```

`SEED_FINGERPRINT` 를 갱신하지 않으면 앱이 "이미 적용된 시드"로 판단해 **새 데이터를 무시합니다.**
설정 화면의 「내장 데이터 다시 인식」으로 강제 재적용할 수도 있습니다.
재적용 시에도 사용자의 학습 기록(FSRS 상태·오답·북마크)은 `mergeCard()` 가 보존합니다.

---

## 7. 현재 데이터셋에서 발견된 문제 (재작성 시 반영 권장)

| 문제 | 건수 | 영향 |
|---|---|---|
| `grammarExamples` 와 `...TranslationsKO` 배열 길이 불일치 | 71행 | 예문–번역 짝이 어긋남 |
| `Example1` 은 있는데 `Example1_KO` 없음 (문법) | 469행 | 예문 해석 미표시 |
| `Example1` 이 `grammarExamples` 목록 밖 | 28행 | 번역이 다른 문장에 붙음 |
| `TBCL_Level` 이 `第5級` 형식 | 496행 | TBCL 필터에 안 잡힘 → `5` 로 |
| `Medium` 이 `구어·문어` | 370행 | → `Both` |
| `Currency` 가 `현대` | 370행 | → `Current` |
| 어휘 `Example_CHT` 보유율 49% | 4,814행 결측 | 빈칸채우기 출제 폭 절반 |
| 어휘 `Collocation_CHT` 보유율 0.6% | 9,392행 결측 | 연어 학습이 사실상 비어 있음 |
| 어휘 `Measure_CHT` 보유율 0.5% | 9,401행 결측 | 양사 모드가 사실상 비어 있음 |
