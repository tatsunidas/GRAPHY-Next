/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  formatArea,
  formatLength,
  formatMeanSd,
  formatNumber,
  formatValue,
  roiStatsSummary,
  roiStatsTextLines,
  valueUnitLabel,
} from "./roiStatsText";
import type { RoiStatsResult, RoiValueStats } from "./roiStats";

/** テストでは辞書に依存せず、キーをそのまま返す `t`（整形の検査に集中する）。 */
const t = (key: string) => (key === "roiStats.unit.raw" ? "(raw)" : key.replace("roiStats.", ""));

const values = (over: Partial<RoiValueStats> = {}): RoiValueStats => ({
  n: 138,
  mean: 43.21,
  sd: 11.83,
  min: 12,
  max: 88,
  median: 42,
  sum: 5963,
  p5: 20,
  p95: 70,
  skewness: 0.1,
  kurtosis: -0.2,
  entropy: 4.2,
  unit: "HU",
  ...over,
});

const result = (over: Partial<RoiStatsResult> = {}): RoiStatsResult => ({
  roiUid: "u",
  tool: "RectangleROI",
  imageId: "wadouri:x",
  geometry: {
    kind: "area",
    areaMm2: 12.44,
    areaPx2: 49.76,
    perimeterMm: 14.2,
    perimeterPx: 28.4,
    longAxisMm: 5.12,
    shortAxisMm: 3.04,
    sampleCount: 138,
    spatiallyCalibrated: true,
  },
  values: values(),
  computedAt: 0,
  warnings: [],
  ...over,
});

describe("formatNumber", () => {
  it("桁に応じて短くする", () => {
    expect(formatNumber(1234.5)).toBe("1235");
    expect(formatNumber(43.21)).toBe("43.21");
    expect(formatNumber(43.2)).toBe("43.2");
    expect(formatNumber(43)).toBe("43");
    expect(formatNumber(0)).toBe("0");
  });

  it("1 未満は有効数字で残す（SUV を 0 に潰さない）", () => {
    // 0.0421 を小数 2 桁に丸めると 0.04 になり、SUV の議論ができなくなる。
    expect(formatNumber(0.0421)).toBe("0.0421");
    expect(formatNumber(0.5)).toBe("0.5");
  });

  it("非有限値はダッシュ", () => {
    expect(formatNumber(NaN)).toBe("—");
    expect(formatNumber(Infinity)).toBe("—");
  });
});

describe("単位の扱い", () => {
  it("raw は「未校正」と分かる表記にする（数字だけ出さない）", () => {
    expect(valueUnitLabel("raw", t)).toBe("(raw)");
    expect(formatValue(12.5, "raw", t)).toBe("12.5 (raw)");
  });

  it("単位不明（空文字）は何も付けない", () => {
    expect(formatValue(12.5, "", t)).toBe("12.5");
  });

  it("SUV はそのまま出る", () => {
    expect(formatMeanSd(values({ mean: 4.2, sd: 1.1, unit: "SUVbw" }), t)).toBe("4.2 ± 1.1 SUVbw");
  });
});

describe("面積・長さ", () => {
  it("mm があれば mm、無ければ px と明示する（mm を捏造しない）", () => {
    expect(formatArea(result())).toBe("12.44 mm²");
    const uncal = result({
      geometry: { kind: "area", areaPx2: 49.76, perimeterPx: 28.4, sampleCount: 138, spatiallyCalibrated: false },
    });
    expect(formatArea(uncal)).toBe("49.76 px²");
    expect(formatLength(uncal)).toBe("28.4 px");
  });

  it("面積が無ければ null", () => {
    expect(
      formatArea(result({ geometry: { kind: "line", perimeterMm: 10, sampleCount: 20, spatiallyCalibrated: true } })),
    ).toBeNull();
  });
});

describe("roiStatsTextLines", () => {
  it("compact は 2 行（面積と平均±SD）", () => {
    const lines = roiStatsTextLines(result(), "compact", t);
    expect(lines).toEqual(["area: 12.44 mm²", "mean: 43.21 ± 11.83 HU"]);
  });

  it("full は最小・最大・中央値・画素数・周囲長・長径×短径も出す", () => {
    const lines = roiStatsTextLines(result(), "full", t);
    expect(lines[0]).toBe("area: 12.44 mm²");
    expect(lines).toContain("min: 12 HU");
    expect(lines).toContain("max: 88 HU");
    expect(lines).toContain("median: 42 HU");
    expect(lines).toContain("n: 138");
    expect(lines).toContain("perimeter: 14.2 mm");
    expect(lines).toContain("axes: 5.12 mm × 3.04 mm");
  });

  it("開いた ROI は長さ＋画素統計（面積は出さない）", () => {
    const open = result({
      tool: "GraphyPolylineROI",
      geometry: { kind: "line", perimeterMm: 38.6, perimeterPx: 77.2, sampleCount: 78, spatiallyCalibrated: true },
    });
    const lines = roiStatsTextLines(open, "compact", t);
    expect(lines).toEqual(["length: 38.6 mm", "mean: 43.21 ± 11.83 HU"]);
  });

  it("プローブは値だけ", () => {
    const point = result({
      tool: "Probe",
      geometry: { kind: "point", sampleCount: 1, spatiallyCalibrated: true },
      values: values({ n: 1, mean: -102, sd: 0 }),
    });
    expect(roiStatsTextLines(point, "compact", t)).toEqual(["-102 HU"]);
  });

  it("統計がまだ無ければ幾何だけ出す（'—' を並べない）", () => {
    const geomOnly = result({ values: undefined });
    expect(roiStatsTextLines(geomOnly, "compact", t)).toEqual(["area: 12.44 mm²"]);
  });

  it("計測できないツール・未計算では空（既存ラベルを消す判断はここでしない）", () => {
    expect(roiStatsTextLines(undefined, "full", t)).toEqual([]);
    const none = result({ geometry: { kind: "none", sampleCount: 0, spatiallyCalibrated: true }, values: undefined });
    expect(roiStatsTextLines(none, "full", t)).toEqual([]);
  });
});

describe("roiStatsSummary", () => {
  it("隅一覧の 1 行", () => {
    expect(roiStatsSummary(result(), t)).toBe("12.44 mm²  43.21 ± 11.83 HU");
  });

  it("統計が無ければサイズだけ", () => {
    expect(roiStatsSummary(result({ values: undefined }), t)).toBe("12.44 mm²");
  });

  it("未計算・対象外は空", () => {
    expect(roiStatsSummary(undefined, t)).toBe("");
  });
});
