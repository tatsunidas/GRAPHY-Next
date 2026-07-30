/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { chooseRescale, encodeFrames, finiteRange, framePixelsBase64 } from "./derivedSeriesEncode";

describe("finiteRange", () => {
  it("NaN / Infinity を無視して値域を出す", () => {
    expect(finiteRange([new Float32Array([NaN, -5, 10, Infinity])])).toEqual({ min: -5, max: 10 });
  });

  it("複数フレームを横断する", () => {
    expect(finiteRange([new Float32Array([0, 1]), new Float32Array([-3, 7])])).toEqual({ min: -3, max: 7 });
  });

  it("有効値が無ければ null", () => {
    expect(finiteRange([new Float32Array([NaN, NaN])])).toBeNull();
    expect(finiteRange([])).toBeNull();
  });
});

describe("chooseRescale", () => {
  it("整数かつ Int16 に収まるなら恒等（HU をそのまま保つ）", () => {
    expect(chooseRescale({ min: -1024, max: 3000 }, true)).toEqual({ slope: 1, intercept: 0, identity: true });
  });

  it("小数なら Int16 全域へ線形写像する", () => {
    const r = chooseRescale({ min: 0, max: 1 }, false);
    expect(r.identity).toBe(false);
    expect(r.slope).toBeCloseTo(1 / 65534, 12);
    // stored=-32768 が min、stored=+32766 が max に戻ること。
    expect(-32768 * r.slope + r.intercept).toBeCloseTo(0, 10);
    expect(32766 * r.slope + r.intercept).toBeCloseTo(1, 10);
  });

  it("整数でも Int16 を超えるなら量子化する", () => {
    expect(chooseRescale({ min: 0, max: 100000 }, true).identity).toBe(false);
  });

  it("定数マップ・値域なしは恒等", () => {
    expect(chooseRescale({ min: 5, max: 5 }, false).identity).toBe(true);
    expect(chooseRescale(null, false).identity).toBe(true);
  });
});

describe("encodeFrames", () => {
  it("HU のような整数はそのまま入る（量子化誤差を足さない）", () => {
    const { frames, slope, intercept, identity } = encodeFrames([new Float32Array([-1024, 0, 40, 1331])]);
    expect(identity).toBe(true);
    expect(slope).toBe(1);
    expect(intercept).toBe(0);
    expect(Array.from(frames[0])).toEqual([-1024, 0, 40, 1331]);
  });

  it("0〜1 のマップは復元誤差が十分小さい", () => {
    const src = new Float32Array([0, 0.25, 0.5, 0.75, 1]);
    const { frames, slope, intercept } = encodeFrames([src]);
    for (let i = 0; i < src.length; i++) {
      expect(frames[0][i] * slope + intercept).toBeCloseTo(src[i], 4);
    }
  });

  it("NaN は値域の最小値（背景）になる", () => {
    const { frames, slope, intercept } = encodeFrames([new Float32Array([NaN, 0.5, 1])]);
    expect(frames[0][0] * slope + intercept).toBeCloseTo(0.5, 4);
    // 有効値の最小が 0.5 なので、NaN もそこへ寄る（＝下端）。
    expect(frames[0][0]).toBe(frames[0][1]);
  });

  it("Int16 の範囲を超える値は飽和させる（溢れさせない）", () => {
    const { frames } = encodeFrames([new Float32Array([-100000, 100000])]);
    for (const v of frames[0]) {
      expect(v).toBeGreaterThanOrEqual(-32768);
      expect(v).toBeLessThanOrEqual(32767);
    }
  });

  it("フレーム数・長さを保つ", () => {
    const { frames } = encodeFrames([new Float32Array(4), new Float32Array(4)]);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveLength(4);
  });
});

describe("framePixelsBase64", () => {
  it("リトルエンディアンの Int16 として符号化する", () => {
    // 1 = 0x0001 → LE で 01 00、-1 = 0xFFFF → FF FF
    const b64 = framePixelsBase64(new Int16Array([1, -1]));
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(Array.from(bytes)).toEqual([1, 0, 255, 255]);
  });

  it("大きな配列でも壊れない（チャンク詰め）", () => {
    const px = new Int16Array(512 * 512);
    px[px.length - 1] = 1234;
    const bytes = Uint8Array.from(atob(framePixelsBase64(px)), (c) => c.charCodeAt(0));
    expect(bytes).toHaveLength(px.length * 2);
    expect(new Int16Array(bytes.buffer)[px.length - 1]).toBe(1234);
  });
});
