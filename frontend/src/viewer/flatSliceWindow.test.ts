import { describe, expect, it, vi } from "vitest";
import {
  FLAT_GUARD_WIDTH,
  flatSliceGuardRange,
  refineFlatSliceWindow,
  sampleSliceIndices,
  unionRange,
  type VoiRange,
} from "./flatSliceWindow";

describe("flatSliceGuardRange（全画素が同じ値のスライス）", () => {
  it("★ 全部 0 のスライスでも、幅のある窓を返す（旧実装は [0,0] で幅 0 になり、色関数が壊れた）", () => {
    const r = flatSliceGuardRange(new Float32Array(100));
    expect(r).not.toBeNull();
    expect(r!.upper - r!.lower).toBe(FLAT_GUARD_WIDTH);
    expect(r!.upper).toBeGreaterThan(r!.lower);
  });
  it("全部同じ値 v なら v を中心にする", () => {
    const r = flatSliceGuardRange([7, 7, 7])!;
    expect((r.lower + r.upper) / 2).toBe(7);
  });
  it("負例: 値に幅があるスライスでは何もしない（cornerstone の既定のまま）", () => {
    expect(flatSliceGuardRange([0, 0, 5])).toBeNull();
    expect(flatSliceGuardRange(new Float32Array([0, 7465, 160122.5]))).toBeNull();
  });
  it("有限の値が無ければ null（NaN だけ・空）", () => {
    expect(flatSliceGuardRange([NaN, NaN])).toBeNull();
    expect(flatSliceGuardRange([])).toBeNull();
    expect(flatSliceGuardRange(null)).toBeNull();
  });
  it("NaN は無視して判定する", () => {
    expect(flatSliceGuardRange([NaN, 3, 3])).not.toBeNull();
    expect(flatSliceGuardRange([NaN, 3, 4])).toBeNull();
  });
});

describe("sampleSliceIndices", () => {
  it("枚数が少なければ全部", () => expect(sampleSliceIndices(5, 16)).toEqual([0, 1, 2, 3, 4]));
  it("多ければ、先頭と末尾を含み等間隔に count 個", () => {
    const s = sampleSliceIndices(48, 16);
    expect(s.length).toBe(16);
    expect(s[0]).toBe(0);
    expect(s[s.length - 1]).toBe(47);
    expect([...s].sort((a, b) => a - b)).toEqual(s);
  });
  it("0 枚・count 0 は空", () => {
    expect(sampleSliceIndices(0)).toEqual([]);
    expect(sampleSliceIndices(10, 0)).toEqual([]);
  });
});

describe("unionRange", () => {
  it("和集合。幅が出なければ null", () => {
    expect(unionRange([{ lower: 0, upper: 0 }, { lower: 0, upper: 160122.5 }])).toEqual({ lower: 0, upper: 160122.5 });
    expect(unionRange([{ lower: 0, upper: 0 }, null])).toBeNull();
    expect(unionRange([])).toBeNull();
  });
});

describe("refineFlatSliceWindow（置いた最小の窓を、シリーズの値域へ置き換える）", () => {
  const guard: VoiRange = { lower: -0.5, upper: 0.5 };
  // GNBP-D 4h の形: 先頭と末尾が全 0、中ほどに臓器
  const slices: Record<string, number[]> = {
    s0: [0, 0, 0], s1: [0, 7465, 7465], s2: [0, 7465, 160122.5], s3: [0, 0, 0],
  };
  const deps = (over: Partial<Parameters<typeof refineFlatSliceWindow>[1]> = {}) => {
    const apply = vi.fn();
    return {
      apply,
      d: {
        imageIds: ["s0", "s1", "s2", "s3"],
        readValues: async (id: string) => slices[id] ?? null,
        currentRange: () => guard,
        apply,
        isStale: () => false,
        ...over,
      },
    };
  };

  it("★ 先頭が全 0 でも、シリーズ全体の最小〜最大に置き換える", async () => {
    const { apply, d } = deps();
    const r = await refineFlatSliceWindow(guard, d);
    expect(r).toEqual({ lower: 0, upper: 160122.5 });
    expect(apply).toHaveBeenCalledWith({ lower: 0, upper: 160122.5 });
  });
  it("負例: 利用者が窓を変えていたら上書きしない", async () => {
    const { apply, d } = deps({ currentRange: () => ({ lower: 100, upper: 200 }) });
    expect(await refineFlatSliceWindow(guard, d)).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
  it("負例: 別のスタックに替わった（stale）なら何もしない", async () => {
    const { apply, d } = deps({ isStale: () => true });
    expect(await refineFlatSliceWindow(guard, d)).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
  it("負例: シリーズ全体が全部同じなら、置き換えない（最小の窓のまま）", async () => {
    const { apply, d } = deps({ readValues: async () => [0, 0, 0] });
    expect(await refineFlatSliceWindow(guard, d)).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
  it("読めないスライスがあっても、読めた分で決める", async () => {
    const { d } = deps({ readValues: async (id: string) => (id === "s2" ? slices.s2 : null) });
    expect(await refineFlatSliceWindow(guard, d)).toEqual({ lower: 0, upper: 160122.5 });
  });
});
