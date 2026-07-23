/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// W/L プリセット（主に CT。HU 空間の WindowCenter/Width）。
// 本体 frontend/src/viewer2d/wlPresets.ts の組み込み既定を脱 React 移植（i18n を使わず日本語ラベル固定）。
// portable はユーザー編集/永続化を持たない（固定リスト＋数値直接入力で足りる）。

export interface WlPreset {
  key: string;
  label: string;
  center: number;
  width: number;
}

/** 既定プリセット（本体 DEFAULT_PRESETS と同値）。 */
export const WL_PRESETS: WlPreset[] = [
  { key: "brain", label: "脳", center: 40, width: 80 },
  { key: "soft", label: "軟部/縦隔", center: 40, width: 400 },
  { key: "lung", label: "肺野", center: -600, width: 1500 },
  { key: "bone", label: "骨", center: 300, width: 1500 },
  { key: "abdomen", label: "腹部", center: 40, width: 350 },
  { key: "liver", label: "肝臓", center: 60, width: 160 },
];
