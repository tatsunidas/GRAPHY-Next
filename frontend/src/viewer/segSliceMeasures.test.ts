/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import { segSliceMeasures } from "./segSliceMeasures";

type V3 = [number, number, number];
const AXIAL = [1, 0, 0, 0, 1, 0];
const z = (zs: number[]): V3[] => zs.map((v) => [-48, -50, v]);
const cum = (steps: number[]) => steps.reduce<number[]>((acc, s) => [...acc, acc[acc.length - 1] + s], [0]);

describe("segSliceMeasures（SEG の SliceThickness・SpacingBetweenSlices）", () => {
  it("一様（2.5 mm）・厚み 5 mm（重なりのある CT）: SBS = 2.5（中心間）、厚み = 5（source の公称厚）", () => {
    const m = segSliceMeasures(z(cum([2.5, 2.5, 2.5, 2.5])), AXIAL, 5);
    expect(m.spacingBetweenSlices).toBeCloseTo(2.5, 12);
    expect(m.sliceThickness).toBe(5);
  });
  it("一様で source に厚みが無ければ、厚みは間隔の中央値", () => {
    const m = segSliceMeasures(z(cum([3, 3, 3])), AXIAL, null);
    expect(m.sliceThickness).toBeCloseTo(3, 12);
    expect(m.spacingBetweenSlices).toBeCloseTo(3, 12);
  });
  it("不等間隔（2.0, 3.5, 2.5, 3.0, 2.0, 3.5）: SBS は書かない（0）。旧式は先頭 2 枚の 2.0 を書いていた", () => {
    const ipps = z(cum([2.0, 3.5, 2.5, 3.0, 2.0, 3.5]));
    const m = segSliceMeasures(ipps, AXIAL, 2.0);
    expect(m.spacingBetweenSlices).toBe(0);
    const oldValue = Math.hypot(ipps[1][0] - ipps[0][0], ipps[1][1] - ipps[0][1], ipps[1][2] - ipps[0][2]); // 旧式（負例）
    expect(oldValue).toBeCloseTo(2.0, 12);
  });
  it("1 枚欠損（2.5 と 5.0 が混ざる）: SBS は書かない", () => {
    expect(segSliceMeasures(z(cum([2.5, 2.5, 5.0, 2.5, 2.5])), AXIAL, 2.5).spacingBetweenSlices).toBe(0);
  });
  it("逆順（位置が減る順）でも一様なら同じ値", () => {
    const ipps = z(cum([2.5, 2.5, 2.5, 2.5])).reverse();
    expect(segSliceMeasures(ipps, AXIAL, 2.5).spacingBetweenSlices).toBeCloseTo(2.5, 12);
  });
  it("順不同でも法線方向に並べ替えて隣接同士を結ぶ（不等間隔の判定が入れ替わらない）", () => {
    const ordered = z(cum([2.5, 2.5, 2.5, 2.5]));
    const shuffled = [ordered[3], ordered[0], ordered[4], ordered[1], ordered[2]];
    expect(segSliceMeasures(shuffled, AXIAL, 2.5).spacingBetweenSlices).toBeCloseTo(2.5, 12);
  });
  it("チルト: IPP が (0, 2.5·sin15°, 2.5·cos15°) ずつ進む → SBS = 中心間距離 2.5（DICOM の定義。法線方向の 2.4148 ではない）", () => {
    const t = (15 * Math.PI) / 180;
    const ipps: V3[] = [0, 1, 2, 3, 4].map((k) => [0, 2.5 * Math.sin(t) * k, 2.5 * Math.cos(t) * k]);
    expect(segSliceMeasures(ipps, AXIAL, 2.5).spacingBetweenSlices).toBeCloseTo(2.5, 12);
  });
  it("斜位 IOP でも、IPP が法線方向に進むなら中心間距離", () => {
    const iop = [0.9, 0.436, 0, -0.436, 0.9, 0]; // z 軸まわりの回転。法線は +z
    expect(segSliceMeasures(z(cum([2, 2, 2])), iop, 2).spacingBetweenSlices).toBeCloseTo(2, 12);
  });
  it("IPP の丸め（±0.005 mm）は一様として扱う", () => {
    const zs = cum([2.5, 2.5, 2.5, 2.5]).map((v, i) => v + (i % 2 ? 0.005 : -0.005));
    expect(segSliceMeasures(z(zs), AXIAL, 2.5).spacingBetweenSlices).toBeGreaterThan(2.4);
  });
  it("1 枚だけ・IPP なし: SBS は書かない。厚みは source の値、無ければ 1", () => {
    expect(segSliceMeasures(z([5]), AXIAL, 3)).toEqual({ sliceThickness: 3, spacingBetweenSlices: 0 });
    expect(segSliceMeasures([undefined, undefined], AXIAL, null)).toEqual({ sliceThickness: 1, spacingBetweenSlices: 0 });
  });
});
