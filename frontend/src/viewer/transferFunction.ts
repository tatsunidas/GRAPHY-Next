/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D Viewer の転送関数（TF）選択面（P1）。
 *
 * 旧 GRAPHY の `volume.frag`（`uRenderMode`）に対応するレンダリングモードと、色/不透明度転送関数の
 * 既定（Cornerstone3D の VR プリセット `VIEWPORT_PRESETS`）をここに集約する。P1 ではプリセットを TF の
 * 実体として使い、任意カーブ編集（`vtkPiecewiseFunction`）とヒストグラムは P2（3D LUT カーブダイアログ）で足す。
 *
 * 設計: `fw/3d-viewer-design.md` §4 / §6 / §7。W/L は常に HU/SUV（モダリティ値空間）で駆動する（§3.3・
 * `viewer/pixelCalibration.ts` 単一入口）。プリセット名は Cornerstone の `VIEWPORT_PRESETS.name` と厳密一致が必要。
 */
import { Enums, utilities as csUtilities } from "@cornerstonejs/core";
import type { LutData } from "../api";

/** レンダリングモード。旧 `volume.frag` の DVR/MIP に、MinIP/AVG を加えたもの。Ortho は別ビュー（P2）。 */
export type RenderMode = "VR" | "MIP" | "MINIP" | "AVG";

/**
 * モード → Cornerstone `BlendModes`。
 * VR(DVR)=COMPOSITE（emission-absorption 合成）、MIP=最大値、MinIP=最小値、AVG=平均。
 */
export function blendModeFor(mode: RenderMode): number {
  const B = Enums.BlendModes;
  switch (mode) {
    case "MIP":
      return B.MAXIMUM_INTENSITY_BLEND;
    case "MINIP":
      return B.MINIMUM_INTENSITY_BLEND;
    case "AVG":
      return B.AVERAGE_INTENSITY_BLEND;
    case "VR":
    default:
      return B.COMPOSITE;
  }
}

// Cornerstone `VIEWPORT_PRESETS` の名前（`constants/viewportPresets`）。厳密一致でのみ適用される。
const CT_PRESETS = [
  "CT-Bone",
  "CT-Bones",
  "CT-Soft-Tissue",
  "CT-Muscle",
  "CT-Fat",
  "CT-Lung",
  "CT-Chest-Vessels",
  "CT-Chest-Contrast-Enhanced",
  "CT-Pulmonary-Arteries",
  "CT-Coronary-Arteries-3",
  "CT-Liver-Vasculature",
  "CT-Cardiac",
  "CT-AAA",
  "CT-Air",
] as const;

const MR_PRESETS = ["MR-Default", "MR-Angio", "MR-T2-Brain", "DTI-FA-Brain"] as const;

/** MIP/MinIP 時の既定プリセット（グレースケール寄り）。 */
export const MIP_PRESET_CT = "CT-MIP";
export const MIP_PRESET_MR = "MR-MIP";

/** VR(DVR) 時の既定プリセット。 */
export const DEFAULT_VR_PRESET_CT = "CT-Bone";
export const DEFAULT_VR_PRESET_MR = "MR-Default";

/** モダリティ別の選択可能な VR プリセット一覧（UI ドロップダウン用）。不明モダリティは CT+MR を返す。 */
export function presetsForModality(modality: string | null): string[] {
  const m = (modality ?? "").toUpperCase();
  if (m === "CT" || m === "PT" || m === "PET") return [...CT_PRESETS];
  if (m === "MR") return [...MR_PRESETS];
  return [...CT_PRESETS, ...MR_PRESETS];
}

// ── 色 LUT（カラーマップ）─────────────────────────────────────────
// 旧 GRAPHY の `applyLut`（ImageJ LUT/`.lut`）に相当。backend LUT（`LutData` r/g/b 各 256）を
// Cornerstone のカラーマップとして登録し、`setProperties({ colormap: { name } })` で VR/MIP に適用する。
// 色は VOI レンジ（現在の W/L）へマップされる（`setColorMapTransferFunctionForVolumeActor`）。

/** グレースケール（LUT リセット）用に登録するカラーマップ名。 */
export const GRAYSCALE_COLORMAP = "GRAPHY-Grayscale";

let grayscaleRegistered = false;
/** グレースケールカラーマップを一度だけ登録する（LUT 解除の戻り先）。 */
export function ensureGrayscaleColormap(): string {
  if (!grayscaleRegistered) {
    try {
      csUtilities.colormap.registerColormap({
        name: GRAYSCALE_COLORMAP,
        RGBPoints: [0, 0, 0, 0, 1, 1, 1, 1],
      });
      grayscaleRegistered = true;
    } catch {
      /* ignore */
    }
  }
  return GRAYSCALE_COLORMAP;
}

/**
 * backend の `LutData`（r/g/b 各 0..255・256 エントリ）を Cornerstone カラーマップとして登録し、名前を返す。
 * RGBPoints は正規化 [0..1]（x=i/255, rgb=v/255）。同名は上書き（冪等）。適用は `applyColormap`。
 */
export function registerLutColormap(lut: LutData): string {
  const n = Math.min(lut.r.length, lut.g.length, lut.b.length);
  const pts: number[] = [];
  const denom = n > 1 ? n - 1 : 1;
  for (let i = 0; i < n; i++) {
    pts.push(i / denom, lut.r[i] / 255, lut.g[i] / 255, lut.b[i] / 255);
  }
  const name = `GRAPHY-LUT-${lut.name}`;
  try {
    csUtilities.colormap.registerColormap({ name, RGBPoints: pts });
  } catch {
    /* ignore */
  }
  return name;
}

/** モダリティ＋モードに応じた既定プリセット名。 */
export function defaultPreset(modality: string | null, mode: RenderMode): string {
  const m = (modality ?? "").toUpperCase();
  const isMr = m === "MR";
  if (mode === "MIP" || mode === "MINIP" || mode === "AVG") {
    return isMr ? MIP_PRESET_MR : MIP_PRESET_CT;
  }
  return isMr ? DEFAULT_VR_PRESET_MR : DEFAULT_VR_PRESET_CT;
}
