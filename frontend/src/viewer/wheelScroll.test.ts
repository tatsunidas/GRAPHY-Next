/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { createWheelStepper, installWheelSliceGate, WHEEL_FINE_PX, WHEEL_IDLE_MS } from "./wheelScroll";

/** 連続イベントを流して、送られたスライス数の合計と最大の 1 回分を返す。 */
function feed(
  stepper: ReturnType<typeof createWheelStepper>,
  events: Array<{ dy: number; mode?: number; ts?: number }>,
): { total: number; steps: number[] } {
  const steps: number[] = [];
  let ts = 0;
  for (const e of events) {
    ts = e.ts ?? ts + 16; // 60fps 相当で連続して来る想定
    steps.push(stepper(e.dy, e.mode ?? 0, ts));
  }
  return { total: steps.reduce((a, b) => a + b, 0), steps };
}

describe("createWheelStepper — 1 ノッチ = 1 スライス", () => {
  it("Chrome/Edge の 1 ノッチ（deltaY=100）は 1 スライス", () => {
    const s = createWheelStepper();
    const r = feed(s, Array.from({ length: 5 }, () => ({ dy: 100 })));
    expect(r.steps).toEqual([1, 1, 1, 1, 1]);
    expect(r.total).toBe(5);
  });

  it("deltaY=120 の環境でも 2 スライス飛ぶ回が出ない（端数を持ち越さない）", () => {
    // 「px を貯めて 100 で割る」実装だと 5 ノッチ目で 2 になる。ここが退行の本体。
    const s = createWheelStepper();
    const r = feed(s, Array.from({ length: 20 }, () => ({ dy: 120 })));
    expect(new Set(r.steps)).toEqual(new Set([1]));
    expect(r.total).toBe(20);
  });

  it("Firefox の行単位（deltaMode=1, deltaY=3）も 1 スライス", () => {
    const s = createWheelStepper();
    const r = feed(s, [
      { dy: 3, mode: 1 },
      { dy: 3, mode: 1 },
      { dy: -3, mode: 1 },
    ]);
    expect(r.steps).toEqual([1, 1, -1]);
  });

  it("1 イベントでは絶対に 2 スライス以上送らない", () => {
    const s = createWheelStepper();
    const r = feed(s, [{ dy: 4000 }, { dy: 1e6 }]);
    expect(r.steps).toEqual([1, 1]);
  });

  it("トラックパッドの細かい delta は貯めてから 1 スライス（イベント毎には送らない）", () => {
    const s = createWheelStepper();
    // 8px × 5 = 40px でちょうど 1 スライス。
    const r = feed(s, Array.from({ length: 10 }, () => ({ dy: 8 })));
    expect(r.total).toBe(2);
    expect(r.steps.filter((x) => x !== 0).length).toBe(2);
    expect(Math.max(...r.steps)).toBe(1);
  });

  it("向きを変えたら端数を捨てる（戻し始めが空振りしない）", () => {
    const s = createWheelStepper();
    feed(s, [{ dy: 30 }]); // 40px に届かず 0（端数 30 が残る）
    const back = feed(s, Array.from({ length: 5 }, () => ({ dy: -8 })));
    expect(back.total).toBe(-1); // 端数を持ち越していたら 40px 貯まらず 0 になる
  });

  it("間が空いたら端数を捨てる（惰性スクロールの続きで動かさない）", () => {
    const s = createWheelStepper();
    expect(s(30, 0, 0)).toBe(0);
    expect(s(30, 0, WHEEL_IDLE_MS + 1)).toBe(0); // 捨てているので 60px にはならない
    expect(s(WHEEL_FINE_PX, 0, WHEEL_IDLE_MS + 17)).toBe(1);
  });

  it("0 / NaN は何も送らない", () => {
    const s = createWheelStepper();
    expect(s(0, 0, 0)).toBe(0);
    expect(s(Number.NaN, 0, 16)).toBe(0);
  });
});

// ── installWheelSliceGate（Cornerstone の StackScrollTool へ通す前の間引き） ──────
//
// vitest の環境は "node"（jsdom を入れていない）ので、必要な口だけを持つ偽の要素を使う。
// 見るのは「どのイベントを止め、どれを通したか」だけで、DOM の実装には依存しない。

interface FakeWheelEvent {
  deltaY: number;
  deltaMode: number;
  timeStamp: number;
  prevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

function fakeElement() {
  const handlers: Array<(e: FakeWheelEvent) => void> = [];
  const el = {
    dataset: {} as Record<string, string>,
    addEventListener: (_type: string, fn: (e: FakeWheelEvent) => void) => handlers.push(fn),
  };
  let ts = 0;
  return {
    el: el as unknown as HTMLElement,
    handlerCount: () => handlers.length,
    /** ホイールを 1 件流し、Cornerstone まで届いたか（= 止められなかったか）を返す。 */
    fire(deltaY: number, deltaMode = 0, at?: number): boolean {
      ts = at ?? ts + 16;
      const e: FakeWheelEvent = {
        deltaY,
        deltaMode,
        timeStamp: ts,
        prevented: false,
        stopped: false,
        preventDefault() {
          this.prevented = true;
        },
        stopImmediatePropagation() {
          this.stopped = true;
        },
      };
      for (const fn of handlers) fn(e);
      return !e.stopped;
    },
  };
}

describe("installWheelSliceGate", () => {
  it("マウスホイールのノッチは素通しする（Cornerstone が 1 スライス送る）", () => {
    const f = fakeElement();
    installWheelSliceGate(f.el);
    expect([f.fire(100), f.fire(100), f.fire(-100)]).toEqual([true, true, true]);
  });

  it("トラックパッドの細かい delta は 40px 貯まるまで止める", () => {
    const f = fakeElement();
    installWheelSliceGate(f.el);
    const passed = Array.from({ length: 10 }, () => f.fire(8));
    // 8px × 5 = 40px ごとに 1 回だけ通る＝ 10 件中 2 件。
    expect(passed.filter(Boolean).length).toBe(2);
  });

  it("同じ要素に二重には付かない", () => {
    const f = fakeElement();
    installWheelSliceGate(f.el);
    installWheelSliceGate(f.el);
    expect(f.handlerCount()).toBe(1);
  });
});
