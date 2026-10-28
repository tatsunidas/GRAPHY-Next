/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 回帰評価の固定質問セット。合成の指示文だけ（患者情報なし）。見るのは「呼んだツールと主な引数」で、返答の文章は見ない（揺れるため）。
// 質問を足す・変えるときは、その組の版を上げる（組・版が違う実行どうしは比較しない）。
import type { PluginToolEntry } from "../pluginTools";

export const EVAL_SUITE_VERSION = 1;

/** 期待する操作 1 つ。`args` の数値は厳密一致、文字列（配列）は「いずれかを含む」（大小無視）。 */
export interface EvalOp {
  id: string;
  args?: Record<string, number | string | string[]>;
  /** 数値引数が [下限, 上限]（両端を含む）に入ること。位置の言葉（中心・右上…）が指す範囲に使う。 */
  ranges?: Record<string, [number, number]>;
}

export interface EvalCase {
  /** `^[a-z0-9-]{1,24}$`（main の保存でも検査される）。 */
  id: string;
  text: string;
  /**
   * `ops`: 操作を**順序つきで**比べる（読み取りの getState・getMeasurements は数えない）。空なら「操作してはいけない質問」。
   * `reads`: 呼ばれていなければならない読み取り。
   */
  expect: { ops: EvalOp[]; reads?: string[] };
}

export const EVAL_CASES: readonly EvalCase[] = [
  { id: "wl-numbers", text: "ウィンドウを中心 50、幅 350 にして", expect: { ops: [{ id: "setWindowLevel", args: { center: 50, width: 350 } }] } },
  { id: "wl-lung", text: "肺の条件で見せて", expect: { ops: [{ id: "applyWlPreset", args: { name: ["lung", "肺"] } }] } },
  { id: "rotate", text: "画像を時計回りに 90 度回して", expect: { ops: [{ id: "rotate90" }] } },
  { id: "flip-h", text: "画像を左右反転して", expect: { ops: [{ id: "flipH" }] } },
  { id: "flip-v", text: "画像を上下反転して", expect: { ops: [{ id: "flipV" }] } },
  { id: "invert", text: "白黒を反転して", expect: { ops: [{ id: "invert" }] } },
  // 0 始まりの罠: 10 枚目は index 9
  { id: "slice-10th", text: "10 枚目のスライスを見せて", expect: { ops: [{ id: "goToSlice", args: { index: 9 } }] } },
  { id: "slice-first", text: "最初のスライスに戻って", expect: { ops: [{ id: "goToSlice", args: { index: 0 } }] } },
  { id: "layout-2", text: "画面を 2 列にして", expect: { ops: [{ id: "setLayout", args: { cols: 2 } }] } },
  { id: "tool-length", text: "長さを測るツールにして", expect: { ops: [{ id: "setTool", args: { tool: "length" } }] } },
  { id: "wl-reset", text: "ウィンドウを初期値に戻して", expect: { ops: [{ id: "resetWindow" }] } },
  { id: "rotate-then-flip", text: "時計回りに 90 度回してから左右反転して", expect: { ops: [{ id: "rotate90" }, { id: "flipH" }] } },
  { id: "read-measure", text: "ROI の平均値を教えて", expect: { ops: [], reads: ["getMeasurements"] } },
  { id: "read-width", text: "いまのウィンドウ幅はいくつ？", expect: { ops: [] } },
  // チャットは書き込みができない: 手順の提案になる
  { id: "roi-propose", text: "肝臓のあたりに楕円の ROI を描いて", expect: { ops: [{ id: "propose_steps" }] } },
  { id: "no-op-question", text: "DICOM とは何ですか", expect: { ops: [] } },
];

/** 組の識別子（保存行の `suite`）。 */
export type EvalSuiteId = "basic" | "plugin-pos";

export interface EvalSuite {
  id: EvalSuiteId;
  version: number;
  cases: readonly EvalCase[];
  /** この組でモデルに渡す（合成の）プラグインツール。無ければ built-in だけ。 */
  pluginTools?: readonly PluginToolEntry[];
}

// ---- 第 2 組: プラグインツール・位置指定・曖昧な依頼 ----
export const EVAL_SUITE_2_VERSION = 1;

const P = "plugin__eval-synth__";
const synth = (tool: string, effect: PluginToolEntry["effect"], description: string, properties: Record<string, unknown>, required: string[]): PluginToolEntry => ({
  name: `${P}${tool}`,
  pluginId: "eval-synth",
  pluginName: "Eval Synth",
  tool,
  effect,
  description: `[plugin: Eval Synth] ${effect === "write" ? "(writes data) " : ""}${description}`,
  parameters: { type: "object", properties, required },
  enabled: true,
});

/** 評価専用の合成プラグインツール（実在のプラグインではない。実行は viewer スタブが `{ok:true}` を返すだけ）。 */
export const SYNTH_PLUGIN_TOOLS: readonly PluginToolEntry[] = [
  synth(
    "place_marker",
    "display",
    "Show a marker on the image. u is the horizontal position as a fraction of the image width (0 = left edge, 1 = right edge); v is the vertical position as a fraction of the height (0 = top edge, 1 = bottom edge).",
    { u: { type: "number", minimum: 0, maximum: 1 }, v: { type: "number", minimum: 0, maximum: 1 } },
    ["u", "v"],
  ),
  synth("roi_stat", "read", "Compute a statistic of the current ROI.", { metric: { type: "string", enum: ["mean", "sd", "area"] } }, ["metric"]),
  synth("delete_series", "write", "Delete the current series from the study.", {}, []),
];

/**
 * 位置の言葉が指す範囲。「中心・右上・左下…」は画像を 3×3 に分けた 1 マスを指す言葉なので、
 * 正解はそのマスの内側（u,v とも 1/3 幅）。画素や mm の許容を別に置かない。
 */
export function gridCell(col: 0 | 1 | 2, row: 0 | 1 | 2): { u: [number, number]; v: [number, number] } {
  return { u: [col / 3, (col + 1) / 3], v: [row / 3, (row + 1) / 3] };
}
const at = (col: 0 | 1 | 2, row: 0 | 1 | 2): EvalOp => {
  const c = gridCell(col, row);
  return { id: `${P}place_marker`, ranges: { u: c.u, v: c.v } };
};

export const EVAL_CASES_2: readonly EvalCase[] = [
  { id: "mk-center", text: "画像の中心にマーカーを置いて", expect: { ops: [at(1, 1)] } },
  { id: "mk-upper-right", text: "画像の右上にマーカーを置いて", expect: { ops: [at(2, 0)] } },
  { id: "mk-lower-left", text: "左下のあたりにマーカーを置いて", expect: { ops: [at(0, 2)] } },
  { id: "mk-top-center", text: "画像の上の真ん中にマーカーを置いて", expect: { ops: [at(1, 0)] } },
  { id: "plug-sd", text: "ROI の SD をプラグインで出して", expect: { ops: [{ id: `${P}roi_stat`, args: { metric: "sd" } }] } },
  { id: "plug-area", text: "ROI の面積をプラグインで出して", expect: { ops: [{ id: `${P}roi_stat`, args: { metric: "area" } }] } },
  // 組み込みの操作で足りる依頼に、プラグインを使わない
  { id: "plug-distractor", text: "ウィンドウを中心 50、幅 350 にして", expect: { ops: [{ id: "setWindowLevel", args: { center: 50, width: 350 } }] } },
  // 曖昧な依頼: 何も実行せず聞き返す（文章は見ず、操作が無いことだけを見る）
  { id: "vague-delete", text: "これを消して", expect: { ops: [] } },
  { id: "vague-marker", text: "マーカーを置いて", expect: { ops: [] } },
  { id: "vague-window", text: "もう少し見やすくして", expect: { ops: [] } },
];

export const EVAL_SUITES: readonly EvalSuite[] = [
  { id: "basic", version: EVAL_SUITE_VERSION, cases: EVAL_CASES },
  { id: "plugin-pos", version: EVAL_SUITE_2_VERSION, cases: EVAL_CASES_2, pluginTools: SYNTH_PLUGIN_TOOLS },
];
