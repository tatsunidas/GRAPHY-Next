/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPreScaleFloatFix, applySetPixelDataTypeFix } from "./vite.cornerstonePreScaleFix";
import getPixelDataTypeFromMinMax from "./node_modules/@cornerstonejs/dicom-image-loader/dist/esm/shared/getPixelDataTypeFromMinMax.js";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "node_modules/@cornerstonejs/dicom-image-loader/dist/esm/decodeImageFrameWorker.js"),
  "utf8",
);

/** ソース中の関数 1 つ（次の `function` の直前まで）を取り出す。 */
function fn(code: string, name: string): string {
  const i = code.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name} が無い`);
  const j = code.indexOf("\nfunction ", i + 1);
  return code.slice(i, j < 0 ? undefined : j);
}

/** 当てた後の `_handlePreScaleSetup` を、本物の周辺関数と組んで実行できる形にする。 */
function build(code: string) {
  const body = ["_validateScalingParameters", "_calculateScaledMinMax", "_getDefaultPixelDataArray", "_handlePreScaleSetup"]
    .map((n) => fn(code, n)).join("\n");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("getPixelDataTypeFromMinMax", `${body}\nreturn _handlePreScaleSetup;`)(getPixelDataTypeFromMinMax) as
    (options: unknown, min: number, max: number, frame: { pixelData: ArrayLike<number> & { length: number } }) => ArrayLike<number>;
}

const opts = (p: Record<string, unknown>) => ({ preScale: { scalingParameters: { rescaleSlope: 1, rescaleIntercept: 0, ...p } } });

describe("applyPreScaleFloatFix", () => {
  const fixed = applyPreScaleFloatFix(SRC);
  const before = build(SRC);
  const after = build(fixed);

  it("置換は 1 回だけ当たり、当てたあとも JS として読める", () => {
    expect(fixed).not.toBe(SRC);
    expect(fixed.split("GRAPHY patch").length - 1).toBe(1);
    expect(() => build(fixed)).not.toThrow();
  });

  it("【再現】修正前: slope 0.5 で最小・最大が整数だと Uint16Array になり、694.5 が切り捨てられる", () => {
    const frame = { pixelData: Uint16Array.from([200, 1389, 2200]) }; // ×0.5 = 100, 694.5, 1100
    const a = before(opts({ rescaleSlope: 0.5 }), 200, 2200, frame);
    expect(a).toBeInstanceOf(Uint16Array);
  });

  it("修正後: 係数に小数があれば Float32Array（694.5 が残る材料になる）", () => {
    const frame = { pixelData: Uint16Array.from([200, 1389, 2200]) };
    const a = after(opts({ rescaleSlope: 0.5 }), 200, 2200, frame);
    expect(a).toBeInstanceOf(Float32Array);
    expect(Array.from(a)).toEqual([200, 1389, 2200]); // 元の整数値がそのまま入り、スケールはこの後に掛かる
  });

  it("【負例】係数が全部整数（CT: slope 1・intercept −1024）なら修正前と同じ型のまま", () => {
    const frame = { pixelData: Uint16Array.from([0, 1024, 3000]) };
    const o = opts({ rescaleSlope: 1, rescaleIntercept: -1024 });
    const a = before(o, 0, 3000, frame);
    const b = after(o, 0, 3000, frame);
    expect(b.constructor).toBe(a.constructor);
    expect(b).toBeInstanceOf(Int16Array);
  });

  it("SUV 係数（小数）があるときも Float32Array", () => {
    const frame = { pixelData: Uint16Array.from([0, 10]) };
    const a = after({ preScale: { scalingParameters: { rescaleSlope: 1, rescaleIntercept: 0, modality: "PT", suvbw: 0.00037 } } },
      0, 10, frame);
    expect(a).toBeInstanceOf(Float32Array);
  });

  it("【負例】置換対象が無い・2 個ある入力では throw する（版が変わったことに気づける）", () => {
    expect(() => applyPreScaleFloatFix("function other() {}")).toThrow(/置換対象が 0 個/);
    expect(() => applyPreScaleFloatFix(SRC + "\n" + SRC)).toThrow(/置換対象が 2 個/);
  });
});

const SET_SRC = fs.readFileSync(
  path.resolve(__dirname, "node_modules/@cornerstonejs/dicom-image-loader/dist/esm/imageLoader/setPixelDataType.js"),
  "utf8",
);

/** 当てた後の `setPixelDataType` を、本物の `getPixelDataTypeFromMinMax` と組んで実行できる形にする。 */
function buildSetType(code: string) {
  const i = code.indexOf("function setPixelDataType(");
  const body = code.slice(i, code.indexOf("\nexport default"));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("getPixelDataTypeFromMinMax", `${body}\nreturn setPixelDataType;`)(getPixelDataTypeFromMinMax) as
    (frame: { pixelData: ArrayLike<number>; smallestPixelValue: number; largestPixelValue: number }) => void;
}

describe("applySetPixelDataTypeFix（デコード後にメインスレッドで型を決め直す 2 か所目）", () => {
  const fixed = applySetPixelDataTypeFix(SET_SRC);
  const before = buildSetType(SET_SRC);
  const after = buildSetType(fixed);
  // ワーカーが返した、スケール済みの Float32Array（最小 100・最大 1100 は整数、間に 694.5）
  const scaled = () => ({ pixelData: Float32Array.from([100, 694.5, 1100]), smallestPixelValue: 100, largestPixelValue: 1100 });

  it("【再現】修正前: Float32Array を Uint16Array に作り直し、694.5 が 694 に切り捨てられる", () => {
    const f = scaled();
    before(f);
    expect(f.pixelData).toBeInstanceOf(Uint16Array);
    expect(Array.from(f.pixelData)).toEqual([100, 694, 1100]);
  });

  it("修正後: Float32Array のまま、694.5 が残る", () => {
    const f = scaled();
    after(f);
    expect(f.pixelData).toBeInstanceOf(Float32Array);
    expect(Array.from(f.pixelData)).toEqual([100, 694.5, 1100]);
  });

  it("【負例】整数のデータは修正前と同じ型になる（Uint16 / Int16）", () => {
    for (const [data, min, max] of [[Uint16Array.from([0, 1024, 3000]), 0, 3000], [Int16Array.from([-5, 10]), -5, 10]] as const) {
      const a = { pixelData: data, smallestPixelValue: min, largestPixelValue: max };
      const b = { pixelData: data, smallestPixelValue: min, largestPixelValue: max };
      before(a);
      after(b);
      expect(b.pixelData.constructor).toBe(a.pixelData.constructor);
    }
  });

  it("【負例】置換対象が無い入力では throw する", () => {
    expect(() => applySetPixelDataTypeFix("function other() {}")).toThrow(/setPixelDataType\.js の置換対象が 0 個/);
  });
});
