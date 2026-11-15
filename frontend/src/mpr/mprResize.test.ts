// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import { observeResize } from "./mprResize";

/** 偽の ResizeObserver と rAF（手で進める）。 */
function fakes() {
  const roInstances: FakeRO[] = [];
  class FakeRO {
    cb: ResizeObserverCallback;
    observed: Element[] = [];
    disconnected = false;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      roInstances.push(this);
    }
    observe(el: Element) { this.observed.push(el); }
    disconnect() { this.disconnected = true; }
    fire(sizes: Array<[Element, number, number]>) {
      this.cb(sizes.map(([target, w, h]) => ({ target, contentRect: { width: w, height: h } as DOMRectReadOnly }) as ResizeObserverEntry), this as unknown as ResizeObserver);
    }
  }
  const frames: Array<() => void> = [];
  let nextId = 1;
  const cancelled = new Set<number>();
  const ids: number[] = [];
  const raf = (cb: () => void) => {
    const id = nextId++;
    ids.push(id);
    frames.push(() => { if (!cancelled.has(id)) cb(); });
    return id;
  };
  const cancel = (id: number) => { cancelled.add(id); };
  const flush = () => { const f = frames.splice(0); f.forEach((x) => x()); };
  return { FakeRO, roInstances, raf, cancel, flush };
}

const el = () => document.createElement("div");

describe("observeResize（MPR のセルのサイズ変化）", () => {
  it("初回の通知で 1 回（次のフレームで）呼ぶ", () => {
    const f = fakes();
    let n = 0;
    const [a, b, c] = [el(), el(), el()];
    observeResize([a, b, c], () => n++, { RO: f.FakeRO as never, raf: f.raf, cancel: f.cancel });
    f.roInstances[0].fire([[a, 400, 300], [b, 400, 300], [c, 400, 300]]);
    expect(n).toBe(0); // rAF まで待つ
    f.flush();
    expect(n).toBe(1); // 3 面が同じフレームで通知されても 1 回
  });

  it("同じサイズの再通知は無視、高さだけ変わったときは呼ぶ", () => {
    const f = fakes();
    let n = 0;
    const a = el();
    observeResize([a], () => n++, { RO: f.FakeRO as never, raf: f.raf, cancel: f.cancel });
    f.roInstances[0].fire([[a, 400, 300]]);
    f.flush();
    f.roInstances[0].fire([[a, 400, 300]]);
    f.flush();
    expect(n).toBe(1);
    f.roInstances[0].fire([[a, 400, 264]]); // 読み出し行などで高さだけ縮む
    f.flush();
    expect(n).toBe(2);
  });

  it("幅か高さが 0 のセル（隠れた面）は無視する", () => {
    const f = fakes();
    let n = 0;
    const a = el();
    observeResize([a], () => n++, { RO: f.FakeRO as never, raf: f.raf, cancel: f.cancel });
    f.roInstances[0].fire([[a, 0, 300]]);
    f.roInstances[0].fire([[a, 400, 0]]);
    f.flush();
    expect(n).toBe(0);
  });

  it("要素を全部観測し、解除で disconnect と保留中の rAF を取り消す", () => {
    const f = fakes();
    let n = 0;
    const [a, b] = [el(), el()];
    const stop = observeResize([a, null, b], () => n++, { RO: f.FakeRO as never, raf: f.raf, cancel: f.cancel });
    expect(f.roInstances[0].observed).toEqual([a, b]);
    f.roInstances[0].fire([[a, 400, 300]]);
    stop();
    f.flush();
    expect(n).toBe(0); // 解除後は呼ばない
    expect(f.roInstances[0].disconnected).toBe(true);
  });
});
