/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { sliceSpacingReport, sopIndexMap } from "./sliceLayout";
import { framesToLabelVolume, type MaskFramesInput } from "./maskFrames";
import { rtStructRoiToLabelVolume } from "./rtstructToLabelVolume";
import type { VolumeGeom } from "./labelVolume";

describe("sliceSpacingReport", () => {
  it("等間隔なら uniform", () => {
    expect(sliceSpacingReport([0, 3, 6, 9]).uniform).toBe(true);
  });
  it("欠けたスライスがあると uniform ではない（実例: 31.4 / 55.4 / 61.4）", () => {
    const r = sliceSpacingReport([31.4243, 55.4243, 61.4243]);
    expect(r.uniform).toBe(false);
    expect(r.steps.map((s) => Math.round(s))).toEqual([24, 6]);
  });
  it("同じ位置の重なりを数える", () => {
    const r = sliceSpacingReport([0, 3, 3, 6]);
    expect(r.duplicates).toBe(1);
    expect(r.uniform).toBe(false);
  });
});

// 実データと同じ形: 3 枚・軸位断・位置 31.4 / 55.4 / 61.4。
// Cornerstone は先頭と中央の距離（24 mm）を間隔にして体積を組む。
const geom: VolumeGeom = {
  dims: [2, 2, 3],
  spacing: [1, 1, 24],
  origin: [0, 0, 31.4243],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
};
const sops = ["sop30", "sop38", "sop40"];
const ipp: [number, number, number][] = [
  [0, 0, 31.4243],
  [0, 0, 55.4243],
  [0, 0, 61.4243],
];
const one = btoa(String.fromCharCode(1, 1, 1, 1));
const input = (k: number): MaskFramesInput => ({
  rows: 2,
  columns: 2,
  segments: [{ number: 1, label: "R", color: null, frames: [{ referencedSopInstanceUid: sops[k], imagePositionPatient: ipp[k], mask: one }] }],
});
const sliceOf = (lv: { data: Uint8Array } | null) =>
  lv ? [0, 1, 2].filter((k) => lv.data.slice(k * 4, k * 4 + 4).some((v) => v)) : [];

describe("2D の ROI を、描かれている画像と同じスライスに載せる", () => {
  it("SOP で当てると 3 枚目の画像（実位置 61.4）は k=2 に載る", () => {
    expect(sliceOf(framesToLabelVolume(input(2), geom, undefined, sopIndexMap(sops)))).toEqual([2]);
  });
  it("（修正前の振る舞い）IPP から計算すると k=round(30/24)=1 に載り、画像とずれる", () => {
    expect(sliceOf(framesToLabelVolume(input(2), geom))).toEqual([1]);
  });
  it("RTSTRUCT の輪郭も参照 SOP で当てる", () => {
    const ring = [0, 0, 61.4243, 2, 0, 61.4243, 2, 2, 61.4243, 0, 2, 61.4243];
    const roi = { name: "R", color: null, type: null, contours: [{ referencedSopInstanceUid: "sop40", points: ring, geometricType: "CLOSED_PLANAR" }] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(sliceOf(rtStructRoiToLabelVolume(roi as any, geom, 1, sopIndexMap(sops)))).toEqual([2]);
  });
});
