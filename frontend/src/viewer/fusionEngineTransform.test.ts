/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * 手動位置合わせ（R1）が **Fusion のリサンプル結果として** どう出るかを固定するテスト。
 *
 * <p>`regTransform.test.ts` が固定しているのは行列の規約だけで、「実際にオーバーレイが
 * 回るのか・平行移動するのか」は誰も見ていなかった。実機で
 * 「Rotate が Shift のように見える」という報告が出たため、その切り分けを数値で行えるようにする。
 *
 * <p>ここで示していること:
 * <ul>
 *   <li>軸位（axial）背景に対して <b>rz は面内回転として出る</b>（重心が回る・見かけの平行移動ではない）</li>
 *   <li><b>rx / ry は面内では平行移動としてしか見えない</b>（＝仕様であって不具合ではない）。
 *       単一スライスに対する面外傾斜は、その断面では並進 ＋ 別 z の内容の混入として現れる</li>
 *   <li>回転中心は <b>前景ボリュームの中心</b>。中心から離れた断面ほど、腕の長さの分だけ
 *       見かけの並進成分が大きくなる</li>
 * </ul>
 */
import { describe, it, expect } from "vitest";
import { computeFusionSlice, type FusionVolume, type BackgroundSliceMeta } from "./fusionEngine";
import { manualAdjustToTransform, ZERO_ADJUST, type Vec3 } from "./regTransform";

const N = 64;          // 64×64
const SPACING = 1;     // 1 mm
const NSLICES = 9;     // z = 0..8 mm
const ORIGIN = -32;    // ipp の x/y

/**
 * 前景ボリューム: 全スライス同じ模様（非対称な明るいブロック）。
 * z 方向に一様なので、**面内で何が起きたか**だけを見られる。
 */
function makeFgVolume(): FusionVolume {
  const slices = [];
  for (let z = 0; z < NSLICES; z++) {
    const pixels = new Float32Array(N * N);
    // 列 40..49 / 行 30..33 の非対称ブロック（回転すると重心が明確に動く）。
    for (let v = 30; v <= 33; v++) {
      for (let u = 40; u <= 49; u++) pixels[v * N + u] = 100;
    }
    slices.push({ ipp: [ORIGIN, ORIGIN, z] as Vec3, pixels, slope: 1, intercept: 0 });
  }
  return {
    iop: [1, 0, 0, 0, 1, 0],
    pixelSpacingCol: SPACING,
    pixelSpacingRow: SPACING,
    cols: N,
    rows: N,
    slices,
  };
}

/** 背景スライス: 前景と同一グリッド。z は引数で指定（中心断面 = 4）。 */
function makeBgSlice(z: number): BackgroundSliceMeta {
  return {
    iop: [1, 0, 0, 0, 1, 0],
    ipp: [ORIGIN, ORIGIN, z],
    pixelSpacingCol: SPACING,
    pixelSpacingRow: SPACING,
    cols: N,
    rows: N,
  };
}

/** 前景ボリュームの中心（world）。FusionOverlayViewer が算出しているものと同じ定義。 */
const FG_CENTER: Vec3 = [
  ORIGIN + ((N - 1) / 2) * SPACING,
  ORIGIN + ((N - 1) / 2) * SPACING,
  (0 + (NSLICES - 1)) / 2,
];

/** 明るい画素の重心（画素座標）。何も無ければ null。 */
function centroid(out: Float32Array, cols: number, rows: number): { u: number; v: number; n: number } | null {
  let su = 0, sv = 0, n = 0;
  for (let v = 0; v < rows; v++) {
    for (let u = 0; u < cols; u++) {
      const val = out[v * cols + u];
      if (Number.isFinite(val) && val > 50) { su += u; sv += v; n++; }
    }
  }
  return n === 0 ? null : { u: su / n, v: sv / n, n };
}

describe("Fusion × 手動位置合わせ（R1）", () => {
  const fg = makeFgVolume();
  const bgMid = makeBgSlice(4); // 前景ボリュームの中心断面

  it("恒等: ブロックは元の位置に出る", () => {
    const out = computeFusionSlice(fg, bgMid, manualAdjustToTransform(ZERO_ADJUST, FG_CENTER));
    const c = centroid(out, N, N)!;
    expect(c.u).toBeCloseTo(44.5, 1); // 列 40..49
    expect(c.v).toBeCloseTo(31.5, 1); // 行 30..33
  });

  it("tx/ty: 指定した向きへ mm 単位で平行移動する", () => {
    const out = computeFusionSlice(fg, bgMid, manualAdjustToTransform({ ...ZERO_ADJUST, tx: 5, ty: -3 }, FG_CENTER));
    const c = centroid(out, N, N)!;
    // 前景を +x に 5mm 動かす → 画面上でもブロックは +u へ 5px 動く（1mm/px）。
    expect(c.u).toBeCloseTo(44.5 + 5, 1);
    expect(c.v).toBeCloseTo(31.5 - 3, 1);
  });

  it("rz: 面内回転として出る（並進ではない）", () => {
    const deg = 90;
    const out = computeFusionSlice(fg, bgMid, manualAdjustToTransform({ ...ZERO_ADJUST, rz: deg }, FG_CENTER));
    const c = centroid(out, N, N)!;

    // 中心（31.5, 31.5）まわりに 90° 回した位置に来ているはず。
    // world +z まわりの右手系回転は、+x=列 / +y=行 の画面では (u,v) → (c − (v−c), c + (u−c))。
    const cu = (N - 1) / 2, cv = (N - 1) / 2;
    const du = 44.5 - cu, dv = 31.5 - cv;
    expect(c.u).toBeCloseTo(cu - dv, 0);
    expect(c.v).toBeCloseTo(cv + du, 0);

    // ★ ブロックは 10×4 なので、90° 回れば 4×10 になる。
    //   「回転ではなく平行移動」なら縦横比は変わらない。ここが本質的な判定。
    let minU = N, maxU = -1, minV = N, maxV = -1;
    for (let v = 0; v < N; v++) {
      for (let u = 0; u < N; u++) {
        if (Number.isFinite(out[v * N + u]) && out[v * N + u] > 50) {
          if (u < minU) minU = u; if (u > maxU) maxU = u;
          if (v < minV) minV = v; if (v > maxV) maxV = v;
        }
      }
    }
    expect(maxU - minU + 1).toBeCloseTo(4, 0);   // 幅が 10 → 4 になる
    expect(maxV - minV + 1).toBeCloseTo(10, 0);  // 高さが 4 → 10 になる
  });

  it("rx: 軸位断面では平行移動としてしか見えない（仕様）", () => {
    // z 方向に一様な前景なので、面外傾斜は「面内の並進」としてのみ観測される。
    const out = computeFusionSlice(fg, bgMid, manualAdjustToTransform({ ...ZERO_ADJUST, rx: 10 }, FG_CENTER));
    const c = centroid(out, N, N)!;
    // 形は変わらない（縦横比が保たれる＝回って見えない）。
    let minU = N, maxU = -1, minV = N, maxV = -1;
    for (let v = 0; v < N; v++) {
      for (let u = 0; u < N; u++) {
        if (Number.isFinite(out[v * N + u]) && out[v * N + u] > 50) {
          if (u < minU) minU = u; if (u > maxU) maxU = u;
          if (v < minV) minV = v; if (v > maxV) maxV = v;
        }
      }
    }
    expect(maxU - minU + 1).toBeCloseTo(10, 0); // 幅は 10 のまま
    expect(c.u).toBeCloseTo(44.5, 1);           // x 方向には動かない
  });

  it("回転中心はボリューム中心: 端の断面ほど見かけの並進が大きい", () => {
    const adjust = { ...ZERO_ADJUST, rx: 10 };
    const cMid = centroid(computeFusionSlice(fg, makeBgSlice(4), manualAdjustToTransform(adjust, FG_CENTER)), N, N)!;
    const cEnd = centroid(computeFusionSlice(fg, makeBgSlice(8), manualAdjustToTransform(adjust, FG_CENTER)), N, N)!;
    // 中心断面（z=4）ではほぼ動かず、端（z=8, 腕の長さ 4mm）では v がずれる。
    expect(Math.abs(cMid.v - 31.5)).toBeLessThan(Math.abs(cEnd.v - 31.5));
  });
});
