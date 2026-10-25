import { describe, expect, it } from "vitest";
import {
  filterRows, ibsiFileBase, ibsiResultJson, passedOf, summarize,
  type IbsiCheckResult, type IbsiReport, type IbsiRow, type IbsiVerdict,
} from "./ibsiCheck";

const row = (verdict: IbsiVerdict, name: string, family = "Morphology"): IbsiRow => ({
  family, imageBiomarker: name, radiomicsjName: name, column: `${family}_${name}`, consensus: null,
  reference: 1, tolerance: verdict === "PASS" ? 0.1 : null, computed: verdict === "NOT_SUPPORTED" ? null : 1,
  verdict, referenceStatus: null,
});

function report(rows: IbsiRow[]): IbsiReport {
  const counts = { PASS: 0, PASS_AT_REFERENCE_DIGITS: 0, FAIL: 0, NOT_COMPUTED: 0, NOT_SUPPORTED: 0, NO_MANUAL_REFERENCE: 0 };
  for (const r of rows) counts[r.verdict] += 1;
  return {
    dataSet: "digital phantom", radiomicsjVersion: "2.5.2", referenceFile: "x.xlsx", referenceSha256: "ab".repeat(32),
    settingsFile: "s.properties", settings: "k=v", rule: "rule", skippedDiagnostics: 60,
    checked: counts.PASS + counts.PASS_AT_REFERENCE_DIGITS + counts.FAIL, counts, rows,
  };
}

const sample = report([
  row("PASS", "VolumeMesh"), row("PASS", "Surface"), row("PASS_AT_REFERENCE_DIGITS", "Mean", "IntensityBasedStatistical"),
  row("FAIL", "IntensityAtVolumeFraction10", "IntensityVolumeHistogram"), row("NOT_COMPUTED", "MoransI"),
  row("NOT_SUPPORTED", "Agg2D"), row("NO_MANUAL_REFERENCE", "AreaUnderIVH"),
]);

describe("summarize", () => {
  it("counts each verdict and separates the library's own criterion from the tolerance pass", () => {
    const s = summarize(sample);
    expect(s).toEqual({
      checked: 4, withinTolerance: 2, atReferenceDigits: 1, failed: 1, notComputed: 1, notSupported: 1,
      noManualReference: 1,
    });
    expect(passedOf(s)).toBe(3);
  });
  it("refuses a report whose counts disagree with its rows", () => {
    const bad = { ...sample, counts: { ...sample.counts, FAIL: 0 } };
    expect(() => summarize(bad)).toThrow(/FAIL/);
  });
});

describe("filterRows", () => {
  it("keeps only failures (and only failures: the filter must drop the passes)", () => {
    const f = filterRows(sample.rows, "FAIL", "");
    expect(f.map((r) => r.verdict)).toEqual(["FAIL"]);
  });
  it("PROBLEM is failures and not-computed; NOT_JUDGED is unsupported and no-manual-reference", () => {
    expect(filterRows(sample.rows, "PROBLEM", "").map((r) => r.verdict)).toEqual(["FAIL", "NOT_COMPUTED"]);
    expect(filterRows(sample.rows, "NOT_JUDGED", "").map((r) => r.verdict)).toEqual(["NOT_SUPPORTED", "NO_MANUAL_REFERENCE"]);
  });
  it("searches family and names case-insensitively", () => {
    expect(filterRows(sample.rows, "ALL", "volumefraction").length).toBe(1);
    expect(filterRows(sample.rows, "ALL", "intensitybased").length).toBe(1);
    expect(filterRows(sample.rows, "ALL", "no such feature").length).toBe(0);
  });
});

describe("export", () => {
  const result: IbsiCheckResult = {
    graphyVersion: "0.9.9", radiomicsjVersion: "2.5.2", ranAt: "2026-10-25T15:04:05+09:00", report: sample, csv: "a,b\n",
  };
  it("names files by data set, version and day", () => {
    expect(ibsiFileBase(result)).toBe("ibsi1_digital_phantom_RadiomicsJ-2.5.2_2026-10-25");
  });
  it("writes the RadiomicsJ report unchanged with the app version and time added", () => {
    const o = JSON.parse(ibsiResultJson(result));
    expect(o.graphyNextVersion).toBe("0.9.9");
    expect(o.ranAt).toBe(result.ranAt);
    expect(o.report).toEqual(sample);
  });
});
