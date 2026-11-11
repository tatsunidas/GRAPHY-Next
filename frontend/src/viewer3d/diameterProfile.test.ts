import { describe, expect, it } from "vitest";
import { diameterProfile, nearestIndex } from "./diameterProfile";

const line = (n: number, step: number): number[][] => Array.from({ length: n }, (_, i) => [0, 0, i * step]);

describe("diameterProfile", () => {
  it("弧長は隣り合う点の距離の累積（直線 3 mm 刻み・折れ線 3-4-5 の三角形）", () => {
    const p = diameterProfile(line(4, 3), [4, 4, 4, 4])!;
    expect(p.arcMm).toEqual([0, 3, 6, 9]);
    expect(p.lengthMm).toBe(9);
    const q = diameterProfile([[0, 0, 0], [3, 0, 0], [3, 4, 0]], [1, 1, 1])!;
    expect(q.arcMm).toEqual([0, 3, 7]);
  });

  it("最小（位置つき）と最大。同値は最初の点", () => {
    const p = diameterProfile(line(5, 2), [4, 3, 2, 2, 4])!;
    expect(p.min).toEqual({ index: 2, arcMm: 4, d: 2 });
    expect(p.max).toBe(4);
    expect(p.nValid).toBe(5);
  });

  it("🔴 null の点で線が切れる（補間しない）。runs は連続して測れた点の並び", () => {
    const p = diameterProfile(line(6, 1), [4, 4, null, null, 3, 3])!;
    expect(p.runs).toHaveLength(2);
    expect(p.runs[0].map((x) => x.arcMm)).toEqual([0, 1]);
    expect(p.runs[1].map((x) => x.arcMm)).toEqual([4, 5]);
    expect(p.nValid).toBe(4);
  });

  it("端が null でも（先頭・末尾）空の run を作らない", () => {
    const p = diameterProfile(line(5, 1), [null, 3, 3, 3, null])!;
    expect(p.runs).toHaveLength(1);
    expect(p.runs[0]).toHaveLength(3);
  });

  it("🔴 最小は null を 0 として扱わない（測れていない所が最小にならない）", () => {
    const p = diameterProfile(line(4, 1), [null, 3, 2.5, null])!;
    expect(p.min).toEqual({ index: 2, arcMm: 2, d: 2.5 });
  });

  it("非有限の径も測れなかった点と同じ扱い", () => {
    const p = diameterProfile(line(4, 1), [3, NaN, Infinity, 3])!;
    expect(p.runs).toHaveLength(2);
    expect(p.nValid).toBe(2);
  });

  it("全点 null: min・max は null、runs は空（長さは返る）", () => {
    const p = diameterProfile(line(3, 1), [null, null, null])!;
    expect(p.min).toBeNull();
    expect(p.max).toBeNull();
    expect(p.runs).toEqual([]);
    expect(p.lengthMm).toBe(2);
  });

  it("負例: 点が 1 つ・長さ不一致・非有限の点は null（黙って揃えない）", () => {
    expect(diameterProfile([[0, 0, 0]], [3])).toBeNull();
    expect(diameterProfile(line(3, 1), [3, 3])).toBeNull();
    expect(diameterProfile([[0, 0, 0], [NaN, 0, 0]], [3, 3])).toBeNull();
  });
});

describe("nearestIndex", () => {
  it("最も近い弧長の点（同距離は前の点）。点が無ければ -1", () => {
    expect(nearestIndex([0, 3, 6, 9], 4)).toBe(1);
    expect(nearestIndex([0, 3, 6, 9], 4.6)).toBe(2);
    expect(nearestIndex([0, 3, 6, 9], 100)).toBe(3);
    expect(nearestIndex([0, 3], 1.5)).toBe(0);
    expect(nearestIndex([], 1)).toBe(-1);
  });
});
