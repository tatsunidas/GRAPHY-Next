/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { rawRequiredBytes, rawSizeStatus, type RawDims } from "./rawSize";

const base: RawDims = { width: 64, height: 48, slices: 10, phases: 1, type: "int16", offset: 512 };

describe("rawRequiredBytes", () => {
  it("読み飛ばし＋幅×高さ×枚数×時相×型の大きさ", () => {
    expect(rawRequiredBytes(base)).toBe(512 + 64 * 48 * 10 * 2);
    expect(rawRequiredBytes({ ...base, type: "float64", phases: 3, offset: 0 })).toBe(64 * 48 * 10 * 3 * 8);
    expect(rawRequiredBytes({ ...base, type: "uint8" })).toBe(512 + 64 * 48 * 10);
  });

  it("正しくない入力は null", () => {
    expect(rawRequiredBytes({ ...base, width: 0 })).toBeNull();
    expect(rawRequiredBytes({ ...base, slices: 2.5 })).toBeNull();
    expect(rawRequiredBytes({ ...base, offset: -1 })).toBeNull();
    expect(rawRequiredBytes({ ...base, phases: Number.NaN })).toBeNull();
    expect(rawRequiredBytes({ ...base, width: 2 ** 40, height: 2 ** 20 })).toBeNull();
  });
});

describe("rawSizeStatus", () => {
  it("ちょうど・1 バイト不足・余り", () => {
    expect(rawSizeStatus(100, 100)).toEqual({ kind: "exact" });
    expect(rawSizeStatus(101, 100)).toEqual({ kind: "short", missing: 1 });
    expect(rawSizeStatus(100, 107)).toEqual({ kind: "trailing", extra: 7 });
  });
});
