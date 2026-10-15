/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { regularGrid, sliceGeometry, type SliceInfo } from "./sliceGeometry";

const AX = [1, 0, 0, 0, 1, 0];
const ax = (zs: number[], extra: Partial<SliceInfo> = {}): SliceInfo[] =>
  zs.map((z, i) => ({ id: `s${i}`, sop: `sop${i}`, ipp: [-10, -20, z], iop: AX, ...extra }));

describe("sliceGeometry: 奥行きの求め方", () => {
  it("IPP があれば法線への射影（実空間の直交距離）。入力の順に依らず並べ替える", () => {
    const g = sliceGeometry(ax([9, 0, 3, 6]));
    expect(g.source).toBe("ipp");
    expect(g.positions).toEqual([0, 3, 6, 9]);
    expect(g.order).toEqual([1, 2, 3, 0]);
    expect(g.kind).toBe("uniform");
    expect(g.nominalSpacing).toBe(3);
  });
  it("斜めの向きでも、直線距離ではなく法線方向の距離を使う", () => {
    const c = Math.SQRT1_2;
    const iop = [1, 0, 0, 0, c, c]; // 法線 = (0, -c, c)
    const s: SliceInfo[] = [0, 1, 2].map((k) => ({ id: `${k}`, ipp: [0, 0, 4 * k], iop }));
    const g = sliceGeometry(s);
    expect(g.nominalSpacing).toBeCloseTo(4 * c, 9);
    expect(g.shearDeg).toBeCloseTo(45, 6);
  });
  it("IPP が無ければ SBS（中心どうしの距離）", () => {
    const s: SliceInfo[] = [0, 1, 2].map((k) => ({ id: `${k}`, spacingBetweenSlices: 4, sliceThickness: 3 }));
    const g = sliceGeometry(s);
    expect(g.source).toBe("sbs");
    expect(g.nominalSpacing).toBe(4);
  });
  it("NM の負の SBS は大きさとして使う", () => {
    const g = sliceGeometry([{ id: "a", spacingBetweenSlices: -2.5 }, { id: "b", spacingBetweenSlices: -2.5 }]);
    expect(g.nominalSpacing).toBe(2.5);
  });
  it("SBS も無ければ厚み（推定）、何も無ければ不明", () => {
    expect(sliceGeometry([{ id: "a", sliceThickness: 5 }, { id: "b", sliceThickness: 5 }]).source).toBe("thickness");
    expect(sliceGeometry([{ id: "a" }, { id: "b" }]).source).toBe("unknown");
  });
  it("1 枚だけなら幅は SBS → 厚み", () => {
    const g = sliceGeometry([{ id: "a", ipp: [0, 0, 5], iop: AX, sliceThickness: 2, spacingBetweenSlices: 2.5 }]);
    expect(g.kind).toBe("single");
    expect(g.widths).toEqual([2.5]);
  });
});

describe("sliceGeometry: 並びの分類", () => {
  it("IPP の丸め程度の揺れ（0.005 mm）は均一", () => {
    expect(sliceGeometry(ax([0, 3.005, 5.996, 9])).kind).toBe("uniform");
  });
  it("欠けたスライスを数える", () => {
    const g = sliceGeometry(ax([0, 3, 9, 12]));
    expect(g.kind).toBe("missing");
    expect(g.missingCount).toBe(1);
    expect(g.minSpacing).toBe(3);
  });
  it("実例 31.4 / 55.4 / 61.4 は欠け（6 mm の整数倍）として扱い、幅は [24, 15, 6]", () => {
    const g = sliceGeometry(ax([31.4243, 55.4243, 61.4243]));
    expect(g.kind).toBe("missing");
    expect(g.missingCount).toBe(3);
    expect(g.minSpacing).toBeCloseTo(6, 9);
    expect(g.widths.map((w) => Math.round(w * 1000) / 1000)).toEqual([24, 15, 6]);
  });
  it("整数倍でなければ不規則", () => {
    expect(sliceGeometry(ax([0, 5, 12, 20])).kind).toBe("irregular");
  });
  it("同じ位置の重なりは体積にしない", () => {
    expect(sliceGeometry(ax([0, 3, 3, 6])).kind).toBe("duplicates");
  });
  it("IOP がずれていれば知らせる", () => {
    const s = ax([0, 3]);
    s[1].iop = [1, 0, 0, 0, 0.999, 0.0447];
    expect(sliceGeometry(s).iopConsistent).toBe(false);
  });
  it("等間隔なら幅の合計 = N × 間隔（ボクセル数 × ボクセル体積と同じになる）", () => {
    const g = sliceGeometry(ax([0, 3, 6, 9, 12]));
    expect(g.widths).toEqual([3, 3, 3, 3, 3]);
  });
});

describe("regularGrid", () => {
  it("最小の間隔の格子に取り直し、元のスライスの格子番号を返す", () => {
    const r = regularGrid(sliceGeometry(ax([31.4243, 55.4243, 61.4243])));
    expect(r.count).toBe(6);
    expect(r.spacing).toBeCloseTo(6, 9);
    expect(r.gridIndexOf).toEqual([0, 4, 5]);
  });
});
