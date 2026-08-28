/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * A7 の色マップ（`vesselColorMap`）。
 *
 * <p>守りたいのは「**無い値を色で埋めない**」こと。血管に色が乗ると、それだけで
 * 「そこは解析された」と読まれる——値の無い区間が色付くのは、数字の捏造と同じ重さの誤り。
 */
import { describe, expect, it } from "vitest";
import {
  NO_VALUE_RGB,
  normalizeValue,
  rampColor,
  resampleColorsNearest,
  segmentValues,
  valuesToRgb,
} from "./vesselColorMap";

const gray = [
  Math.round(NO_VALUE_RGB[0] * 255),
  Math.round(NO_VALUE_RGB[1] * 255),
  Math.round(NO_VALUE_RGB[2] * 255),
];

describe("rampColor", () => {
  it("両端は赤と青（range[0] が赤・低いほど悪い量に合わせてある）", () => {
    const lo = rampColor(0);
    const hi = rampColor(1);
    expect(lo[0]).toBeGreaterThan(lo[2]); // 赤 > 青
    expect(hi[2]).toBeGreaterThan(hi[0]); // 青 > 赤
  });

  it("範囲外はクランプする（外挿して存在しない色を作らない）", () => {
    expect(rampColor(-5)).toEqual(rampColor(0));
    expect(rampColor(5)).toEqual(rampColor(1));
  });

  it("非有限はグレー（＝値なし）", () => {
    expect(rampColor(NaN)).toEqual(NO_VALUE_RGB);
    expect(rampColor(Infinity)).toEqual(NO_VALUE_RGB);
  });
});

describe("normalizeValue", () => {
  it("範囲が退化していたら正規化しない（全点同じ色にするより「作れなかった」と言う）", () => {
    expect(normalizeValue(0.8, [1, 1])).toBeNaN();
  });

  it("非有限の値・範囲は NaN", () => {
    expect(normalizeValue(NaN, [0, 1])).toBeNaN();
    expect(normalizeValue(0.5, [0, NaN])).toBeNaN();
  });

  it("線形に写す", () => {
    expect(normalizeValue(0.75, [0.5, 1])).toBeCloseTo(0.5, 12);
  });
});

describe("segmentValues", () => {
  it("値が来なかった点は NaN のまま（埋めない）", () => {
    const v = segmentValues(4, [{ index: 1, value: 0.9 }]);
    // Float32Array なので値そのものは丸まる。ここで見たいのは「1 点だけ入った」こと。
    expect(Array.from(v).map((x) => Number.isNaN(x))).toEqual([true, false, true, true]);
    expect(v[1]).toBeCloseTo(0.9, 6);
  });

  it("範囲外・非整数・非有限の添字/値は取り込まない", () => {
    const v = segmentValues(3, [
      { index: -1, value: 1 },
      { index: 3, value: 1 },
      { index: 1.5, value: 1 },
      { index: 0, value: NaN },
    ]);
    expect(Array.from(v).every((x) => Number.isNaN(x))).toBe(true);
  });
});

describe("resampleColorsNearest", () => {
  it("最近傍なので「値なし」のグレーと実際の色が混ざらない", () => {
    // 値ありの赤 1 点と、値なしのグレー 1 点。
    const src = valuesToRgb(Float32Array.from([0, NaN]), [0, 1]);
    const out = resampleColorsNearest(src, 5);
    const colors: number[][] = [];
    for (let i = 0; i < 5; i++) colors.push([out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]);
    // 出てくるのは「元の 2 色」だけ。中間色は 1 つも生まれない。
    const distinct = new Set(colors.map((c) => c.join(",")));
    expect(distinct.size).toBe(2);
    expect(colors[0]).toEqual([src[0], src[1], src[2]]);
    expect(colors[4]).toEqual(gray);
  });

  it("両端が保存される（狭窄の位置が端でずれない）", () => {
    const src = valuesToRgb(Float32Array.from([0, 0.5, 1]), [0, 1]);
    const out = resampleColorsNearest(src, 21);
    expect([out[0], out[1], out[2]]).toEqual([src[0], src[1], src[2]]);
    expect([out[60], out[61], out[62]]).toEqual([src[6], src[7], src[8]]);
  });

  it("元が空なら全部グレー（色を発明しない）", () => {
    const out = resampleColorsNearest(new Uint8Array(0), 2);
    expect(Array.from(out)).toEqual([...gray, ...gray]);
  });
});

describe("valuesToRgb", () => {
  it("値なしはグレーになる", () => {
    const out = valuesToRgb(Float32Array.from([NaN]), [0, 1]);
    expect(Array.from(out)).toEqual(gray);
  });
});
