/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { regularGrid, sliceGeometry, type SliceInfo } from "./sliceGeometry";
import {
  depthVolumeStatus,
  interpolateToGrid,
  labelVolumeMeshVolume,
  maskVolumeFromGeometry,
  maskVolumeFromLabels,
  sopGridIndexMap,
  volumeDepthNote,
  type MaskDepthContext,
} from "./depthVolume";

const IOP = [1, 0, 0, 0, 1, 0];
const infos = (zs: number[], extra: Partial<SliceInfo> = {}): SliceInfo[] =>
  zs.map((z, i) => ({ id: `i${i}`, sop: `s${i}`, ipp: [0, 0, z], iop: IOP, ...extra }));

/** 全画素が同じ値の 1 スライス。 */
const flat = (v: number, n = 4) => new Float32Array(n).fill(v);

describe("interpolateToGrid", () => {
  it("欠けたスライス: 元の位置は元の画素のまま、欠けた位置は前後の線形補間", () => {
    const g = sliceGeometry(infos([0, 1, 4])); // 2, 3 が欠け
    expect(g.kind).toBe("missing");
    const grid = regularGrid(g);
    expect(grid.count).toBe(5);
    const src = [flat(0), flat(30), flat(120)];
    const { data, original } = interpolateToGrid(src, g.positions, grid, 4);
    expect(original).toEqual([true, true, false, false, true]);
    const at = (j: number) => data[j * 4];
    expect([at(0), at(1), at(4)]).toEqual([0, 30, 120]);
    expect(at(2)).toBeCloseTo(30 + 90 / 3, 5); // 1/3
    expect(at(3)).toBeCloseTo(30 + (90 * 2) / 3, 5); // 2/3
  });

  it("中点は前後の平均", () => {
    const g = sliceGeometry(infos([0, 2, 6]));
    const grid = regularGrid(g);
    const { data } = interpolateToGrid([flat(10), flat(20), flat(60)], g.positions, grid, 4);
    expect(grid.gridIndexOf).toEqual([0, 1, 3]);
    expect(data[2 * 4]).toBe(40); // z=4 は 2 と 6 の中点
  });

  it("不規則な間隔: 実際の距離で重みを付ける（最近傍ではない）", () => {
    const g = sliceGeometry(infos([0, 1, 2.5]));
    expect(g.kind).toBe("irregular");
    const grid = regularGrid(g);
    expect(grid.count).toBe(4);
    const { data, original } = interpolateToGrid([flat(0), flat(10), flat(25)], g.positions, grid, 4);
    expect(original).toEqual([true, true, false, true]);
    expect(data[2 * 4]).toBeCloseTo(10 + (15 * 1) / 1.5, 5); // z=2: 1 と 2.5 の間の 1/1.5
  });
});

describe("sopGridIndexMap", () => {
  it("格子の番号に変える。補間した面には SOP が当たらない", () => {
    const m = sopGridIndexMap(["a", "b", "c"], [0, 1, 4]);
    expect(m.get("c")).toBe(4);
    expect([...m.values()]).not.toContain(2);
  });
  it("格子が無ければ並び順", () => {
    expect(sopGridIndexMap(["a", null, "c"]).get("c")).toBe(2);
  });
});

describe("volumeDepthNote", () => {
  it("IPP で均一なら何も出さない", () => {
    expect(volumeDepthNote(sliceGeometry(infos([0, 1, 2, 3])))).toBeNull();
  });
  it("欠け・不規則・推定", () => {
    expect(volumeDepthNote(sliceGeometry(infos([0, 1, 4])))).toEqual({ id: "missing", n: 2 });
    const g = sliceGeometry(infos([0, 1, 2.5]));
    expect(volumeDepthNote(g, { count: 4, spacing: 1 })).toEqual({ id: "irregular", from: 3, to: 4, spacing: 1 });
    const noIpp = (x: Partial<SliceInfo>) => [0, 1, 2].map((i): SliceInfo => ({ id: `i${i}`, ...x }));
    expect(volumeDepthNote(sliceGeometry(noIpp({ sliceThickness: 2 })))?.id).toBe("thickness");
    expect(volumeDepthNote(sliceGeometry(noIpp({ spacingBetweenSlices: 2 })))?.id).toBe("sbs");
    expect(volumeDepthNote(sliceGeometry(noIpp({})))?.id).toBe("unknown");
  });
});

/** 4×4 の中の 2×2 の正方形（4 画素）。 */
const block = (): Int32Array => {
  const a = new Int32Array(16);
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) a[y * 4 + x] = 1;
  return a;
};

describe("maskVolumeFromGeometry", () => {
  const slice = (stackIndex: number) => ({ stackIndex, labels: block(), width: 4, height: 4 });
  it("均一な間隔: ボクセル数 × ボクセルの体積", () => {
    const g = sliceGeometry(infos([0, 3, 6, 9]));
    const r = maskVolumeFromGeometry([slice(0), slice(1), slice(2)], g, 0.5, 0.25);
    expect(r.voxels).toBe(12);
    expect(r.volumeMm3).toBeCloseTo(12 * 0.5 * 0.25 * 3, 9);
  });
  it("不均一な間隔: 面積 × スライスの幅の和", () => {
    const g = sliceGeometry(infos([0, 1, 4])); // 幅 1, 2, 3
    expect(g.widths).toEqual([1, 2, 3]);
    const r = maskVolumeFromGeometry([slice(0), slice(1), slice(2)], g, 1, 1);
    expect(r.volumeMm3).toBeCloseTo(4 * (1 + 2 + 3), 9);
    // 公称の間隔（2 mm）を全部に当てると全体の合計は偶然一致するので、スライス単位でも確かめる
    expect(maskVolumeFromGeometry([slice(0)], g, 1, 1).volumeMm3).toBeCloseTo(4 * 1, 9);
    expect(maskVolumeFromGeometry([slice(2)], g, 1, 1).volumeMm3).toBeCloseTo(4 * 3, 9);
    // 均一とみなした値ではない
    expect(r.volumeMm3).not.toBeCloseTo(4 * 1 * 3, 3);
  });
  it("入力の順が奥行きの順でなくても、位置の幅で引く", () => {
    const g = sliceGeometry(infos([4, 0, 1])); // order = [1, 2, 0]、幅は 1, 2, 3
    const r = maskVolumeFromGeometry([slice(0)], g, 1, 1); // 添字 0 は z=4 の端 → 幅 3
    expect(r.volumeMm3).toBeCloseTo(12, 9);
  });
});

describe("labelVolumeMeshVolume", () => {
  const dims = [4, 4, 5] as const;
  const data = new Uint8Array(4 * 4 * 5);
  for (const k of [0, 1, 2, 3, 4]) for (let i = 0; i < 16; i++) if (block()[i]) data[k * 16 + i] = 1;
  it("奥行きの指定が無ければ全面 × 間隔 = ボクセル数 × ボクセルの体積", () => {
    const r = labelVolumeMeshVolume(data, dims, [1, 1, 1]);
    expect(r.volumeMm3).toBeCloseTo(r.voxels * 1, 9);
  });
  it("補間した面は使わず、元のスライスの幅で求める", () => {
    // 元のスライスは格子の 0, 1, 4（z = 0, 1, 4 mm。幅 1, 2, 3）
    const r = labelVolumeMeshVolume(data, dims, [1, 1, 1], { gridIndexOf: [0, 1, 4], widths: [1, 2, 3] });
    expect(r.volumeMm3).toBeCloseTo(4 * 6, 9);
    expect(r.voxels).toBe(12);
  });
});

describe("maskVolumeFromLabels", () => {
  const ctx = (g = sliceGeometry(infos([0, 2, 4])), spacingKnown = true): MaskDepthContext => ({
    indexOfSource: new Map(["i0", "i1", "i2"].map((id, i) => [id, i])),
    geometry: g,
    colSp: 1,
    rowSp: 1,
    spacingKnown,
  });
  const sl = (id: string) => ({ sourceId: id, labels: block(), width: 4, height: 4 });
  it("IPP: 体積を出し、注意は無い", () => {
    const r = maskVolumeFromLabels(ctx(), [sl("i0"), sl("i1")]);
    expect(r.volumeMm3).toBeCloseTo(4 * 2 * 2, 9);
    expect(r.warnings).toEqual([]);
  });
  it("PixelSpacing が無ければ体積を出さない（0 にしない）", () => {
    const r = maskVolumeFromLabels(ctx(undefined, false), [sl("i0")]);
    expect(r.volumeMm3).toBeUndefined();
    expect(r.warnings).toContain("spacing-unknown");
  });
  it("スライス厚からの推定は体積を出し、推定の注意を付ける", () => {
    const g = sliceGeometry([0, 1, 2].map((i): SliceInfo => ({ id: `i${i}`, sliceThickness: 5 })));
    const r = maskVolumeFromLabels(ctx(g), [sl("i0")]);
    expect(r.volumeMm3).toBeCloseTo(4 * 5, 9);
    expect(r.warnings).toEqual(["depth-estimated"]);
  });
  it("間隔が不明なら体積を出さない", () => {
    const g = sliceGeometry([0, 1, 2].map((i): SliceInfo => ({ id: `i${i}` })));
    const r = maskVolumeFromLabels(ctx(g), [sl("i0")]);
    expect(r.volumeMm3).toBeUndefined();
    expect(r.warnings).toContain("depth-unknown");
  });
  it("スタックに無いスライスに前景があれば体積を出さない", () => {
    const r = maskVolumeFromLabels(ctx(), [sl("zzz")]);
    expect(r.volumeMm3).toBeUndefined();
    expect(r.warnings).toContain("depth-unknown");
  });
  it("前景の無いスライスは無視する", () => {
    const empty = { sourceId: "zzz", labels: new Int32Array(16), width: 4, height: 4 };
    expect(maskVolumeFromLabels(ctx(), [sl("i0"), empty]).volumeMm3).toBeCloseTo(8, 9);
  });
});

describe("depthVolumeStatus", () => {
  it("同じ位置の重なりは体積を出さない", () => {
    expect(depthVolumeStatus("ipp", "duplicates", true).volumeKnown).toBe(false);
  });
});
