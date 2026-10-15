/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { crosshairColorFor, rgbCss } from "./mpr";

const ids = { axial: "a", sagittal: "s", coronal: "c" };

describe("crosshairColorFor", () => {
  it("面ごとの色は今までと同じ（Axial 緑・Sagittal 黄・Coronal 青）、知らない面は灰色", () => {
    expect(crosshairColorFor("a", ids, "perPlane", [1, 2, 3])).toEqual([0, 220, 0]);
    expect(crosshairColorFor("s", ids, "perPlane", [1, 2, 3])).toEqual([220, 220, 0]);
    expect(crosshairColorFor("c", ids, "perPlane", [1, 2, 3])).toEqual([0, 160, 255]);
    expect(crosshairColorFor("x", ids, "perPlane", [1, 2, 3])).toEqual([200, 200, 200]);
  });

  it("単色はどの面も指定の色", () => {
    for (const id of ["a", "s", "c"]) expect(crosshairColorFor(id, ids, "single", [255, 0, 255])).toEqual([255, 0, 255]);
  });
});

describe("rgbCss", () => {
  it("SVG の stroke に書ける rgb() の文字列にする", () => {
    expect(rgbCss([0, 220, 0])).toBe("rgb(0, 220, 0)");
  });
});
