/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import { ippToleranceMm, placeSegFrame, emptyRejectCounts, totalRejected, type Vec3 } from "./segFramePlacement";

// 表示中シリーズ: 非正方画素（行 0.9・列 0.6 mm）、スライス間隔 2.5 mm、IPP = (-48 + 0.6·0, ...)。
const COL = 0.6, ROW = 0.9;
const ipps: Vec3[] = Array.from({ length: 10 }, (_, k) => [-48, -50, 5 + 2.5 * k] as Vec3);
const sopToZ = new Map(ipps.map((_, k) => [`1.2.${k}`, k] as [string, number]));
const ippOfZ = (z: number) => ipps[z] ?? null;
const tol = ippToleranceMm(ROW, COL);
const place = (sop: string | null, ipp: Vec3 | null, strict = true, ipOf: (z: number) => Vec3 | null = ippOfZ) =>
  placeSegFrame(sop, ipp, sopToZ, ipOf, ipps.length, tol, strict);

describe("ippToleranceMm", () => {
  it("max(0.01 mm, 画素間隔の最小値 × 5%)。0.6 / 0.9 → 0.03 mm。取れなければ 0.01", () => {
    expect(ippToleranceMm(ROW, COL)).toBeCloseTo(0.03, 12);
    expect(ippToleranceMm(0.1, 0.1)).toBe(0.01); // 0.005 → 下限
    expect(ippToleranceMm(null, undefined)).toBe(0.01);
    expect(ippToleranceMm(0.9, null)).toBeCloseTo(0.045, 12);
  });
});

describe("placeSegFrame（SEG の取り込み: 位置が合わないフレームは載せない）", () => {
  it("SOP 一致 + IPP 一致 → その z", () => {
    expect(place("1.2.3", ipps[3])).toEqual({ z: 3 });
  });
  it("丸め（0.005 mm）は受理する", () => {
    expect(place("1.2.3", [ipps[3][0] + 0.005, ipps[3][1], ipps[3][2]])).toEqual({ z: 3 });
  });
  it("SOP 一致でも IPP が 4 列（2.4 mm）ずれていれば positionMismatch（旧式は SOP だけで受理して 2.4 mm ずれた位置に入れた）", () => {
    expect(place("1.2.3", [ipps[3][0] + 4 * COL, ipps[3][1], ipps[3][2]])).toEqual({ reject: "positionMismatch" });
  });
  it("1 画素ずれ（0.6 mm / 0.9 mm）も positionMismatch", () => {
    expect(place("1.2.3", [ipps[3][0] + COL, ipps[3][1], ipps[3][2]])).toEqual({ reject: "positionMismatch" });
    expect(place("1.2.3", [ipps[3][0], ipps[3][1] + ROW, ipps[3][2]])).toEqual({ reject: "positionMismatch" });
  });
  it("スライス方向のずれ（別のスライス位置）も positionMismatch", () => {
    expect(place("1.2.3", [ipps[3][0], ipps[3][1], ipps[3][2] + 2.5])).toEqual({ reject: "positionMismatch" });
  });
  it("参照 SOP が表示中シリーズに無い（別シリーズの SEG）は、IPP が近くても otherSeries（旧式は IPP 最近傍 5 mm で採用していた）", () => {
    expect(place("9.9.9", ipps[3])).toEqual({ reject: "otherSeries" });
  });
  it("参照 SOP なし + IPP 一致 → 最近傍の z", () => {
    expect(place(null, ipps[4])).toEqual({ z: 4 });
  });
  it("参照 SOP なし + IPP が 2 mm ずれ → noPosition（旧式は 5 mm 以内で採用していた）", () => {
    expect(place(null, [ipps[4][0], ipps[4][1], ipps[4][2] + 1.0])).toEqual({ reject: "noPosition" });
    expect(place(null, null)).toEqual({ reject: "noPosition" });
  });
  it("画像側に IPP が無い（XA など）+ SOP 一致 → SOP だけで受理", () => {
    expect(place("1.2.3", ipps[3], true, () => null)).toEqual({ z: 3 });
    expect(place("1.2.3", null, true, () => null)).toEqual({ z: 3 });
  });
  it("負例: 旧式（SOP が一致すれば IPP を見ない）では、4 列ずれた SEG も受理される", () => {
    const shifted: Vec3 = [ipps[3][0] + 4 * COL, ipps[3][1], ipps[3][2]];
    const oldPlace = (sop: string) => sopToZ.get(sop); // 旧式
    expect(oldPlace("1.2.3")).toBe(3);
    expect("reject" in place("1.2.3", shifted)).toBe(true);
  });
});

describe("placeSegFrame（保存済みマスクの復元: 従来の寛容な対応づけ）", () => {
  it("SOP が一致すれば IPP は見ない", () => {
    expect(place("1.2.3", [ipps[3][0] + 4 * COL, ipps[3][1], ipps[3][2]], false)).toEqual({ z: 3 });
  });
  it("SOP が変わっても（シリーズの取り込み直し）IPP 最近傍 5 mm 以内なら復元できる", () => {
    expect(place("9.9.9", [ipps[3][0], ipps[3][1], ipps[3][2] + 1.0], false)).toEqual({ z: 3 });
    expect(place("9.9.9", [ipps[3][0], ipps[3][1], ipps[3][2] + 30], false)).toEqual({ reject: "noPosition" });
  });
});

describe("拒否の集計", () => {
  it("合計", () => {
    const c = emptyRejectCounts();
    expect(totalRejected(c)).toBe(0);
    c.otherSeries = 2; c.positionMismatch = 3; c.sizeMismatch = 1;
    expect(totalRejected(c)).toBe(6);
  });
});
