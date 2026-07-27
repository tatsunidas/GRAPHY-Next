import { describe, expect, it, vi } from "vitest";
import { computeSuvScale, isSuvError, suvUnitLabel, type SuvParams } from "./suv";

// suv.ts は Cornerstone のメタデータプロバイダとローダを import するが、computeSuvScale は
// それらに触れない純関数。実体をロードすると WebGL/worker 依存が走るのでモックに差し替える。
// （vi.mock は vitest により import より前へ巻き上げられる）
vi.mock("@cornerstonejs/core", () => ({ metaData: { get: () => undefined } }));
vi.mock("@cornerstonejs/dicom-image-loader", () => ({ default: {} }));

/** F-18 FDG・70kg・175cm・370MBq・投与から 1 時間後に撮像、という標準的な PET の条件。 */
function baseParams(over: Partial<SuvParams> = {}): SuvParams {
  return {
    patientWeight: 70,
    patientHeight: 1.75,
    patientSex: "M",
    totalDoseBq: 370e6,
    halfLifeSec: 6586.2,
    radionuclideName: "Fluorine-18",
    injectionTimeMs: Date.UTC(2026, 6, 27, 9, 0, 0),
    scanTimeMs: Date.UTC(2026, 6, 27, 10, 0, 0),
    units: "BQML",
    correctedImage: ["ATTN", "DECY"],
    alreadySuv: false,
    modality: "PT",
    ...over,
  };
}

/** 1 時間崩壊させた 370MBq（Bq）。実装の Math.pow(2, -t/T) とは別式（exp）で独立に検算する。 */
const DECAYED_DOSE_BQ = 370e6 * Math.exp((-Math.LN2 * 3600) / 6586.2);

describe("computeSuvScale", () => {
  it("Units=GML（SUV 化済み）は再校正せず scale=1", () => {
    const r = computeSuvScale(baseParams({ units: "GML" }), "bw");
    if (isSuvError(r)) throw new Error(`unexpected error: ${r.error}`);
    expect(r.scale).toBe(1);
    expect(r.warnings).toContain("alreadySuv");
  });

  it("alreadySuv フラグが立っていれば Units によらず scale=1", () => {
    const r = computeSuvScale(baseParams({ alreadySuv: true }), "bw");
    if (isSuvError(r)) throw new Error(`unexpected error: ${r.error}`);
    expect(r.scale).toBe(1);
  });

  it("BQML の SUVbw は 体重g ÷ 崩壊補正後投与量", () => {
    const r = computeSuvScale(baseParams(), "bw");
    if (isSuvError(r)) throw new Error(`unexpected error: ${r.error}`);
    expect(r.scale).toBeCloseTo(70000 / DECAYED_DOSE_BQ, 12);
    expect(r.unit).toBe("SUVbw");
    expect(r.type).toBe("bw");
    expect(r.warnings).toEqual([]);
  });

  it("SUL(James) の男性係数は 128（OHIF の 120 ではない）", () => {
    const bw = computeSuvScale(baseParams(), "bw");
    const sul = computeSuvScale(baseParams(), "sul-james");
    if (isSuvError(bw) || isSuvError(sul)) throw new Error("unexpected error");
    // LBM = 1.1*70 - 128*(70/175)^2 = 77 - 20.48 = 56.52kg
    expect(sul.scale / bw.scale).toBeCloseTo(56.52 / 70, 10);
    expect(sul.unit).toBe("SUVlbm");
  });

  it("SUL(Janmahasatian) は BMI ベースの別式を使う", () => {
    const bw = computeSuvScale(baseParams(), "bw");
    const sul = computeSuvScale(baseParams(), "sul-janma");
    if (isSuvError(bw) || isSuvError(sul)) throw new Error("unexpected error");
    const bmi = 70 / (1.75 * 1.75);
    const lbm = (9270 * 70) / (6680 + 216 * bmi);
    expect(sul.scale / bw.scale).toBeCloseTo(lbm / 70, 10);
  });

  it("BSA(DuBois) は m^2 を cm^2 に換算して正規化する", () => {
    const r = computeSuvScale(baseParams(), "bsa");
    if (isSuvError(r)) throw new Error(`unexpected error: ${r.error}`);
    const bsaCm2 = 0.007184 * Math.pow(70, 0.425) * Math.pow(175, 0.725) * 10000;
    expect(r.scale).toBeCloseTo(bsaCm2 / DECAYED_DOSE_BQ, 12);
    expect(r.unit).toBe("SUVbsa");
  });

  it("撮像時刻が投与時刻より前なら 24h 補正して警告する（日付欠損の日跨ぎ）", () => {
    const r = computeSuvScale(
      baseParams({
        injectionTimeMs: Date.UTC(2026, 6, 27, 23, 0, 0),
        scanTimeMs: Date.UTC(2026, 6, 27, 0, 0, 0),
      }),
      "bw",
    );
    if (isSuvError(r)) throw new Error(`unexpected error: ${r.error}`);
    expect(r.warnings).toContain("midnightAdjust");
    // 補正後の実効崩壊時間は 1 時間になる。
    expect(r.scale).toBeCloseTo(70000 / DECAYED_DOSE_BQ, 12);
  });

  it("必須属性が欠けていれば計算せずエラーを返す", () => {
    expect(computeSuvScale(baseParams({ totalDoseBq: undefined }), "bw")).toEqual({
      error: "missingDose",
    });
    expect(computeSuvScale(baseParams({ halfLifeSec: undefined }), "bw")).toEqual({
      error: "missingHalfLife",
    });
    expect(computeSuvScale(baseParams({ scanTimeMs: undefined }), "bw")).toEqual({
      error: "missingTime",
    });
    expect(computeSuvScale(baseParams({ injectionTimeMs: undefined }), "bw")).toEqual({
      error: "missingTime",
    });
    expect(computeSuvScale(baseParams({ patientWeight: undefined }), "bw")).toEqual({
      error: "missingWeight",
    });
  });

  it("身長が必要なタイプだけ身長欠損でエラーになる", () => {
    for (const t of ["sul-james", "sul-janma", "bsa"] as const) {
      expect(computeSuvScale(baseParams({ patientHeight: undefined }), t)).toEqual({
        error: "missingHeight",
      });
    }
    expect(isSuvError(computeSuvScale(baseParams({ patientHeight: undefined }), "bw"))).toBe(
      false,
    );
  });

  it("Philips CNTS: SUV Scale Factor があれば直接使い bw に丸める", () => {
    const r = computeSuvScale(
      baseParams({ units: "CNTS", philipsSuvScaleFactor: 0.5 }),
      "bsa",
    );
    if (isSuvError(r)) throw new Error(`unexpected error: ${r.error}`);
    expect(r.scale).toBe(0.5);
    expect(r.type).toBe("bw");
    expect(r.unit).toBe("SUVbw");
    expect(r.warnings).toContain("philipsBwOnly");
  });

  it("Philips CNTS: 私設タグが両方無ければエラー", () => {
    expect(computeSuvScale(baseParams({ units: "CNTS" }), "bw")).toEqual({
      error: "philipsInvalid",
    });
  });

  it("Philips CNTS: ActivityConcentration は標準式に係数を掛ける", () => {
    const plain = computeSuvScale(baseParams(), "bw");
    const cnts = computeSuvScale(
      baseParams({ units: "CNTS", philipsActivityConcScaleFactor: 3 }),
      "bw",
    );
    if (isSuvError(plain) || isSuvError(cnts)) throw new Error("unexpected error");
    expect(cnts.scale).toBeCloseTo(plain.scale * 3, 12);
    expect(cnts.warnings).toContain("philipsActivityConc");
  });
});

describe("suvUnitLabel", () => {
  it("タイプごとの表示単位", () => {
    expect(suvUnitLabel("bw")).toBe("SUVbw");
    expect(suvUnitLabel("sul-james")).toBe("SUVlbm");
    expect(suvUnitLabel("sul-janma")).toBe("SUVlbm");
    expect(suvUnitLabel("bsa")).toBe("SUVbsa");
  });
});

describe("isSuvError", () => {
  it("成功結果とエラー結果を判別する", () => {
    expect(isSuvError({ error: "missingDose" })).toBe(true);
    expect(isSuvError({ scale: 1, unit: "SUVbw", type: "bw", warnings: [] })).toBe(false);
  });
});
