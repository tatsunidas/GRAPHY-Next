/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * W/L プリセット（主に CT。モダリティ値=HU 空間の WindowCenter/Width）。
 * MR は標準化された絶対値が無いため既定（DICOM ウィンドウ）に戻す用途が中心。
 */
export interface WlPreset {
  key: string;
  /** ラベル i18n キー。 */
  labelKey: string;
  center: number;
  width: number;
}

export const WL_PRESETS: WlPreset[] = [
  { key: "brain", labelKey: "viewer2d.wl.brain", center: 40, width: 80 },
  { key: "soft", labelKey: "viewer2d.wl.soft", center: 40, width: 400 },
  { key: "lung", labelKey: "viewer2d.wl.lung", center: -600, width: 1500 },
  { key: "bone", labelKey: "viewer2d.wl.bone", center: 300, width: 1500 },
  { key: "abdomen", labelKey: "viewer2d.wl.abdomen", center: 40, width: 350 },
  { key: "liver", labelKey: "viewer2d.wl.liver", center: 60, width: 160 },
];
