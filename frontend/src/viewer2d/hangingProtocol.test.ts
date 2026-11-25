import { describe, expect, it } from "vitest";
import {
  arrange,
  checkStorable,
  matchProtocol,
  MAX_STORED_CHARS,
  normalizeText,
  parseHangingProtocol,
  serializeHangingProtocol,
  type HangingProtocol,
  type SeriesLike,
} from "./hangingProtocol";

/** 検証済みのプロトコルを作る（形が不正なら、その場でテストを落とす）。 */
function P(raw: Record<string, unknown>): HangingProtocol {
  const r = parseHangingProtocol({ version: 1, ...raw });
  if (!r.ok) throw new Error(r.errors.join(" / "));
  return r.protocol;
}
const S = (uid: string, modality: string | null, num: number | null, desc: string | null): SeriesLike => ({ seriesInstanceUid: uid, modality, seriesNumber: num, seriesDescription: desc });

// 頭部 MR の一覧（入力の順はわざと乱してある）。手計算の期待値は各テストに書く。
const MR: SeriesLike[] = [
  S("s4", "MR", 5, "AX FLAIR"),
  S("s1", "MR", 1, "Localizer"),
  S("s6", "MR", 6, "AX T1 +C"),
  S("s2", "MR", 3, "AX T2"),
  S("s7", "MR", null, null),
  S("s3", "MR", 2, "AX T1"),
  S("s5", "MR", 4, "DWI b1000"),
];
const t1 = { series: { modality: "MR", descriptionContains: "T1" } };
const t2 = { series: { modality: "MR", descriptionContains: "T2" } };
const flair = { series: { modality: "MR", descriptionContains: "FLAIR" } };

describe("arrange（配置）", () => {
  const brain = P({ id: "brain", name: "頭部", slots: [t1, t2, flair], grid: { rows: 1, cols: 3 }, gridPortrait: { rows: 3, cols: 1 } });

  it("スロットの順に並ぶ（T1 が 2 つあるときはシリーズ番号の小さい方 s3）。入力の順を逆にしても同じ", () => {
    const a = arrange(brain, MR, { portrait: false });
    expect(a.seriesUids).toEqual(["s3", "s2", "s4"]);
    expect(a.unfilledSlots).toEqual([]);
    expect(arrange(brain, [...MR].reverse(), { portrait: false }).seriesUids).toEqual(["s3", "s2", "s4"]);
  });

  it("pick: all は該当をすべて展開（T1 は s3→s6）、last は最後（s6）", () => {
    const all = P({ id: "a", name: "a", slots: [{ series: { ...t1.series, pick: "all" } }, t2, flair], grid: { rows: 0, cols: 0 } });
    expect(arrange(all, MR, { portrait: false }).seriesUids).toEqual(["s3", "s6", "s2", "s4"]);
    const last = P({ id: "l", name: "l", slots: [{ series: { ...t1.series, pick: "last" } }], grid: { rows: 0, cols: 0 } });
    expect(arrange(last, MR, { portrait: false }).seriesUids).toEqual(["s6"]);
  });

  it("modality だけの pick: all は、シリーズ番号の昇順で、番号なし（s7）が末尾", () => {
    const p = P({ id: "m", name: "m", slots: [{ series: { modality: "mr", pick: "all" } }], grid: { rows: 0, cols: 0 } });
    expect(arrange(p, MR, { portrait: false }).seriesUids).toEqual(["s1", "s3", "s2", "s5", "s4", "s6", "s7"]);
  });

  it("同じシリーズを 2 つのスロットが取り合わない（先のスロットが優先）", () => {
    const p = P({ id: "d", name: "d", slots: [t1, t1], grid: { rows: 0, cols: 0 } });
    expect(arrange(p, MR, { portrait: false }).seriesUids).toEqual(["s3", "s6"]);
  });

  it("埋まらないスロットは詰め、添字を返す", () => {
    const pd = { series: { descriptionContains: "PD" } };
    const p = P({ id: "u", name: "u", slots: [t1, pd, t2], grid: { rows: 0, cols: 0 } });
    const a = arrange(p, MR, { portrait: false });
    expect(a.seriesUids).toEqual(["s3", "s2"]);
    expect(a.unfilledSlots).toEqual([1]);
  });

  it("全角・大文字小文字・空白・ゼロ幅文字の違いを吸収する。説明が null のシリーズは説明の条件に合わない", () => {
    const fw = P({ id: "f", name: "f", slots: [{ series: { descriptionContains: "ｔ１" } }], grid: { rows: 0, cols: 0 } });
    expect(arrange(fw, [S("a", "MR", 1, "AX​T1"), S("n", "MR", 2, null)], { portrait: false }).seriesUids).toEqual(["a"]);
    const sp = P({ id: "s", name: "s", slots: [{ series: { descriptionContains: "  flair " } }], grid: { rows: 0, cols: 0 } });
    expect(arrange(sp, [S("a", "MR", 1, "  AX   FLAIR  ")], { portrait: false }).seriesUids).toEqual(["a"]);
    // 表記の違い（T1 と T1W）は吸収しない
    const w = P({ id: "w", name: "w", slots: [{ series: { descriptionContains: "T1W" } }], grid: { rows: 0, cols: 0 } });
    expect(arrange(w, [S("a", "MR", 1, "AX T1")], { portrait: false }).seriesUids).toEqual([]);
  });

  it("numberEquals と、番号・説明が同じときの決定的な並び（説明→UID）", () => {
    const num = P({ id: "n", name: "n", slots: [{ series: { numberEquals: 5 } }], grid: { rows: 0, cols: 0 } });
    expect(arrange(num, MR, { portrait: false }).seriesUids).toEqual(["s4"]);
    const tie = [S("u2", "MR", 1, "B"), S("u3", "MR", 1, "A"), S("u1", "MR", 1, "A")];
    const all = P({ id: "t", name: "t", slots: [{ series: { modality: "MR", pick: "all" } }], grid: { rows: 0, cols: 0 } });
    expect(arrange(all, tie, { portrait: false }).seriesUids).toEqual(["u1", "u3", "u2"]);
  });

  it("縦長の窓では gridPortrait、未指定なら grid のまま", () => {
    expect(arrange(brain, MR, { portrait: true })).toMatchObject({ rows: 3, cols: 1 });
    expect(arrange(brain, MR, { portrait: false })).toMatchObject({ rows: 1, cols: 3 });
    const noPortrait = P({ id: "x", name: "x", slots: [t1], grid: { rows: 2, cols: 2 } });
    expect(arrange(noPortrait, MR, { portrait: true })).toMatchObject({ rows: 2, cols: 2 });
  });
});

describe("matchProtocol（照合）", () => {
  const general = P({ id: "gen", name: "MR 一般", match: { modality: ["MR"] }, slots: [t1], grid: { rows: 0, cols: 0 } });
  const brain = P({ id: "brain", name: "頭部", match: { modality: ["MR"], studyDescriptionContains: "brain" }, slots: [t1, t2, flair], grid: { rows: 1, cols: 3 } });
  const any = P({ id: "any", name: "何でも", slots: [{ series: { modality: "MR" } }], grid: { rows: 0, cols: 0 } });
  const ct = P({ id: "ct", name: "CT", match: { modality: ["CT"] }, slots: [{ series: { modality: "CT" } }], grid: { rows: 0, cols: 0 } });
  const all = [general, brain, any, ct];

  it("条件の数が多い方を選ぶ（頭部 > MR 一般 > 条件なし）。配列の順を入れ替えても同じ", () => {
    const study = { modality: "MR", studyDescription: "MRI BRAIN w/o contrast" };
    expect(matchProtocol(all, study, MR)?.id).toBe("brain");
    expect(matchProtocol([...all].reverse(), study, MR)?.id).toBe("brain");
    expect(matchProtocol(all, { modality: "MR", studyDescription: "MRI spine" }, MR)?.id).toBe("gen");
    expect(matchProtocol([any], { modality: "MR" }, MR)?.id).toBe("any");
  });

  it("合うものが無いときは null（従来どおり）。CT の検査に MR のプロトコルは出ない", () => {
    expect(matchProtocol([general, brain], { modality: "CT" }, [S("c1", "CT", 1, "Lung")])).toBeNull();
    expect(matchProtocol([], { modality: "MR" }, MR)).toBeNull();
    expect(matchProtocol([ct], { modality: "CT" }, [S("c1", "CT", 1, "Lung")])?.id).toBe("ct");
  });

  it("スロットが 1 つも埋まらないプロトコルは「合う」と言わない", () => {
    const pd = P({ id: "pd", name: "PD", match: { modality: ["MR"] }, slots: [{ series: { descriptionContains: "PD" } }], grid: { rows: 0, cols: 0 } });
    expect(matchProtocol([pd], { modality: "MR" }, MR)).toBeNull();
  });

  it("検査の modalities（複数）のどれかに合えばよい。説明が null の検査は説明の条件に合わない", () => {
    const pt = P({ id: "pt", name: "PT", match: { modality: ["PT"] }, slots: [{ series: { modality: "PT" } }], grid: { rows: 0, cols: 0 } });
    expect(matchProtocol([pt], { modality: "CT", modalities: ["CT", "PT"] }, [S("p", "PT", 1, "AC")])?.id).toBe("pt");
    expect(matchProtocol([brain], { modality: "MR", studyDescription: null }, MR)).toBeNull();
  });

  it("同順位は、埋まるスロットが多い → 名前 → id で決める", () => {
    const a = P({ id: "z1", name: "B", match: { modality: ["MR"] }, slots: [t1], grid: { rows: 0, cols: 0 } });
    const b = P({ id: "z2", name: "A", match: { modality: ["MR"] }, slots: [t1], grid: { rows: 0, cols: 0 } });
    const c = P({ id: "z0", name: "A", match: { modality: ["MR"] }, slots: [t1], grid: { rows: 0, cols: 0 } });
    expect(matchProtocol([a, b, c], { modality: "MR" }, MR)?.id).toBe("z0"); // name が同じ A なら id の昇順
    const more = P({ id: "zz", name: "Z", match: { modality: ["MR"] }, slots: [t1, t2], grid: { rows: 0, cols: 0 } });
    expect(matchProtocol([a, b, more], { modality: "MR" }, MR)?.id).toBe("zz"); // 埋まるスロットが多い
  });
});

describe("parseHangingProtocol / serialize", () => {
  const valid = { version: 1, id: "ok-1", name: "例", match: { modality: ["MR"] }, slots: [{ series: { descriptionContains: "T1" } }], grid: { rows: 1, cols: 2 } };

  it("正しい形は通り、書き出して読み直すと同じ（往復）。知らないキーは保持して書き戻す", () => {
    const r = parseHangingProtocol({ ...valid, future: { a: [1, 2] }, note: "x" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.protocol.extra).toEqual({ future: { a: [1, 2] }, note: "x" });
    const text = serializeHangingProtocol(r.protocol);
    const again = parseHangingProtocol(JSON.parse(text));
    expect(again.ok && again.protocol).toEqual(r.protocol);
    expect(JSON.parse(text)).toMatchObject({ future: { a: [1, 2] }, note: "x", id: "ok-1" });
  });

  const bad: [string, unknown, string][] = [
    ["JSON でない値（null）", null, "全体"],
    ["配列", [], "全体"],
    ["version 違い", { ...valid, version: 2 }, "version"],
    ["id に /", { ...valid, id: "a/b" }, "id"],
    ["id にスペース", { ...valid, id: "a b" }, "id"],
    ["id が 41 文字", { ...valid, id: "a".repeat(41) }, "id"],
    ["name が空", { ...valid, name: "  " }, "name"],
    ["name が 101 文字", { ...valid, name: "あ".repeat(101) }, "name"],
    ["slots が空", { ...valid, slots: [] }, "slots"],
    ["slots が 25 個", { ...valid, slots: Array.from({ length: 25 }, () => valid.slots[0]) }, "25 個"],
    ["条件が空のスロット", { ...valid, slots: [{ series: {} }] }, "slots[0].series: 条件が空"],
    ["numberEquals が小数", { ...valid, slots: [{ series: { numberEquals: 1.5 } }] }, "numberEquals"],
    ["pick が未知", { ...valid, slots: [{ series: { modality: "MR", pick: "second" } }] }, "pick"],
    ["説明が 101 文字", { ...valid, slots: [{ series: { descriptionContains: "a".repeat(101) } }] }, "descriptionContains"],
    ["rows が負", { ...valid, grid: { rows: -1, cols: 2 } }, "grid.rows"],
    ["cols が 13", { ...valid, grid: { rows: 1, cols: 13 } }, "grid.cols"],
    ["rows が小数", { ...valid, grid: { rows: 1.5, cols: 2 } }, "grid.rows"],
    ["grid が無い", { ...valid, grid: undefined }, "grid"],
    ["gridPortrait が不正", { ...valid, gridPortrait: { rows: 1 } }, "gridPortrait.cols"],
    ["match.modality が空配列", { ...valid, match: { modality: [] } }, "match.modality"],
  ];
  it.each(bad)("負例: %s → 場所つきの理由で拒否", (_label, raw, expected) => {
    const r = parseHangingProtocol(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain(expected);
  });

  it("保存できる大きさ: ちょうど 4000 文字は通り、1 文字超で拒否", () => {
    const r = parseHangingProtocol({ ...valid, extra0: "" });
    if (!r.ok) throw new Error("前提が崩れた");
    const len0 = serializeHangingProtocol(r.protocol).length; // extra0 が空文字のときの長さ
    const at = (n: number): HangingProtocol => ({ ...r.protocol, extra: { extra0: "x".repeat(n) } });
    const pad = MAX_STORED_CHARS - len0;
    expect(serializeHangingProtocol(at(pad)).length).toBe(MAX_STORED_CHARS);
    expect(checkStorable(at(pad))).toBeNull();
    expect(checkStorable(at(pad + 1))).toMatch(/大きすぎ/);
  });
});

describe("normalizeText", () => {
  it("NFKC・ゼロ幅・空白・大文字小文字", () => {
    expect(normalizeText("　Ｔ１​　 Flair ")).toBe("t1 flair");
    expect(normalizeText("")).toBe("");
  });
});
