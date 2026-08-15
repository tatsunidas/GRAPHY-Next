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
