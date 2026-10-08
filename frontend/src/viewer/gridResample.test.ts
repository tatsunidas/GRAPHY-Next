/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { makeVolume, sampleTrilinear } from "./regGeometry";
import {
  checkStitchInputs,
  stitchToGrid,
  unionGrid,
  type StitchGrid,
  type StitchInput,
  type StitchPetInfo,
} from "./gridResample";

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
  fr?: string;
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
    frameOfReferenceUid: o.fr ?? "1.2.3",
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
  it("(a) 重なり 9 枚 × 2.0 mm: 重なり 18.0・隙間 0.0・dims・原点・全ボクセルが真値", () => {
    // 1 本目 w=-100..-100+18 (10 枚), 2 本目は 1 本目の末尾 18 mm と重なる
    const a = makeInput({ w0: -100, nz: 20 }); // -100..-62
    const b = makeInput({ w0: -80, nz: 20 }); // -80..-42 → 重なり -80..-62 = 18
    const g = unionGrid([a, b]);
    expect(g.overlapMm).toBeCloseTo(18.0, 2);
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
    expect(g.overlapMm).toBeCloseTo(18.0, 2);
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

  it("(d) 10 mm の隙間: gapMm 10.0・隙間のボクセルは NaN・他は真値", () => {
    const a = makeInput({ w0: -100, nz: 20 }); // -100..-62
    const b = makeInput({ w0: -52, nz: 20 }); // -52..-14
    const g = unionGrid([a, b]);
    expect(g.gapMm).toBeCloseTo(10.0, 2);
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
  it("FoR が違う → frameOfReference", () => {
    expect(checkStitchInputs([makeInput({ w0: -100 }), makeInput({ w0: -60, fr: "9.9" })]).violations).toEqual(["frameOfReference"]);
  });
  it("FoR が空 → frameOfReference", () => {
    expect(checkStitchInputs([makeInput({ w0: -100, fr: "" }), makeInput({ w0: -60, fr: "" })]).violations).toEqual(["frameOfReference"]);
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
