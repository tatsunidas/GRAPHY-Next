/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { makeVolume, sampleTrilinear } from "./regGeometry";
import {
  BLEND_MEAN,
  MipAccumulator,
  estimateGains,
  matchEnds,
  type BlendOptions,
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
    const cs = cells(g, stitchToGrid([a, b], g, BLEND_MEAN));
    expect(cs.every((c) => Number.isFinite(c.value))).toBe(true);
    expect(maxErr(cs, () => 0)).toBeLessThan(EPS);
  });

  it("(a') 斜めの向き（IOP が軸に平行でない）でも同じ", () => {
    const a = makeInput({ w0: -100, nz: 20, frameTilt: 20, tilt: 20 });
    const b = makeInput({ w0: -80, nz: 20, frameTilt: 20, tilt: 20 });
    const g = unionGrid([a, b]);
    expect(g.overlapMm).toBeCloseTo(20.0, 2);
    const cs = cells(g, stitchToGrid([a, b], g, BLEND_MEAN), frame(20));
    expect(cs.every((c) => Number.isFinite(c.value))).toBe(true);
    expect(maxErr(cs, () => 0)).toBeLessThan(EPS);
  });

  it("(b) 2 本目をスライス間隔の 0.4 倍ずらす: 全ボクセルが ε 内で継ぎ目に段差が無い", () => {
    const a = makeInput({ w0: -100, nz: 20 });
    const b = makeInput({ w0: -80 + 0.4 * 2, nz: 20 });
    const g = unionGrid([a, b]);
    const sl = stitchToGrid([a, b], g, BLEND_MEAN);
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
    const cs = cells(g, stitchToGrid([a, b], g, BLEND_MEAN));
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
    const cs = cells(g, stitchToGrid([a, b], g, BLEND_MEAN));
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
    return { a, b, g, cs: cells(g, stitchToGrid([a, b], g, BLEND_MEAN)) };
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
    const sl = stitchToGrid([a, b], g, BLEND_MEAN);
    const nanSlices = sl.map((s, k) => (Number.isNaN(s[0]) ? k : -1)).filter((k) => k >= 0);
    expect(nanSlices).toEqual([10, 11, 12]);
    // それ以外のスライスは全画素が有限
    sl.forEach((s, k) => { if (!nanSlices.includes(k)) expect(Array.from(s).every(Number.isFinite)).toBe(true); });
  });

  it("重なりの中では縁の複製を平均に混ぜない（真値と一致）", () => {
    const a = makeInput({ w0: -100, nz: 20 });
    const b = makeInput({ w0: -80 + 0.7, nz: 20 });
    const g = unionGrid([a, b]);
    expect(maxErr(cells(g, stitchToGrid([a, b], g, BLEND_MEAN)), () => 0)).toBeLessThan(EPS);
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
    const all = stitchToGrid([a, b], g, BLEND_MEAN);
    const it = stitchSlices([a, b], g, BLEND_MEAN);
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
  // 各組の重なり・隙間は、その 2 本だけで格子を作って縁で測る。
  const pairOf = (ins: StitchInput[], sh: number[], t: number) => {
    const g = unionGrid([shiftInput(ins[t], sh[t], n), shiftInput(ins[t + 1], sh[t + 1], n)]);
    return { overlap: g.overlapMm, gap: g.gapMm };
  };
  it("組ごとの重なり: 3 本で 8 mm と 3 mm（各組を縁で測る）", () => {
    const ins = [0, 1, 2].map(() => makeInput({ w0: -100 }));
    const sh = placeAlongNormal(ins, [8, 3], false);
    expect(pairOf(ins, sh, 0).overlap).toBeCloseTo(8, 6);
    expect(pairOf(ins, sh, 1).overlap).toBeCloseTo(3, 6);
    expect(unionGrid(ins.map((x, t) => shiftInput(x, sh[t], n))).overlapMm).toBeCloseTo(11, 6);
  });
  it("組ごとの重なり: 負の値はその組だけ隙間になる", () => {
    const ins = [0, 1, 2].map(() => makeInput({ w0: -100 }));
    const sh = placeAlongNormal(ins, [8, -2], false);
    expect(pairOf(ins, sh, 0).overlap).toBeCloseTo(8, 6);
    expect(pairOf(ins, sh, 1).gap).toBeCloseTo(2, 6);
    expect(pairOf(ins, sh, 1).overlap).toBeCloseTo(0, 6);
  });
  it("組ごとの重なり: 同じ値の配列は数の指定と同じ（両向き）", () => {
    const ins = [0, 1, 2].map(() => makeInput({ w0: -100 }));
    for (const rev of [false, true]) {
      const a = placeAlongNormal(ins, 5, rev), b = placeAlongNormal(ins, [5, 5], rev);
      b.forEach((v, t) => expect(v).toBeCloseTo(a[t], 9));
    }
  });
  it("組ごとの重なり: 向きを反転しても各組の重なりが指定どおり（− 側へ並ぶ）", () => {
    const ins = [0, 1, 2].map(() => makeInput({ w0: -100 }));
    const sh = placeAlongNormal(ins, [8, 3], true);
    expect(pairOf(ins, sh, 0).overlap).toBeCloseTo(8, 6);
    expect(pairOf(ins, sh, 1).overlap).toBeCloseTo(3, 6);
    expect(sh[1]).toBeLessThan(0);
    expect(sh[2]).toBeLessThan(sh[1]);
  });
  it("組ごとの重なり: 個数が組の数と合わなければ例外", () => {
    const ins = [0, 1, 2].map(() => makeInput({ w0: -100 }));
    expect(() => placeAlongNormal(ins, [8], false)).toThrow();
    expect(() => placeAlongNormal(ins, [8, 3, 1], false)).toThrow();
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
    const all = stitchToGrid(ins, g, BLEND_MEAN);
    const [nx, ny, nz] = g.dims;
    const acc = new MipAccumulator(g.dims);
    [...stitchSlices(ins, g, BLEND_MEAN)].forEach((s, k) => acc.add(k, s));
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
    [...stitchSlices(ins, g, BLEND_MEAN)].forEach((s, k) => acc.add(k, s));
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
    [...stitchSlices(ins, g, BLEND_MEAN)].forEach((s, k) => acc.add(k, s));
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

describe("ブレンド（線形）", () => {
  // 重なりが各入力の半分より短いとき、縁からの距離は重なりに面した縁までの距離になる（標準の羽毛化）。
  const A2 = () => makeInput({ w0: -100, nz: 30 }); // -100..-42
  const B2 = () => makeInput({ w0: -62, nz: 30, add: 100 }); // -62..-4（2 本目だけ +100）
  // 縁で測った重なりは -63..-41（O = 22）。重なり内の位置 s = w + 63、2 本目の重みは s / O。
  const weight2 = (w: number, f: number) => Math.min(1, Math.max(0, 0.5 + ((w + 63) / 22 - 0.5) / f));
  const run = (blend: BlendOptions) => {
    const ins = [A2(), B2()];
    const g = unionGrid(ins);
    return cells(g, stitchToGrid(ins, g, blend));
  };

  it("範囲 100%: 重なり内で 2 本目の重みが s/O（解析式）。端では 1 本目に近い", () => {
    const cs = run({ mode: "linear", fraction: 1 });
    const inOverlap = cs.filter((c) => c.w >= -62 - 1e-6 && c.w <= -42 + 1e-6);
    expect(inOverlap.length).toBeGreaterThan(0);
    for (const c of inOverlap) expect(c.value).toBeCloseTo(c.truthV + 100 * weight2(c.w, 1), 3);
    const first = cs.find((c) => Math.abs(c.w - -62) < 1e-6)!;
    expect(first.value - first.truthV).toBeCloseTo(100 / 22, 3); // 2 本目の寄与は端で 1/22
  });
  it("範囲を狭めると中央で切り替わる（10%: 端は片方だけ、中央は 50:50）", () => {
    const cs = run({ mode: "linear", fraction: 0.1 });
    for (const c of cs.filter((c) => c.w >= -62 - 1e-6 && c.w <= -42 + 1e-6)) {
      expect(c.value).toBeCloseTo(c.truthV + 100 * weight2(c.w, 0.1), 3);
    }
    const mid = cs.find((c) => Math.abs(c.w - -52) < 1e-6)!;
    expect(mid.value - mid.truthV).toBeCloseTo(50, 3);
    const near = cs.find((c) => Math.abs(c.w - -60) < 1e-6)!;
    expect(near.value - near.truthV).toBeCloseTo(0, 3);
  });
  it("重なりの外（1 本だけが覆う点）は真値のまま・平均は従来どおり", () => {
    const cs = run({ mode: "linear", fraction: 1 });
    for (const c of cs.filter((c) => c.w < -62 - 1e-6)) expect(c.value).toBeCloseTo(c.truthV, 3);
    for (const c of cs.filter((c) => c.w > -42 + 1e-6)) expect(c.value).toBeCloseTo(c.truthV + 100, 3);
    const mean = run(BLEND_MEAN);
    for (const c of mean.filter((c) => c.w >= -62 - 1e-6 && c.w <= -42 + 1e-6)) expect(c.value).toBeCloseTo(c.truthV + 50, 3);
  });
  it("3 本が重なっても、同じ値なら真値のまま（重みは正規化される・NaN にならない）", () => {
    const ins = [makeInput({ w0: -100 }), makeInput({ w0: -98 }), makeInput({ w0: -96 })];
    const g = unionGrid(ins);
    for (const c of cells(g, stitchToGrid(ins, g, { mode: "linear", fraction: 1 }))) expect(c.value).toBeCloseTo(c.truthV, 3);
  });
  it("範囲が不正（0・1 超）なら例外", () => {
    const ins = [A2(), B2()];
    const g = unionGrid(ins);
    expect(() => stitchToGrid(ins, g, { mode: "linear", fraction: 0 })).toThrow();
    expect(() => stitchToGrid(ins, g, { mode: "linear", fraction: 1.5 })).toThrow();
  });
  it("検査が効く: 重みの向きを逆にした期待値とは合わない", () => {
    const cs = run({ mode: "linear", fraction: 1 });
    const wrong = cs.filter((c) => c.w >= -62 - 1e-6 && c.w <= -42 + 1e-6).map((c) => Math.abs(c.value - (c.truthV + 100 * (1 - weight2(c.w, 1)))));
    expect(Math.max(...wrong)).toBeGreaterThan(10);
  });
});

// 世界座標で構造を持つ関数（ステーションを切り出す元。端同士の照合と信号合わせの検査用）。
// 周期的な少数の正弦だと遠い位置同士でも相関が出る（実際の解剖は繰り返さない）ので、固定シードで多数の正弦を足す。
function makeTex(seed: number, terms = 16): (x: number, y: number, z: number) => number {
  let st = seed;
  const rnd = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 4294967296);
  const ps = Array.from({ length: terms }, () => ({
    kx: (rnd() - 0.5) * 0.9, ky: (rnd() - 0.5) * 0.9, kz: (rnd() - 0.5) * 1.2, ph: rnd() * 6.28, a: 0.5 + rnd(),
  }));
  return (x, y, z) => ps.reduce((sum, p) => sum + p.a * Math.sin(p.kx * x + p.ky * y + p.kz * z + p.ph), 0);
}
const tex = makeTex(11);
const tex2 = makeTex(23);

function texInput(w0: number, o: { nz?: number; desc?: boolean; fn?: (x: number, y: number, z: number) => number; mul?: number; add?: number; nx?: number } = {}): StitchInput {
  const nx = o.nx ?? 64, ny = 64, nz = o.nz ?? 20, sz = 2;
  const fn = o.fn ?? tex;
  const f = frame(0);
  const top = w0 + (nz - 1) * sz;
  const ipp0: [number, number, number] = o.desc ? [5, -7, top] : [5, -7, w0];
  const step: [number, number, number] = [0, 0, o.desc ? -sz : sz];
  const data = new Float32Array(nx * ny * nz);
  const vol0 = makeVolume(data, [nx, ny, nz], f.iop, ipp0, 1, 1.5, step);
  const m = vol0.indexToWorld;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        data[k * nx * ny + j * nx + i] =
          fn(m[0] * i + m[1] * j + m[2] * k + m[3], m[4] * i + m[5] * j + m[6] * k + m[7], m[8] * i + m[9] * j + m[10] * k + m[11]) * (o.mul ?? 1) + (o.add ?? 0);
      }
  return { volume: vol0, iop: f.iop, modality: "MR", patientId: "P1" };
}

describe("信号合わせ（ゲイン）", () => {
  const pos = (x: number, y: number, z: number) => 40 + tex(x, y, z); // 正の信号
  it("2 本目だけ ×1.25 → 倍率は 0.8（和の比）、基準は 1", () => {
    const ins = [texInput(-100, { fn: pos }), texInput(-70, { fn: pos, mul: 1.25 })]; // 重なり 5 枚
    const e = estimateGains(ins);
    expect(e.gains[0]).toBe(1);
    expect(e.gains[1]).toBeCloseTo(0.8, 2);
    expect(e.estimable).toEqual([true, true]);
  });
  it("3 本の連鎖: ×1.25、×1.5 → 0.8、0.8/1.2。順序を入れ替えて渡しても同じ", () => {
    const a = texInput(-100, { fn: pos });
    const b = texInput(-70, { fn: pos, mul: 1.25 });
    const c = texInput(-40, { fn: pos, mul: 1.5 });
    const e = estimateGains([c, a, b]); // 位置順は a, b, c
    expect(e.gains[1]).toBe(1);
    expect(e.gains[2]).toBeCloseTo(0.8, 2);
    expect(e.gains[0]).toBeCloseTo(1 / 1.5, 2);
  });
  it("隙間（重なりなし）・信号が負の組は推定不可（倍率 1 のまま）", () => {
    const gap = estimateGains([texInput(-100, { fn: pos }), texInput(-40, { fn: pos, mul: 1.25 })]);
    expect(gap.estimable).toEqual([true, false]);
    expect(gap.gains[1]).toBe(1);
    const neg = estimateGains([texInput(-100, { fn: (x, y, z) => -pos(x, y, z) }), texInput(-70, { fn: (x, y, z) => -pos(x, y, z) })]);
    expect(neg.estimable[1]).toBe(false);
  });
  it("gains を渡すと重なりの値が基準側に揃う", () => {
    const ins = [texInput(-100, { fn: pos }), texInput(-70, { fn: pos, mul: 1.25 })];
    const g = unionGrid(ins);
    const e = estimateGains(ins);
    const [nx, ny] = g.dims;
    const sl = stitchToGrid(ins, g, { mode: "linear", fraction: 1, gains: e.gains });
    const m = g.indexToWorld;
    let worst = 0;
    sl.forEach((s, k) => {
      for (let j = 0; j < ny; j += 7) for (let i = 0; i < nx; i += 7) {
        const x = m[0] * i + m[1] * j + m[2] * k + m[3], y = m[4] * i + m[5] * j + m[6] * k + m[7], z = m[8] * i + m[9] * j + m[10] * k + m[11];
        worst = Math.max(worst, Math.abs(s[j * nx + i] - pos(x, y, z)));
      }
    });
    expect(worst).toBeLessThan(0.05);
    const without = stitchToGrid(ins, g, { mode: "linear", fraction: 1 });
    let w2 = 0;
    without.forEach((s, k) => {
      for (let j = 0; j < ny; j += 7) for (let i = 0; i < nx; i += 7) {
        const x = m[0] * i + m[1] * j + m[2] * k + m[3], y = m[4] * i + m[5] * j + m[6] * k + m[7], z = m[8] * i + m[9] * j + m[10] * k + m[11];
        w2 = Math.max(w2, Math.abs(s[j * nx + i] - pos(x, y, z)));
      }
    });
    expect(w2).toBeGreaterThan(0.3); // 補正しないと 2 本目側が 25% 大きいまま
  });
  it("gains の数が入力と違えば例外", () => {
    const ins = [texInput(-100), texInput(-70)];
    expect(() => stitchToGrid(ins, unionGrid(ins), { mode: "mean", gains: [1] })).toThrow();
  });
});

describe("端の一致度（並び順・重なりの自動判定）", () => {
  // 3 本のステーション（各 20 枚 × 2 mm）。隣り合う 2 本が 5 枚（10 mm）重なる。
  const stations = (o: { desc?: boolean; fn?: (x: number, y: number, z: number) => number } = {}) => [
    texInput(-100, o), texInput(-70, { ...o, mul: 1.25, add: 7 }), texInput(-40, o),
  ];
  it("シャッフルして渡しても、昇順の順序と重なり 10 mm を返す（ゲイン・オフセットが違っても）", () => {
    const s = stations();
    const r = matchEnds([s[2], s[0], s[1]]);
    expect(r.comparable).toBe(true);
    expect(r.order).toEqual([1, 2, 0]);
    expect(r.pairs.map((p) => p.overlapMm)).toEqual([10, 10]);
    for (const p of r.pairs) expect(p.score).toBeGreaterThan(0.95);
    expect(r.margin).not.toBeNull();
    expect(r.margin!).toBeGreaterThan(0.5);
  });
  it("k 軸が降順の入力でも同じ結果", () => {
    const s = stations({ desc: true });
    const r = matchEnds([s[1], s[2], s[0]]);
    expect(r.order).toEqual([2, 0, 1]);
    expect(r.pairs.map((p) => p.overlapMm)).toEqual([10, 10]);
  });
  it("負例: 互いに無関係な 3 本は一致度が低く、正しい鎖の一致度より十分小さい", () => {
    const un = [texInput(-100), texInput(-70, { fn: tex2 }), texInput(-40, { fn: makeTex(37) })];
    const bad = matchEnds(un);
    const good = matchEnds(stations());
    expect(Math.max(...bad.pairs.map((p) => p.score))).toBeLessThan(0.6);
    expect(Math.min(...good.pairs.map((p) => p.score))).toBeGreaterThan(0.95);
  });
  it("面内の格子が違う入力があれば比較しない（順序は入力のまま）", () => {
    const r = matchEnds([texInput(-100), texInput(-70, { nx: 32 })]);
    expect(r.comparable).toBe(false);
    expect(r.order).toEqual([0, 1]);
    expect(r.pairs).toEqual([]);
  });
  it("検査が効く: 末尾と先頭を取り違えた鎖（逆順）の一致度は低い", () => {
    const s = stations();
    const r = matchEnds([s[0], s[1], s[2]]);
    const rev = matchEnds([s[2], s[1], s[0]]);
    expect(r.order).toEqual([0, 1, 2]);
    expect(rev.order).toEqual([2, 1, 0]); // 並べ替えられて、逆順のままにはならない
  });
});

describe("ブレンド（中点切り）", () => {
  // 1 本目 -100..-42、2 本目 -62..-4（2 本目だけ +100）。縁で測った重なりは -63..-41、中点は -52。
  const ins = () => [makeInput({ w0: -100, nz: 30 }), makeInput({ w0: -62, nz: 30, add: 100 })];
  const run = () => {
    const x = ins();
    const g = unionGrid(x);
    return cells(g, stitchToGrid(x, g, { mode: "midpoint" }));
  };

  it("重なりの中点で切れ、混ぜない（中点より手前は 1 本目だけ、奥は 2 本目だけ）", () => {
    const cs = run();
    expect(cs.every((c) => Number.isFinite(c.value))).toBe(true);
    for (const c of cs.filter((c) => c.w >= -62 - 1e-6 && c.w <= -42 + 1e-6)) {
      const expected = c.w < -52 - 1e-6 ? 0 : c.w > -52 + 1e-6 ? 100 : null;
      if (expected !== null) expect(c.value).toBeCloseTo(c.truthV + expected, 3);
      else expect([0, 100].some((e) => Math.abs(c.value - (c.truthV + e)) < 1e-3)).toBe(true); // ちょうど中点はどちらか一方
    }
  });
  it("重なりの外は従来どおり真値（1 本だけが覆う）", () => {
    const cs = run();
    for (const c of cs.filter((c) => c.w < -63)) expect(c.value).toBeCloseTo(c.truthV, 3);
    for (const c of cs.filter((c) => c.w > -41)) expect(c.value).toBeCloseTo(c.truthV + 100, 3);
  });
  it("mean は混ぜる（中点切りが mean と同じ値を返す壊れ方を落とす）", () => {
    const x = ins();
    const g = unionGrid(x);
    const mean = cells(g, stitchToGrid(x, g, BLEND_MEAN));
    const mid = run();
    const k = mean.findIndex((c) => Math.abs(c.w - -56) < 1e-6);
    expect(mean[k].value - mean[k].truthV).toBeCloseTo(50, 3);
    expect(mid[k].value - mid[k].truthV).toBeCloseTo(0, 3);
  });
});

describe("面内の格子が違う入力（連結の再サンプル）", () => {
  /** 面内 nx×ny・間隔 s の入力。線形な真値から切り出す（原点 (ox, oy)、先頭の法線方向位置 w0、nz 枚、スライス間隔 sz）。 */
  function gridInput(o: { nx: number; ny: number; s: number; ox: number; oy: number; w0: number; nz: number; sz: number; add?: number }): StitchInput {
    const f = frame(0);
    const ipp0: [number, number, number] = [o.ox, o.oy, o.w0];
    const data = new Float32Array(o.nx * o.ny * o.nz);
    const v0 = makeVolume(data, [o.nx, o.ny, o.nz], f.iop, ipp0, o.s, o.s, [0, 0, o.sz]);
    const m = v0.indexToWorld;
    for (let k = 0; k < o.nz; k++)
      for (let j = 0; j < o.ny; j++)
        for (let i = 0; i < o.nx; i++) {
          data[k * o.nx * o.ny + j * o.nx + i] =
            truth(m[0] * i + m[1] * j + m[2] * k + m[3], m[4] * i + m[5] * j + m[6] * k + m[7], m[8] * i + m[9] * j + m[10] * k + m[11]) + (o.add ?? 0);
        }
    return { volume: v0, iop: f.iop, modality: "CT", patientId: "P1" };
  }
  // 小さい視野（8×8・1 mm）が手前、大きい視野（8×8・2 mm = 視野 4 倍の面積）が奥。法線方向は 1 mm 間隔で重なり 5 枚。
  const small = () => gridInput({ nx: 8, ny: 8, s: 1, ox: 0, oy: 0, w0: 0, nz: 10, sz: 1 });
  const big = () => gridInput({ nx: 8, ny: 8, s: 2, ox: 0, oy: 0, w0: 5, nz: 10, sz: 1, add: 100 });

  it("共通格子は細かい側の間隔、範囲は 2 つの視野の和集合", () => {
    const g = unionGrid([small(), big()]);
    expect(g.spacing).toEqual([1, 1, 1]);
    expect(g.dims).toEqual([15, 15, 15]); // 大きい視野の中心は 0..14 mm
  });
  it("中点切りで再サンプル: 小さい視野の中は手前=真値、奥=+100。大きい視野だけが覆う所は +100、どちらも覆わない所は NaN", () => {
    const x = [small(), big()];
    const g = unionGrid(x);
    const sl = stitchToGrid(x, g, { mode: "midpoint" });
    const [nx, ny] = g.dims;
    const m = g.indexToWorld;
    let nanCount = 0;
    for (let k = 0; k < g.dims[2]; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const xw = m[0] * i + m[1] * j + m[2] * k + m[3];
          const yw = m[4] * i + m[5] * j + m[6] * k + m[7];
          const zw = m[8] * i + m[9] * j + m[10] * k + m[11];
          const v = sl[k][j * nx + i];
          const inSmall = xw <= 7 + 1e-9 && yw <= 7 + 1e-9 && zw <= 9 + 1e-9;
          const inBig = zw >= 5 - 1e-9; // 面内は 0..14 の全域
          if (!inSmall && !inBig) { expect(Number.isNaN(v)).toBe(true); nanCount++; continue; }
          expect(Number.isNaN(v)).toBe(false);
          // 重なり（zw 5..9）の縁で測った中点は 7（small の縁 9.5、big の縁 4.5 → 中点 7）。
          const useBig = inBig && (!inSmall || zw > 7 + 1e-9);
          const expected = truth(xw, yw, zw) + (useBig ? 100 : 0);
          expect(v).toBeCloseTo(expected, 3);
        }
    expect(nanCount).toBeGreaterThan(0); // 検査の対象（覆われない点）が実在する
  });
  it("位相のずれた格子（粗い側の原点が 0.5 mm ずれる）でも線形な真値を再現する（三線形）", () => {
    const x = [small(), gridInput({ nx: 8, ny: 8, s: 2, ox: 0.5, oy: 0.5, w0: 5, nz: 10, sz: 1 })];
    const g = unionGrid(x);
    const sl = stitchToGrid(x, g, { mode: "midpoint" });
    // 粗い側の面内の縁から半画素以内の点は、端の値の複製（仕様）で線形にならないので、縁（x または y が 0）は除く。
    const [nx, ny] = g.dims;
    const m = g.indexToWorld;
    let checked = 0;
    let worst = 0;
    for (let k = 0; k < g.dims[2]; k++)
      for (let j = 1; j < ny; j++)
        for (let i = 1; i < nx; i++) {
          const v = sl[k][j * nx + i];
          if (Number.isNaN(v)) continue;
          const xw = m[0] * i + m[1] * j + m[2] * k + m[3];
          const yw = m[4] * i + m[5] * j + m[6] * k + m[7];
          const zw = m[8] * i + m[9] * j + m[10] * k + m[11];
          worst = Math.max(worst, Math.abs(v - truth(xw, yw, zw)));
          checked++;
        }
    expect(checked).toBeGreaterThan(0);
    expect(worst).toBeLessThan(EPS * 10);
  });
});
