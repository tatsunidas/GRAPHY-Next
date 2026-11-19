/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";

import { advancedToText, managedKeys, parseAdvanced, valueMatches, type SettingSchemaEntry } from "./advancedSettings";
import { ROI_FEATURE_FAMILIES, defaultRoiFeatureForm, roiFeatureSettings } from "./roiFeatureSettings";

const SCHEMA: SettingSchemaEntry[] = [
  { key: "INT_deltaGLCM", type: "int", defaultValue: "1" },
  { key: "DOUBLE_zScore", type: "double", defaultValue: "3.0" },
  { key: "BOOL_removeOutliers", type: "boolean", defaultValue: "0" },
  { key: "STRING_weightingNorm", type: "string", defaultValue: "" },
  { key: "DOUBLEARRAY_resamplingFactorXYZ", type: "array", defaultValue: null },
  { key: "INT_binCount", type: "int", defaultValue: "32" },
  { key: "INTARRAY_box_sizes", type: "array", defaultValue: "2,3,4" },
];

describe("parseAdvanced", () => {
  it("reads KEY=value lines, ignoring blanks, comments and spaces", () => {
    const r = parseAdvanced("# note\n\n  INT_deltaGLCM = 2 \n! another\nDOUBLE_zScore=2.5\r\n", SCHEMA);
    expect(r.errors).toEqual([]);
    expect(r.entries).toEqual({ INT_deltaGLCM: "2", DOUBLE_zScore: "2.5" });
  });

  it("refuses, with the line number and a reason, what cannot be accepted (negative)", () => {
    const r = parseAdvanced([
      "INT_deltaGLCM",                 // 1: no '='
      "INT_deltaGLCM=2",               // 2: ok
      "INT_deltaGLCM=3",               // 3: duplicate
      "INT_binCount=5",                // 4: managed by the discretisation field
      "BOGUS_key=1",                   // 5: unknown
      "DOUBLE_zScore=abc",             // 6: bad value
      "bad key=1",                     // 7: bad key
      "BOOL_removeOutliers=yes",       // 8: bad boolean
    ].join("\n"), SCHEMA);
    expect(r.entries).toEqual({ INT_deltaGLCM: "2" });
    expect(r.errors.map((e) => [e.line, e.code, e.detail])).toEqual([
      [1, "format", undefined], [3, "duplicate", undefined], [4, "managed", "discretisation"],
      [5, "unknown", undefined], [6, "value", "double"], [7, "format", undefined], [8, "value", "boolean"],
    ]);
  });

  it("without a schema it checks the form, the duplicates and the keys of the other fields only", () => {
    const r = parseAdvanced("BOGUS_key=1\nDOUBLEARRAY_resamplingFactorXYZ=1,1,1\nINT_label=2");
    expect(r.entries).toEqual({ BOGUS_key: "1" });
    expect(r.errors.map((e) => [e.key, e.detail])).toEqual([["DOUBLEARRAY_resamplingFactorXYZ", "resampling"], ["INT_label", "backend"]]);
  });

  it("checks the value of each type", () => {
    expect(valueMatches("int", "-3") && !valueMatches("int", "3.5") && !valueMatches("int", "")).toBe(true);
    expect(valueMatches("double", "1e-3") && !valueMatches("double", "NaNx")).toBe(true);
    expect(valueMatches("boolean", "TRUE") && valueMatches("boolean", "0") && !valueMatches("boolean", "2")).toBe(true);
    expect(valueMatches("array", "1,2.5, 3") && !valueMatches("array", "1,,2")).toBe(true);
  });

  it("round-trips through the text (sorted by key)", () => {
    expect(advancedToText({ INT_deltaGLCM: "2", DOUBLE_zScore: "2.5" })).toBe("DOUBLE_zScore=2.5\nINT_deltaGLCM=2");
  });
});

describe("the keys of the other fields", () => {
  it("every key that roiFeatureSettings writes for the other fields is refused here (no drift)", () => {
    const emitted = new Set<string>();
    const forms = [
      defaultRoiFeatureForm(),
      { ...defaultRoiFeatureForm(), fixedBinNumber: false, resampleMm: 2, rangeMinText: "-100", rangeMaxText: "400" },
      { ...defaultRoiFeatureForm(), logOn: true, logByRadius: false, logSigmaMm: "1.5, 2" },
    ];
    for (const f of forms) for (const k of Object.keys(roiFeatureSettings(f))) emitted.add(k);
    const managed = managedKeys();
    expect([...emitted].filter((k) => !managed.has(k))).toEqual([]);
    for (const fam of ROI_FEATURE_FAMILIES) expect(managed.get(fam.setting)).toBe("family");
  });

  it("the value kind keys are refused (they belong to the value kind field)", () => {
    for (const k of ["INT_IVH_MODE", "DOUBLE_IVH_binWidth", "BOOL_interpolation_intensity_rounding"]) {
      expect(parseAdvanced(`${k}=1`).errors[0]?.detail).toBe("valueKind");
    }
  });
});

describe("roiFeatureSettings with the advanced text", () => {
  it("adds the accepted entries, and a field of the screen wins over the same key", () => {
    const f = { ...defaultRoiFeatureForm(), advancedText: "INT_deltaGLCM=2\nINT_binCount=999\nBOGUS=1" };
    const s = roiFeatureSettings(f);
    expect(s.INT_deltaGLCM).toBe("2");
    expect(s.INT_binCount).toBe("32"); // 離散化の欄が決める（詳細設定には書けない）
    expect(s.BOGUS).toBe("1"); // スキーマなしでは形だけ。backend が実行時に断る
  });

  it("with the default form it adds nothing", () => {
    expect(Object.keys(roiFeatureSettings(defaultRoiFeatureForm())).some((k) => k === "INT_deltaGLCM")).toBe(false);
  });
});
