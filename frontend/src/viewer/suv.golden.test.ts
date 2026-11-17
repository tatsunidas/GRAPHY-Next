import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { computeSuvScale, isSuvError, type SuvParams, type SuvType } from "./suv";

// suv.ts は Cornerstone を import するが、computeSuvScale は触れない純関数（suv.test.ts と同じモック）。
vi.mock("@cornerstonejs/core", () => ({ metaData: { get: () => undefined } }));
vi.mock("@cornerstonejs/dicom-image-loader", () => ({ default: {} }));

/**
 * Java（backend の PetSuvCalibration）と共通のテスト値。別に書いた Python の参照
 * （automator/src/spike/suvGoldenReference.py）が作る。2 つの実装が同じ値になることを保つ。
 */
interface GoldenCase {
  name: string;
  type: SuvType;
  params: Record<string, number | string | boolean | null>;
  expected: { scale?: number; unit?: string; type?: string; warnings?: string[]; error?: string };
}
const golden = JSON.parse(
  readFileSync(resolve(__dirname, "../../../backend/src/test/resources/radiomics/suv-golden.json"), "utf8"),
) as { tolerance: number; cases: GoldenCase[] };

function paramsOf(p: GoldenCase["params"]): SuvParams {
  const n = (k: string) => (p[k] == null ? undefined : (p[k] as number));
  return {
    patientWeight: n("patientWeight"),
    patientHeight: n("patientHeight"),
    patientSex: p.patientSex == null ? undefined : (p.patientSex as "M" | "F"),
    totalDoseBq: n("totalDoseBq"),
    halfLifeSec: n("halfLifeSec"),
    radionuclideName: "test",
    injectionTimeMs: n("injectionTimeMs"),
    scanTimeMs: n("scanTimeMs"),
    units: p.units == null ? undefined : (p.units as string),
    correctedImage: [],
    decayCorrection: p.decayCorrection == null ? undefined : (p.decayCorrection as string),
    philipsSuvScaleFactor: n("philipsSuvScaleFactor"),
    philipsActivityConcScaleFactor: n("philipsActivityConcScaleFactor"),
    alreadySuv: p.alreadySuv === true,
    modality: "PT",
  };
}

describe("computeSuvScale: Java と共通のテスト値（独立の Python の参照）", () => {
  it("ケースが実在する（空の比較で通らない）", () => {
    expect(golden.cases.filter((c) => c.expected.error === undefined).length).toBeGreaterThanOrEqual(15);
    expect(golden.cases.filter((c) => c.expected.error !== undefined).length).toBeGreaterThanOrEqual(10);
  });

  for (const c of golden.cases) {
    it(c.name, () => {
      const r = computeSuvScale(paramsOf(c.params), c.type);
      if (c.expected.error !== undefined) {
        expect(isSuvError(r)).toBe(true);
        if (isSuvError(r)) expect(r.error).toBe(c.expected.error);
      } else {
        if (isSuvError(r)) throw new Error(`unexpected error: ${r.error}`);
        const e = c.expected.scale as number;
        expect(Math.abs(r.scale - e)).toBeLessThanOrEqual(Math.abs(e) * golden.tolerance);
        expect(r.unit).toBe(c.expected.unit);
        expect(r.type).toBe(c.expected.type);
        expect(r.warnings).toEqual(c.expected.warnings);
      }
    });
  }
});
