/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 中心線ストレート化（straightened / stretched CPR volume）コア。旧 GRAPHY
 * `com.vis.core.slicer.StraightenedVolumeBuilder` の TS 移植（純関数・Cornerstone 非依存）。
 *
 * {@link Centerline3D} に沿って、各弧長位置で接線に直交する断面（normal×binormal 平面）の円板を
 * サンプルし、それを弧長方向に積み上げて**まっすぐ伸ばした 3D ボリューム**を作る（血管解析の
 * ストレート CPR）。出力軸:
 * - X（列）  = binormal 方向オフセット。
 * - Y（行）  = normal 方向オフセット（行 0 = 最大オフセット。CPR と同じ軸位慣習）。
 * - Z（深さ）= 中心線に沿った弧長。
 *
 * **重要（設計 §10 の注記を継承）**: 出力座標系は合成的で、患者 LPS へ剛体写像できない。
 * 曲率のある中心線を直線化しているため、DICOM の IPP/IOP は幾何的に無意味になる。派生シリーズ
 * 保存時は `imageOrientationPatient`/`imagePositionPatient` を null（合成空間）とし、UI/メタで明示する。
 *
 * サンプラは `reslice.ts` の {@link makeWorldSampler}（world→ボクセル・トリリニア）を CPR と共有し、
 * voxel⇔world の写像を単一の真実源にする。
 */
import type { ResliceVolume, Vec3 } from "./reslice";
import { makeWorldSampler } from "./reslice";
import { Centerline3D, type FrameMode } from "./centerline";

/** ストレート化パラメータ。 */
export interface StraightenParams {
  /** 弧長方向（Z / スライス間）の間隔（mm）。 */
  arcStepMm: number;
  /** 断面内（normal・binormal 方向）のピクセル間隔（mm）。 */
  crossStepMm: number;
  /** 断面の半幅（mm）。断面は [-half, +half]²。 */
  crossHalfWidthMm: number;
  frameMode: FrameMode;
  /** ボリューム外のサンプルに割り当てる値。 */
  outOfBoundsValue: number;
}

/** ストレート化結果（積層 2D スライス）。 */
export interface StraightenResult {
  /** frame-major（スライス k → 行 → 列）フラット配列。長さ = width*height*depth。 */
  data: Int16Array;
  width: number; // binormal（列）
  height: number; // normal（行）
  depth: number; // 弧長（スライス数）
  /** DICOM PixelSpacing 慣習 [rowSpacing, colSpacing] = [crossStep, crossStep]。 */
  pixelSpacing: [number, number];
  /** 隣接スライス間距離（mm）= arcStep。 */
  sliceSpacingMm: number;
  /** 中心線全長（mm）。 */
  lengthMm: number;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** 既定パラメータ（呼び出し側が上書きする土台）。 */
export function defaultStraightenParams(): StraightenParams {
  return {
    arcStepMm: 1,
    crossStepMm: 0.5,
    crossHalfWidthMm: 20,
    frameMode: "ROTATION_MINIMIZING",
    outOfBoundsValue: 0,
  };
}

/**
 * 中心線に沿ってボリュームをストレート化し、積層 2D スライス（＋幾何）を返す。
 * `curve` は 2 点以上が前提。
 *
 * @param sampleFn 任意の world→値サンプラ。省略時は `makeWorldSampler(vol)`（生配列トリリニア）。
 *   Cornerstone streaming volume ではレイアウト仮定が崩れ得るため、呼び出し側が
 *   `voxelManager.getAtIJK` ベースの権威あるサンプラを渡せるようにしている（CPR と同方針）。
 */
export function buildStraightenedVolume(
  curve: Centerline3D,
  vol: ResliceVolume,
  params: StraightenParams,
  sampleFn?: (w: Vec3) => number,
): StraightenResult {
  if (!curve || curve.size() < 2) {
    throw new Error("curve must have at least 2 control points");
  }
  if (params.crossHalfWidthMm <= 0) {
    throw new Error("crossHalfWidthMm must be > 0");
  }
  const arcStep = params.arcStepMm > 0 ? params.arcStepMm : 1;
  const crossStep = params.crossStepMm > 0 ? params.crossStepMm : 1;
  const half = params.crossHalfWidthMm;

  const sampleAt = sampleFn ?? makeWorldSampler(vol, "linear");

  const length = curve.getTotalLength();
  const depth = Math.max(1, Math.round(length / arcStep) + 1);
  // 断面: [-half, +half] を crossStep 刻み（両端含む）。
  const side = Math.max(1, Math.round((2 * half) / crossStep) + 1);
  const width = side; // binormal（列）
  const height = side; // normal（行）
  const frame = width * height;

  const data = new Int16Array(width * height * depth);
  const oob = clampInt16(params.outOfBoundsValue);

  for (let k = 0; k < depth; k++) {
    const s = Math.min(k * arcStep, length);
    const f = curve.frameAt(s, params.frameMode);
    const base = k * frame;
    for (let row = 0; row < height; row++) {
      // 行 0 = 最大 normal オフセット（Z 降順の軸位慣習に合わせる）。
      const nOff = half - row * crossStep;
      const rowPos = add(f.position, mul(f.normal, nOff));
      const rowBase = base + row * width;
      for (let col = 0; col < width; col++) {
        const bOff = -half + col * crossStep;
        const p = add(rowPos, mul(f.binormal, bOff));
        const v = sampleAt(p);
        data[rowBase + col] = Number.isFinite(v) ? clampInt16(Math.round(v)) : oob;
      }
    }
  }

  return {
    data,
    width,
    height,
    depth,
    pixelSpacing: [crossStep, crossStep],
    sliceSpacingMm: arcStep,
    lengthMm: length,
  };
}

/** k 番目スライスの Int16 フレームを切り出す（派生シリーズ保存用）。 */
export function straightenedFrame(result: StraightenResult, k: number): Int16Array {
  const frame = result.width * result.height;
  const base = k * frame;
  return result.data.subarray(base, base + frame);
}

function clampInt16(v: number): number {
  if (v < -32768) return -32768;
  if (v > 32767) return 32767;
  return v;
}
