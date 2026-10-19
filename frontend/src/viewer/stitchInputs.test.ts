/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { buildDerivedVolumeRequest } from "./derivedVolumeSave";
import { makeVolume } from "./regGeometry";
import {
  concatSlices,
  divideInput,
  petInfoFromSuvParams,
  stitchBackground,
  stitchDerivation,
  toStitchInput,
} from "./stitchInputs";
import type { SuvParams } from "./suv";
import { checkStitchInputs, stitchSlices, unionGrid, type StitchGrid, type StitchInput } from "./volumeStitch";

// 真値: 世界座標の 1 次関数（volumeStitch.test.ts と同じ式。入力はここから切り出す）。
const A = 0.5, B = -0.3, C = 0.8, D = 12;
const truth = (x: number, y: number, z: number) => A * x + B * y + C * z + D;
const IOP = [1, 0, 0, 0, 1, 0];
const NX = 12, NY = 10, SZ = 2;

function makeInput(w0: number, add = 0, nz = 10): StitchInput {
  const ipp0: [number, number, number] = [5, -7, w0];
  const data = new Float32Array(NX * NY * nz);
  const vol0 = makeVolume(data, [NX, NY, nz], IOP, ipp0, 1, 1.5, [0, 0, SZ]);
  const m = vol0.indexToWorld;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++)
        data[k * NX * NY + j * NX + i] =
          truth(
            m[0] * i + m[1] * j + m[2] * k + m[3],
            m[4] * i + m[5] * j + m[6] * k + m[7],
            m[8] * i + m[9] * j + m[10] * k + m[11],
          ) + add;
  return { volume: vol0, iop: IOP, modality: "CT", patientId: "P1" };
}

function decode(pixels: string): Int16Array {
  const bin = atob(pixels);
  const u8 = new Uint8Array(bin.length);
  for (let n = 0; n < bin.length; n++) u8[n] = bin.charCodeAt(n);
  return new Int16Array(u8.buffer);
}

/** 結合 → 連結 → 保存要求。要求の値を slope・intercept で戻し、(w, 戻した値, 真値, 格納値) を返す。 */
function viaSave(inputs: StitchInput[], background: number, slicesFn = stitchSlices) {
  const grid: StitchGrid = unionGrid(inputs);
  const data = concatSlices(slicesFn(inputs, grid, "mean"), grid);
  const req = buildDerivedVolumeRequest({
    grid, data, studyUid: "S", seriesUid: "E", seriesDescription: "d",
    derivationDescription: stitchDerivation(["a", "b"], grid), suvScale: null, background,
  });
  const [nx, ny, nz] = grid.dims;
  const m = grid.indexToWorld;
  const cells: Array<{ w: number; back: number; truthV: number; stored: number }> = [];
  for (let k = 0; k < nz; k++) {
    const px = decode(req.frames[k].pixels);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const x = m[0] * i + m[1] * j + m[2] * k + m[3];
        const y = m[4] * i + m[5] * j + m[6] * k + m[7];
        const z = m[8] * i + m[9] * j + m[10] * k + m[11];
        const stored = px[j * nx + i];
        cells.push({ w: z, back: stored * req.rescaleSlope + req.rescaleIntercept, truthV: truth(x, y, z), stored });
      }
  }
  return { grid, req, cells };
}

describe("つなぎ合わせ → 保存要求（正例）", () => {
  it("(a) 重なり 9 枚: IOP・先頭 IPP・枚数・全ボクセルが真値（量子化込みの ε）", () => {
    const b1 = makeInput(-100);
    const b2 = makeInput(-98); // 1 本目の末尾 9 枚と同じ位置
    const { grid, req, cells } = viaSave([b1, b2], -1000);
    expect(grid.overlapMm).toBeCloseTo(18, 6);
    expect(grid.gapMm).toBeCloseTo(0, 6);
    req.imageOrientationPatient.forEach((v, n) => expect(Math.abs(v - IOP[n])).toBeLessThan(1e-6));
    expect(Math.abs(req.frames[0].imagePositionPatient[2] - -100)).toBeLessThan(1e-3);
    const L = -80 - -100;
    expect(req.frames.length).toBe(Math.floor(L / 2 + 1e-9) + 1);
    const eps = (0.01 + req.rescaleSlope) / 2 + 1e-4;
    const err = Math.max(...cells.map((c) => Math.abs(c.back - c.truthV)));
    expect(err).toBeLessThanOrEqual(eps);
  });

  it("(c) 2 本目だけ +100: 重なりは +50、1 本目だけは真値、2 本目だけは +100", () => {
    const { cells, req } = viaSave([makeInput(-100), makeInput(-98, 100)], -1000);
    const eps = (0.01 + req.rescaleSlope) / 2 + 1e-4;
    const add = (w: number) => (w < -98 - 1e-6 ? 0 : w > -82 + 1e-6 ? 100 : 50);
    const err = Math.max(...cells.map((c) => Math.abs(c.back - (c.truthV + add(c.w)))));
    expect(err).toBeLessThanOrEqual(eps);
  });

  it("(c) 検査が効く: 平均を「後勝ち」に差し替えると重なりの検査が落ちる", () => {
    function* lastWins(inputs: readonly StitchInput[], grid: StitchGrid, o: "mean") {
      const mean = [...stitchSlices(inputs, grid, o)];
      const last = [...stitchSlices([inputs[inputs.length - 1]], grid, o)];
      const first = [...stitchSlices([inputs[0]], grid, o)];
      for (let k = 0; k < mean.length; k++) {
        const s = new Float32Array(mean[k]);
        for (let n = 0; n < s.length; n++) s[n] = Number.isNaN(last[k][n]) ? first[k][n] : last[k][n];
        yield s;
      }
    }
    const { cells, req } = viaSave([makeInput(-100), makeInput(-98, 100)], -1000, lastWins);
    const eps = (0.01 + req.rescaleSlope) / 2 + 1e-4;
    const add = (w: number) => (w < -98 - 1e-6 ? 0 : w > -82 + 1e-6 ? 100 : 50);
    const err = Math.max(...cells.map((c) => Math.abs(c.back - (c.truthV + add(c.w)))));
    expect(err).toBeGreaterThan(eps);
  });

  it("(d) 10 mm の隙間: 隙間のボクセルは PixelPaddingValue の格納値", () => {
    const { grid, req, cells } = viaSave([makeInput(-100), makeInput(-70)], -500);
    expect(grid.gapMm).toBeCloseTo(10, 6);
    expect(req.pixelPaddingValue).not.toBeNull();
    const gap = cells.filter((c) => c.w > -81 + 1e-6 && c.w < -71 - 1e-6 && Math.abs(c.w - -82) > 1 + 1e-6 && Math.abs(c.w - -70) > 1 + 1e-6);
    expect(gap.length).toBeGreaterThan(0);
    for (const c of gap) expect(c.stored).toBe(req.pixelPaddingValue);
    const eps = (0.01 + req.rescaleSlope) / 2 + 1e-4;
    const real = cells.filter((c) => c.w <= -82 || c.w >= -70);
    expect(Math.max(...real.map((c) => Math.abs(c.back - c.truthV)))).toBeLessThanOrEqual(eps);
  });
});

describe("入力の組み立て", () => {
  it("toStitchInput は iop・モダリティ・体積をそのまま写す", () => {
    const v = makeInput(0).volume;
    const x = toStitchInput({ volume: v, iop: IOP, modality: "MR" }, "PID");
    expect(x.volume).toBe(v);
    expect(x.iop).toBe(IOP);
    expect(x.modality).toBe("MR");
    expect(x.patientId).toBe("PID");
  });

  it("petInfoFromSuvParams は 5 項目を写す（基準時刻は scanTimeMs）", () => {
    const p = {
      patientSex: "M", radionuclideName: "F18", correctedImage: [], alreadySuv: false,
      decayCorrection: "START", units: "BQML", halfLifeSec: 6586, totalDoseBq: 3e8,
      scanTimeMs: 1000, injectionTimeMs: 5,
    } as SuvParams;
    expect(petInfoFromSuvParams(p)).toEqual({
      decayCorrection: "START", referenceTimeMs: 1000, units: "BQML", halfLifeSec: 6586, totalDoseBq: 3e8,
    });
  });

  it("concatSlices は k 枚目を data[k·nx·ny…] に入れる", () => {
    const g = { dims: [2, 3, 3] as [number, number, number] };
    const out = concatSlices([0, 1, 2].map((k) => new Float32Array(6).fill(k + 1)), g);
    expect(out.length).toBe(18);
    expect(out[0]).toBe(1);
    expect(out[6]).toBe(2);
    expect(out[17]).toBe(3);
  });

  it("divideInput は元を変えずに割る／stitchBackground は有限な最小", () => {
    const x = makeInput(0);
    const before = x.volume.data[5];
    const y = divideInput(x, 2);
    expect(y.volume.data[5]).toBeCloseTo(before / 2, 5);
    expect(x.volume.data[5]).toBe(before);
    const z = makeInput(0);
    z.volume.data[3] = NaN;
    z.volume.data[4] = -777;
    expect(stitchBackground([z])).toBe(-777);
  });

  it("stitchDerivation は全入力の UID を含む", () => {
    const g = unionGrid([makeInput(-100), makeInput(-98)]);
    const s = stitchDerivation(["1.2.9", "1.2.8"], g);
    expect(s).toContain("1.2.9");
    expect(s).toContain("1.2.8");
    expect(s).toContain("mean");
  });
});

describe("負例", () => {
  const pet = (over: object = {}) => ({
    decayCorrection: "START", referenceTimeMs: 1000, units: "BQML", halfLifeSec: 6586, totalDoseBq: 3e8, ...over,
  });
  const petInput = (info: object): StitchInput => ({ ...makeInput(-100), modality: "PT", pet: pet(info) });

  it("scanTimeMs だけが違う PET は petReference で落ちる", () => {
    const mk = (scan: number) =>
      petInfoFromSuvParams({
        patientSex: "M", radionuclideName: "F18", correctedImage: [], alreadySuv: false,
        decayCorrection: "START", units: "BQML", halfLifeSec: 6586, totalDoseBq: 3e8, scanTimeMs: scan,
      } as SuvParams);
    const r = checkStitchInputs([
      { ...makeInput(-100), modality: "PT", pet: mk(1000) },
      { ...makeInput(-98), modality: "PT", pet: mk(61000) },
    ]);
    expect(r.violations).toEqual(["petReference"]);
  });

  it("halfLifeSec が欠けると petReference で落ちる", () => {
    const r = checkStitchInputs([petInput({}), { ...petInput({ halfLifeSec: undefined }), volume: makeInput(-98).volume }]);
    expect(r.violations).toContain("petReference");
  });

  it("concatSlices は枚数の足りない（多い）ジェネレータで例外", () => {
    const g = { dims: [2, 2, 3] as [number, number, number] };
    expect(() => concatSlices([new Float32Array(4), new Float32Array(4)], g)).toThrow();
    expect(() => concatSlices([1, 2, 3, 4].map(() => new Float32Array(4)), g)).toThrow();
    expect(() => concatSlices([1, 2, 3].map(() => new Float32Array(3)), g)).toThrow();
  });

  it("患者・モダリティ・向き違いは理由つきで拒否される", () => {
    const a = makeInput(-100);
    expect(checkStitchInputs([a, { ...makeInput(-98), patientId: "P2" }]).violations).toEqual(["patient"]);
    expect(checkStitchInputs([a, { ...makeInput(-98), modality: "MR" }]).violations).toEqual(["modality"]);
    const t = (5 * Math.PI) / 180;
    expect(
      checkStitchInputs([a, { ...makeInput(-98), iop: [1, 0, 0, 0, Math.cos(t), Math.sin(t)] }]).violations,
    ).toEqual(["orientation"]);
  });
});
