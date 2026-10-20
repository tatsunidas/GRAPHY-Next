import { describe, expect, it } from "vitest";
import {
  cinematicScaleFor,
  cinematicScaleForModel,
  cinematicScaleForQuality,
  estimateFrameSeconds,
  fitCostModel,
  medianInterval,
  predictMs,
  settleHoldMs,
} from "./cinematicScale";

describe("medianInterval", () => {
  it("is the median and does not move for one outlier (a 1 s gap from a tab switch)", () => {
    const base = Array.from({ length: 29 }, (_, i) => 16.5 + (i % 3) * 0.2);
    const clean = medianInterval(base);
    expect(clean).toBeCloseTo(16.7, 1);
    expect(medianInterval([...base, 1000])).toBeCloseTo(clean, 1);
    // 数を倍にしても中央値は変わらない（フレーム数は統計の安定のため）
    expect(medianInterval([...base, ...base])).toBeCloseTo(clean, 6);
  });
  it("is NaN when nothing usable was measured (never 0)", () => {
    expect(medianInterval([])).toBeNaN();
    expect(medianInterval([Number.NaN, 0, -3])).toBeNaN();
  });
});

describe("cinematicScaleFor", () => {
  const t = 16.7;
  it("is 1 when one full-resolution frame fits the budget (negative case)", () => {
    expect(cinematicScaleFor(10, t, 800, 600)).toBe(1);
    expect(cinematicScaleFor(t, t, 800, 600)).toBe(1);
  });
  it("is ceil(sqrt(tFull / tBudget)) otherwise (cost is proportional to pixels)", () => {
    expect(cinematicScaleFor(t * 1.01, t, 800, 600)).toBe(2);
    expect(cinematicScaleFor(t * 4, t, 800, 600)).toBe(2);
    expect(cinematicScaleFor(t * 4.01, t, 800, 600)).toBe(3);
    expect(cinematicScaleFor(2000, t, 800, 600)).toBe(Math.ceil(Math.sqrt(2000 / t)));
  });
  it("never goes below one pixel", () => {
    expect(cinematicScaleFor(1e9, t, 800, 600)).toBe(600);
    expect(cinematicScaleFor(1e9, t, 3, 200)).toBe(3);
  });
  it("does not shrink when nothing was measured", () => {
    expect(cinematicScaleFor(Number.NaN, t, 800, 600)).toBe(1);
    expect(cinematicScaleFor(100, Number.NaN, 800, 600)).toBe(1);
    expect(cinematicScaleFor(100, 0, 800, 600)).toBe(1);
    expect(cinematicScaleFor(0, t, 800, 600)).toBe(1);
  });
  it("full quality never shrinks (the user's override)", () => {
    const slow = { fixedMs: 0, perFullMs: 5000 };
    expect(cinematicScaleForQuality("full", slow, t, 800, 600)).toBe(1);
    expect(cinematicScaleForQuality("auto", slow, t, 800, 600)).toBeGreaterThan(1);
  });
});

describe("settleHoldMs / estimateFrameSeconds / toFullResolutionMs", () => {
  it("hold is three display intervals, NaN when unmeasured", () => {
    expect(settleHoldMs(16.7)).toBeCloseTo(50.1, 6);
    expect(settleHoldMs(Number.NaN)).toBeNaN();
    expect(settleHoldMs(0)).toBeNaN();
  });
  it("scales a probe frame by k squared", () => {
    expect(estimateFrameSeconds(100, 8)).toBeCloseTo(6.4, 6);
    expect(estimateFrameSeconds(100, 1)).toBeCloseTo(0.1, 6);
    expect(estimateFrameSeconds(Number.NaN, 8)).toBeNaN();
    expect(estimateFrameSeconds(100, 0.5)).toBeNaN();
  });
});

describe("fitCostModel (t(k) = fixed + perFull / k^2)", () => {
  it("recovers fixed and perFull from two scales", () => {
    const m = fitCostModel([{ k: 1, ms: 10.8 }, { k: 4, ms: 2.7 }])!;
    // 10.8 = f + p, 2.7 = f + p/16 → p = 8.64, f = 2.16
    expect(m.perFullMs).toBeCloseTo(8.64, 6);
    expect(m.fixedMs).toBeCloseTo(2.16, 6);
    expect(predictMs(m, 2)).toBeCloseTo(2.16 + 8.64 / 4, 6);
  });
  it("uses the median per scale and the extreme scales (a middle scale does not change the fit)", () => {
    const a = fitCostModel([{ k: 1, ms: 10 }, { k: 4, ms: 2.5 }])!;
    const b = fitCostModel([{ k: 1, ms: 10 }, { k: 1, ms: 10.2 }, { k: 1, ms: 99 }, { k: 2, ms: 4 }, { k: 4, ms: 2.5 }])!;
    expect(b.perFullMs).toBeCloseTo(a.perFullMs, 0);
  });
  it("assumes no fixed cost from one scale only (an upper bound), and never from nothing", () => {
    expect(fitCostModel([{ k: 4, ms: 3 }])).toEqual({ fixedMs: 0, perFullMs: 48 });
    expect(fitCostModel([])).toBeNull();
    expect(fitCostModel([{ k: 1, ms: Number.NaN }, { k: 0.5, ms: 3 }, { k: 2, ms: 0 }])).toBeNull();
  });
  it("falls back to the lowest scale alone when the two points are inverted or the fixed cost is negative (noise)", () => {
    // 大きい k のほうが遅い（雑音）
    expect(fitCostModel([{ k: 1, ms: 5 }, { k: 4, ms: 6 }])).toEqual({ fixedMs: 0, perFullMs: 5 });
    // 画素数に比例する以上に速い（固定費が負になる）: k=1 が 10、k=4 が 0.1 → fixed < 0
    const m = fitCostModel([{ k: 1, ms: 10 }, { k: 4, ms: 0.1 }])!;
    expect(m.fixedMs).toBeGreaterThanOrEqual(0);
  });
});

describe("cinematicScaleForModel", () => {
  it("does not shrink when the full-resolution frame (fixed + perFull) fits the budget — the case the pure k^2 formula got wrong", () => {
    // 実測: 1736×1214 の Intel 内蔵 GPU で k=1 が 10.8 ms、予算 16.7 ms。k=2 で測った 4.3 ms を k² 倍して 17.2 ms とみなすと誤って縮小する
    expect(cinematicScaleFor(4.3 * 4, 16.7, 1736, 1214)).toBe(2);
    const m = fitCostModel([{ k: 1, ms: 10.8 }, { k: 2, ms: 4.3 }])!;
    expect(cinematicScaleForModel(m, 16.7, 1736, 1214)).toBe(1);
  });
  it("shrinks to the smallest integer k whose predicted time fits", () => {
    const m = { fixedMs: 2, perFullMs: 100 };
    const k = cinematicScaleForModel(m, 16.7, 800, 600);
    expect(predictMs(m, k)).toBeLessThanOrEqual(16.7);
    expect(predictMs(m, k - 1)).toBeGreaterThan(16.7);
  });
  it("ignores the fixed cost when it alone exceeds the budget (shrinking cannot meet it)", () => {
    const k = cinematicScaleForModel({ fixedMs: 30, perFullMs: 100 }, 16.7, 800, 600);
    expect(k).toBe(Math.ceil(Math.sqrt(100 / 16.7)));
  });
  it("is 1 without a model", () => {
    expect(cinematicScaleForModel(null, 16.7, 800, 600)).toBe(1);
    expect(cinematicScaleForModel({ fixedMs: 0, perFullMs: Number.NaN }, 16.7, 800, 600)).toBe(1);
  });
});
