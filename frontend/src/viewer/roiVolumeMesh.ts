/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 塗りの ROI の体積を、実際の位置で形を作るメッシュから求める。純関数（`fw/slice-depth-policy.md` §4）。
 *
 * <p>各スライスの塗りの輪郭（画素の境界をなぞった外周と穴。{@link traceMaskContours}）を、
 * そのスライスの実際の位置で、幅 w_i（前後のスライスまでの距離の半分ずつ。{@link sliceGeometry}）だけ
 * 法線方向に押し出した角柱の集まりを ROI の形とする。隣の角柱とは境の面で接するだけで重ならない。
 *
 * <p>体積は発散定理で求める。場 F = (0, 0, z)（z はスライスの法線方向）を取ると、側面は法線が z に直交して寄与 0、
 * 上下の面だけが残り、角柱 1 つの体積 = 断面の面積 × 高さ w_i になる。断面の面積は輪郭の多角形の面積
 * （外周は正、穴は負の符号付き面積）なので、平滑化などに左右されない。
 *
 * <p>2D の面積を「メッシュで統一」しているのと同じ考え方で、2D の Σ³・Σ の窓・3D の体積をすべてこれで求める。
 * 3D の表示用の滑らかなメッシュは見た目だけに使い、体積には使わない。
 */
import { signedArea, traceMaskContours } from "./maskContour";

export interface VolumeMeshSlice {
  /** ラベル（行優先、width × height）。 */
  labels: ArrayLike<number>;
  width: number;
  height: number;
  /** 列の間隔・行の間隔（mm）。 */
  colSpacingMm: number;
  rowSpacingMm: number;
  /** このスライスの幅（mm）。`sliceGeometry().widths`。 */
  widthMm: number;
}

export interface RoiVolumeResult {
  volumeMm3: number;
  /** スライスごとの断面積（mm²）。 */
  areasMm2: number[];
  /** 前景の画素数（体積とは別の項目）。 */
  voxels: number;
}

/**
 * スライスごとの輪郭から体積を求める。`segment` を渡すとその番号だけ、省略すると 0 より大きい画素すべて。
 */
export function roiVolumeFromSlices(slices: ReadonlyArray<VolumeMeshSlice>, segment?: number): RoiVolumeResult {
  let volumeMm3 = 0;
  let voxels = 0;
  const areasMm2: number[] = [];
  for (const s of slices) {
    for (let i = 0; i < s.labels.length; i++) {
      const v = s.labels[i];
      if (segment === undefined ? v > 0 : v === segment) voxels++;
    }
    let areaPx = 0;
    for (const c of traceMaskContours(s.labels, s.width, s.height, segment)) {
      areaPx += signedArea(c.outer);
      for (const h of c.holes) areaPx += signedArea(h); // 穴は負
    }
    const areaMm2 = areaPx * s.colSpacingMm * s.rowSpacingMm;
    areasMm2.push(areaMm2);
    volumeMm3 += areaMm2 * s.widthMm;
  }
  return { volumeMm3, areasMm2, voxels };
}
