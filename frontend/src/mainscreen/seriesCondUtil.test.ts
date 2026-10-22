import { describe, expect, it } from "vitest";
import type { SeriesCondition, TagDictEntry } from "../api";
import { parseConditions, serializeConditions } from "./tagPathUtil";
import {
  canRun,
  coerceOp,
  conditionError,
  daToInput,
  hasPath,
  inputToDa,
  keepNumeric,
  opsForVr,
  pathKey,
  usedSingleTags,
  visibleDict,
} from "./seriesCondUtil";

const cond = (over: Partial<SeriesCondition> = {}): SeriesCondition => ({
  segments: [{ tag: "00080060" }],
  vr: "CS",
  exclude: false,
  op: "EQUALS",
  value1: "MR",
  value2: "",
  ...over,
});

const dict: TagDictEntry[] = [
  { tag: "00080060", keyword: "Modality", vr: "CS" } as TagDictEntry,
  { tag: "00180050", keyword: "SliceThickness", vr: "DS" } as TagDictEntry,
  { tag: "0008103E", keyword: "SeriesDescription", vr: "LO" } as TagDictEntry,
];

describe("opsForVr", () => {
  it("数値・日時は大小比較を持つ", () => {
    expect(opsForVr("DS")).toEqual(["EQUALS", "GT", "LT", "GE", "LE", "RANGE"]);
    expect(opsForVr("DA")).toContain("RANGE");
  });
  it("文字は完全・部分・前方・後方で、大小は持たない", () => {
    expect(opsForVr("LO")).toEqual(["EQUALS", "CONTAINS", "STARTS_WITH", "ENDS_WITH"]);
    expect(opsForVr("LO")).not.toContain("GT");
  });
  it("VR を変えたとき使えない演算子は先頭に戻す", () => {
    expect(coerceOp("CONTAINS", "DS")).toBe("EQUALS");
    expect(coerceOp("GT", "LO")).toBe("EQUALS");
    expect(coerceOp("GT", "DS")).toBe("GT");
  });
});

describe("重複経路", () => {
  it("同じ経路は重複、creator が違う Private は別経路、SQ 経由は別経路", () => {
    const cs = [cond()];
    expect(hasPath(cs, [{ tag: "00080060" }])).toBe(true);
    expect(hasPath(cs, [{ tag: "00080060", creator: "ACME" }])).toBe(false);
    expect(hasPath(cs, [{ tag: "00081140" }, { tag: "00081150" }])).toBe(false);
    expect(pathKey([{ tag: "00191001", creator: "A" }])).not.toBe(pathKey([{ tag: "00191001", creator: "B" }]));
  });
  it("小文字の tag でも同一とみなす", () => {
    expect(hasPath([cond({ segments: [{ tag: "0008103E" }] })], [{ tag: "0008103e" }])).toBe(true);
  });
});

describe("辞書の絞り込みと非表示", () => {
  it("名前・番号（区切りあり／なし）のどれでも引ける", () => {
    const none = new Set<string>();
    expect(visibleDict(dict, "slicethick", none).map((e) => e.tag)).toEqual(["00180050"]);
    expect(visibleDict(dict, "0018,0050", none).map((e) => e.tag)).toEqual(["00180050"]);
    expect(visibleDict(dict, "00180050", none).map((e) => e.tag)).toEqual(["00180050"]);
    expect(visibleDict(dict, "(0008,", none).length).toBe(2);
    expect(visibleDict(dict, "存在しない", none)).toEqual([]);
  });
  it("設定済みの単独タグは一覧から消える", () => {
    const used = usedSingleTags([cond()]);
    expect(visibleDict(dict, "", used).map((e) => e.tag)).not.toContain("00080060");
    expect(visibleDict(dict, "", used).length).toBe(2);
  });
  it("SQ 経由で使ったタグは、単独としては隠さない", () => {
    const used = usedSingleTags([cond({ segments: [{ tag: "00081140" }, { tag: "00080060" }] })]);
    expect(used.size).toBe(0);
  });
});

describe("入力検査", () => {
  it("値が空・数値でない・範囲が逆はエラー", () => {
    expect(conditionError(cond({ value1: "" }))).toBe("value");
    expect(conditionError(cond({ vr: "DS", op: "GT", value1: "abc" }))).toBe("number");
    expect(conditionError(cond({ vr: "DS", op: "RANGE", value1: "9", value2: "3" }))).toBe("order");
    expect(conditionError(cond({ vr: "DS", op: "RANGE", value1: "3", value2: "" }))).toBe("number");
  });
  it("正しい条件は null", () => {
    expect(conditionError(cond())).toBeNull();
    expect(conditionError(cond({ vr: "DS", op: "RANGE", value1: "1.5", value2: "3" }))).toBeNull();
    expect(conditionError(cond({ vr: "DA", op: "RANGE", value1: "20260101", value2: "20260131" }))).toBeNull();
  });
  it("条件が無ければ全シリーズ対象で実行できる。入力不備の条件が 1 つでもあれば実行できない", () => {
    expect(canRun([])).toBe(true);
    expect(canRun([cond()])).toBe(true);
    expect(canRun([cond(), cond({ value1: "" })])).toBe(false);
  });
  it("数値欄は数字記号以外を捨てる／日付の相互変換", () => {
    expect(keepNumeric("1a2.5-x")).toBe("12.5-");
    expect(daToInput("20260115")).toBe("2026-01-15");
    expect(inputToDa("2026-01-15")).toBe("20260115");
    expect(daToInput("")).toBe("");
  });
});

describe("条件の保存→読込の往復", () => {
  it("新しい演算子・Private・SQ 経路・Exclude・断面を失わない", () => {
    const cs: SeriesCondition[] = [
      cond({ vr: "LO", op: "STARTS_WITH", value1: "Ax", segments: [{ tag: "0008103E" }] }),
      cond({ vr: "LO", op: "ENDS_WITH", value1: "FLAIR", exclude: true, segments: [{ tag: "0008103E" }, { tag: "00080060" }] }),
      cond({ vr: "DS", op: "GT", value1: "4.5", segments: [{ tag: "00180050" }] }),
      cond({ vr: "DS", op: "RANGE", value1: "1", value2: "9", segments: [{ tag: "00191001", creator: "ACME PRIV" }] }),
    ];
    const text = serializeConditions(cs, ["AXIAL", "CORONAL"]);
    const back = parseConditions(text);
    expect(back.planes).toEqual(["AXIAL", "CORONAL"]);
    expect(back.conditions).toEqual(cs);
  });
});
