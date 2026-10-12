/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { hexToRgb01, hexToRgb255 } from "./hexColor";

describe("hexToRgb01", () => {
  it("#rrggbb を 0..1 の RGB に直す", () => {
    expect(hexToRgb01("#ffffff")).toEqual([1, 1, 1]);
    expect(hexToRgb01("#000000")).toEqual([0, 0, 0]);
    expect(hexToRgb01("#336699")).toEqual([0x33 / 255, 0x66 / 255, 0x99 / 255]);
    expect(hexToRgb01("FF0000")).toEqual([1, 0, 0]);
  });

  it("読めない値は黒", () => {
    expect(hexToRgb01(undefined)).toEqual([0, 0, 0]);
    expect(hexToRgb01("")).toEqual([0, 0, 0]);
    expect(hexToRgb01("white")).toEqual([0, 0, 0]);
  });
});

describe("hexToRgb255", () => {
  it("#rrggbb を 0..255 の RGB に、読めない値は null", () => {
    expect(hexToRgb255("#ff00ff")).toEqual([255, 0, 255]);
    expect(hexToRgb255("x")).toBeNull();
    expect(hexToRgb255(undefined)).toBeNull();
  });
});
