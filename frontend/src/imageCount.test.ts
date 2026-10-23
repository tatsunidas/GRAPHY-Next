import { describe, expect, it } from "vitest";
import { imageCount } from "./imageCount";

describe("imageCount", () => {
  it("フレーム数があればそれ（XA の 2 ショット 89+93 = 182、SOP 数は 2）", () => {
    expect(imageCount({ numberOfFrames: 182, numberOfInstances: 2 })).toBe(182);
  });
  it("フレーム数が null / 未指定なら SOP 数", () => {
    expect(imageCount({ numberOfFrames: null, numberOfInstances: 2 })).toBe(2);
    expect(imageCount({ numberOfInstances: 7 })).toBe(7);
  });
  it("フレーム数 0 は 0 のまま（null と区別する）", () => {
    expect(imageCount({ numberOfFrames: 0, numberOfInstances: 3 })).toBe(0);
  });
});
