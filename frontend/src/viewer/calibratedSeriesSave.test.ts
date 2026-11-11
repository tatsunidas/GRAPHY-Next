import { describe, expect, it } from "vitest";
import {
  calibrationUnit,
  describeCalibratedSave,
  gridOfVolume,
  isUniformStack,
  sliceDeviation,
  SLICE_UNIFORM_TOLERANCE,
} from "./calibratedSeriesSave";
import { buildDerivedVolumeRequest } from "./derivedVolumeSave";
import { axisGrid } from "./gridResample";
import { makeVolume } from "./regGeometry";
import type { SuvCalibration } from "./suvStore";

const types: SuvCalibration["type"][] = ["bw", "sul-james", "sul-janma", "bsa", "pid", "suvr"];

describe("calibrationUnit", () => {
  it("6 種の単位コードは 16 文字以内（SH）・`\\` なし。表示名は読み戻しで使う短い名前", () => {
    for (const type of types) {
      const u = calibrationUnit({ type, unit: "x" });
      expect(u.unitCode.length).toBeLessThanOrEqual(16);
      expect(u.unitCode).not.toContain("\\");
      expect(u.unitMeaning.length).toBeGreaterThan(0);
    }
  });
  it("CID 85（PS3.16）にあるものは標準のコードそのまま", () => {
    expect(calibrationUnit({ type: "bw", unit: "" }).unitCode).toBe("g/ml{SUVbw}");
    expect(calibrationUnit({ type: "sul-james", unit: "" }).unitCode).toBe("g/ml{SUVlbm}");
    expect(calibrationUnit({ type: "bsa", unit: "" }).unitCode).toBe("cm2/ml{SUVbsa}");
  });
  it("表示名は校正の単位（unit）と同じで、読み戻しても TLG 等の分岐が変わらない", () => {
    expect(calibrationUnit({ type: "bw", unit: "SUVbw" }).unitMeaning).toBe("SUVbw");
    expect(calibrationUnit({ type: "pid", unit: "%ID/cc" }).unitMeaning).toBe("%ID/cc");
    expect(calibrationUnit({ type: "suvr", unit: "SUVR" }).unitMeaning).toBe("SUVR");
    // James と Janmahasatian は表示名が同じ SUVlbm。コードで区別できる
    expect(calibrationUnit({ type: "sul-james", unit: "" }).unitMeaning).toBe("SUVlbm");
    expect(calibrationUnit({ type: "sul-janma", unit: "" }).unitMeaning).toBe("SUVlbm");
    expect(calibrationUnit({ type: "sul-james", unit: "" }).unitCode).not.toBe(calibrationUnit({ type: "sul-janma", unit: "" }).unitCode);
  });
});

/** 4×3×5 の元。傾き（ガントリチルト）あり: スライスの法線方向と、IPP の進む方向が違う。 */
function tiltedVolume() {
  const dims = [4, 3, 5] as const;
  const data = Float32Array.from({ length: 4 * 3 * 5 }, (_, i) => i * 0.25);
  const iop = [1, 0, 0, 0, Math.cos(0.3), Math.sin(0.3)];
  // 傾いたスタック: 法線は (0, -sin, cos)。スライスは法線ではなく別方向へ 3 mm ずつ進む。
  const step: [number, number, number] = [0.5, 2.0, 2.2];
  return makeVolume(data, dims, iop, [-10, 5, 100], 2.0, 1.5, step);
}

describe("gridOfVolume", () => {
  it("補間しない: dims・アフィンが元と同じで、保存の要求の IOP・IPP・枚数が元の幾何と一致（傾きがあっても）", () => {
    const v = tiltedVolume();
    const g = gridOfVolume(v);
    expect(g.dims).toEqual(v.dims);
    const req = buildDerivedVolumeRequest({
      grid: g, data: v.data, studyUid: "1", seriesUid: "2", seriesDescription: "x", derivationDescription: "y", background: NaN,
      parametricMap: { label: "L", explanation: "E", unitCode: "{SUVR}", unitMeaning: "SUVR" },
    });
    expect(req.frames).toHaveLength(5);
    const m = v.indexToWorld;
    for (let k = 0; k < 5; k++) {
      const want = [m[2] * k + m[3], m[6] * k + m[7], m[10] * k + m[11]];
      req.frames[k].imagePositionPatient.forEach((x, a) => expect(x).toBeCloseTo(want[a], 9));
    }
    [1, 0, 0, 0, Math.cos(0.3), Math.sin(0.3)].forEach((x, a) => expect(req.imageOrientationPatient[a]).toBeCloseTo(x, 12));
    expect(req.pixelSpacing[0]).toBeCloseTo(1.5, 12); // 行間隔
    expect(req.pixelSpacing[1]).toBeCloseTo(2.0, 12); // 列間隔
  });
  it("値はビット同一（Float32 のまま・NaN も残る）で、Rescale・割り戻しは使われない", () => {
    const v = tiltedVolume();
    v.data[7] = NaN;
    const req = buildDerivedVolumeRequest({
      grid: gridOfVolume(v), data: v.data, studyUid: "1", seriesUid: "2", seriesDescription: "x", derivationDescription: "y", background: NaN,
      parametricMap: { label: "L", explanation: "E", unitCode: "%{ID}/ml", unitMeaning: "%ID/cc" },
    });
    expect(req.parametricMap?.unitMeaning).toBe("%ID/cc");
    expect([req.rescaleSlope, req.rescaleIntercept, req.pixelPaddingValue]).toEqual([1, 0, null]);
    const bytes = Uint8Array.from(atob(req.frames[0].pixels), (c) => c.charCodeAt(0));
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < 12; i++) {
      const got = dv.getFloat32(i * 4, true);
      if (Number.isNaN(v.data[i])) expect(got).toBeNaN();
      else expect(got).toBe(v.data[i]);
    }
    expect(Number.isNaN(dv.getFloat32(7 * 4, true))).toBe(true);
  });
  it("負例: axisGrid（法線へ直交化）では、傾きのある元の IPP が元と一致しない", () => {
    const v = tiltedVolume();
    const ax = axisGrid(v, v.spacing);
    const m = v.indexToWorld;
    const want = [m[2] * 1 + m[3], m[6] * 1 + m[7], m[10] * 1 + m[11]];
    const got = [ax.indexToWorld[2] + ax.indexToWorld[3], ax.indexToWorld[6] + ax.indexToWorld[7], ax.indexToWorld[10] + ax.indexToWorld[11]];
    expect(Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2])).toBeGreaterThan(0.1);
  });
  it("スライス間隔は法線への射影", () => {
    const v = tiltedVolume();
    const g = gridOfVolume(v);
    const n = [0, -Math.sin(0.3), Math.cos(0.3)];
    const proj = Math.abs(0.5 * n[0] + 2.0 * n[1] + 2.2 * n[2]);
    expect(g.spacing[2]).toBeCloseTo(proj, 9);
  });
});

describe("sliceDeviation / isUniformStack", () => {
  const v = tiltedVolume();
  const m = v.indexToWorld;
  const ipps = (shift: Record<number, number> = {}) =>
    Array.from({ length: 5 }, (_, k) => ({
      ipp: [m[2] * (k + (shift[k] ?? 0)) + m[3], m[6] * (k + (shift[k] ?? 0)) + m[7], m[10] * (k + (shift[k] ?? 0)) + m[11]] as [number, number, number],
    }));
  it("均一な元は通る", () => {
    expect(sliceDeviation(v, ipps())).toBeLessThan(1e-9);
    expect(isUniformStack(v, ipps())).toBe(true);
  });
  it("負例: 1 枚だけ間隔の 5% ずらした元は断る。許容 0.1% 以内のずれは通る", () => {
    expect(isUniformStack(v, ipps({ 3: 0.05 }))).toBe(false);
    expect(isUniformStack(v, ipps({ 3: SLICE_UNIFORM_TOLERANCE / 2 }))).toBe(true);
  });
  it("枚数が合わなければ断る", () => {
    expect(isUniformStack(v, ipps().slice(0, 4))).toBe(false);
  });
});

describe("describeCalibratedSave", () => {
  it("シリーズ名は 64 文字以内で、末尾の単位は残る", () => {
    const d = describeCalibratedSave({ type: "bw", unit: "SUVbw", scale: 0.00123456789 }, "x".repeat(100));
    expect(d.seriesDescription.length).toBe(64);
    expect(d.seriesDescription.endsWith(" SUVbw")).toBe(true);
    expect(d.derivationDescription).toContain("0.00123457");
  });
  it("SUVR は参照領域（名前・平均・単位・n）を派生の説明に残す", () => {
    const d = describeCalibratedSave(
      { type: "suvr", unit: "SUVR", scale: 0.002, ref: { label: "小脳", mean: 500, unit: "BQML", n: 120 } },
      "PET",
    );
    expect(d.seriesDescription).toBe("PET SUVR");
    expect(d.derivationDescription).toContain("Reference: 小脳 mean 500.000 BQML n=120");
  });
  it("LUT ラベルは SH（16 文字）に入る", () => {
    for (const type of types) expect(describeCalibratedSave({ type, unit: "SUVbw", scale: 1 }, "s").label.length).toBeLessThanOrEqual(16);
  });
});
