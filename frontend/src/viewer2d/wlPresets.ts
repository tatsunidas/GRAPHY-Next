/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * W/L プリセット（主に CT。モダリティ値=HU 空間の WindowCenter/Width）。
 * MR は標準化された絶対値が無いため既定（DICOM ウィンドウ）に戻す用途が中心。
 *
 * プリセットはユーザーが編集/追加/リセットできる（GRAPHY の WwWlPresets 相当）。
 * 永続化は `wlPresetStore.ts`（backend 設定キー `viewer.wlPresets`）。組み込み既定は
 * i18n ラベル（`labelKey`）、ユーザー定義は自由入力名（`name`）で表示する。
 */
export interface WlPreset {
  /** 安定 ID（React key / 選択用。既定は "brain" 等、ユーザー定義は生成 ID）。 */
  key: string;
  /** 組み込み既定のラベル i18n キー（ユーザー定義では未設定）。 */
  labelKey?: string;
  /** ユーザー定義プリセットの表示名（自由入力。既定では未設定）。 */
  name?: string;
  center: number;
  width: number;
}

/** 組み込み既定プリセット（リセット時に戻す先）。 */
export const DEFAULT_PRESETS: WlPreset[] = [
  { key: "brain", labelKey: "viewer2d.wl.brain", center: 40, width: 80 },
  { key: "soft", labelKey: "viewer2d.wl.soft", center: 40, width: 400 },
  { key: "lung", labelKey: "viewer2d.wl.lung", center: -600, width: 1500 },
  { key: "bone", labelKey: "viewer2d.wl.bone", center: 300, width: 1500 },
  { key: "abdomen", labelKey: "viewer2d.wl.abdomen", center: 40, width: 350 },
  { key: "liver", labelKey: "viewer2d.wl.liver", center: 60, width: 160 },
];

/** 後方互換エイリアス（静的既定を参照する既存コード用）。 */
export const WL_PRESETS = DEFAULT_PRESETS;

/** 表示ラベルを解決（ユーザー定義名 → i18n ラベル → key の順）。 */
export function presetLabel(p: WlPreset, t: (k: string) => string): string {
  if (p.name && p.name.trim()) return p.name;
  if (p.labelKey) return t(p.labelKey);
  return p.key;
}
