/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetFusionProbeStore,
  getFusionProbeData,
  hasFusionProbe,
  registerFusionProbe,
  sampleFusionValue,
  setFusionProbeData,
  subscribeFusionProbe,
  unregisterFusionProbe,
  type FusionProbeData,
} from "./fusionProbe";

/** cols×rows の連番データ（値 = j*cols + i）。 */
function grid(cols: number, rows: number, extra: Partial<FusionProbeData> = {}): FusionProbeData {
  const values = new Float32Array(cols * rows);
  for (let i = 0; i < values.length; i++) values[i] = i;
  return { values, cols, rows, unit: "HU", scale: 1, suv: false, ...extra };
}

beforeEach(() => {
  _resetFusionProbeStore();
});

describe("sampleFusionValue", () => {
  it("格子が一致するとき（空間 Fusion）は添字をそのまま引く", () => {
    const data = grid(4, 3);
    expect(sampleFusionValue(data, 0, 0, 4, 3)?.value).toBe(0);
    expect(sampleFusionValue(data, 2, 1, 4, 3)?.value).toBe(1 * 4 + 2);
    // 連続 index は最近傍の格子点へ丸める。
    expect(sampleFusionValue(data, 2.4, 1.4, 4, 3)?.value).toBe(1 * 4 + 2);
    expect(sampleFusionValue(data, 2.6, 0.6, 4, 3)?.value).toBe(1 * 4 + 3);
  });

  it("格子が違うとき（非空間フォールバック）は画素中心どうしを比例対応させる", () => {
    // 前景 2×2 を base 4×4 へ引き伸ばした状態。base の左半分が前景の列 0。
    const data = grid(2, 2);
    expect(sampleFusionValue(data, 0, 0, 4, 4)?.value).toBe(0); // (0,0)
    expect(sampleFusionValue(data, 1, 0, 4, 4)?.value).toBe(0); // まだ列 0
    expect(sampleFusionValue(data, 2, 0, 4, 4)?.value).toBe(1); // 列 1 へ
    expect(sampleFusionValue(data, 3, 3, 4, 4)?.value).toBe(3); // (1,1)
  });

  it("前景が無い画素（NaN）と範囲外は null", () => {
    const data = grid(4, 3);
    data.values[5] = NaN;
    expect(sampleFusionValue(data, 1, 1, 4, 3)).toBeNull();
    expect(sampleFusionValue(data, -1, 0, 4, 3)).toBeNull();
    expect(sampleFusionValue(data, 0, 9, 4, 3)).toBeNull();
    expect(sampleFusionValue(null, 0, 0, 4, 3)).toBeNull();
  });

  it("SUV 校正済みなら乗数を掛けた値と単位を返す", () => {
    const data = grid(2, 1, { unit: "SUVbw", scale: 0.5, suv: true });
    const s = sampleFusionValue(data, 1, 0, 2, 1);
    expect(s).toEqual({ value: 0.5, unit: "SUVbw", suv: true });
  });
});

describe("レジストリ", () => {
  it("登録するとビューポートに紐づき、解除で消える", () => {
    expect(hasFusionProbe("vp1")).toBe(false);
    registerFusionProbe("vp1");
    expect(hasFusionProbe("vp1")).toBe(true);
    // 値が未着でも「オーバーレイは載っている」＝二段表示にする。
    expect(getFusionProbeData("vp1")).toBeNull();
    unregisterFusionProbe("vp1");
    expect(hasFusionProbe("vp1")).toBe(false);
  });

  it("着脱のときだけ通知し、値の差し替えでは通知しない", () => {
    let n = 0;
    const off = subscribeFusionProbe(() => { n++; });
    registerFusionProbe("vp1");
    expect(n).toBe(1);
    setFusionProbeData("vp1", grid(2, 2));
    setFusionProbeData("vp1", null);
    expect(n).toBe(1); // 再構成のたびに base を再レンダさせない
    unregisterFusionProbe("vp1");
    expect(n).toBe(2);
    off();
  });

  it("値を先に置かれても取りこぼさない（登録を兼ねる）", () => {
    setFusionProbeData("vp2", grid(2, 2));
    expect(hasFusionProbe("vp2")).toBe(true);
    expect(getFusionProbeData("vp2")?.cols).toBe(2);
  });

  it("解除したビューポートの値は残らない", () => {
    setFusionProbeData("vp3", grid(2, 2));
    unregisterFusionProbe("vp3");
    expect(getFusionProbeData("vp3")).toBeNull();
  });
});
