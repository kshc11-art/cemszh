#!/usr/bin/env python3
"""
CEMS v9.4.1 시드 빌더 — cems-seed-3 생성기

입력 : content/cems_zh_full_seed_v932.json (cems-seed-2)
출력 : content/cems_zh_seed_v940.json      (cems-seed-3)

이 스크립트가 남기는 열 이름이 곧 앱이 읽는 열 이름이다.
데이터셋을 새로 만들 때는 아래 VOCAB / EXPR / GRAMMAR / EXAMPLE 목록을
그대로 헤더로 사용하면 된다.
"""
import json
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ── canonical 열 정의 (learning/cems-9.4.1-schema.js 와 1:1 일치) ─────────────
VOCAB_REQUIRED = ["Traditional_CH", "Meaning_KO"]
VOCAB_CORE = [
    "Simplified_CH", "Pinyin", "POS", "Meaning_EN",
    "Example_CHT", "Example_Pinyin", "Example_KO", "Example_EN",
    "Collocation_CHT", "Synonym_CHT", "Antonym_CHT", "Measure_CHT", "Variants_CHT",
]
VOCAB_META = [
    "HSK", "TOCFL", "TBCL_Level", "CEFR",
    "Register", "Medium", "Frequency", "Priority",
    "Topic_Primary", "Style_Tags", "Common_Error", "비고", "tags",
    "sourceVolumes", "sourceLessons",
]

EXPR_REQUIRED = ["Expression", "Meaning_KO"]
EXPR_CORE = [
    "Meaning_EN", "Function",
    "Example1", "Example1_Pinyin", "Example1_KO",
    "Example2", "Example2_Pinyin", "Example2_KO",
    "Similar_Expr",
]
EXPR_META = [
    "L1", "L2", "L3",
    "Formality", "Currency", "Medium", "Register",
    "HSK", "Frequency", "Priority",
    "Style_Tags", "Common_Error", "tags",
    "sourceVolumes", "sourceLessons",
]

GRAMMAR_REQUIRED = ["Expression", "Meaning_KO"]
GRAMMAR_CORE = [
    "Grammar_Point", "Structure_CHT", "Meaning_EN", "Function",
    "Example1", "Example1_Pinyin", "Example1_KO",
    "Example2", "Example2_Pinyin", "Example2_KO",
    "grammarExamples", "grammarExamplePinyin",
    "grammarExampleTranslationsKO", "grammarExampleTranslationsEN",
]
GRAMMAR_META = [
    "L1", "L2", "L3",
    "TBCL_Level", "TBCL_Band", "TBCL_Sequence", "HSK", "CEFR",
    "Formality", "Currency", "Medium", "Register",
    "Frequency", "Priority", "Style_Tags", "Common_Error", "tags",
    "sourceVolumes", "sourceLessons",
]

EXAMPLE_KEEP = [
    "id", "targetText", "textTraditional", "textSimplified", "pinyin",
    "translationKo", "translationEn", "acceptedAnswers",
    "sourceTypes", "sourceRefs", "lessons", "tags", "audioRefs",
]

ARRAY_FIELDS = {
    "tags", "sourceVolumes", "sourceLessons", "grammarExamples", "grammarExamplePinyin",
    "grammarExampleTranslationsKO", "grammarExampleTranslationsEN",
    "acceptedAnswers", "sourceTypes", "sourceRefs", "lessons", "audioRefs",
}

ALIAS = {
    "Headword_CHT": "Traditional_CH", "POS_KO": "POS",
    "TBCL": "TBCL_Level", "TBCL_Grammar_Level": "TBCL_Level",
    "HSK_Exact": "HSK", "TOCFL_Level": "TOCFL",
    "sourceVolume": "sourceVolumes", "sourceLesson": "sourceLessons",
}


def txt(v):
    return "" if v is None else str(v).strip()


def take(row, fields):
    out = {}
    for f in fields:
        src = f
        for a, c in ALIAS.items():
            if c == f and f not in row and a in row:
                src = a
                break
        v = row.get(src)
        if f in ARRAY_FIELDS:
            if isinstance(v, list):
                seen, lst = set(), []
                for x in v:
                    k = x if isinstance(x, dict) else txt(x)
                    kk = json.dumps(k, sort_keys=True, ensure_ascii=False) if isinstance(k, dict) else k
                    if k and kk not in seen:
                        seen.add(kk)
                        lst.append(k)
                if lst:
                    out[f] = lst
            elif txt(v):
                out[f] = [x for x in re.split(r"\s*[;,|]\s*", txt(v)) if x]
            continue
        if isinstance(v, bool) or isinstance(v, (int, float)):
            out[f] = v
        elif txt(v):
            out[f] = txt(v)
    return out


def is_grammar(row):
    if row.get("contentKind") == "grammar":
        return True
    if txt(row.get("Grammar_Point")):
        return True
    if txt(row.get("L1")) == "문법":
        return True
    return any(re.fullmatch(r"문법|grammar|tbcl문법", txt(t), re.I) for t in (row.get("tags") or []))


def main():
    src = ROOT / "content" / "cems_zh_full_seed_v932.json"
    dst = ROOT / "content" / "cems_zh_seed_v940.json"
    seed = json.loads(src.read_text(encoding="utf-8"))
    if seed.get("schemaVersion") != "cems-seed-2":
        sys.exit("입력 시드가 cems-seed-2 가 아닙니다.")

    vocab_fields = VOCAB_REQUIRED + VOCAB_CORE + VOCAB_META
    expr_fields = EXPR_REQUIRED + EXPR_CORE + EXPR_META
    gram_fields = GRAMMAR_REQUIRED + GRAMMAR_CORE + GRAMMAR_META

    vocabulary, dropped_v = [], []
    seen = set()
    for row in seed.get("vocabulary", []):
        out = take(row, vocab_fields)
        out["contentKind"] = "vocab"
        key = out.get("Traditional_CH", "")
        if not key or not out.get("Meaning_KO"):
            dropped_v.append(key or "(no key)")
            continue
        if key in seen:
            dropped_v.append(key)
            continue
        seen.add(key)
        vocabulary.append(out)

    expressions, grammar, dropped_e = [], [], []
    seen_e = set()
    for row in seed.get("expressions", []):
        gram = is_grammar(row)
        out = take(row, gram_fields if gram else expr_fields)
        out["contentKind"] = "grammar" if gram else "expression"
        key = out.get("Expression", "")
        if not key or not out.get("Meaning_KO"):
            dropped_e.append(key or "(no key)")
            continue
        if key in seen_e:
            dropped_e.append(key)
            continue
        seen_e.add(key)
        (grammar if gram else expressions).append(out)

    examples = []
    for row in seed.get("examples", []):
        out = take(row, EXAMPLE_KEEP)
        if not out.get("id") or not out.get("targetText"):
            continue
        examples.append(out)

    payload = {
        "schemaVersion": "cems-seed-3",
        "appVersion": "9.4.1",
        "language": "zh",
        "buildId": "9.4.1",
        "source": seed.get("source", {}),
        "counts": {
            "vocabulary": len(vocabulary),
            "expressions": len(expressions),
            "grammar": len(grammar),
            "examples": len(examples),
        },
        "vocabulary": vocabulary,
        "expressions": expressions,
        "grammar": grammar,
        "examples": examples,
    }
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    dst.write_text(text, encoding="utf-8")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()

    print("출력:", dst)
    print("용량: %.2f MB (이전 %.2f MB)" % (len(text.encode()) / 1048576, src.stat().st_size / 1048576))
    print("counts:", payload["counts"])
    print("버려진 어휘 행:", len(dropped_v), "버려진 표현/문법 행:", len(dropped_e))
    print("SEED_FINGERPRINT = 'sha256:%s'" % digest)
    return digest


if __name__ == "__main__":
    main()
