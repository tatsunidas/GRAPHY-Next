import { describe, expect, it } from "vitest";
import { measureCrossSection, minWidthOfHull } from "./crossSectionMeasure";

const N = 81; // 中心 (40,40)
const STEP = 0.1;
/** 判定式で格子を塗る（u,v は中心からの mm）。 */
function paint(inside: (u: number, v: number) => boolean): Uint8Array {
  const g = new Uint8Array(N * N);
  const c = (N - 1) / 2;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) g[j * N + i] = inside((i - c) * STEP, (j - c) * STEP) ? 1 : 0;
  return g;
}

describe("measureCrossSection", () => {
  it("円（半径 2 mm）: 面積 πr²・等価径 4.0・最小幅 4.0（刻み 0.1 mm の範囲で一致）", () => {
    const m = measureCrossSection(paint((u, v) => Math.hypot(u, v) <= 2), N, STEP);
    expect(m.centerInMask && !m.touchesBoundary).toBe(true);
    expect(m.areaMm2!).toBeCloseTo(Math.PI * 4, 0);
    expect(Math.abs(m.equivalentDiameterMm! - 4)).toBeLessThan(0.1);
    expect(Math.abs(m.minWidthMm! - 4)).toBeLessThan(0.2);
  });

  it("楕円（半軸 1.5 と 3.0）: 最小幅 = 短径 3.0、等価径 2√(ab)（解析式）。等価径と最小幅は別の量", () => {
    const m = measureCrossSection(paint((u, v) => (u / 3) ** 2 + (v / 1.5) ** 2 <= 1), N, STEP);
    expect(Math.abs(m.minWidthMm! - 3)).toBeLessThan(0.2);
    expect(Math.abs(m.equivalentDiameterMm! - 2 * Math.sqrt(3 * 1.5))).toBeLessThan(0.1);
    expect(m.equivalentDiameterMm!).toBeGreaterThan(m.minWidthMm!);
  });

  it("斜めに置いた楕円でも最小幅は同じ（全方位）", () => {
    const a = Math.PI / 6;
    const m = measureCrossSection(paint((u, v) => ((u * Math.cos(a) + v * Math.sin(a)) / 3) ** 2 + ((-u * Math.sin(a) + v * Math.cos(a)) / 1.5) ** 2 <= 1), N, STEP);
    expect(Math.abs(m.minWidthMm! - 3)).toBeLessThan(0.2);
  });

  it("穴（内側の背景）は面積から引く（中心が環の上にある場合）", () => {
    const m = measureCrossSection(paint((u, v) => { const r = Math.hypot(u - 1.25, v); return r <= 2.5 && r > 0.8; }), N, STEP);
    expect(m.centerInMask).toBe(true);
    expect(Math.abs(m.areaMm2! - Math.PI * (2.5 ** 2 - 0.8 ** 2))).toBeLessThan(0.3);
  });

  it("中心を含む成分だけを数える（隣の円は混ぜない）", () => {
    const only = measureCrossSection(paint((u, v) => Math.hypot(u, v) <= 1.5), N, STEP);
    const withNeighbour = measureCrossSection(paint((u, v) => Math.hypot(u, v) <= 1.5 || Math.hypot(u - 3.5, v) <= 1.5), N, STEP);
    expect(withNeighbour.areaMm2).toBe(only.areaMm2);
  });

  it("中心が背景なら全値 null（近くの別の構造で埋めない）", () => {
    const m = measureCrossSection(paint((u, v) => Math.hypot(u - 2, v) <= 1.5), N, STEP);
    expect(m).toEqual({ centerInMask: false, touchesBoundary: false, areaMm2: null, equivalentDiameterMm: null, minWidthMm: null });
  });

  it("成分が格子の縁に触れたら全値 null＋touchesBoundary（切れた径を返さない）", () => {
    const m = measureCrossSection(paint((u, v) => Math.hypot(u, v) <= 5), N, STEP); // 格子の半幅は 4 mm
    expect(m.touchesBoundary).toBe(true);
    expect(m.areaMm2).toBeNull();
    expect(m.equivalentDiameterMm).toBeNull();
    expect(m.minWidthMm).toBeNull();
  });

  it("minWidthOfHull: 辺 2×1 の長方形は 1", () => {
    expect(minWidthOfHull([[0, 0], [2, 0], [2, 1], [0, 1]])).toBeCloseTo(1, 12);
    expect(minWidthOfHull([[0, 0], [1, 1]])).toBe(0);
  });
});
