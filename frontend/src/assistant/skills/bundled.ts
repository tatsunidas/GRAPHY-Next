/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// アプリに同梱するスキル（読み取り専用。表示操作だけで、今ある機能で動く）。実行時に利用者のスキルと同じ検証を通る。
import type { Skill } from "./skillModel";

export const BUNDLED_SKILLS: readonly Skill[] = [
  {
    schemaVersion: 1,
    id: "ct-window-tour",
    title: { ja: "CT 標準ウィンドウ巡回", en: "CT window tour" },
    description: {
      ja: "肺 → 軟部 → 骨の順にウィンドウを切り替え、各段階で確認します（表示のみ・元に戻せます）。",
      en: "Switch the window through lung, soft tissue and bone, confirming at each stage (display only, undoable).",
    },
    inputs: [],
    steps: [
      { kind: "tool", id: "applyWlPreset", params: { name: "lung" } },
      { kind: "confirm", message: { ja: "肺の条件を表示しました。軟部の条件へ進みますか？", en: "Lung window shown. Continue to the soft-tissue window?" } },
      { kind: "tool", id: "applyWlPreset", params: { name: "soft" } },
      { kind: "confirm", message: { ja: "軟部の条件を表示しました。骨の条件へ進みますか？", en: "Soft-tissue window shown. Continue to the bone window?" } },
      { kind: "tool", id: "applyWlPreset", params: { name: "bone" } },
    ],
  },
  {
    schemaVersion: 1,
    id: "slice-review",
    title: { ja: "指定スライスを選んだ条件で確認", en: "Review a slice with a chosen window" },
    description: {
      ja: "ウィンドウの条件を選び、途中で見たいスライス番号（0 始まり）を尋ねて、そのスライスを表示します。",
      en: "Pick a window preset, then be asked for a slice number (0-based) and jump to it.",
    },
    inputs: [
      { key: "preset", label: { ja: "ウィンドウの条件", en: "Window preset" }, type: "enum", values: ["soft", "lung", "bone", "brain", "abdomen", "liver"], default: "soft" },
      { key: "slice", label: { ja: "スライス番号（0 始まり）", en: "Slice number (0-based)" }, type: "integer", min: 0, max: 100000, default: 0 },
    ],
    steps: [
      { kind: "tool", id: "applyWlPreset", params: { name: { $input: "preset" } } },
      { kind: "ask", input: "slice" },
      { kind: "tool", id: "goToSlice", params: { index: { $input: "slice" } } },
      { kind: "confirm", message: { ja: "このスライスでよいですか？（やめると、ここで止まります）", en: "Is this the slice you wanted? (Stopping ends the skill here.)" } },
    ],
  },
];
