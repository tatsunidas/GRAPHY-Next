/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { RoiFeatureResult, RoiFeatureRow } from "../api";
import { roiFeatureDataCsv, roiFeatureDefinitionsCsv, roiFeatureFileBase } from "./roiFeatureCsv";

const row = (column: string, value: number | null, over: Partial<RoiFeatureRow> = {}): RoiFeatureRow => {
  const us = column.indexOf("_");
  return {
    column,
    family: column.slice(0, us),
    feature: column.slice(us + 1),
    ibsi: "ABCD",
    value,
    notes: [],
    ...over,
  };
};

const result = (rows: RoiFeatureRow[], fixedBinNumber = true): RoiFeatureResult => ({
  radiomicsjVersion: "2.4.1",
  computedAt: "2026-10-18T05:03:00Z",
  fromCache: false,
  label: 1,
  rows,
  discretisation: { fixedBinNumber, nBins: 32, binWidth: 25, ivhMode: 0, ivhBinCount: 1000, ivhBinWidth: 2.5 },
});

/** 引用付きの 1 行を RFC 4180 で分ける（試験用）。 */
function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** データ表を「列名 → 数値」に読み戻す。 */
function readBack(csv: string): Map<string, number> {
  const [h, v] = csv.split("\r\n");
  const names = splitRow(h);
  const values = splitRow(v);
  return new Map(names.map((n, i) => [n, Number(values[i])]));
}

/** 読み戻した値が結果の行と全列で一致するか（Object.is で NaN と -0 も区別する）。 */
function matches(csv: string, rows: RoiFeatureRow[]): boolean {
  const m = readBack(csv);
  return m.size === rows.length && rows.every((r) => Object.is(m.get(r.column), r.value ?? NaN));
}

const sample = [
  row("Diagnostics_NumberOfVoxels", 605, { ibsi: null }),
  row("IntensityBasedStatistical_Kurtosis", -1.2345678901234567, { notes: ["EXCESS_KURTOSIS"] }),
  row("IntensityHistogram_Entropy", 0.1 + 0.2, { notes: ["LOG2_DISCRETISED"] }),
  row("IntensityVolumeHistogram_AreaUnderTheIVHCurve", 1e-300),
  row("GLCM_JointMaximum", 123456789.125),
  row("Morphology_VolumeMesh", 5644.8),
  row("Fractal_Capacity", null, { ibsi: null, notes: ["NON_IBSI"] }),
];

describe("roiFeatureDataCsv", () => {
  it("1 行目が列名、2 行目が値で、列名と並びは結果のまま", () => {
    const csv = roiFeatureDataCsv(result(sample));
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3); // 末尾の改行で空の 3 つ目
    expect(lines[2]).toBe("");
    expect(splitRow(lines[0])).toEqual(sample.map((r) => r.column));
    expect(splitRow(lines[1])).toHaveLength(sample.length);
  });

  it("読み戻すと全列で値の差 0（倍精度の往復、NaN は NaN）", () => {
    const csv = roiFeatureDataCsv(result(sample));
    expect(matches(csv, sample)).toBe(true);
    expect(csv.split("\r\n")[1].split(",")).toContain("NaN");
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("負例: 値の並びを入れ替えた CSV は同じ比較で不一致になる", () => {
    const csv = roiFeatureDataCsv(result(sample));
    const [h, v] = csv.split("\r\n");
    const swapped = v.split(",");
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    expect(matches(`${h}\r\n${swapped.join(",")}\r\n`, sample)).toBe(false);
  });

  it("列名に , や \" があっても列がずれない", () => {
    const odd = [row('X_a,b "c"', 1), row("Y_d", 2)];
    const csv = roiFeatureDataCsv(result(odd));
    expect(splitRow(csv.split("\r\n")[0])).toEqual(['X_a,b "c"', "Y_d"]);
    expect(matches(csv, odd)).toBe(true);
  });
});

describe("roiFeatureDefinitionsCsv", () => {
  const defs = (rows: RoiFeatureRow[], fixed = true) =>
    roiFeatureDefinitionsCsv(result(rows, fixed)).split("\r\n").filter((l) => l).map(splitRow);

  it("列は column,family,feature,ibsi,notes,discretisation で、行はデータ表の列と同じ並び", () => {
    const t = defs(sample);
    expect(t[0]).toEqual(["column", "family", "feature", "ibsi", "notes", "discretisation"]);
    expect(t.slice(1).map((r) => r[0])).toEqual(sample.map((r) => r.column));
  });

  it("IBSI 外は空、注記は符号、離散化は使う族にだけ付く", () => {
    const by = new Map(defs(sample).slice(1).map((r) => [r[0], r]));
    expect(by.get("Fractal_Capacity")?.slice(3)).toEqual(["", "NON_IBSI", ""]);
    expect(by.get("Diagnostics_NumberOfVoxels")?.[3]).toBe("");
    expect(by.get("IntensityBasedStatistical_Kurtosis")?.slice(4)).toEqual(["EXCESS_KURTOSIS", ""]);
    expect(by.get("IntensityHistogram_Entropy")?.slice(4)).toEqual(["LOG2_DISCRETISED", "fixedBinNumber=32"]);
    expect(by.get("GLCM_JointMaximum")?.[5]).toBe("fixedBinNumber=32");
    expect(by.get("IntensityVolumeHistogram_AreaUnderTheIVHCurve")?.[5])
      .toBe("ivhMode=0;ivhBinCount=1000;ivhBinWidth=2.5");
    expect(by.get("Morphology_VolumeMesh")?.[5]).toBe("");
  });

  it("ビン幅のときはビン幅を書く", () => {
    const by = new Map(defs(sample, false).slice(1).map((r) => [r[0], r]));
    expect(by.get("GLCM_JointMaximum")?.[5]).toBe("binWidth=25");
  });

  it("注記が 2 つなら ; でつなぐ", () => {
    const t = defs([row("GLAM_X", 1, { ibsi: null, notes: ["NON_IBSI", "EXCESS_KURTOSIS"] })]);
    expect(t[1][4]).toBe("NON_IBSI;EXCESS_KURTOSIS");
  });
});

describe("roiFeatureFileBase", () => {
  it("シリーズ番号とセグメントを入れ、無ければ roi", () => {
    expect(roiFeatureFileBase(3, 0)).toBe("roi-features-3-seg0");
    expect(roiFeatureFileBase(null, 2)).toBe("roi-features-roi-seg2");
    expect(roiFeatureFileBase("a/b", 1)).toBe("roi-features-a_b-seg1");
  });
});
