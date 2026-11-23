import { describe, expect, it } from "vitest";
import { createWheelStepper, WHEEL_DISCRETE_PX, WHEEL_FINE_PX, WHEEL_IDLE_MS } from "./wheelScroll";
import { formatWheelReport, isDiscreteWheel, summarizeWheelLog, type WheelSample } from "./wheelDiagnostics";

/** 実際の createWheelStepper を通して、サンプルと返り値の組を作る。 */
function run(events: Array<{ dy: number; mode?: number; gap?: number }>): { samples: WheelSample[]; steps: number[] } {
  const stepper = createWheelStepper();
  let t = 1000;
  const samples: WheelSample[] = [];
  const steps: number[] = [];
  events.forEach((e, i) => {
    t += i === 0 ? 0 : e.gap ?? 16;
    const mode = e.mode ?? 0;
    samples.push({ t, dy: e.dy, mode });
    steps.push(stepper(e.dy, mode, t));
  });
  return { samples, steps };
}

describe("summarizeWheelLog", () => {
  it("離散ノッチ（deltaY=100）5 回: 離散 100%・最小=中央値=最大=100・スライス 5・間隔 16ms", () => {
    const { samples, steps } = run(Array.from({ length: 5 }, () => ({ dy: 100 })));
    const s = summarizeWheelLog(samples, steps);
    expect(s.count).toBe(5);
    expect([s.absMin, s.absMedian, s.absMax]).toEqual([100, 100, 100]);
    expect(s.discreteRatio).toBe(1);
    expect(s.totalSlices).toBe(5);
    expect(s.gapMinMs).toBe(16);
    expect(s.gapMedianMs).toBe(16);
    expect(s.modes).toEqual([0]);
    expect(s.topValues).toEqual([{ dy: 100, n: 5 }]);
    expect(s.bursts).toEqual([{ events: 5, sumDy: 500, slices: 5 }]);
  });

  it("細かい連続（deltaY=4 を 20 回 = 80px）: 離散 0%・合計 80px・スライス 2（40px ごと）", () => {
    const { samples, steps } = run(Array.from({ length: 20 }, () => ({ dy: 4 })));
    const s = summarizeWheelLog(samples, steps);
    expect(s.discreteRatio).toBe(0);
    expect(s.bursts).toEqual([{ events: 20, sumDy: 80, slices: 2 }]);
    expect(s.totalSlices).toBe(2);
  });

  it("行単位（deltaMode=1, deltaY=3）は離散扱い。deltaMode の種類を出す", () => {
    const { samples, steps } = run([{ dy: 3, mode: 1 }, { dy: 3, mode: 1 }]);
    const s = summarizeWheelLog(samples, steps);
    expect(s.modes).toEqual([1]);
    expect(s.discreteRatio).toBe(1);
    expect(s.totalSlices).toBe(2);
    expect(isDiscreteWheel(3, 1)).toBe(true);
    expect(isDiscreteWheel(WHEEL_DISCRETE_PX - 1, 0)).toBe(false);
    expect(isDiscreteWheel(WHEEL_DISCRETE_PX, 0)).toBe(true);
  });

  it("250ms を超える間でバーストが分かれる。向きが逆でもスライス数は数える（符号つき deltaY は合計に残る）", () => {
    const { samples, steps } = run([
      { dy: 100 }, { dy: 100 },
      { dy: -100, gap: WHEEL_IDLE_MS + 1 }, { dy: -100 }, { dy: -100 },
    ]);
    const s = summarizeWheelLog(samples, steps);
    expect(s.bursts).toEqual([
      { events: 2, sumDy: 200, slices: 2 },
      { events: 3, sumDy: -300, slices: 3 },
    ]);
    expect(s.gapMinMs).toBe(16);
    // ちょうど idleMs の間はバーストを分けない（ステッパーの `ts - last > idleMs` と同じ）
    const same = summarizeWheelLog(
      [{ t: 0, dy: 100, mode: 0 }, { t: WHEEL_IDLE_MS, dy: 100, mode: 0 }],
      [1, 1],
    );
    expect(same.bursts).toHaveLength(1);
  });

  it("イベント 0 件では、0 で埋めず null（不明）を返す", () => {
    const s = summarizeWheelLog([], []);
    expect(s.count).toBe(0);
    for (const v of [s.absMin, s.absMedian, s.absMax, s.gapMinMs, s.gapMedianMs, s.discreteRatio]) expect(v).toBeNull();
    expect(s.bursts).toEqual([]);
    const text = formatWheelReport(s, { platform: "", userAgent: "" });
    expect(text).toContain("不明");
    expect(text).not.toMatch(/最小\/中央値\/最大: 0/);
  });

  it("1 件だけでは間隔は不明（0 にしない）", () => {
    const { samples, steps } = run([{ dy: 100 }]);
    const s = summarizeWheelLog(samples, steps);
    expect(s.gapMinMs).toBeNull();
    expect(s.gapMedianMs).toBeNull();
  });
});

describe("formatWheelReport", () => {
  it("ビューアの定数と、環境、バーストごとの行が入る", () => {
    const { samples, steps } = run(Array.from({ length: 3 }, () => ({ dy: 100 })));
    const text = formatWheelReport(summarizeWheelLog(samples, steps), { platform: "Linux x86_64", userAgent: "UA-TEST" });
    expect(text).toContain(`${WHEEL_FINE_PX}px で 1 スライス`);
    expect(text).toContain(`${WHEEL_IDLE_MS}ms`);
    expect(text).toContain("Linux x86_64 / UA-TEST");
    expect(text).toContain("#1: イベント 3 / deltaY 合計 300 / スライス 3");
  });
});
