#!/usr/bin/env python3
"""
CEMS v9.4.1 데이터셋 검증기

사용법:
    python3 authoring/validate_seed_v940.py content/cems_zh_seed_v940.json

데이터셋을 새로 만든 뒤 반드시 이 스크립트를 통과시킨 다음 배포하십시오.
FAIL 이 하나라도 있으면 앱이 해당 행을 버리거나 학습 모드가 출제되지 않습니다.
"""
import json
import re
import sys
import hashlib
from collections import Counter
from pathlib import Path

REQUIRED = {
    "vocabulary": ["Traditional_CH", "Meaning_KO"],
    "expressions": ["Expression", "Meaning_KO"],
    "grammar": ["Expression", "Meaning_KO"],
    "examples": ["id", "targetText"],
}
KEY = {
    "vocabulary": "Traditional_CH",
    "expressions": "Expression",
    "grammar": "Expression",
    "examples": "id",
}
DOMAIN = {
    "HSK": r"^(?:[1-6]|7-9)$",
    "Register": r"^(?:중립|구어체|문어체|격식)$",
    "Formality": r"^(?:중립|구어체|문어체|격식)$",
    "Medium": r"^(?:Spoken|Written|Both)$",
    "Currency": r"^(?:Current|Dated|Archaic)$",
    "Frequency": r"^K[1-6]$",
    "Priority": r"^P[1-3]$",
    "TBCL_Level": r"^[1-7]$",
    "CEFR": r"^[ABC][12]$",
}
# 모드가 켜지려면 있어야 하는 필드
MODE_REQUIREMENTS = {
    "vocabulary": {
        "타이핑/받아쓰기(병음)": ["Pinyin"],
        "빈칸채우기": ["Example_CHT"],
        "연어 학습": ["Collocation_CHT"],
        "간체↔번체": ["Simplified_CH"],
        "양사 선택": ["Measure_CHT"],
    },
    "expressions": {"표현 빈칸": ["Example1"], "표현 쓰기": ["Example1"]},
    "grammar": {"예문 빈칸": ["Example1"], "문형 입력": ["Expression"]},
}

fails, warns = [], []


def fail(msg):
    fails.append(msg)


def warn(msg):
    warns.append(msg)


def txt(v):
    return "" if v is None else str(v).strip()


def check_section(name, rows):
    print(f"\n── {name} ({len(rows)}행) ──")
    if not rows:
        fail(f"{name}: 비어 있음")
        return

    # 1) 필수 필드
    for f in REQUIRED[name]:
        missing = sum(1 for r in rows if not txt(r.get(f)))
        if missing:
            fail(f"{name}: 필수 필드 '{f}' 누락 {missing}행 → 앱이 이 행들을 버립니다")
    print("  필수 필드      : OK" if not any(f.startswith(name + ":") for f in fails) else "  필수 필드      : FAIL")

    # 2) 키 중복
    keys = [txt(r.get(KEY[name])) for r in rows]
    dup = [k for k, c in Counter(keys).items() if k and c > 1]
    if dup:
        fail(f"{name}: 키 '{KEY[name]}' 중복 {len(dup)}건 예: {dup[:5]} → 나중 행이 앞 행을 덮어씁니다")
    else:
        print(f"  키 중복        : 없음 ({KEY[name]})")

    # 3) 값 도메인
    for f, pat in DOMAIN.items():
        bad = Counter(txt(r.get(f)) for r in rows if txt(r.get(f)) and not re.fullmatch(pat, txt(r.get(f))))
        if bad:
            top = ", ".join(f"{v}({c})" for v, c in bad.most_common(3))
            warn(f"{name}.{f}: 규격 밖 값 {sum(bad.values())}건 [{top}] → 필터 칩에 잡히지 않습니다")

    # 4) 모드 가용성
    for mode, fields in MODE_REQUIREMENTS.get(name, {}).items():
        n = sum(1 for r in rows if all(txt(r.get(f)) for f in fields))
        pct = n * 100 // len(rows)
        mark = "OK " if pct >= 50 else "낮음"
        print(f"  {mark} {mode:20} 출제 가능 {n:5}행 ({pct}%)")
        if n == 0:
            fail(f"{name}: '{mode}' 모드가 0행 → 해당 모드가 절대 출제되지 않습니다")

    # 5) 진행 상태 필드 혼입
    progress = ["stability", "nextReview", "reviewCount", "mastery", "fsrsState", "lapses"]
    leaked = [p for p in progress if any(p in r for r in rows[:200])]
    if leaked:
        warn(f"{name}: 학습 진행 필드가 데이터셋에 포함됨 {leaked} → 앱이 생성하므로 제거하십시오")


def check_grammar_examples(rows):
    print("\n── 문법 예문 정합성 ──")
    no_ko = miss_len = orphan = 0
    for r in rows:
        cht = r.get("grammarExamples") or []
        ko = r.get("grammarExampleTranslationsKO") or []
        if cht and ko and len(cht) != len(ko):
            miss_len += 1
        if txt(r.get("Example1")) and not txt(r.get("Example1_KO")):
            no_ko += 1
        if txt(r.get("Example1")) and cht and txt(r.get("Example1")) not in cht:
            orphan += 1
    print(f"  Example1 있으나 Example1_KO 없음     : {no_ko}")
    print(f"  grammarExamples/KO 배열 길이 불일치  : {miss_len}")
    print(f"  Example1 이 grammarExamples 밖       : {orphan}")
    if miss_len:
        fail(f"문법: grammarExamples 와 grammarExampleTranslationsKO 길이 불일치 {miss_len}행 "
             "→ 두 배열은 같은 길이여야 하며 같은 인덱스끼리 짝입니다")
    if orphan:
        warn(f"문법: Example1 이 grammarExamples 에 없는 행 {orphan}건 → 번역 짝이 어긋날 수 있습니다")


def check_dialogue(examples):
    print("\n── 대화 학습 계약 ──")
    pat = re.compile(r"^(.+?-D\d+)-(?:U)?(\d+)$", re.I)
    dial = [r for r in examples
            if any(re.search(r"dialog", str(t), re.I) for t in (r.get("sourceTypes") or []))]
    groups = Counter()
    bad = 0
    for r in dial:
        refs = r.get("sourceRefs") or []
        ref = next((x for x in refs if re.search(r"dialog", str(x.get("type", "")), re.I)), refs[0] if refs else {})
        m = pat.match(str(ref.get("id", "")))
        if m:
            groups[m.group(1)] += 1
        else:
            bad += 1
    usable = sum(1 for v in groups.values() if v >= 2)
    print(f"  대화 예문           : {len(dial)}")
    print(f"  ID 패턴 불일치      : {bad}")
    print(f"  묶인 대화 그룹      : {len(groups)} (2문장 이상 {usable})")
    if dial and not usable:
        fail("대화 학습: 사용 가능한 그룹이 0 → sourceRefs[].id 를 'ACC1-L01-D01-U01' 형식으로 맞추십시오")
    if bad:
        warn(f"대화 학습: ID 패턴 불일치 {bad}건은 그룹에서 제외됩니다")


def main():
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "content/cems_zh_seed_v940.json")
    raw = path.read_bytes()
    seed = json.loads(raw.decode("utf-8"))

    print(f"파일   : {path}")
    print(f"용량   : {len(raw) / 1048576:.2f} MB")
    print(f"스키마 : {seed.get('schemaVersion')}")
    if seed.get("schemaVersion") != "cems-seed-3":
        fail("schemaVersion 이 'cems-seed-3' 이 아닙니다")

    for name in ["vocabulary", "expressions", "grammar", "examples"]:
        check_section(name, seed.get(name) or [])

    check_grammar_examples(seed.get("grammar") or [])
    check_dialogue(seed.get("examples") or [])

    # 표현 / 문법 키 충돌 (같은 IndexedDB 스토어를 공유하므로 치명적)
    ek = {txt(r.get("Expression")) for r in (seed.get("expressions") or [])}
    gk = {txt(r.get("Expression")) for r in (seed.get("grammar") or [])}
    clash = ek & gk
    print(f"\n── 표현/문법 키 충돌 ──\n  충돌 {len(clash)}건")
    if clash:
        fail(f"표현과 문법이 같은 Expression 키를 씁니다 {list(clash)[:5]} "
             "→ 두 종류는 expressions 스토어를 공유하므로 하나가 사라집니다")

    print("\n" + "=" * 58)
    for m in fails:
        print("FAIL  " + m)
    for m in warns:
        print("WARN  " + m)
    print(f"\nFAIL {len(fails)}건 · WARN {len(warns)}건")
    print("SEED_FINGERPRINT = 'sha256:%s'" % hashlib.sha256(raw).hexdigest())
    print("  → learning/cems-9.4.1-stable.js 의 SEED_FINGERPRINT 를 위 값으로 교체하십시오.")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
