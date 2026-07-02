/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Curved MPR（曲面平面再構成, curved planar reformation）コア。旧 GRAPHY
 * `com.vis.core.slicer.CurvedReformatter` の TS 移植（純関数・Cornerstone 非依存）。
 *
 * {@link Centerline3D} に沿ってボリュームを 2D ラスタへ「平坦化」する。
 * 出力軸:
 * - X（列） = 曲線に沿った弧長。
 * - Y（行） = 曲線ローカルの第2軸（normal）方向のオフセット。`FIXED_Z`（world Z 投影＝歯科パノラマ）
 *   または `ROTATION_MINIMIZING`（捩れ最小＝血管 CPR）。行 0 = 最大オフセット（DICOM 軸位スタックが
 *   Z 降順＝上方を先頭にする慣習に合わせる）。
 *
 * 任意で曲線の binormal 軸に沿った帯（バンド）を AVERAGE/MIP/MINIP で投影し、スラブ厚のある再構成にできる。
 *
 * サンプラは `reslice.ts` の {@link makeWorldSampler}（world→ボクセル・トリリニア）を共有する。
 * これにより Curved MPR と平面リスライスで voxel⇔world の写像が単一の真実源になる。
 */
import type { ResliceVolume, Vec3 } from "./reslice";
import { makeWorldSampler } from "./reslice";
import { Centerline3D, type FrameMode } from "./centerline";

/** 帯投影モード。 */
export type ProjectionMode = "CENTERLINE_ONLY" | "AVERAGE" | "MIP" | "MINIP";

/** Curved MPR パラメータ。旧 `CurvedReformatter.Params` に対応。 */
export interface CurvedParams {
  /** 出力列間隔（曲線に沿う, mm）。 */
  arcStepMm: number;
  /** 出力行間隔（第2軸方向, mm）。 */
  secondAxisStepMm: number;
  /** 各曲線点からの第2軸オフセット範囲（mm, min < max）。 */
  secondAxisMinMm: number;
  secondAxisMaxMm: number;
  frameMode: FrameMode;
  /** binormal 方向の帯半幅（mm）。0 = センターラインのみ。 */
  bandHalfWidthMm: number;
  /** 帯の横断サンプル数（両端含む）。bandHalfWidthMm<=0 なら無視。 */
  bandSampleCount: number;
  projectionMode: ProjectionMode;
  /** ボリューム外のサンプルに割り当てる値。 */
  outOfBoundsValue: number;
}

/** Curved MPR 結果。 */
export interface CurvedResult {
  /** row-major, 長さ = width*height。 */
  pixels: Float32Array;
  width: number; // 弧長方向
  height: number; // 第2軸方向
  pixelSpacingX: number; // 1 列あたり mm = arcStepMm
  pixelSpacingY: number; // 1 行あたり mm = secondAxisStepMm
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** 既定パラメータ（呼び出し側が上書きする土台）。 */
export function defaultCurvedParams(): CurvedParams {
  return {
    arcStepMm: 1,
    secondAxisStepMm: 1,
    secondAxisMinMm: -50,
    secondAxisMaxMm: 50,
    frameMode: "FIXED_Z",
    bandHalfWidthMm: 0,
    bandSampleCount: 5,
    projectionMode: "CENTERLINE_ONLY",
    outOfBoundsValue: 0,
  };
}

/**
 * 曲線に沿ってボリュームを再構成し、2D ラスタ（＋出力ピクセル間隔）を返す。
 * `curve` は 2 点以上、`secondAxisMaxMm > secondAxisMinMm` が前提。
 *
 * @param sampleFn 任意の world→値サンプラ。省略時は `makeWorldSampler(vol)`（生配列トリリニア）。
 *   Cornerstone の streaming volume では生配列のレイアウト仮定が崩れることがあるため、呼び出し側が
 *   `voxelManager.getAtIJK` ベースの権威あるサンプラを渡せるようにしている。
 */
export function reformat(
  curve: Centerline3D,
  vol: ResliceVolume,
  params: CurvedParams,
  sampleFn?: (w: Vec3) => number,
): CurvedResult {
  if (!curve || curve.size() < 2) {
    throw new Error("curve must have at least 2 control points");
  }
  if (params.secondAxisMaxMm <= params.secondAxisMinMm) {
    throw new Error("secondAxisMaxMm must be > secondAxisMinMm");
  }
  const arcStep = params.arcStepMm > 0 ? params.arcStepMm : 1;
  const secondStep = params.secondAxisStepMm > 0 ? params.secondAxisStepMm : 1;

  const sampleAt = sampleFn ?? makeWorldSampler(vol, "linear");

  const length = curve.getTotalLength();
  const width = Math.max(1, Math.round(length / arcStep) + 1);
  const height = Math.max(1, Math.round((params.secondAxisMaxMm - params.secondAxisMinMm) / secondStep) + 1);

  const pixels = new Float32Array(width * height);

  const useBand =
    params.projectionMode !== "CENTERLINE_ONLY" &&
    params.bandHalfWidthMm > 0 &&
    params.bandSampleCount > 1;

  for (let col = 0; col < width; col++) {
    const s = Math.min(col * arcStep, length);
    const frame = curve.frameAt(s, params.frameMode);

    for (let row = 0; row < height; row++) {
      // 行 0 = 最大オフセット（Z 降順の軸位慣習に合わせる）。
      const h = params.secondAxisMaxMm - row * secondStep;
      const basePos = add(frame.position, mul(frame.normal, h));

      let value: number;
      if (!useBand) {
        value = sampleAt(basePos);
      } else {
        value = projectBand(sampleAt, basePos, frame.binormal, params);
      }
      pixels[row * width + col] = value;
    }
  }

  return { pixels, width, height, pixelSpacingX: arcStep, pixelSpacingY: secondStep };
}

function projectBand(
  sampleAt: (p: Vec3) => number,
  basePos: Vec3,
  binormal: Vec3,
  params: CurvedParams,
): number {
  const n = params.bandSampleCount;
  const half = params.bandHalfWidthMm;
  let sum = 0;
  let max = -Number.MAX_VALUE;
  let min = Number.MAX_VALUE;
  for (let k = 0; k < n; k++) {
    const b = -half + (2 * half * k) / (n - 1);
    const p = add(basePos, mul(binormal, b));
    const val = sampleAt(p);
    sum += val;
    if (val > max) max = val;
    if (val < min) min = val;
  }
  switch (params.projectionMode) {
    case "MIP":
      return max;
    case "MINIP":
      return min;
    case "AVERAGE":
    default:
      return sum / n;
  }
}

// ── アンフォールド（回転）CPR ＝「展開図」 ────────────────────────
/**
 * アンフォールド CPR パラメータ。中心線の周りを 360° 掃引して筒を開いた展開図を作る
 * （腸管の仮想展開 / 血管壁の全周展開）。
 */
export interface UnfoldParams {
  /** 出力列間隔（曲線に沿う弧長, mm）。 */
  arcStepMm: number;
  /** 角度分割（度）。行数 = round(360/angleStepDeg)。 */
  angleStepDeg: number;
  frameMode: FrameMode;
  /** 径方向サンプル範囲（mm, 中心線からの距離）。min<max で帯投影、min>=max なら単一半径 max。 */
  radialMinMm: number;
  radialMaxMm: number;
  /** 径方向サンプル数（帯投影時, >=2）。 */
  radialSampleCount: number;
  projectionMode: ProjectionMode;
  outOfBoundsValue: number;
}

/** アンフォールド CPR 結果。 */
export interface UnfoldResult {
  /** row-major, 長さ = width*height。行=角度（0..360°）、列=弧長。 */
  pixels: Float32Array;
  width: number; // 弧長方向
  height: number; // 角度方向
  /** 1 列あたり mm = arcStepMm。 */
  pixelSpacingX: number;
  /** 1 行あたりの近似周方向 mm = 2π·r/height（r=径範囲の中央値）。展開のため近似。 */
  pixelSpacingY: number;
  angleStepDeg: number;
}

/** 既定パラメータ（呼び出し側が上書きする土台）。 */
export function defaultUnfoldParams(): UnfoldParams {
  return {
    arcStepMm: 1,
    angleStepDeg: 2,
    frameMode: "ROTATION_MINIMIZING",
    radialMinMm: 0,
    radialMaxMm: 10,
    radialSampleCount: 8,
    projectionMode: "CENTERLINE_ONLY",
    outOfBoundsValue: 0,
  };
}

/**
 * 中心線の周りを 360° 掃引した展開図（X=弧長, Y=角度）を返す。
 * 角度 θ ごとに方向 `dir(θ)=cosθ·normal + sinθ·binormal` を作り、径方向に
 * 単一半径（`radialMaxMm`）または帯 [radialMinMm, radialMaxMm] を投影（MIP/MINIP/AVG）でサンプルする。
 *
 * @param sampleFn 任意の world→値サンプラ。省略時は `makeWorldSampler(vol)`（CPR と同方針）。
 */
export function unfoldReformat(
  curve: Centerline3D,
  vol: ResliceVolume,
  params: UnfoldParams,
  sampleFn?: (w: Vec3) => number,
): UnfoldResult {
  if (!curve || curve.size() < 2) {
    throw new Error("curve must have at least 2 control points");
  }
  const arcStep = params.arcStepMm > 0 ? params.arcStepMm : 1;
  const angleStep = params.angleStepDeg > 0 ? params.angleStepDeg : 2;

  const sampleAt = sampleFn ?? makeWorldSampler(vol, "linear");

  const length = curve.getTotalLength();
  const width = Math.max(1, Math.round(length / arcStep) + 1);
  const height = Math.max(1, Math.round(360 / angleStep)); // 0..360° を period なく一巡

  const rMax = params.radialMaxMm;
  const rMin = Math.max(0, params.radialMinMm);
  const useBand =
    params.projectionMode !== "CENTERLINE_ONLY" && rMax > rMin && params.radialSampleCount > 1;
  const rMid = useBand ? (rMin + rMax) / 2 : rMax;

  const pixels = new Float32Array(width * height);

  for (let col = 0; col < width; col++) {
    const s = Math.min(col * arcStep, length);
    const frame = curve.frameAt(s, params.frameMode);
    for (let row = 0; row < height; row++) {
      const theta = (row * angleStep * Math.PI) / 180;
      const ct = Math.cos(theta), st = Math.sin(theta);
      // dir(θ) = cosθ·normal + sinθ·binormal（normal/binormal は正規直交＝単位方向）。
      const dir: Vec3 = [
        frame.normal[0] * ct + frame.binormal[0] * st,
        frame.normal[1] * ct + frame.binormal[1] * st,
        frame.normal[2] * ct + frame.binormal[2] * st,
      ];
      let value: number;
      if (!useBand) {
        value = sampleAt(add(frame.position, mul(dir, rMax)));
      } else {
        const n = params.radialSampleCount;
        let sum = 0, max = -Number.MAX_VALUE, min = Number.MAX_VALUE;
        for (let k = 0; k < n; k++) {
          const r = rMin + ((rMax - rMin) * k) / (n - 1);
          const val = sampleAt(add(frame.position, mul(dir, r)));
          sum += val;
          if (val > max) max = val;
          if (val < min) min = val;
        }
        value =
          params.projectionMode === "MIP" ? max : params.projectionMode === "MINIP" ? min : sum / n;
      }
      pixels[row * width + col] = value;
    }
  }

  const circ = (2 * Math.PI * Math.max(rMid, 1e-3)) / height;
  return {
    pixels,
    width,
    height,
    pixelSpacingX: arcStep,
    pixelSpacingY: circ,
    angleStepDeg: angleStep,
  };
}
