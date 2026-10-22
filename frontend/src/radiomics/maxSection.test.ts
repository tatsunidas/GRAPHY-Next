import { describe, expect, it } from "vitest";
import type { MaxSectionResult } from "../api";
import { formatAreaMm2, formatPositionMm, tiePositions } from "./maxSection";

const slice = (positionMm: number) => ({ sopInstanceUid: "1.2", frame: -1, positionMm, pixels: 225, areaMm2: 110.25 });

describe("maxSection", () => {
  it("位置・面積の桁と負のゼロ", () => {
    expect(formatPositionMm(-35)).toBe("-35.0");
    expect(formatPositionMm(-0.04)).toBe("0.0");
    expect(formatAreaMm2(110.25)).toBe("110.25");
  });
  it("同面積は位置を並べ、単独なら空", () => {
    const one: MaxSectionResult = { best: slice(4), ties: [slice(4)], totalSlices: 4, pixelAreaMm2: 0.49 };
    const two: MaxSectionResult = { ...one, ties: [slice(2), slice(8)] };
    expect(tiePositions(one)).toBe("");
    expect(tiePositions(two)).toBe("2.0, 8.0");
  });
});
