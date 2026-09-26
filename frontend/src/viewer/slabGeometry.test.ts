import { describe, expect, it } from "vitest";
import { clampSlabDepth, maxSlabDepthMm, slabPlaneFromCamera } from "./slabGeometry";

describe("slabGeometry", () => {
  it("法線は視線方向を正規化し、原点は焦点から depth だけ視線方向へずれる", () => {
    const { origin, normal } = slabPlaneFromCamera([10, 20, 30], [0, 0, -2], 5);
    expect(normal).toEqual([0, 0, -1]);
    expect(origin).toEqual([10, 20, 25]);
  });
  it("斜めの視線でも |原点-焦点| = depth", () => {
    const { origin } = slabPlaneFromCamera([0, 0, 0], [1, 1, 1], 6);
    expect(Math.hypot(...origin)).toBeCloseTo(6, 6);
  });
  it("可動域は外接箱の対角の半分、depth はその範囲に丸める", () => {
    expect(maxSlabDepthMm([0, 3, 0, 4, 0, 0])).toBeCloseTo(2.5);
    expect(clampSlabDepth(100, 2.5)).toBe(2.5);
    expect(clampSlabDepth(-100, 2.5)).toBe(-2.5);
    expect(clampSlabDepth(Number.NaN, 2.5)).toBe(0);
  });
});
