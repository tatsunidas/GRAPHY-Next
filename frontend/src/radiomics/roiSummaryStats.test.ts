import { describe, expect, it } from "vitest";
import type { RoiFeatureRow } from "../api";
import { SECONDARY_QUANTITIES, SIX_STATISTICS, summaryLines } from "./roiSummaryStats";
import {
  applySixStatistics, defaultRoiFeatureForm, isSixStatistics, rangeBounds, roiFeatureSettings,
} from "./roiFeatureSettings";

const row = (column: string, value: number | null): RoiFeatureRow => {
  const i = column.indexOf("_");
  return { column, family: column.slice(0, i), feature: column.slice(i + 1), ibsi: null, value, notes: [] };
};

describe("summaryLines", () => {
  const all = [...SIX_STATISTICS, ...SECONDARY_QUANTITIES].map((d, i) => row(d.column, i + 0.5));
  it("returns the six statistics in order, with the value of the same row", () => {
    const lines = summaryLines(all, SIX_STATISTICS);
    expect(lines.map((l) => l.label)).toEqual(["Mean", "SD", "Entropy", "MPP", "Skewness", "Kurtosis"]);
    expect(lines.map((l) => l.row.value)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5]);
  });
  it("leaves out a line whose family was not calculated, and keeps an undefined (null) value as a line", () => {
    const withoutAux = all.filter((r) => !r.column.startsWith("AuxiliaryStatistics_"));
    expect(summaryLines(withoutAux, SIX_STATISTICS).map((l) => l.label)).not.toContain("MPP");
    expect(summaryLines(withoutAux, SECONDARY_QUANTITIES).map((l) => l.label)).toEqual(["Variance", "Uniformity"]);
    const undef = all.map((r) => (r.column.endsWith("ReciprocalKurtosis") ? { ...r, value: null } : r));
    const l = summaryLines(undef, SECONDARY_QUANTITIES).find((x) => x.label === "1/(kurtosis+3)");
    expect(l?.row.value).toBeNull();
  });
  it("does not pick filtered columns", () => {
    expect(summaryLines([row("log_sigma1.5mm_IntensityBasedStatistical_Mean", 1)], SIX_STATISTICS)).toEqual([]);
  });
});

describe("preset and range", () => {
  it("six statistics turns on exactly three families and sends the auxiliary switch", () => {
    const f = applySixStatistics(defaultRoiFeatureForm());
    expect(isSixStatistics(f)).toBe(true);
    expect(isSixStatistics(defaultRoiFeatureForm())).toBe(false);
    const s = roiFeatureSettings(f);
    expect(Object.entries(s).filter(([k, v]) => k.startsWith("BOOL_enable") && v === "1").map(([k]) => k).sort())
      .toEqual(["BOOL_enableAuxiliaryStatistics", "BOOL_enableIntensityBasedStatistics", "BOOL_enableIntensityHistogram"]);
  });
  it("the auxiliary family is off by default", () => {
    expect(roiFeatureSettings(defaultRoiFeatureForm()).BOOL_enableAuxiliaryStatistics).toBe("0");
  });
  it("sends each bound that is given, alone or both, and nothing for an invalid input", () => {
    const f = defaultRoiFeatureForm();
    expect(roiFeatureSettings(f).DOUBLE_rangeMin).toBeUndefined();
    expect(roiFeatureSettings(f).DOUBLE_rangeMax).toBeUndefined();
    const both = { ...f, rangeMinText: "-50", rangeMaxText: "400" };
    expect(roiFeatureSettings(both)).toMatchObject({ DOUBLE_rangeMin: "-50", DOUBLE_rangeMax: "400" });
    const lower = roiFeatureSettings({ ...f, rangeMinText: "-50" });
    expect(lower.DOUBLE_rangeMin).toBe("-50");
    expect(lower.DOUBLE_rangeMax).toBeUndefined();
    const upper = roiFeatureSettings({ ...f, rangeMaxText: "400" });
    expect(upper.DOUBLE_rangeMax).toBe("400");
    expect(upper.DOUBLE_rangeMin).toBeUndefined();
    expect(rangeBounds({ ...f, rangeMinText: "-50" }).problem).toBeNull();
    const reversed = { ...f, rangeMinText: "5", rangeMaxText: "1" };
    expect(rangeBounds(reversed).problem).toBe("ORDER");
    expect(roiFeatureSettings(reversed).DOUBLE_rangeMin).toBeUndefined();
    expect(rangeBounds({ ...f, rangeMinText: "abc", rangeMaxText: "1" }).problem).toBe("INVALID");
    expect(roiFeatureSettings({ ...f, rangeMinText: "abc" }).DOUBLE_rangeMin).toBeUndefined();
  });
});
