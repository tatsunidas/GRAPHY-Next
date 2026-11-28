import { describe, expect, it } from "vitest";
import {
  autoApplyDecision, chooseAutoProtocol, exportProtocols, extractProtocols, hasStored, isAutoApplyOn, parseImport,
  sortForStudy, toStoreUpdate,
} from "./hangingProtocolStore";
import { MAX_STORED_CHARS, parseHangingProtocol, type HangingProtocol } from "./hangingProtocol";

const raw = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `name ${id}`, version: 1, match: {}, slots: [{ series: { descriptionContains: "t1" } }], grid: { rows: 1, cols: 2 }, ...extra,
});
const parsed = (v: object): HangingProtocol => {
  const r = parseHangingProtocol(v);
  if (!r.ok) throw new Error(r.errors.join(","));
  return r.protocol;
};
const stored = (...items: object[]) =>
  Object.fromEntries(items.map((v) => [`hanging.protocol.${(v as { id: string }).id}`, JSON.stringify(v)]));
const series = (uid: string, desc: string, sopClassUid: string | null = null) =>
  ({ seriesInstanceUid: uid, seriesNumber: 1, seriesDescription: desc, modality: "MR", sopClassUid });
const study = { modality: "MR", modalities: ["MR"], studyDescription: "Brain" };

describe("extractProtocols", () => {
  it("名前順で返し、削除済み（空文字）と別の鍵は数えない", () => {
    const r = extractProtocols({
      ...stored(raw("b"), raw("a")), "hanging.protocol.gone": "", "search.saved.x": "{}", "viewer.hangingAutoApply": "true",
    });
    expect(r.items.map((p) => p.id)).toEqual(["a", "b"]);
    expect(r.broken).toEqual([]);
  });

  it("読めない値・形が不正・鍵と id の食い違いは、理由つきで分ける", () => {
    const r = extractProtocols({
      "hanging.protocol.j": "{", "hanging.protocol.v": JSON.stringify(raw("v", { version: 2 })),
      "hanging.protocol.k": JSON.stringify(raw("other")),
    });
    expect(r.items).toEqual([]);
    expect(r.broken.map((b) => b.key)).toEqual(["hanging.protocol.j", "hanging.protocol.k", "hanging.protocol.v"]);
    expect(r.broken.every((b) => b.errors.length > 0)).toBe(true);
  });

  it("読めない保存も「ある」と数える。空文字は無い", () => {
    expect(hasStored({ "hanging.protocol.j": "{" }, "j")).toBe(true);
    expect(hasStored({ "hanging.protocol.j": "" }, "j")).toBe(false);
  });
});

describe("保存・書き出し・取り込みの往復", () => {
  it("知らないキーも保ったまま往復する", () => {
    const original = raw("a", { note: { keep: 1 }, gridPortrait: { rows: 2, cols: 1 } });
    const back = parseImport(exportProtocols([parsed(original)]));
    expect(back.ok && back.entries).toHaveLength(1);
    const e = back.ok ? back.entries[0] : null;
    expect(e?.ok && JSON.parse(e.value)).toEqual(original);
    expect(e?.ok && e.key).toBe("hanging.protocol.a");
  });

  it("4000 文字ちょうどは保存でき、1 文字超えると保存できない", () => {
    const sized = (n: number) => {
      const base = toStoreUpdate(parsed(raw("a", { pad: "" })));
      if (!base.ok) throw new Error("base");
      return parsed(raw("a", { pad: "x".repeat(n - base.value.length) }));
    };
    expect(MAX_STORED_CHARS).toBe(4000);
    const at = toStoreUpdate(sized(4000));
    expect(at.ok && at.value.length).toBe(4000);
    expect(toStoreUpdate(sized(4001)).ok).toBe(false);
    const imp = parseImport(JSON.stringify(JSON.parse(exportProtocols([sized(4001)]))));
    expect(imp.ok && imp.entries[0].ok).toBe(false);
  });

  it("1 件でも配列でも読み、件ごとに可否を返す。重複する id は 2 件目以降を断る", () => {
    const one = parseImport(JSON.stringify(raw("a")));
    expect(one.ok && one.entries.map((e) => e.ok)).toEqual([true]);
    const many = parseImport(JSON.stringify([raw("a"), raw("b", { version: 9 }), raw("a")]));
    expect(many.ok && many.entries.map((e) => e.ok)).toEqual([true, false, false]);
    expect(parseImport("not json").ok).toBe(false);
  });
});

describe("sortForStudy", () => {
  it("検査の条件に合うものが先頭", () => {
    const list = [parsed(raw("a", { match: { modality: ["CT"] } })), parsed(raw("b", { match: { modality: ["MR"] } }))];
    expect(sortForStudy(list, study).map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("自動適用", () => {
  it("設定が無ければ切", () => {
    expect(isAutoApplyOn({})).toBe(false);
    expect(isAutoApplyOn({ "viewer.hangingAutoApply": "false" })).toBe(false);
    expect(isAutoApplyOn({ "viewer.hangingAutoApply": "true" })).toBe(true);
  });

  it("条件の多いものを選び、並びを返す", () => {
    const loose = parsed(raw("loose"));
    const tight = parsed(raw("tight", { match: { modality: ["MR"] } }));
    const r = chooseAutoProtocol([loose, tight], study, [series("s", "T1")], { portrait: false });
    expect(r?.protocol.id).toBe("tight");
    expect(r?.plan.series.map((s) => s.seriesInstanceUid)).toEqual(["s"]);
  });

  it("非画像にしか合わないプロトコルは選ばず、画像に合う別のものを選ぶ", () => {
    const pdfOnly = parsed(raw("pdf", { match: { modality: ["MR"] }, slots: [{ series: { descriptionContains: "report" } }] }));
    const images = parsed(raw("img"));
    const list = [series("pdf", "report", "1.2.840.10008.5.1.4.1.1.104.1"), series("s", "T1")];
    expect(chooseAutoProtocol([pdfOnly, images], study, list, { portrait: false })?.protocol.id).toBe("img");
    expect(chooseAutoProtocol([pdfOnly], study, list, { portrait: false })).toBeNull();
  });

  it("何も失わないときだけ適用する", () => {
    expect(autoApplyDecision([], "k", true)).toBe("apply");
    expect(autoApplyDecision(["other"], "k", false)).toBe("apply");
    expect(autoApplyDecision(["other"], "k", true)).toBe("other-patients");
    expect(autoApplyDecision(["k"], "k", false)).toBe("has-tiles");
    expect(autoApplyDecision(["k", "other"], "k", true)).toBe("has-tiles");
  });
});
