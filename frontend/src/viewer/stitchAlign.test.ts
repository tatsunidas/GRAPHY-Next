/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { makeVolume } from "./regGeometry";
import {
  IDENTITY_PLACEMENT,
  defaultOutputSpacing,
  describePlacement,
  iopAngleDeg,
  isIdentityPlacement,
  placeInput,
  placementError,
  placementFromRigid,
  placementMatrix,
  volumeCenter,
  type Placement,
} from "./stitchAlign";
import {
  checkStitchInputs,
  shiftInput,
  stitchToGrid,
  unionGrid,
  type StitchInput,
} from "./volumeStitch";

const truth = (x: number, y: number, z: number) => 0.5 * x - 0.3 * y + 0.8 * z + 12;

function input(nx: number, ny: number, nz: number, ipp: [number, number, number], px = 1, py = 1.5, sz = 2): StitchInput {
  const data = new Float32Array(nx * ny * nz);
  const vol = makeVolume(data, [nx, ny, nz], [1, 0, 0, 0, 1, 0], ipp, px, py, [0, 0, sz]);
  const m = vol.indexToWorld;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        data[k * nx * ny + j * nx + i] = truth(
          m[0] * i + m[1] * j + m[2] * k + m[3], m[4] * i + m[5] * j + m[6] * k + m[7], m[8] * i + m[9] * j + m[10] * k + m[11],
        );
  return { volume: vol, iop: [1, 0, 0, 0, 1, 0], modality: "CT", patientId: "P1" };
}

const world = (inp: StitchInput, i: number, j: number, k: number): [number, number, number] => {
  const m = inp.volume.indexToWorld;
  return [
    m[0] * i + m[1] * j + m[2] * k + m[3],
    m[4] * i + m[5] * j + m[6] * k + m[7],
    m[8] * i + m[9] * j + m[10] * k + m[11],
  ];
};
const P = (o: Partial<Placement>): Placement => ({ ...IDENTITY_PLACEMENT, ...o });
const near = (a: readonly number[], b: readonly number[], eps = 1e-9) => a.forEach((v, n) => expect(Math.abs(v - b[n])).toBeLessThan(eps));

describe("placeInput（幾何）", () => {
  const base = input(12, 10, 8, [5, -7, 20]);
  const c = volumeCenter(base);

  it("恒等はそのまま返す（従来の出力と同一）", () => {
    expect(isIdentityPlacement(IDENTITY_PLACEMENT)).toBe(true);
    expect(placeInput(base, IDENTITY_PLACEMENT)).toBe(base);
    expect(placeInput(base, null)).toBe(base);
  });

  it("平行移動は shiftInput と同じ（法線方向）", () => {
    const a = placeInput(base, P({ tz: 7.5 }));
    const b = shiftInput(base, 7.5, [0, 0, 1]);
    near(Array.from(a.volume.indexToWorld), Array.from(b.volume.indexToWorld));
    near(Array.from(a.volume.worldToIndex), Array.from(b.volume.worldToIndex));
  });

  it("同じデータを共有し、元は変えない", () => {
    const before = Array.from(base.volume.indexToWorld);
    const a = placeInput(base, P({ rz: 30, tx: 2 }));
    expect(a.volume.data).toBe(base.volume.data);
    expect(Array.from(base.volume.indexToWorld)).toEqual(before);
  });

  it("z まわり 90° は中心まわりに (dx,dy) → (−dy,dx)", () => {
    const a = placeInput(base, P({ rz: 90 }));
    const p0 = world(base, 0, 0, 0);
    const p1 = world(a, 0, 0, 0);
    const dx = p0[0] - c[0], dy = p0[1] - c[1];
    near(p1, [c[0] - dy, c[1] + dx, p0[2]]);
    // 中心は動かない
    near(volumeCenter(a), c);
  });

  it("回転後の IOP と間隔が新しい行列に合う", () => {
    const a = placeInput(base, P({ rz: 90 }));
    near(a.iop, [0, 1, 0, -1, 0, 0], 1e-9);
    near(Array.from(a.volume.spacing), [1, 1.5, 2]);
    expect(iopAngleDeg(base.iop, a.iop)).toBeCloseTo(90, 6);
  });

  it("X 反転は中心を通る面で鏡映（左右が入れ替わる）", () => {
    const a = placeInput(base, P({ flipX: true }));
    const p0 = world(base, 3, 4, 2);
    const p1 = world(a, 3, 4, 2);
    near(p1, [2 * c[0] - p0[0], p0[1], p0[2]]);
    expect(a.volume.indexToWorld[0]).toBeCloseTo(-1, 12); // 列方向が反転
  });

  it("拡大は中心から 2 倍に離れ、間隔も 2 倍", () => {
    const a = placeInput(base, P({ sx: 2, sy: 2, sz: 2 }));
    const p0 = world(base, 0, 0, 0);
    const p1 = world(a, 0, 0, 0);
    near(p1, [c[0] + 2 * (p0[0] - c[0]), c[1] + 2 * (p0[1] - c[1]), c[2] + 2 * (p0[2] - c[2])]);
    near(Array.from(a.volume.spacing), [2, 3, 4]);
  });

  it("worldToIndex は indexToWorld の逆", () => {
    const a = placeInput(base, P({ rx: 12, ry: -7, rz: 33, tx: 1, ty: -2, tz: 3, sx: 1.1, sy: 1.1, sz: 1.1, flipY: true }));
    const w = world(a, 4, 5, 3);
    const m = a.volume.worldToIndex;
    near([
      m[0] * w[0] + m[1] * w[1] + m[2] * w[2] + m[3],
      m[4] * w[0] + m[5] * w[1] + m[6] * w[2] + m[7],
      m[8] * w[0] + m[9] * w[1] + m[10] * w[2] + m[11],
    ], [4, 5, 3]);
  });

  it("拡大率 0 以下は欄の誤りとして検出する", () => {
    expect(placementError(P({ sx: 0 }))).toBe("scale");
    expect(placementError(P({ tx: NaN }))).toBe("number");
    expect(placementError(P({ rx: 5 }))).toBeNull();
    expect(() => placeInput(base, P({ sx: 0 }))).toThrow();
  });

  it("剛体の分解: placementMatrix → placementFromRigid で元の値に戻る", () => {
    const p = P({ tx: 3, ty: -2, tz: 1.5, rx: 4, ry: -6, rz: 11 });
    const q = placementFromRigid(placementMatrix(p, c), c);
    (["tx", "ty", "tz", "rx", "ry", "rz"] as const).forEach((k) => expect(Math.abs(q[k] - p[k])).toBeLessThan(1e-9));
  });

  it("記述: 恒等は空、使った項目だけを残す", () => {
    expect(describePlacement(IDENTITY_PLACEMENT)).toBe("");
    const s = describePlacement(P({ tx: 1, rz: 5, flipX: true }));
    expect(s).toContain("t(1,0,0)mm");
    expect(s).toContain("r(0,0,5)deg");
    expect(s).toContain("flip(X)");
    expect(s).not.toContain("s(");
  });
});

describe("異なる FOV・位置・間隔の入力", () => {
  it("面内の大きさ・位置・間隔が違う 2 本を結合しても真値の関数どおり", () => {
    const a = input(12, 10, 8, [5, -7, 0], 1, 1.5, 2);
    const b = input(9, 14, 8, [8, -12, 14], 1.25, 1, 2); // 面内に位置も間隔もずれ、法線方向は a の続き
    expect(checkStitchInputs([a, b]).ok).toBe(true);
    const g = unionGrid([a, b]);
    const sl = stitchToGrid([a, b], g, { mode: "mean" });
    let n = 0;
    const [nx, ny, nz] = g.dims;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const v = sl[k][j * nx + i];
          if (Number.isNaN(v)) continue;
          const m = g.indexToWorld;
          const t = truth(m[0] * i + m[1] * j + m[2] * k + m[3], m[4] * i + m[5] * j + m[6] * k + m[7], m[8] * i + m[9] * j + m[10] * k + m[11]);
          expect(Math.abs(v - t)).toBeLessThan(1e-3);
          n++;
        }
    expect(n).toBeGreaterThan(nx * ny * 8); // 両方の範囲を実際に埋めている
  });
});

describe("向きの違う入力（再サンプル）", () => {
  const a = input(14, 12, 8, [0, 0, 0]);
  const b0 = input(14, 12, 8, [0, 0, 24]);
  const b = placeInput(b0, P({ rz: 10, tx: 1.5 }));

  it("既定（strict）では向き違反、再サンプルの指定では通る", () => {
    expect(checkStitchInputs([a, b]).violations).toContain("orientation");
    expect(checkStitchInputs([a, b], { orientation: "resample" }).ok).toBe(true);
    // 他の条件は再サンプルでも見る
    expect(checkStitchInputs([a, { ...b, patientId: "P2" }], { orientation: "resample" }).violations).toContain("patient");
  });

  it("結合値は元データを逆写像した点の真値（独立に解析的に計算）", () => {
    const g = unionGrid([a, b], undefined, 0);
    const sl = stitchToGrid([a, b], g, { mode: "mean" });
    const c = volumeCenter(b0);
    const th = (10 * Math.PI) / 180;
    // 出力点 P から元の b0 の点: c + Rz(−θ)(P − c − t)
    const back = (x: number, y: number, z: number): [number, number, number] => {
      const dx = x - c[0] - 1.5, dy = y - c[1];
      return [c[0] + Math.cos(th) * dx + Math.sin(th) * dy, c[1] - Math.sin(th) * dx + Math.cos(th) * dy, z - 0];
    };
    const [nx, ny, nz] = g.dims;
    const m = g.indexToWorld;
    let checked = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const x = m[0] * i + m[1] * j + m[2] * k + m[3], y = m[4] * i + m[5] * j + m[6] * k + m[7], z = m[8] * i + m[9] * j + m[10] * k + m[11];
          if (z < 26) continue; // b だけが覆う範囲
          const v = sl[k][j * nx + i];
          if (Number.isNaN(v)) continue;
          const q = back(x, y, z);
          // 中心の範囲の内側だけ（縁は半ボクセルの端値で受けるため補間の真値と一致しない）
          const w = b0.volume.worldToIndex;
          const ii = w[0] * q[0] + w[1] * q[1] + w[2] * q[2] + w[3];
          const jj = w[4] * q[0] + w[5] * q[1] + w[6] * q[2] + w[7];
          const kk = w[8] * q[0] + w[9] * q[1] + w[10] * q[2] + w[11];
          if (ii < 0 || ii > 13 || jj < 0 || jj > 11 || kk < 0 || kk > 7) continue;
          expect(Math.abs(v - truth(q[0], q[1], q[2]))).toBeLessThan(1e-3);
          checked++;
        }
    expect(checked).toBeGreaterThan(100);
  });

  it("基準シリーズを後ろにしても、出力の軸は基準の向きになる", () => {
    const g0 = unionGrid([a, b], undefined, 0);
    const g1 = unionGrid([a, b], undefined, 1);
    expect(g0.indexToWorld[0]).toBeCloseTo(1, 9);
    expect(g1.indexToWorld[0]).toBeCloseTo(Math.cos((10 * Math.PI) / 180), 9);
  });

  it("反転は画素の鏡像になる（左右の入れ替わりを数値で確認）", () => {
    const f = placeInput(a, P({ flipX: true }));
    const g = unionGrid([a, f], undefined, 0); // 基準 a の軸。f は鏡映されて同じ範囲に載る
    const sl = stitchToGrid([f], g, { mode: "mean" });
    const [nx, ny] = g.dims;
    const o = stitchToGrid([a], g, { mode: "mean" });
    // 同じ行・スライスで、列が逆順になっている
    for (let i = 0; i < nx; i++) expect(Math.abs(sl[3][2 * nx + i] - o[3][2 * nx + (nx - 1 - i)])).toBeLessThan(1e-3);
    expect(ny).toBe(unionGrid([a]).dims[1]);
  });
});

describe("defaultOutputSpacing（出力の間隔の既定）", () => {
  const a = input(12, 10, 8, [0, 0, 0], 1, 1.5, 2);
  const b = input(12, 10, 8, [0, 0, 20], 0.8, 2, 3);

  it("基準なしは位置合わせ前の各軸の最小値", () => {
    expect(defaultOutputSpacing([a, b], null)).toEqual([0.8, 1.5, 2]);
  });

  it("基準ありは、その入力の間隔（他に細かいものがあっても）", () => {
    expect(defaultOutputSpacing([a, b], 0)).toEqual([1, 1.5, 2]);
    expect(defaultOutputSpacing([a, b], 1)).toEqual([0.8, 2, 3]);
  });

  it("拡大した入力の実寸変化は、既定に影響しない（位置合わせ前の入力から求める）", () => {
    const scaled = placeInput(b, P({ sx: 0.5, sy: 0.5, sz: 0.5 }));
    expect(Array.from(scaled.volume.spacing)).toEqual([0.4, 1, 1.5]); // 実寸は変わっている
    expect(defaultOutputSpacing([a, b], null)).toEqual([0.8, 1.5, 2]); // 既定は変わらない
    expect(Array.from(unionGrid([a, scaled], undefined, 0).spacing)).not.toEqual([0.8, 1.5, 2]); // 従来の既定なら変わっていた
    expect(Array.from(unionGrid([a, scaled], defaultOutputSpacing([a, b], null), 0).spacing)).toEqual([0.8, 1.5, 2]);
  });

  it("入力が無ければ例外", () => {
    expect(() => defaultOutputSpacing([], null)).toThrow();
  });
});
