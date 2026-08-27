/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { csvValueUnit, roiStatsCsvBlobText, roiStatsToCsv, type RoiStatsCsvRow } from "./roiStatsCsv";
import type { RoiStatsResult } from "./roiStats";

const stats = (over: Partial<RoiStatsResult> = {}): RoiStatsResult => ({
  roiUid: "u",
  tool: "RectangleROI",
  imageId: "wadouri:http://localhost:1/api/studies/1/instances/1.2.3/file",
  geometry: {
    kind: "area",
    areaMm2: 12.5,
    areaPx2: 50,
    perimeterMm: 14,
    perimeterPx: 28,
    longAxisMm: 5,
    shortAxisMm: 3,
    sampleCount: 138,
    spatiallyCalibrated: true,
  },
  values: {
    n: 138,
    mean: 43.2,
    sd: 11.8,
    min: 12,
    max: 88,
    median: 42,
    sum: 5961.6,
    p5: 20,
    p95: 70,
    skewness: 0.1,
    kurtosis: -0.2,
    entropy: 4.2,
    unit: "HU",
  },
  computedAt: 0,
  warnings: [],
  ...over,
});

const row = (over: Partial<RoiStatsCsvRow> = {}): RoiStatsCsvRow => ({
  index: 1,
  label: "肝S6",
  tool: "RectangleROI",
  stats: stats(),
  ...over,
});

const parse = (csv: string) => csv.split("\r\n").map((l) => l.split(","));

describe("csvValueUnit", () => {
  it("単一なら単位を返す", () => {
    expect(csvValueUnit([row()])).toBe("HU");
  });

  it("混在なら列名に埋め込まない（'mixed'）", () => {
    const suv = stats({ values: { ...stats().values!, unit: "SUVbw" } });
    expect(csvValueUnit([row(), row({ stats: suv })])).toBe("mixed");
  });

  it("統計が無ければ空", () => {
    expect(csvValueUnit([row({ stats: undefined })])).toBe("");
  });
});

describe("roiStatsToCsv", () => {
  it("単位を列名に入れる（セルは数値のまま）", () => {
    const [header, data] = parse(roiStatsToCsv([row()]));
    expect(header).toContain("mean[HU]");
    expect(header).toContain("area[mm2]");
    expect(data[header.indexOf("mean[HU]")]).toBe("43.2"); // 単位は混ざらない
  });

  it("面積と使用画素数を別の列で出す（同じ量ではない）", () => {
    const [header, data] = parse(roiStatsToCsv([row()]));
    expect(data[header.indexOf("area[mm2]")]).toBe("12.5");
    expect(data[header.indexOf("samples")]).toBe("138");
  });

  it("出せない値は空セル（0 で埋めない）", () => {
    const open = stats({
      geometry: { kind: "line", perimeterMm: 38.6, perimeterPx: 77, sampleCount: 78, spatiallyCalibrated: true },
    });
    const [header, data] = parse(roiStatsToCsv([row({ stats: open })]));
    expect(data[header.indexOf("area[mm2]")]).toBe("");
    expect(data[header.indexOf("perimeter")]).toBe("38.6");
    expect(data[header.indexOf("lengthUnit")]).toBe("mm");
  });

  it("未校正では lengthUnit が px になる", () => {
    const uncal = stats({
      geometry: { kind: "area", areaPx2: 50, perimeterPx: 28, sampleCount: 138, spatiallyCalibrated: false },
    });
    const [header, data] = parse(roiStatsToCsv([row({ stats: uncal })]));
    expect(data[header.indexOf("lengthUnit")]).toBe("px");
    expect(data[header.indexOf("area[mm2]")]).toBe("");
    expect(data[header.indexOf("area[px2]")]).toBe("50");
  });

  it("統計が無い ROI も行としては出す（番号がずれない）", () => {
    const lines = parse(roiStatsToCsv([row(), row({ index: 2, stats: undefined })]));
    expect(lines.length).toBe(3);
    expect(lines[2][0]).toBe("2");
  });

  it("列は種別によらず固定（縦に並べたときに列がずれない）", () => {
    const open = stats({ geometry: { kind: "line", perimeterMm: 5, sampleCount: 10, spatiallyCalibrated: true } });
    const lines = parse(roiStatsToCsv([row(), row({ index: 2, stats: open })]));
    expect(lines[1].length).toBe(lines[0].length);
    expect(lines[2].length).toBe(lines[0].length);
  });

  it("カンマ・引用符・改行を含むラベルをエスケープする", () => {
    const csv = roiStatsToCsv([row({ label: 'a,b "c"\nd' })]);
    expect(csv).toContain('"a,b ""c""\nd"');
    // エスケープしたセル内の改行で行数が増えないこと（引用の中）。
    expect(csv.split("\r\n").length).toBe(2);
  });

  it("警告も列に出す（なぜ空なのかを CSV だけで追える）", () => {
    const bad = stats({ values: undefined, warnings: ["no-spacing", "no-pixels"] });
    const [header, data] = parse(roiStatsToCsv([row({ stats: bad })]));
    expect(data[header.indexOf("warnings")]).toBe("no-spacing no-pixels");
  });
});

describe("roiStatsCsvBlobText", () => {
  it("Excel 用に BOM を付ける", () => {
    expect(roiStatsCsvBlobText([row()]).charCodeAt(0)).toBe(0xfeff);
  });
});
