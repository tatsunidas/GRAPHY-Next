/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { makeVolume, sampleTrilinear } from "./regGeometry";
import {
  MipAccumulator,
  checkStitchInputs,
  coordinatesCoincide,
  normalOfIop,
  placeAlongNormal,
  previewSpacing,
  shiftInput,
  stitchSlices,
  stitchToGrid,
  unionGrid,
  type StitchGrid,
  type StitchInput,
  type StitchPetInfo,
} from "./volumeStitch";

// 真値: 世界座標の 1 次関数を 1 つの連続した範囲で定義し、そこから入力を切り出す
// （格子の作り方とは独立。trilinear は 1 次関数を厳密に再現するので ε は丸めだけ）。
const A = 0.5, B = -0.3, C = 0.8, D = 12;
const truth = (x: number, y: number, z: number) => A * x + B * y + C * z + D;
const EPS = 1e-4;

function frame(tiltDeg: number) {
  const t = (tiltDeg * Math.PI) / 180;
  const rc: [number, number, number] = [1, 0, 0];
  const rr: [number, number, number] = [0, Math.cos(t), Math.sin(t)];
  const n: [number, number, number] = [
    rc[1] * rr[2] - rc[2] * rr[1],
    rc[2] * rr[0] - rc[0] * rr[2],
    rc[0] * rr[1] - rc[1] * rr[0],
  ];
  return { rc, rr, n, iop: [...rc, ...rr] };
}

interface Opts {
  w0: number; // 先頭スライスの法線方向位置 [mm]
  nz?: number;
  sz?: number;
  add?: number;
  tilt?: number; // この入力が持つ IOP の傾き（既定 0）
  patient?: string;
  modality?: string;
  pet?: StitchPetInfo;
  frameTilt?: number; // 世界の座標系を傾ける（斜めの向きの検査）
}

function makeInput(o: Opts): StitchInput {
  const nx = 12, ny = 10, nz = o.nz ?? 10, sz = o.sz ?? 2;
  const f = frame(o.frameTilt ?? 0);
  const ipp0: [number, number, number] = [
    f.rc[0] * 5 + f.rr[0] * -7 + f.n[0] * o.w0,
    f.rc[1] * 5 + f.rr[1] * -7 + f.n[1] * o.w0,
    f.rc[2] * 5 + f.rr[2] * -7 + f.n[2] * o.w0,
  ];
  const data = new Float32Array(nx * ny * nz);
  const vol0 = makeVolume(data, [nx, ny, nz], f.iop, ipp0, 1, 1.5, [f.n[0] * sz, f.n[1] * sz, f.n[2] * sz]);
  const m = vol0.indexToWorld;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        data[k * nx * ny + j * nx + i] =
          truth(
            m[0] * i + m[1] * j + m[2] * k + m[3],
            m[4] * i + m[5] * j + m[6] * k + m[7],
            m[8] * i + m[9] * j + m[10] * k + m[11],
          ) + (o.add ?? 0);
      }
  const iop = o.tilt ? frame(o.tilt).iop : f.iop;
  return {
    volume: vol0,
    iop,
    modality: o.modality ?? "CT",
    patientId: o.patient ?? "P1",
    pet: o.pet,
  };
}

interface Cell { w: number; value: number; truthV: number }

/** 格子の全ボクセルを (法線方向位置, 値, 真値) で返す。 */
function cells(grid: StitchGrid, slices: Float32Array[], f = frame(0)): Cell[] {
  const [nx, ny, nz] = grid.dims;
  const m = grid.indexToWorld;
  const out: Cell[] = [];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const x = m[0] * i + m[1] * j + m[2] * k + m[3];
        const y = m[4] * i + m[5] * j + m[6] * k + m[7];
        const z = m[8] * i + m[9] * j + m[10] * k + m[11];
        out.push({
          w: f.n[0] * x + f.n[1] * y + f.n[2] * z,
          value: slices[k][j * nx + i],
          truthV: truth(x, y, z),
        });
      }
  return out;
}

const maxErr = (cs: Cell[], add: (w: number) => number) =>
  Math.max(...cs.map((c) => Math.abs(c.value - (c.truthV + add(c.w)))));

describe("unionGrid / stitchToGrid（正例）", () => {
  it("(a) 重なり: 重なり 20.0（縁で測る。中心の区間では 18）・隙間 0.0・dims・原点・全ボクセルが真値", () => {
    // 1 本目 w=-100..-100+18 (10 枚), 2 本目は 1 本目の末尾 18 mm と重なる
    const a = makeInput({ w0: -100, nz: 20 }); // -100..-62
    const b = makeInput({ w0: -80, nz: 20 }); // -80..-42 → 重なり -80..-62 = 18
    const g = unionGrid([a, b]);
    expect(g.overlapMm).toBeCloseTo(20.0, 2); // 中心の重なり 18 + 縁の半スライス 1 × 2
    expect(g.gapMm).toBeCloseTo(0.0, 2);
    const L = -42 - -100;
    expect(g.dims[2]).toBe(Math.floor(L / 2 + 1e-9) + 1);
    expect(g.dims[0]).toBe(12);
    expect(g.dims[1]).toBe(10);
    // 原点 = 手前の入力の先頭 IPP
    for (let r = 0; r < 3; r++) expect(Math.abs(g.indexToWorld[r * 4 + 3] - a.volume.indexToWorld[r * 4 + 3])).toBeLessThan(1e-3);
    const cs = cells(g, stitchToGrid([a, b], g, "mean"));
    expect(cs.every((c) => Number.isFinite(c.value))).toBe(true);
    expect(maxErr(cs, () => 0)).toBeLessThan(EPS);
  });

  it("(a') 斜めの向き（IOP が軸に平行でない）でも同じ", () => {
    const a = makeInput({ w0: -100, nz: 20, frameTilt: 20, tilt: 20 });
    const b = makeInput({ w0: -80, nz: 20, frameTilt: 20, tilt: 20 });
    const g = unionGrid([a, b]);
    expect(g.overlapMm).toBeCloseTo(20.0, 2);
    const cs = cells(g, stitchToGrid([a, b], g, "mean"), frame(20));
    expect(cs.every((c) => Number.isFinite(c.value))).toBe(true);
    expect(maxErr(cs, () => 0)).toBeLessThan(EPS);
  });

  it("(b) 2 本目をスライス間隔の 0.4 倍ずらす: 全ボクセルが ε 内で継ぎ目に段差が無い", () => {
    const a = makeInput({ w0: -100, nz: 20 });
    const b = makeInput({ w0: -80 + 0.4 * 2, nz: 20 });
    const g = unionGrid([a, b]);
    const sl = stitchToGrid([a, b], g, "mean");
    const cs = cells(g, sl);
    expect(cs.every((c) => Number.isFinite(c.value))).toBe(true);
    expect(maxErr(cs, () => 0)).toBeLessThan(EPS);
    // 段差: 同じ (i,j) の隣接スライスの差が真値の差（C·間隔 ≈ 1.6）と一致
    const [nx, ny, nz] = g.dims;
    for (let k = 1; k < nz; k++) {
      const d = sl[k][0] - sl[k - 1][0];
      expect(Math.abs(d - C * 2)).toBeLessThan(EPS * 2);
    }
    expect(nx * ny).toBeGreaterThan(0);
  });

  it("(c) 2 本目だけ +100: 重なり +50 / 1 本目のみ +0 / 2 本目のみ +100", () => {
    const a = makeInput({ w0: -100, nz: 20 });
    const b = makeInput({ w0: -80, nz: 20, add: 100 });
    const g = unionGrid([a, b]);
    const cs = cells(g, stitchToGrid([a, b], g, "mean"));
    expect(maxErr(cs, expectedC)).toBeLessThan(EPS);
    // 3 区分とも実在する
    expect(cs.some((c) => expectedC(c.w) === 0)).toBe(true);
    expect(cs.some((c) => expectedC(c.w) === 50)).toBe(true);
    expect(cs.some((c) => expectedC(c.w) === 100)).toBe(true);
  });

  it("(d) 中心間 10 mm の隙間: gapMm 8.0（縁で測る）・隙間のボクセルは NaN・他は真値", () => {
    const a = makeInput({ w0: -100, nz: 20 }); // -100..-62
    const b = makeInput({ w0: -52, nz: 20 }); // -52..-14
    const g = unionGrid([a, b]);
    expect(g.gapMm).toBeCloseTo(8.0, 2); // 中心間 10 − 半スライス 1 × 2
    expect(g.overlapMm).toBeCloseTo(0.0, 2);
    const cs = cells(g, stitchToGrid([a, b], g, "mean"));
    const inGap = (w: number) => w > -62 + 1e-6 && w < -52 - 1e-6;
    expect(cs.filter((c) => inGap(c.w)).length).toBeGreaterThan(0);
    for (const c of cs) {
      if (inGap(c.w)) expect(Number.isNaN(c.value)).toBe(true);
      else expect(Math.abs(c.value - c.truthV)).toBeLessThan(EPS);
    }
  });

  it("間隔は軸ごとの最小値、上書きできる", () => {
    const a = makeInput({ w0: -100, nz: 20, sz: 2 });
    const b = makeInput({ w0: -60, nz: 30, sz: 1 });
    expect(unionGrid([a, b]).spacing).toEqual([1, 1.5, 1]);
    expect(unionGrid([a, b], [2, 3, 4]).spacing).toEqual([2, 3, 4]);
  });
});

function expectedC(w: number): number {
  // 1 本目 -100..-62、2 本目 -80..-42（+100）
  const in1 = w <= -62 + 1e-6;
  const in2 = w >= -80 - 1e-6;
  if (in1 && in2) return 50;
  return in2 ? 100 : 0;
}

describe("テストが重なりの扱いを見分けられる", () => {
  it("「後勝ち」に置き換えると (c) の検査が落ちる", () => {
    const a = makeInput({ w0: -100, nz: 20 });
    const b = makeInput({ w0: -80, nz: 20, add: 100 });
    const g = unionGrid([a, b]);
    const [nx, ny, nz] = g.dims;
    const m = g.indexToWorld;
    const slices: Float32Array[] = [];
    for (let k = 0; k < nz; k++) {
      const s = new Float32Array(nx * ny);
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const x = m[0] * i + m[1] * j + m[2] * k + m[3];
          const y = m[4] * i + m[5] * j + m[6] * k + m[7];
          const z = m[8] * i + m[9] * j + m[10] * k + m[11];
          let v = NaN;
          for (const inp of [a, b]) {
            const w = inp.volume.worldToIndex;
            const t = sampleTrilinear(
              inp.volume,
              w[0] * x + w[1] * y + w[2] * z + w[3],
              w[4] * x + w[5] * y + w[6] * z + w[7],
              w[8] * x + w[9] * y + w[10] * z + w[11],
            );
            if (!Number.isNaN(t)) v = t; // 後勝ち
          }
          s[j * nx + i] = v;
        }
      slices.push(s);
    }
    expect(maxErr(cells(g, slices), expectedC)).toBeGreaterThan(10);
  });
});

describe("checkStitchInputs（負例）", () => {
  const ok = () => [makeInput({ w0: -100 }), makeInput({ w0: -60 })];
  const pet = (over: Partial<StitchPetInfo> = {}): StitchPetInfo => ({
    decayCorrection: "START", referenceTimeMs: 1000, units: "BQML", halfLifeSec: 6586, totalDoseBq: 3e8, ...over,
  });

  it("条件が合う組は ok", () => {
    expect(checkStitchInputs(ok())).toEqual({ ok: true, violations: [] });
  });
  it("入力が 1 本 → tooFew", () => {
    expect(checkStitchInputs([makeInput({ w0: 0 })]).violations).toEqual(["tooFew"]);
  });
  it("IOP を 5° 回す → orientation", () => {
    const r = checkStitchInputs([makeInput({ w0: -100 }), makeInput({ w0: -60, tilt: 5 })]);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(["orientation"]);
  });
  it("DS 桁の丸め程度の差は同じ向きとして通す", () => {
    const b = makeInput({ w0: -60 });
    b.iop = [1, 0, 0, 0, 1.0000005, 1e-7];
    expect(checkStitchInputs([makeInput({ w0: -100 }), b]).ok).toBe(true);
  });
  it("FoR は条件にしない（装置がステーションごとに別の FoR を付ける）", () => {
    expect(checkStitchInputs([makeInput({ w0: -100 }), makeInput({ w0: -60 })]).ok).toBe(true);
  });
  it("PatientID が違う → patient", () => {
    expect(checkStitchInputs([makeInput({ w0: -100 }), makeInput({ w0: -60, patient: "P2" })]).violations).toEqual(["patient"]);
  });
  it("モダリティが違う → modality", () => {
    expect(checkStitchInputs([makeInput({ w0: -100 }), makeInput({ w0: -60, modality: "MR" })]).violations).toEqual(["modality"]);
  });
  it("基準時刻だけが違う PT → petReference", () => {
    const r = checkStitchInputs([
      makeInput({ w0: -100, modality: "PT", pet: pet() }),
      makeInput({ w0: -60, modality: "PT", pet: pet({ referenceTimeMs: 2000 }) }),
    ]);
    expect(r.violations).toEqual(["petReference"]);
  });
  it("PT で値が欠けている → petReference", () => {
    expect(checkStitchInputs([
      makeInput({ w0: -100, modality: "PT", pet: pet() }),
      makeInput({ w0: -60, modality: "PT", pet: pet({ halfLifeSec: undefined }) }),
    ]).violations).toEqual(["petReference"]);
    expect(checkStitchInputs([
      makeInput({ w0: -100, modality: "PT" }),
      makeInput({ w0: -60, modality: "PT" }),
    ]).violations).toEqual(["petReference"]);
  });
  it("PET の項目が全て一致する PT の組は ok", () => {
    expect(checkStitchInputs([
      makeInput({ w0: -100, modality: "PT", pet: pet() }),
      makeInput({ w0: -60, modality: "PT", pet: pet() }),
    ]).ok).toBe(true);
  });
  it("複数の違反はすべて返る", () => {
    const r = checkStitchInputs([makeInput({ w0: -100 }), makeInput({ w0: -60, patient: "P2", modality: "MR" })]);
    expect(r.violations).toEqual(["patient", "modality"]);
  });
});

describe("縁（半ボクセル）の扱い: 重なりなしで隣り合う入力の継ぎ目", () => {
  // 1 本目は w=-100..-82（10 枚）。2 本目は次の位置 -80 から δ だけずらして始める（間隔 2 mm）。
  const seam = (delta: number) => {
    const a = makeInput({ w0: -100 });
    const b = makeInput({ w0: -80 + delta });
    const g = unionGrid([a, b]);
    return { a, b, g, cs: cells(g, stitchToGrid([a, b], g, "mean")) };
  };

  // ずれ δ が半スライス（1 mm = 0.5 × 間隔）以内なら、継ぎ目の格子点は 2 本目のボクセルの縁に入る。
  for (const frac of [0, 0.3, 0.5]) {
    it(`ずれ ${frac} × 間隔（半スライス以内）: 継ぎ目に NaN が無く、値は真値（縁の複製は C × 半スライス以内）`, () => {
      const { g, cs } = seam(frac * 2);
      expect(cs.length).toBeGreaterThan(0);
      expect(cs.every((c) => Number.isFinite(c.value))).toBe(true);
      // 縁の複製を使う点だけ真値からずれる。最大でも傾き C × 半スライス（1 mm）。
      expect(maxErr(cs, () => 0)).toBeLessThanOrEqual(C * 1 + EPS);
      expect(g.gapMm).toBeCloseTo(frac * 2, 2); // 縁で測った隙間は、ずれの分だけ（物理的な隙間）
      expect(g.overlapMm).toBeCloseTo(0, 2);
    });
  }

  // 半スライスを超えてずれると、継ぎ目の格子点はどちらのボクセルにも入らない（本当の隙間）。
  for (const frac of [0.7, 0.95]) {
    it(`ずれ ${frac} × 間隔（半スライス超）: 継ぎ目のスライス 10 だけ NaN、他は有限`, () => {
      const { g, cs } = seam(frac * 2);
      const nanW = cs.filter((c) => Number.isNaN(c.value)).map((c) => c.w);
      expect(nanW.length).toBeGreaterThan(0);
      expect(nanW.every((w) => Math.abs(w - -80) < 1e-6)).toBe(true);
      expect(g.gapMm).toBeCloseTo(frac * 2, 2);
    });
  }

  it("ずれ 0: ぴったり隣り合う 2 本は gapMm 0・全ボクセルが真値", () => {
    const { g, cs } = seam(0);
    expect(g.gapMm).toBeCloseTo(0, 6);
    expect(maxErr(cs, () => 0)).toBeLessThan(EPS);
  });

  it("真の隙間（スライス 3 枚分）は NaN のまま・gapMm > 0", () => {
    const a = makeInput({ w0: -100 });
    const b = makeInput({ w0: -80 + 6 }); // -74 から。-80, -78, -76 が空く
    const g = unionGrid([a, b]);
    expect(g.gapMm).toBeCloseTo(6, 2);
    const sl = stitchToGrid([a, b], g, "mean");
    const nanSlices = sl.map((s, k) => (Number.isNaN(s[0]) ? k : -1)).filter((k) => k >= 0);
    expect(nanSlices).toEqual([10, 11, 12]);
    // それ以外のスライスは全画素が有限
    sl.forEach((s, k) => { if (!nanSlices.includes(k)) expect(Array.from(s).every(Number.isFinite)).toBe(true); });
  });

  it("重なりの中では縁の複製を平均に混ぜない（真値と一致）", () => {
    const a = makeInput({ w0: -100, nz: 20 });
    const b = makeInput({ w0: -80 + 0.7, nz: 20 });
    const g = unionGrid([a, b]);
    expect(maxErr(cells(g, stitchToGrid([a, b], g, "mean")), () => 0)).toBeLessThan(EPS);
  });
});

describe("格子の大きさ・スライスごとの出力", () => {
  it("voxelCount と inflation: 間隔の違う入力が混ざると膨らむ", () => {
    const same = unionGrid([makeInput({ w0: -100 }), makeInput({ w0: -80 })]);
    expect(same.voxelCount).toBe(same.dims[0] * same.dims[1] * same.dims[2]);
    expect(same.inflation).toBeCloseTo(same.voxelCount / (12 * 10 * 10 * 2), 9);
    const fine = unionGrid([makeInput({ w0: -100 }), makeInput({ w0: -80, sz: 0.5 })]);
    expect(fine.inflation).toBeGreaterThan(same.inflation);
  });

  it("stitchSlices は stitchToGrid と同じ値を 1 枚ずつ返す", () => {
    const a = makeInput({ w0: -100, nz: 20 });
    const b = makeInput({ w0: -80 + 0.7, nz: 20 });
    const g = unionGrid([a, b]);
    const all = stitchToGrid([a, b], g, "mean");
    const it = stitchSlices([a, b], g, "mean");
    const first = it.next();
    expect(first.done).toBe(false);
    expect(Array.from(first.value as Float32Array)).toEqual(Array.from(all[0]));
    expect(all.length).toBe(g.dims[2]);
  });
});

describe("向きの許容差は大きさと間隔から導く", () => {
  // 面内 12×10 画素・間隔 1 × 1.5 mm → L = hypot(11, 13.5) ≈ 17.4 mm, s = 1 mm → θ = s/(2L) ≈ 1.64°
  const withTilt = (deg: number) => checkStitchInputs([makeInput({ w0: -100 }), makeInput({ w0: -60, tilt: deg })]);
  it("許容角の内側（1°）は通し、外側（2°）は orientation", () => {
    expect(withTilt(1).ok).toBe(true);
    expect(withTilt(2).violations).toEqual(["orientation"]);
  });
});

describe("位置の指定（重なり mm）", () => {
  const n = normalOfIop(frame(0).iop);
  const place = (ins: StitchInput[], ov: number, rev = false) =>
    ins.map((x, t) => shiftInput(x, placeAlongNormal(ins, ov, rev)[t], n));

  it("座標が全部同じ 2 本でも、指定した重なりになる（縁で測る）", () => {
    const ins = place([makeInput({ w0: -100 }), makeInput({ w0: -100 })], 8);
    const g = unionGrid(ins);
    expect(g.overlapMm).toBeCloseTo(8, 6);
    expect(g.gapMm).toBeCloseTo(0, 6);
  });
  it("負の重なりは隙間になる", () => {
    const g = unionGrid(place([makeInput({ w0: -100 }), makeInput({ w0: -100 })], -6));
    expect(g.overlapMm).toBeCloseTo(0, 6);
    expect(g.gapMm).toBeCloseTo(6, 6);
  });
  it("3 本は隣り合うごとに同じ重なり（全体の長さ = 3L − 2·重なり）", () => {
    const ins = place([0, 1, 2].map(() => makeInput({ w0: -100 })), 8);
    const g = unionGrid(ins);
    expect(g.overlapMm).toBeCloseTo(16, 6);
    expect(g.gapMm).toBeCloseTo(0, 6);
    expect(g.intervals[1][0]).toBeGreaterThan(g.intervals[0][0]);
    expect(g.intervals[2][0]).toBeGreaterThan(g.intervals[1][0]);
  });
  it("向きを反転すると 2 本目が − 側に並ぶ（重なりは同じ）", () => {
    const g = unionGrid(place([makeInput({ w0: -100 }), makeInput({ w0: -100 })], 8, true));
    expect(g.overlapMm).toBeCloseTo(8, 6);
    expect(g.intervals[1][1]).toBeLessThan(g.intervals[0][1]);
  });
  it("shiftInput は元を変えず、世界座標だけ d·n 動く", () => {
    const a = makeInput({ w0: -100 });
    const before = Array.from(a.volume.indexToWorld);
    const b = shiftInput(a, 7, n);
    expect(Array.from(a.volume.indexToWorld)).toEqual(before);
    expect(b.volume.data).toBe(a.volume.data);
    const w = (v: StitchInput, i: number, j: number, k: number) => {
      const m = v.volume.indexToWorld;
      return [0, 1, 2].map((r) => m[r * 4] * i + m[r * 4 + 1] * j + m[r * 4 + 2] * k + m[r * 4 + 3]);
    };
    const p = w(a, 3, 4, 5), q = w(b, 3, 4, 5);
    [0, 1, 2].forEach((r) => expect(q[r] - p[r]).toBeCloseTo(7 * n[r], 9));
    // world → index が index → world の逆になっている
    const wi = b.volume.worldToIndex;
    const idx = [0, 1, 2].map((r) => wi[r * 4] * q[0] + wi[r * 4 + 1] * q[1] + wi[r * 4 + 2] * q[2] + wi[r * 4 + 3]);
    [3, 4, 5].forEach((v, r) => expect(idx[r]).toBeCloseTo(v, 6));
  });
  it("座標が一致しているかの判定（正例・負例）", () => {
    expect(coordinatesCoincide([makeInput({ w0: -100 }), makeInput({ w0: -100 })])).toBe(true);
    expect(coordinatesCoincide([makeInput({ w0: -100 }), makeInput({ w0: -80 })])).toBe(false);
    expect(coordinatesCoincide([makeInput({ w0: -100 })])).toBe(false);
  });
});

describe("MIP プレビュー", () => {
  it("3 方向の最大が、全体を作って総当たりで取った値と一致する", () => {
    const ins = [makeInput({ w0: -100 }), makeInput({ w0: -84, add: 30 })];
    const g = unionGrid(ins);
    const all = stitchToGrid(ins, g, "mean");
    const [nx, ny, nz] = g.dims;
    const acc = new MipAccumulator(g.dims);
    [...stitchSlices(ins, g, "mean")].forEach((s, k) => acc.add(k, s));
    const r = acc.result();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let m = -Infinity;
      for (let k = 0; k < nz; k++) m = Math.max(m, all[k][j * nx + i]);
      expect(r.ax[j * nx + i]).toBeCloseTo(m, 4);
    }
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      let m = -Infinity;
      for (let j = 0; j < ny; j++) m = Math.max(m, all[k][j * nx + i]);
      expect(r.cor[k * nx + i]).toBeCloseTo(m, 4);
    }
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      let m = -Infinity;
      for (let i = 0; i < nx; i++) m = Math.max(m, all[k][j * nx + i]);
      expect(r.sag[k * ny + j]).toBeCloseTo(m, 4);
    }
  });
  it("1 次関数なら MIP は解析的な端の値（A>0・B<0・C>0）", () => {
    const ins = [makeInput({ w0: -100 }), makeInput({ w0: -84 })];
    const g = unionGrid(ins);
    const [nx, ny, nz] = g.dims;
    const acc = new MipAccumulator(g.dims);
    [...stitchSlices(ins, g, "mean")].forEach((s, k) => acc.add(k, s));
    const r = acc.result();
    const m = g.indexToWorld;
    const at = (i: number, j: number, k: number) =>
      truth(m[0] * i + m[1] * j + m[2] * k + m[3], m[4] * i + m[5] * j + m[6] * k + m[7], m[8] * i + m[9] * j + m[10] * k + m[11]);
    expect(r.ax[3 * nx + 2]).toBeCloseTo(at(2, 3, nz - 1), 3); // z が最大の面
    expect(r.cor[4 * nx + 5]).toBeCloseTo(at(5, 0, 4), 3); //     y（B<0）が最小の j=0
    expect(r.sag[4 * ny + 5]).toBeCloseTo(at(nx - 1, 5, 4), 3); // x（A>0）が最大の i
  });
  it("覆われない画素は NaN（隙間）", () => {
    const ins = [makeInput({ w0: -100 }), makeInput({ w0: -60 })];
    const g = unionGrid(ins);
    const acc = new MipAccumulator(g.dims);
    [...stitchSlices(ins, g, "mean")].forEach((s, k) => acc.add(k, s));
    const nanRows = Array.from({ length: g.dims[2] }, (_, k) => Number.isNaN(acc.result().cor[k * g.dims[0]]));
    expect(nanRows.some(Boolean)).toBe(true);
    expect(nanRows[0]).toBe(false);
  });
  it("プレビューの間隔: 最長辺が maxPx に収まり、出力より細かくならない", () => {
    const sp = previewSpacing({ dims: [100, 100, 200], spacing: [1, 1, 2] }, 100);
    expect(sp[0]).toBeCloseTo(4, 9); // 最長 400 mm / 100 px
    expect(sp[2]).toBeCloseTo(4, 9);
    const fine = previewSpacing({ dims: [10, 10, 10], spacing: [1, 1, 1] }, 1000);
    expect(fine).toEqual([1, 1, 1]);
  });
});
