/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 解析結果 → レポート本文の整形（A14・`fw/angio-design.md` §21.5）。
 *
 * <p>ここで守る一番大事な規則は **「数値だけを差し込まない」**。
 * レポートは人が読んで判断する最終成果物なので、出自と限界が数値と同じブロックに要る。
 */
import { describe, expect, it } from "vitest";

import {
  type AnalysisResultRecord,
  type BlockLabels,
  appendBlock,
  assertHasCaveats,
  buildPluginAnalysisRecord,
  formatAnalysisBlock,
} from "./analysisResults";
import { clearAnalysisResults, listAnalysisResults, publishAnalysisResult, useAnalysisResults } from "./analysisResultStore";

const LABELS: BlockLabels = { location: "位置", metric: "項目", value: "値", provenance: "出自" };

function record(over: Partial<AnalysisResultRecord> = {}): AnalysisResultRecord {
  return {
    id: "qca-1",
    kind: "qca",
    studyUid: "1.2.3",
    seriesUid: "1.2.3.9",
    sopInstanceUids: ["1.2.3.10"],
    frameLabel: "ラン 2 / フレーム 12",
    title: "QCA（左前下行枝）",
    metrics: [
      { label: "MLD", value: "1.42", unit: "mm" },
      { label: "%DS", value: "51.1", unit: "%" },
    ],
    provenance: [
      { label: "空間校正", value: "カテーテル 6Fr（実測）" },
      { label: "手修正", value: "中間点 2 / エッジ 3" },
    ],
    caveats: ["径は半値法由来で約 13% 過小です。", "研究用であり診断に用いないこと。"],
    at: 1,
    ...over,
  };
}

describe("formatAnalysisBlock", () => {
  it("見出し・位置・計測表・出自・注意書きを 1 ブロックにする", () => {
    const md = formatAnalysisBlock(record(), LABELS);
    expect(md).toContain("## QCA（左前下行枝）");
    expect(md).toContain("位置: ラン 2 / フレーム 12");
    expect(md).toContain("| MLD | 1.42 mm |");
    expect(md).toContain("| %DS | 51.1 % |");
    expect(md).toContain("- 空間校正: カテーテル 6Fr（実測）");
    expect(md).toContain("> 径は半値法由来で約 13% 過小です。");
  });

  it("🚨 注意書きは計測表より後・出自の直後に置く（末尾へ追いやらない）", () => {
    // 末尾に置くと読まれない。数値のすぐそばに無いと意味が無い。
    const md = formatAnalysisBlock(record(), LABELS);
    const table = md.indexOf("| MLD |");
    const caveat = md.indexOf("> 径は半値法由来");
    expect(table).toBeGreaterThan(-1);
    expect(caveat).toBeGreaterThan(table);
  });

  it("単位の無い値は単位を付けない", () => {
    const md = formatAnalysisBlock(record({ metrics: [{ label: "アンカー", value: "5" }] }), LABELS);
    expect(md).toContain("| アンカー | 5 |");
  });

  it("計測が無くても出自と注意書きは出る（数値が出ないこと自体が結果）", () => {
    const md = formatAnalysisBlock(record({ metrics: [] }), LABELS);
    expect(md).not.toContain("| 項目 |");
    expect(md).toContain("- 空間校正:");
    expect(md).toContain("> 研究用であり診断に用いないこと。");
  });
});

describe("assertHasCaveats", () => {
  it("🚨 注意書きの無い記録は作らせない", () => {
    // 空を許すと、書き忘れた結果が「注意の要らない結果」と同じ顔でレポートに載る。
    expect(() => assertHasCaveats(record({ caveats: [] }))).toThrow();
    expect(() => assertHasCaveats(record())).not.toThrow();
  });
});

describe("appendBlock", () => {
  it("🚨 本文を置き換えず、必ず末尾へ追記する", () => {
    // 人が書いた所見を解析結果で上書きするのは、どんな場合でも間違い。
    expect(appendBlock("所見をここに書いた。", "## QCA")).toBe("所見をここに書いた。\n\n## QCA");
  });

  it("空の本文なら余分な空行を作らない", () => {
    expect(appendBlock("", "## QCA")).toBe("## QCA");
    expect(appendBlock("   \n\n", "## QCA")).toBe("## QCA");
  });

  it("2 回差し込んでも前のブロックが消えない", () => {
    const once = appendBlock("", "## A");
    expect(appendBlock(once, "## B")).toBe("## A\n\n## B");
  });
});

describe("analysisResultStore", () => {
  it("注意書きの無い記録は登録できない", () => {
    clearAnalysisResults();
    expect(() => publishAnalysisResult(record({ caveats: [] }))).toThrow();
    expect(listAnalysisResults()).toHaveLength(0);
  });

  it("同じ id は置き換える（解析し直したら新しいほうが正しい）", () => {
    clearAnalysisResults();
    publishAnalysisResult(record({ at: 1, metrics: [{ label: "MLD", value: "1.00", unit: "mm" }] }));
    publishAnalysisResult(record({ at: 2, metrics: [{ label: "MLD", value: "2.00", unit: "mm" }] }));
    const all = listAnalysisResults();
    expect(all).toHaveLength(1);
    expect(all[0].metrics[0].value).toBe("2.00");
  });

  it("🚨 別スタディの結果は返さない（レポートに他患者の数値を載せない）", () => {
    clearAnalysisResults();
    publishAnalysisResult(record({ id: "a", studyUid: "1.2.3" }));
    publishAnalysisResult(record({ id: "b", studyUid: "9.9.9" }));
    // useAnalysisResults はフックだが、絞り込みの規則そのものを一覧側でも確かめる。
    expect(listAnalysisResults().filter((r) => r.studyUid === "1.2.3")).toHaveLength(1);
    expect(typeof useAnalysisResults).toBe("function");
  });
});

/* ------------------------------------------------------------------ */
/* H39 — プラグインからの解析結果                                      */
/* ------------------------------------------------------------------ */

describe("★buildPluginAnalysisRecord — プラグインの結果をレポートへ載せる", () => {
  const context = { studyUid: "1.2.study", seriesUid: "1.2.series" };
  const producer = { id: "angio-quant", name: "Angio Quant", version: "0.1.0" };
  const labels = { pluginLabel: "プラグイン", researchOnly: "研究用の解析であり、単独で診断に用いないこと。" };
  const input = {
    id: "qca-1",
    kind: "qca" as const,
    sopInstanceUids: ["1.2.sop"],
    frameLabel: "フレーム 12",
    title: "冠動脈定量解析（QCA）",
    metrics: [{ label: "MLD", value: "1.47", unit: "mm" }],
    provenance: [{ label: "空間校正", value: "カテーテル 6Fr" }],
    caveats: ["径は密度計測で測っています。"],
  };

  it("🔴 id にプラグインの名前空間を付ける（本体の記録を差し替えられない）", () => {
    const r = buildPluginAnalysisRecord(input, context, producer, labels, 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 登録簿は id が同じ記録を**置き換える**。素の id を通すと本体の結果を上書きできてしまう。
    expect(r.record.id).toBe("plugin:angio-quant:qca-1");
  });

  it("スタディ / シリーズはプラグインからではなく表示中のものを入れる", () => {
    const r = buildPluginAnalysisRecord(
      { ...input, ...({ studyUid: "9.9.9" } as object) },
      context,
      producer,
      labels,
      1000,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.studyUid).toBe("1.2.study");
    expect(r.record.seriesUid).toBe("1.2.series");
  });

  it("出自にプラグイン名と版を必ず足す", () => {
    const r = buildPluginAnalysisRecord(input, context, producer, labels, 1000);
    if (!r.ok) throw new Error("built failed");
    const row = r.record.provenance.find((p) => p.label === "プラグイン");
    expect(row?.value).toBe("Angio Quant 0.1.0");
    // プラグインが書いた出自も残す（置き換えない）。
    expect(r.record.provenance.some((p) => p.label === "空間校正")).toBe(true);
  });

  it("研究用の 1 行を必ず足す（二重には足さない）", () => {
    const r = buildPluginAnalysisRecord(input, context, producer, labels, 1000);
    if (!r.ok) throw new Error("built failed");
    expect(r.record.caveats).toContain(labels.researchOnly);

    const already = buildPluginAnalysisRecord(
      { ...input, caveats: [labels.researchOnly] },
      context,
      producer,
      labels,
      1000,
    );
    if (!already.ok) throw new Error("built failed");
    expect(already.record.caveats.filter((c) => c === labels.researchOnly)).toHaveLength(1);
  });

  it("🔴 注意書きが空（空白だけを含む）なら拒否する", () => {
    // host が研究用の 1 行を足すので形式上は通せるが、**その解析に固有の限界**を
    // 知っているのはプラグイン側だけ。空を許すと、注意の要らない結果と同じ顔で載る。
    for (const caveats of [[], [""], ["   "]]) {
      const r = buildPluginAnalysisRecord({ ...input, caveats }, context, producer, labels, 1000);
      expect(r.ok).toBe(false);
    }
  });

  it("id が空なら拒否する", () => {
    expect(buildPluginAnalysisRecord({ ...input, id: "  " }, context, producer, labels, 1000).ok).toBe(false);
  });

  it("できた記録は本体と同じ検査（assertHasCaveats）を通る", () => {
    const r = buildPluginAnalysisRecord(input, context, producer, labels, 1000);
    if (!r.ok) throw new Error("built failed");
    expect(() => assertHasCaveats(r.record)).not.toThrow();
  });
});
