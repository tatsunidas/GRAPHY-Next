/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 2D ビューアのタイルの見せ方。
 *  - global: 全患者のタイルを 1 つのグリッドに並べる（患者同士を比べる）。
 *  - tabs  : 患者ごとのタブで分け、表示中の患者のタイルだけ出す（従来）。
 */
export type ViewMode = "global" | "tabs";

/** 選んだ見せ方を保存する localStorage のキー。 */
export const VIEW_MODE_KEY = "graphy.viewer2d.viewMode";

/** 保存値 → 見せ方。`"tabs"` だけがタブで、欠損・不正値は既定の全患者（読めなくても動くように）。 */
export function parseViewMode(raw: string | null | undefined): ViewMode {
  return raw === "tabs" ? "tabs" : "global";
}
