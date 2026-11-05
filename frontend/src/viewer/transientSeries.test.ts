/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it, vi } from "vitest";
import {
  createTransientHandle,
  notifyTransientClosed,
  notifyTransientDim,
  removedTransient,
  syntheticSeriesUid,
  validateTransientSpec,
  type TransientOpened,
} from "./transientSeries";

const tr = (uid: string): TransientOpened => ({
  tileId: "t-" + uid, pluginId: "p", pluginName: "P", label: "L", seriesUid: uid, maps: [], layout: {} as never, scaleBar: true,
});

describe("removedTransient", () => {
  const a = tr("2.25.1");
  const b = tr("2.25.2");
  it("一時タイルが消えたら返す", () => {
    expect(removedTransient([{ transient: a }, {}], [{}])).toEqual([a]);
  });
  it("無関係なタイルが消えても空", () => {
    expect(removedTransient([{ transient: a }, {}], [{ transient: a }])).toEqual([]);
  });
  it("両方消えたら両方", () => {
    expect(removedTransient([{ transient: a }, { transient: b }], [])).toEqual([a, b]);
  });
  it("連結タイル（transient なし）は対象にしない", () => {
    expect(removedTransient([{ concat: {} } as never], [])).toEqual([]);
  });
  it("新しく増えただけなら空", () => {
    expect(removedTransient([], [{ transient: a }])).toEqual([]);
  });
});

const vol = (dims: [number, number, number]) => ({ data: new Float32Array(0), dims, indexToWorld: [] });
const map = (name: string, dims: [number, number, number], window: { center: number; width: number } | null = { center: 1, width: 2 }) =>
  ({ name, volume: vol(dims), window: window as unknown as { center: number; width: number } });

describe("validateTransientSpec", () => {
  it("正しい指定は通る", () => {
    expect(() => validateTransientSpec({ maps: [map("a", [4, 3, 5]), map("b", [4, 3, 5])] }, 5, { rows: 3, columns: 4 })).not.toThrow();
  });
  it("maps が空なら落ちる", () => {
    expect(() => validateTransientSpec({ maps: [] }, 5)).toThrow(/maps is empty/);
  });
  it("参照とスライス数が違えば落ちる", () => {
    expect(() => validateTransientSpec({ maps: [map("a", [4, 3, 6])] }, 5)).toThrow(/6 slices.*5/);
  });
  it("window が無い・幅が 0 なら落ちる", () => {
    expect(() => validateTransientSpec({ maps: [map("a", [4, 3, 5], null)] }, 5)).toThrow(/window/);
    expect(() => validateTransientSpec({ maps: [map("a", [4, 3, 5], { center: 0, width: 0 })] }, 5)).toThrow(/window/);
  });
  it("マップ間で dims が違えば落ちる", () => {
    expect(() => validateTransientSpec({ maps: [map("a", [4, 3, 5]), map("b", [5, 3, 5])] }, 5)).toThrow(/differ/);
  });
  it("面内の大きさが参照と違えば落ちる", () => {
    expect(() => validateTransientSpec({ maps: [map("a", [4, 3, 5])] }, 5, { rows: 4, columns: 3 })).toThrow(/in plane/);
  });
  it("initialC が範囲外なら落ちる", () => {
    expect(() => validateTransientSpec({ maps: [map("a", [4, 3, 5])], initialC: 1 }, 5)).toThrow(/initialC/);
  });
});

describe("syntheticSeriesUid", () => {
  it("2.25.<10 進> で毎回違う", () => {
    const u = syntheticSeriesUid();
    expect(u).toMatch(/^2\.25\.[1-9]\d+$/);
    expect(u.length).toBeLessThanOrEqual(64);
    expect(syntheticSeriesUid()).not.toBe(u);
  });
});

describe("ハンドル", () => {
  const make = (uid: string) => {
    const setMapDisplay = vi.fn();
    const requestClose = vi.fn();
    return { h: createTransientHandle({ tileId: "t", seriesUid: uid, setMapDisplay, requestClose }), setMapDisplay, requestClose };
  };
  it("onClose は 1 度だけ・closed が立つ・後の通知は無視される", () => {
    const { h, setMapDisplay } = make("2.25.10");
    const onClose = vi.fn();
    const onDim = vi.fn();
    h.onClose(onClose);
    h.onDimChange(onDim);
    notifyTransientDim("2.25.10", 1, 2);
    notifyTransientDim("2.25.10", 1, 2); // 同値は捨てる
    notifyTransientDim("2.25.10", 1, 3);
    expect(onDim.mock.calls).toEqual([[{ c: 1, z: 2 }], [{ c: 1, z: 3 }]]);
    expect(h.closed).toBe(false);
    notifyTransientClosed("2.25.10");
    notifyTransientClosed("2.25.10");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.closed).toBe(true);
    notifyTransientDim("2.25.10", 0, 0);
    expect(onDim).toHaveBeenCalledTimes(2);
    h.setMapDisplay(0, { colormap: null });
    expect(setMapDisplay).not.toHaveBeenCalled();
  });
  it("close() は閉じる要求を出し、閉じた後は出さない", () => {
    const { h, requestClose } = make("2.25.11");
    h.close();
    expect(requestClose).toHaveBeenCalledTimes(1);
    notifyTransientClosed("2.25.11");
    h.close();
    expect(requestClose).toHaveBeenCalledTimes(1);
  });
  it("購読解除すると通知されない・閉じた後の onClose は即呼ぶ", () => {
    const { h } = make("2.25.12");
    const onDim = vi.fn();
    h.onDimChange(onDim)();
    notifyTransientDim("2.25.12", 0, 1);
    expect(onDim).not.toHaveBeenCalled();
    notifyTransientClosed("2.25.12");
    const late = vi.fn();
    h.onClose(late);
    expect(late).toHaveBeenCalledTimes(1);
  });
});
