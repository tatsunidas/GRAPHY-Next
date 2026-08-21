/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * **H33 — マスク → メッシュ・計測**（`fw/subtraction-design.md` §15.4）。
 *
 * プラグインが作った 3D マスク（0=背景 / >0=セグメント番号）を受け取り、
 * 本体の実装で**メッシュ化して測る**。
 *
 * <h3>なぜプラグインに計算させないか</h3>
 *
 * H5（ROI）で長径をプラグインに算出させなかったのと同じ理由である。
 * 同じ量を 2 か所で計算すると、**食い違ったときにどちらが正しいか言えなくなる**。
 * ここは `roiMesh.labelVolumeToMesh`（marching cubes・direction 補正済み）と
 * `mesh3d.measureMesh`（発散定理）をそのまま通すだけで、新しい数式は 1 つも足していない。
 *
 * <h3>幾何もプラグインに書かせない</h3>
 *
 * 入力は `PluginVolume` がそのまま持っている **`indexToWorld`（row-major 4×4）**で受ける。
 * origin / direction / spacing への分解はここで行う。プラグイン側で分解させると、
 * `fw/cornerstone-3d-geometry-caveat.md` が禁じている「幾何の 2 本目の実装」が生える。
 *
 * <h3>🔴 ボクセル数の体積とメッシュ体積は違う</h3>
 *
 * `voxelVolumeMm3` は数え上げ、`meshVolumeMm3` は marching cubes ＋ 平滑化した曲面の体積で、
 * **一致しない**（平滑化が角を落とすぶんメッシュ側が小さく出る）。どちらが「正しい」でもないので
 * **両方返す**。片方だけ返すと、利用者はそれを唯一の真値だと読む。
 */
import type { LabelVolume, VolumeGeom } from "../viewer/labelVolume";
import { measureMesh } from "../viewer/mesh3d";
import { labelVolumeToMesh } from "../viewer/roiMesh";

/** プラグインから渡すマスク（`PluginVolume` と同じ幾何の持ち方）。 */
export interface PluginMaskInput {
  /** 長さ nx·ny·nz。0=背景, >0=セグメント番号。 */
  data: Uint8Array;
  dims: [number, number, number];
  /** index (i,j,k,1) → 患者 LPS mm。row-major 4×4（16 要素）。 */
  indexToWorld: number[];
}

export interface PluginMeshMeasurement {
  /** セグメント番号（マスクの値）。 */
  segment: number;
  voxelCount: number;
  /** ボクセル数 × 1 ボクセルの体積。 */
  voxelVolumeMm3: number;
  voxelVolumeMl: number;
  /** メッシュ（平滑化後の曲面）の体積。**ボクセル数の体積とは一致しない**。 */
  meshVolumeMm3: number;
  meshVolumeMl: number;
  surfaceAreaMm2: number;
  /** 主径 [長径, 中径, 短径]（mm・PCA 軸への投影範囲）。本体の ROI 計測と同じ定義。 */
  diameters: [number, number, number];
  numTriangles: number;
  numPoints: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
}

export interface PluginMeshOptions {
  /** 測るセグメント番号。省略時はマスクに出てくる番号すべて。 */
  segments?: number[];
  /** 平滑化反復数（0 で無効）。既定は本体と同じ 15。 */
  smoothIterations?: number;
  passBand?: number;
}

/**
 * `indexToWorld` を `VolumeGeom`（origin / direction / spacing）へ分解する。
 *
 * 列がそれぞれ index 軸の方向 × 間隔になっている前提（DICOM の IOP/spacing から組めば必ずそう）。
 * 間隔が 0 の軸があれば幾何として成立しないので `null` を返す（**でっち上げない**）。
 */
export function geomFromIndexToWorld(
  dims: [number, number, number],
  indexToWorld: number[],
): VolumeGeom | null {
  if (!Array.isArray(indexToWorld) || indexToWorld.length !== 16) return null;
  const m = indexToWorld;
  const cols: [number, number, number][] = [
    [m[0], m[4], m[8]],
    [m[1], m[5], m[9]],
    [m[2], m[6], m[10]],
  ];
  const spacing = cols.map((c) => Math.hypot(c[0], c[1], c[2])) as [number, number, number];
  if (!spacing.every((s) => s > 0 && Number.isFinite(s))) return null;
  const unit = cols.map((c, i) => [c[0] / spacing[i], c[1] / spacing[i], c[2] / spacing[i]]);
  // vtk row-major 3×3。**列**が各 index 軸の単位方向（`labelVolume.VolumeGeom` の約束）。
  const direction = [
    unit[0][0], unit[1][0], unit[2][0],
    unit[0][1], unit[1][1], unit[2][1],
    unit[0][2], unit[1][2], unit[2][2],
  ];
  return {
    dims,
    spacing,
    origin: [m[3], m[7], m[11]],
    direction,
  };
}

/**
 * マスクをメッシュ化して測る（H33）。
 *
 * セグメントごとに**独立したメッシュ**を作る。1 つの LabelVolume に複数の番号が入ったまま
 * marching cubes を掛けると、`contourValue 0.5` は「0 か 非0 か」しか見ないので
 * **別々の病変が 1 つの塊として測られる**。
 *
 * @returns セグメント番号の昇順。メッシュが作れなかったセグメントは飛ばさず、
 *   `numTriangles: 0` として返す（黙って消えると「測れなかった」ことが分からない）。
 */
export function measureMask(
  mask: PluginMaskInput,
  opts: PluginMeshOptions = {},
): PluginMeshMeasurement[] {
  const [nx, ny, nz] = mask.dims;
  const total = nx * ny * nz;
  if (mask.data.length !== total) return [];
  const geom = geomFromIndexToWorld(mask.dims, mask.indexToWorld);
  if (!geom) return [];
  const voxelMm3 = geom.spacing[0] * geom.spacing[1] * geom.spacing[2];

  const counts = new Map<number, number>();
  for (let i = 0; i < total; i++) {
    const v = mask.data[i];
    if (v === 0) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const wanted = opts.segments && opts.segments.length > 0 ? opts.segments : [...counts.keys()];
  wanted.sort((a, b) => a - b);

  const out: PluginMeshMeasurement[] = [];
  for (const segment of wanted) {
    const voxelCount = counts.get(segment) ?? 0;
    const single = new Uint8Array(total);
    for (let i = 0; i < total; i++) single[i] = mask.data[i] === segment ? 1 : 0;
    const lv: LabelVolume = { geom, data: single, voxelMm3 };
    const polydata = voxelCount > 0 ? labelVolumeToMesh(lv, opts) : null;
    const measured = polydata ? measureMesh(polydata) : null;
    out.push({
      segment,
      voxelCount,
      voxelVolumeMm3: voxelCount * voxelMm3,
      voxelVolumeMl: (voxelCount * voxelMm3) / 1000,
      meshVolumeMm3: measured ? measured.volumeMm3 : 0,
      meshVolumeMl: measured ? measured.volumeMm3 / 1000 : 0,
      surfaceAreaMm2: measured ? measured.surfaceAreaMm2 : 0,
      diameters: measured ? measured.diameters : [0, 0, 0],
      numTriangles: measured ? measured.numTriangles : 0,
      numPoints: measured ? measured.numPoints : 0,
      boundsMin: measured ? measured.boundsMin : [0, 0, 0],
      boundsMax: measured ? measured.boundsMax : [0, 0, 0],
    });
  }
  return out;
}
