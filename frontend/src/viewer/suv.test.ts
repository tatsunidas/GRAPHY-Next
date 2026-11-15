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

describe("computeSuvScale 性別が不明のとき（推測で埋めない）", () => {
  for (const type of ["sul-james", "sul-janma"] as const) {
    it(`${type}: 性別が未設定なら missingSex。M・F を明示すれば値が出て、F の scale は M より小さい`, () => {
      const none = computeSuvScale(baseParams({ patientSex: undefined }), type);
      expect(isSuvError(none) && none.error).toBe("missingSex");
      const m = computeSuvScale(baseParams({ patientSex: "M" }), type);
      const f = computeSuvScale(baseParams({ patientSex: "F" }), type);
      if (isSuvError(m) || isSuvError(f)) throw new Error("unexpected error");
      // scale ∝ LBM / 投与量。同じ体重・身長では女性の LBM は男性より小さい。
      expect(f.scale).toBeLessThan(m.scale);
    });
  }
  it("SUVbw・SUVbsa・%ID/cc は性別を使わないので、未設定でも値が出て、M と同じ", () => {
    for (const type of ["bw", "bsa", "pid"] as const) {
      const none = computeSuvScale(baseParams({ patientSex: undefined }), type);
      const m = computeSuvScale(baseParams({ patientSex: "M" }), type);
      if (isSuvError(none) || isSuvError(m)) throw new Error(`unexpected error: ${type}`);
      expect(none.scale).toBe(m.scale);
    }
  });
});

describe("computeSuvScale %ID/cc", () => {
  it("scale = 100 ÷ 崩壊補正後投与量、単位 %ID/cc（体重・身長は不要）", () => {
    const r = computeSuvScale(baseParams({ patientWeight: undefined, patientHeight: undefined }), "pid");
    if (isSuvError(r)) throw new Error(`unexpected error: ${r.error}`);
    expect(Math.abs(r.scale / (100 / DECAYED_DOSE_BQ) - 1)).toBeLessThan(1e-9);
    expect(r.unit).toBe("%ID/cc");
    expect(r.type).toBe("pid");
  });

  it("SUVbw では体重なしが missingWeight、pid は成功（負例と正例）", () => {
    const p = baseParams({ patientWeight: undefined });
    expect(computeSuvScale(p, "bw")).toEqual({ error: "missingWeight" });
    expect(isSuvError(computeSuvScale(p, "pid"))).toBe(false);
  });

  it("体重があれば pid = SUVbw × 100 ÷ 体重g（検算）", () => {
    const bw = computeSuvScale(baseParams(), "bw");
    const pid = computeSuvScale(baseParams(), "pid");
    if (isSuvError(bw) || isSuvError(pid)) throw new Error("unexpected error");
    expect(Math.abs(pid.scale / ((bw.scale * 100) / 70000) - 1)).toBeLessThan(1e-12);
  });

  it("投与量 0・半減期なし・時刻なしは従来どおりエラー", () => {
    expect(computeSuvScale(baseParams({ totalDoseBq: 0 }), "pid")).toEqual({ error: "missingDose" });
    expect(computeSuvScale(baseParams({ halfLifeSec: undefined }), "pid")).toEqual({ error: "missingHalfLife" });
    expect(computeSuvScale(baseParams({ scanTimeMs: undefined }), "pid")).toEqual({ error: "missingTime" });
  });

  it("GML（SUV 化済み）は pid を作らない", () => {
    expect(computeSuvScale(baseParams({ units: "GML" }), "pid")).toEqual({ error: "alreadySuvNoPid" });
  });

  it("Philips CNTS: (7053,1000) だけなら pid はエラー、(7053,1009) があれば成功", () => {
    const only1000 = baseParams({ units: "CNTS", philipsSuvScaleFactor: 0.5 });
    expect(computeSuvScale(only1000, "pid")).toEqual({ error: "philipsPidUnsupported" });
    const r = computeSuvScale(baseParams({ units: "CNTS", philipsActivityConcScaleFactor: 2 }), "pid");
    if (isSuvError(r)) throw new Error(`unexpected error: ${r.error}`);
    expect(Math.abs(r.scale / ((100 / DECAYED_DOSE_BQ) * 2) - 1)).toBeLessThan(1e-9);
  });
});

describe("computeSuvScale DecayCorrection（画素値の補正時刻）", () => {
  // 濃度 3500 Bq/mL・体重 70 kg・投与量 3.5e8 Bq。真値は手計算。
  const dose = 3.5e8;
  const conc = 3500;
  const sameDay = { totalDoseBq: dose, halfLifeSec: 6586.2 };
  const bw = (over: Partial<SuvParams>) => {
    const r = computeSuvScale(baseParams({ ...sameDay, ...over }), "bw");
    if (isSuvError(r)) throw new Error(`unexpected error: ${r.error}`);
    return r;
  };

  it("ADMIN: 投与量を減衰させない。SUVbw = 濃度 × 体重(g) ÷ 投与量 = 0.7", () => {
    const r = bw({ decayCorrection: "ADMIN" });
    expect(r.scale * conc).toBeCloseTo((conc * 70000) / dose, 9);
    expect(r.scale * conc).toBeCloseTo(0.7, 9);
    expect(r.warnings).toContain("decayAdmin");
  });

  it("START: 従来どおり、投与量を 3600 秒・半減期 6586.2 秒で減衰させる（ADMIN との比 2^(3600/6586.2)）", () => {
    const start = bw({ decayCorrection: "START" });
    const admin = bw({ decayCorrection: "ADMIN" });
    expect(start.scale / admin.scale).toBeCloseTo(Math.pow(2, 3600 / 6586.2), 9);
    expect(start.scale * conc).toBeCloseTo(0.7 * Math.exp((Math.LN2 * 3600) / 6586.2), 9);
    expect(start.warnings).not.toContain("decayAdmin");
  });

  it("未指定・NONE は START と同じ近似（NONE は記録だけ残す）", () => {
    const start = bw({ decayCorrection: "START" });
    expect(bw({ decayCorrection: undefined }).scale).toBe(start.scale);
    const none = bw({ decayCorrection: "NONE" });
    expect(none.scale).toBe(start.scale);
    expect(none.warnings).toContain("decayNone");
  });

  it("大文字小文字・前後の空白を無視する", () => {
    expect(bw({ decayCorrection: "admin" }).scale).toBe(bw({ decayCorrection: "ADMIN" }).scale);
    expect(bw({ decayCorrection: " ADMIN " }).scale).toBe(bw({ decayCorrection: "ADMIN" }).scale);
  });

  it("ADMIN は投与時刻・スキャン時刻が無くても計算できる（START は missingTime）", () => {
    const noTime = { injectionTimeMs: undefined, scanTimeMs: undefined };
    expect(bw({ decayCorrection: "ADMIN", ...noTime }).scale * conc).toBeCloseTo(0.7, 9);
    const r = computeSuvScale(baseParams({ ...sameDay, ...noTime, decayCorrection: "START" }), "bw");
    expect(isSuvError(r) && r.error).toBe("missingTime");
  });

  it("SUL（James）・SUVbsa・%ID/cc も ADMIN では減衰させない", () => {
    for (const type of ["sul-james", "bsa", "pid"] as const) {
      const a = computeSuvScale(baseParams({ ...sameDay, decayCorrection: "ADMIN" }), type);
      const s = computeSuvScale(baseParams({ ...sameDay, decayCorrection: "START" }), type);
      if (isSuvError(a) || isSuvError(s)) throw new Error("unexpected error");
      expect(s.scale / a.scale).toBeCloseTo(Math.pow(2, 3600 / 6586.2), 9);
    }
  });

  it("負例: ADMIN を START と同じ式で計算すると 1.46 倍高く出る（旧式。検査が効いている）", () => {
    const old = (conc * 70000) / (dose * Math.pow(2, -3600 / 6586.2));
    expect(old / 0.7).toBeCloseTo(1.4608, 3);
    expect(bw({ decayCorrection: "ADMIN" }).scale * conc).not.toBeCloseTo(old, 2);
  });
});

describe("suvUnitLabel", () => {
  it("タイプごとの表示単位", () => {
    expect(suvUnitLabel("bw")).toBe("SUVbw");
    expect(suvUnitLabel("sul-james")).toBe("SUVlbm");
    expect(suvUnitLabel("sul-janma")).toBe("SUVlbm");
    expect(suvUnitLabel("bsa")).toBe("SUVbsa");
    expect(suvUnitLabel("pid")).toBe("%ID/cc");
  });
});

describe("isSuvError", () => {
  it("成功結果とエラー結果を判別する", () => {
    expect(isSuvError({ error: "missingDose" })).toBe(true);
    expect(isSuvError({ scale: 1, unit: "SUVbw", type: "bw", warnings: [] })).toBe(false);
  });
});
