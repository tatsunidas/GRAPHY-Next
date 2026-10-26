/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 回帰評価の固定質問セット。合成の指示文だけ（患者情報なし）。見るのは「呼んだツールと主な引数」で、返答の文章は見ない（揺れるため）。
// 質問を足す・変えるときは `EVAL_SUITE_VERSION` を上げる（版が違う実行どうしは比較しない）。

export const EVAL_SUITE_VERSION = 1;

/** 期待する操作 1 つ。`args` の数値は厳密一致、文字列（配列）は「いずれかを含む」（大小無視）。 */
export interface EvalOp {
  id: string;
  args?: Record<string, number | string | string[]>;
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
