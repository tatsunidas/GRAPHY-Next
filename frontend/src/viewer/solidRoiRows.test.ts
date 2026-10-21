import { describe, expect, it } from "vitest";
import { solidInfo } from "./solidRoiRows";
import { sphereSolid, volumeMl, formatMl } from "./roi3dBox";

const sph = sphereSolid("a", [0, 0, 0], 10);

describe("solidInfo", () => {
  it("球 r=10mm の容積は 4/3πr³ = 4.1888 mL", () => {
    expect(solidInfo(sph, null).volumeText).toBe("4.1888 mL");
    expect(solidInfo(sph, null).volumeText).toBe(`${formatMl(volumeMl(sph))} mL`);
  });
  it("bounds が無ければ範囲外を判定しない（2D 窓にはボリューム範囲が無い）", () => {
    const far = { ...sph, center: [1000, 0, 0] as [number, number, number] };
    expect(solidInfo(far, null).outside).toBe(false);
  });
  it("bounds があり形がはみ出すと true、収まれば false", () => {
    const b: [number, number, number, number, number, number] = [-50, 50, -50, 50, -50, 50];
    expect(solidInfo(sph, b).outside).toBe(false);
    expect(solidInfo({ ...sph, center: [45, 0, 0] }, b).outside).toBe(true);
  });
  it("式の文字列が空でない", () => {
    expect(solidInfo(sph, null).formula.length).toBeGreaterThan(0);
  });
});
