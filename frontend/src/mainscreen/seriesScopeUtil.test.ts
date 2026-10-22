import { describe, expect, it } from "vitest";
import type { Study } from "../api";
import {
  LARGE_SERIES,
  buildScope,
  cleanFilters,
  etaSeconds,
  formatEta,
  groupByPatient,
  isLargeScope,
  patientState,
  toggleStudy,
  togglePatient,
} from "./seriesScopeUtil";

const st = (uid: string, pid: string, date: string | null = "20250101"): Study =>
  ({ studyInstanceUid: uid, patientId: pid, patientName: `N-${pid}`, studyDate: date, studyDescription: null, modality: "CT", numberOfInstances: 1 }) as Study;

const studies = [st("s1", "B", "20240101"), st("s2", "A", "20250101"), st("s3", "A", "20260101"), st("s4", "B", "20250601")];

describe("cleanFilters", () => {
  it("空欄・空白だけの項目は捨て、全部空なら undefined（DB 全体）", () => {
    expect(cleanFilters({ patientId: "  ", modality: "" })).toBeUndefined();
    expect(cleanFilters({ patientId: " P1 ", studyDateFrom: "20250101" })).toEqual({ patientId: "P1", studyDateFrom: "20250101" });
  });
});

describe("患者→スタディの選択", () => {
  const groups = groupByPatient(studies);
  it("患者 ID 順、スタディは検査日の新しい順", () => {
    expect(groups.map((g) => g.patientId)).toEqual(["A", "B"]);
    expect(groups[0].studies.map((s) => s.studyInstanceUid)).toEqual(["s3", "s2"]);
  });
  it("3 状態: 外していなければ all、全部外せば none、一部なら some", () => {
    expect(patientState(groups[0], new Set())).toBe("all");
    expect(patientState(groups[0], new Set(["s2"]))).toBe("some");
    expect(patientState(groups[0], new Set(["s2", "s3"]))).toBe("none");
  });
  it("患者行: all→全部外す、some/none→全部入れる。他の患者は触らない", () => {
    const off = togglePatient(new Set(), groups[0]);
    expect([...off].sort()).toEqual(["s2", "s3"]);
    expect([...togglePatient(new Set(["s2", "s1"]), groups[0])]).toEqual(["s1"]);
    expect(patientState(groups[1], off)).toBe("all");
  });
  it("スタディ単位の切替は戻せる", () => {
    const a = toggleStudy(new Set(), "s1");
    expect(a.has("s1")).toBe(true);
    expect(toggleStudy(a, "s1").has("s1")).toBe(false);
  });
});

describe("buildScope", () => {
  it("何も外していなければ条件（サーバー解決）。大きな UID 一覧を運ばない", () => {
    const s = buildScope({ patientId: "A" }, studies, new Set());
    expect(s.studyUids).toBeUndefined();
    expect(s.filters).toEqual({ patientId: "A" });
  });
  it("1 件でも外せば、残りの UID を明示する（外したものは含まない）", () => {
    const s = buildScope({ patientId: "A" }, studies, new Set(["s2"]));
    expect(s.studyUids).toEqual(["s1", "s3", "s4"]);
    expect(s.filters).toBeUndefined();
  });
  it("一覧を出せない（上限超え）ときは、外す手段が無いので条件全体", () => {
    expect(buildScope({ modality: "CT" }, null, new Set(["x"])).filters).toEqual({ modality: "CT" });
  });
  it("条件が空なら filters は空オブジェクト（＝DB 全体）", () => {
    expect(buildScope({}, null, new Set()).filters).toEqual({});
  });
});

describe("残り時間の目安", () => {
  it("十分進んでいれば経過÷処理済み×残りで出す", () => {
    expect(etaSeconds(10_000, 100, 400)).toBe(30);
  });
  it("始めて間もない・ほとんど進んでいない・終わった・総数不明は当てにならないので null（負例）", () => {
    expect(etaSeconds(1000, 50, 100)).toBeNull();
    expect(etaSeconds(10_000, 1, 1000)).toBeNull();
    expect(etaSeconds(10_000, 100, 100)).toBeNull();
    expect(etaSeconds(10_000, 10, 0)).toBeNull();
    expect(etaSeconds(10_000, 0, 100)).toBeNull();
  });
  it("表示の単位: 90 秒未満は秒、それ以上は分", () => {
    expect(formatEta(30)).toEqual({ unit: "sec", n: 30 });
    expect(formatEta(0)).toEqual({ unit: "sec", n: 1 });
    expect(formatEta(300)).toEqual({ unit: "min", n: 5 });
  });
});

describe("大規模の判定", () => {
  it("しきい値ちょうどは大規模でない、超えたら大規模", () => {
    expect(isLargeScope(LARGE_SERIES)).toBe(false);
    expect(isLargeScope(LARGE_SERIES + 1)).toBe(true);
  });
});
