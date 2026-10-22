/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { parseScaleLabels, parseScaleSpec, sigmaPreview } from "./scaleSpec";

const ok = (t: string) => parseScaleSpec(t).values;
const err = (t: string) => parseScaleSpec(t).error;

describe("parseScaleSpec", () => {
  it("accepts commas and spaces, drops duplicates, keeps 0", () => {
    expect(ok("0, 2  3,3 4.5")).toEqual([0, 2, 3, 4.5]);
  });

  it("expands a sweep including both ends", () => {
    expect(ok("1:3:0.5")).toEqual([1, 1.5, 2, 2.5, 3]);
  });

  it("does not lose the end to floating point", () => {
    expect(ok("0.1:0.3:0.1")).toEqual([0.1, 0.2, 0.3]);
    expect(ok("0:1:0.1")).toHaveLength(11);
    expect(ok("0:1:0.1")!.at(-1)).toBe(1);
  });

  it("does not run past the end when the step does not divide the range", () => {
    expect(ok("1:2:0.4")).toEqual([1, 1.4, 1.8]);
  });

  it("mixes lists and sweeps and merges equal values", () => {
    expect(ok("0, 1:2:0.5")).toEqual([0, 1, 1.5, 2]);
    expect(ok("1, 1:2:0.5")).toEqual([1, 1.5, 2]);
  });

  it("writes sweep values with the digits of the start and step (no 0.30000000000000004)", () => {
    for (const v of ok("0.1:0.7:0.1")!) expect(String(v).length).toBeLessThanOrEqual(4);
  });

  it("refuses with a reason", () => {
    expect(err("")).toEqual({ key: "empty" });
    expect(err("  ,  ")).toEqual({ key: "empty" });
    expect(err("2, x")).toEqual({ key: "number", token: "x" });
    expect(err("0, -1")).toEqual({ key: "number", token: "-1" });
    expect(err("Infinity")).toEqual({ key: "number", token: "Infinity" });
    expect(err("1:3")).toEqual({ key: "number", token: "1:3" });
    expect(err("1:a:0.5")).toEqual({ key: "number", token: "1:a:0.5" });
    expect(err("1:3:0")).toEqual({ key: "step", token: "1:3:0" });
    expect(err("1:3:-0.5")).toEqual({ key: "step", token: "1:3:-0.5" });
    expect(err("3:1:0.5")).toEqual({ key: "order", token: "3:1:0.5" });
  });

  it("a single-point sweep is that point", () => {
    expect(ok("2:2:0.5")).toEqual([2]);
  });
});

describe("parseScaleLabels", () => {
  it("is null when empty, the labels when the count matches, mismatch otherwise", () => {
    expect(parseScaleLabels("", 3)).toBeNull();
    expect(parseScaleLabels(" , ", 2)).toBeNull();
    expect(parseScaleLabels("1.0, 1.5, 2.5", 3)).toEqual(["1.0", "1.5", "2.5"]);
    expect(parseScaleLabels("1.0, 1.5", 3)).toBe("mismatch");
  });
});

describe("sigmaPreview", () => {
  it("matches the backend conversion and rounding", () => {
    expect(sigmaPreview(4, 2, "SQRT_D", 1)).toBe(2.8284);
    expect(sigmaPreview(4, 3, "SQRT_D", 1)).toBe(2.3094);
    expect(sigmaPreview(4, 3, "IDENTITY", 1)).toBe(4);
    expect(sigmaPreview(4, 3, "COEFFICIENT", 1.5)).toBe(6);
    expect(sigmaPreview(0, 3, "SQRT_D", 1)).toBeNull();
  });
});
