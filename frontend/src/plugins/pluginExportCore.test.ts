/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 書き出し層（H22 / H23）の純ロジックの検証。
 *
 * <p>ここで押さえたいのは「静かに間違える」経路:
 * 量子化の往復・NaN の扱い・法線と平行でない格子。
 */
import { describe, expect, it } from "vitest";
import { gridFrameOffsets, quantizeDoseGrid, sliceMask } from "./pluginExportCore";

describe("sliceMask", () => {
  it("前景のある z だけを平面として返す", () => {
    const dims: [number, number, number] = [2, 2, 3];
    const data = new Uint8Array(12);
    data[4] = 1; // z=1 の 1 ボクセル
    data[7] = 3; // z=1 の別ボクセル（0 以外は前景）
    const out = sliceMask(dims, data);
    expect(out.planes.map((p) => p.z)).toEqual([1]);
    expect(out.foregroundVoxels).toBe(2);
    // 値は 0/1 に正規化される（3 のまま送らない）。
    expect(Array.from(out.planes[0].mask)).toEqual([1, 0, 0, 1]);
  });

  it("前景ゼロなら平面を作らない", () => {
    const out = sliceMask([2, 2, 2], new Uint8Array(8));
    expect(out.planes).toHaveLength(0);
    expect(out.foregroundVoxels).toBe(0);
  });

  it("格子と長さが合わなければ落とす", () => {
    expect(() => sliceMask([2, 2, 2], new Uint8Array(4))).toThrow();
  });
});

describe("quantizeDoseGrid", () => {
  it("格納値 × 係数で元の線量に戻る", () => {
    const data = new Float32Array([0, 0.5, 1.0, 2.0]);
    const q = quantizeDoseGrid(data);
    expect(q.doseGridScaling).toBeCloseTo(2.0 / 65535, 15);
    const view = new DataView(q.bytes.buffer);
    for (let i = 0; i < data.length; i++) {
      const back = view.getUint16(i * 2, true) * q.doseGridScaling;
      // 往復誤差は係数の半分を超えない（それが量子化の定義）。
      expect(Math.abs(back - data[i])).toBeLessThanOrEqual(q.quantizationErrorGy);
    }
    // 最大値は 65535 に張り付く（段を使い切っている）。
    expect(view.getUint16(3 * 2, true)).toBe(65535);
  });

  it("相対誤差は最大値によらず 1/65535 に収まる", () => {
    for (const max of [0.001, 1, 1000]) {
      const q = quantizeDoseGrid(new Float32Array([0, max / 3, max]));
      expect(q.quantizationErrorGy / max).toBeCloseTo(0.5 / 65535, 12);
    }
  });

  it("NaN があるのに背景が未指定なら拒否する", () => {
    const data = new Float32Array([1, NaN, 2]);
    // 🔴 0 Gy で黙って埋めると「線量が無かった」と読まれる。
    expect(() => quantizeDoseGrid(data)).toThrow(/backgroundGy/);
  });

  it("背景を指定すれば埋めて、埋めた数を返す", () => {
    const data = new Float32Array([1, NaN, NaN, 2]);
    const q = quantizeDoseGrid(data, 0);
    expect(q.filledVoxels).toBe(2);
    const view = new DataView(q.bytes.buffer);
    expect(view.getUint16(1 * 2, true)).toBe(0);
  });

  it("全域ゼロは拒否する", () => {
    expect(() => quantizeDoseGrid(new Float32Array([0, 0, 0]))).toThrow();
  });

  it("負の線量は拒否する", () => {
    expect(() => quantizeDoseGrid(new Float32Array([-1, 1]))).toThrow();
  });
});

describe("gridFrameOffsets", () => {
  const axial = [1, 0, 0, 0, 1, 0];

  it("軸位断は 0 始まりの等間隔になる", () => {
    const out = gridFrameOffsets(axial, [0, 0, 4.42], 3);
    expect(out).not.toBeNull();
    expect(out![0]).toBe(0);
    expect(out![1]).toBeCloseTo(4.42, 12);
    expect(out![2]).toBeCloseTo(8.84, 12);
  });

  it("足→頭と反対向きでも符号込みで返す", () => {
    const out = gridFrameOffsets(axial, [0, 0, -3], 2);
    expect(out![1]).toBeCloseTo(-3, 12);
  });

  it("法線と平行でない格子は書けないので null", () => {
    // 傾いた収集（面内へずれながらスライスが進む）。丸めて書くと受け側で静かにずれる。
    const out = gridFrameOffsets(axial, [2, 0, 4], 3);
    expect(out).toBeNull();
  });

  it("スライスが 1 枚なら移動量が無くても書ける", () => {
    const out = gridFrameOffsets(axial, [0, 0, 0], 1);
    expect(out).toEqual([0]);
  });
});
