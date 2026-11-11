/**
 * H76 `measureMaskCrossSections` / H77 `orientCenterlineGraph` の検査。
 *
 * 真値は解析式（世界座標で円筒を塗る）。本体の関数で作った値を正解にしない。
 * 🔴 守りたいのは: 測れない断面は **null**（0 や隣の血管の値で埋めない）、隣り合う別の血管を数えない、
 * 木でないグラフ・端点でない根は黙って通さず理由つきで拒否する。
 */
import { describe, expect, it } from "vitest";
import { extractCenterline, type PluginCenterlineGraph } from "./pluginCenterlineApi";
import { measureMaskCrossSections, orientCenterlineGraph } from "./pluginVesselMeasureApi";
import { validateVesselModelInput } from "./pluginVesselApi";
import type { PluginMaskInput } from "./pluginMeshApi";

type V3 = [number, number, number];

function makeMask(dims: [number, number, number], spacing: V3, origin: V3, value: (w: V3) => number): PluginMaskInput {
  const [nx, ny, nz] = dims;
  const data = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    data[k * nx * ny + j * nx + i] = value([origin[0] + i * spacing[0], origin[1] + j * spacing[1], origin[2] + k * spacing[2]]);
  }
  return { data, dims, indexToWorld: [spacing[0], 0, 0, origin[0], 0, spacing[1], 0, origin[1], 0, 0, spacing[2], origin[2], 0, 0, 0, 1] };
}
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** 軸 a→b、半径 r(s)（s = a からの軸方向の距離 mm）の円筒に入っていれば 1。 */
function cylinder(a: V3, b: V3, r: (s: number) => number) {
  const ax = sub(b, a);
  const len = Math.hypot(...ax);
  const u: V3 = [ax[0] / len, ax[1] / len, ax[2] / len];
  return (w: V3): number => {
    const d = sub(w, a);
    const s = dot(d, u);
    if (s < 0 || s > len) return 0;
    const perp = Math.hypot(d[0] - s * u[0], d[1] - s * u[1], d[2] - s * u[2]);
    return perp <= r(s) ? 1 : 0;
  };
}
const line = (a: V3, b: V3, n: number): V3[] => Array.from({ length: n }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / (n - 1), a[1] + ((b[1] - a[1]) * i) / (n - 1), a[2] + ((b[2] - a[2]) * i) / (n - 1)]);

// 30 mm の直円柱（直径 4.0 mm）。ボクセル 0.5 mm 等方、z 軸。
const ISO = makeMask([60, 60, 80], [0.5, 0.5, 0.5], [0, 0, 0], cylinder([15, 15, 5], [15, 15, 35], () => 2));
const ISO_LINE = line([15, 15, 5], [15, 15, 35], 7);

describe("measureMaskCrossSections", () => {
  it("直径 4.0 mm の直円柱: 端 2 フレームを除き等価径 4.0±0.5・最小幅 4.0±0.5", () => {
    const r = measureMaskCrossSections(ISO, ISO_LINE, { spacingMm: 2, maxRadiusMm: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inner = r.frames.slice(1, -1);
    expect(inner.length).toBeGreaterThan(10);
    for (const f of inner) {
      expect(Math.abs(f.equivalentDiameterMm! - 4)).toBeLessThan(0.5);
      expect(Math.abs(f.minWidthMm! - 4)).toBeLessThan(0.5);
    }
    expect(r.frames[0].arcLengthMm).toBe(0);
    expect(r.frames[1].arcLengthMm).toBeCloseTo(2, 9);
  });

  it("終点まで覆う: 間隔の倍数でなければ終点にフレームが 1 つ増え、倍数なら重複しない", () => {
    const odd = measureMaskCrossSections(ISO, ISO_LINE, { spacingMm: 4, maxRadiusMm: 5 }); // 全長 30 mm
    const even = measureMaskCrossSections(ISO, ISO_LINE, { spacingMm: 5, maxRadiusMm: 5 });
    expect(odd.ok && even.ok).toBe(true);
    if (!odd.ok || !even.ok) return;
    expect(odd.frames.map((f) => f.arcLengthMm)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 30]);
    expect(even.frames.map((f) => f.arcLengthMm)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect(odd.frames[odd.frames.length - 1].positionWorld[2]).toBeCloseTo(35, 6);
  });

  it("異方性ボクセル [0.4,0.4,0.8]・斜めの軸でも同じ径（断面は軸に直交）", () => {
    const a: V3 = [8, 8, 6];
    const b: V3 = [30, 24, 40];
    const mask = makeMask([100, 100, 70], [0.4, 0.4, 0.8], [0, 0, 0], cylinder(a, b, () => 2));
    const r = measureMaskCrossSections(mask, line(a, b, 9), { spacingMm: 3, maxRadiusMm: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inner = r.frames.slice(1, -1);
    expect(inner.length).toBeGreaterThan(8);
    for (const f of inner) expect(Math.abs(f.equivalentDiameterMm! - 4)).toBeLessThan(0.5);
  });

  it("中央 10 mm を直径 2.0 mm に絞る: 最小径の位置が真値±1.0 mm、値 2.0±0.5", () => {
    // 軸方向 s: 5..35 のうち 15..25 が r=1（なめらかでない階段。位置の真値は 20 mm = 軸の中央）
    const mask = makeMask([60, 60, 80], [0.5, 0.5, 0.5], [0, 0, 0], cylinder([15, 15, 5], [15, 15, 35], (s) => (s >= 10 && s <= 20 ? 1 : 2)));
    const r = measureMaskCrossSections(mask, ISO_LINE, { spacingMm: 1, maxRadiusMm: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const valid = r.frames.filter((f) => f.equivalentDiameterMm !== null && f.arcLengthMm > 1 && f.arcLengthMm < 29);
    const min = valid.reduce((m, f) => (f.equivalentDiameterMm! < m.equivalentDiameterMm! ? f : m));
    expect(Math.abs(min.equivalentDiameterMm! - 2)).toBeLessThan(0.5);
    expect(Math.abs(min.arcLengthMm - 15)).toBeLessThan(5.01); // 狭窄区間 10..20 のどこか
    expect(min.arcLengthMm).toBeGreaterThanOrEqual(10 - 1);
    expect(min.arcLengthMm).toBeLessThanOrEqual(20 + 1);
  });

  it("負例: 中心線をマスクの外へ 5 mm ずらす → 全フレーム null（0 でも隣の値でもない）", () => {
    const off = ISO_LINE.map((p) => [p[0] + 5, p[1], p[2]] as V3);
    const r = measureMaskCrossSections(ISO, off, { spacingMm: 2, maxRadiusMm: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const f of r.frames) {
      expect(f.centerInMask).toBe(false);
      expect(f.areaMm2).toBeNull();
      expect(f.equivalentDiameterMm).toBeNull();
      expect(f.minWidthMm).toBeNull();
    }
  });

  it("負例: 走査半径が内腔より小さい → null＋touchesBoundary（切れた径を返さない）", () => {
    const r = measureMaskCrossSections(ISO, ISO_LINE, { spacingMm: 5, maxRadiusMm: 1.5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const f of r.frames.slice(1, -1)) {
      expect(f.touchesBoundary).toBe(true);
      expect(f.equivalentDiameterMm).toBeNull();
    }
  });

  it("負例: 平行に近接する別の円筒（隣の血管。間に背景 1 mm）は径に混ぜない", () => {
    const one = cylinder([15, 15, 5], [15, 15, 35], () => 2);
    const two = cylinder([20, 15, 5], [20, 15, 35], () => 2); // 中心間 5 mm・半径 2+2 = 4 → 間隔 1 mm
    const mask = makeMask([60, 60, 80], [0.5, 0.5, 0.5], [0, 0, 0], (w) => (one(w) || two(w) ? 1 : 0));
    const r = measureMaskCrossSections(mask, ISO_LINE, { spacingMm: 3, maxRadiusMm: 6 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const f of r.frames.slice(1, -1)) expect(Math.abs(f.equivalentDiameterMm! - 4)).toBeLessThan(0.5);
  });

  it("segment 指定: その値のセルだけを数える", () => {
    const m2 = makeMask([60, 60, 80], [0.5, 0.5, 0.5], [0, 0, 0], (w) => { const a = cylinder([15, 15, 5], [15, 15, 35], () => 2)(w); const b = cylinder([15, 15, 5], [15, 15, 35], () => 1)(w); return a ? (b ? 2 : 1) : 0; });
    const outer = measureMaskCrossSections(m2, ISO_LINE, { spacingMm: 10, maxRadiusMm: 5 });
    const inner = measureMaskCrossSections(m2, ISO_LINE, { spacingMm: 10, maxRadiusMm: 5, segment: 2 });
    expect(outer.ok && inner.ok).toBe(true);
    if (!outer.ok || !inner.ok) return;
    expect(Math.abs(outer.frames[1].equivalentDiameterMm! - 4)).toBeLessThan(0.5);
    expect(Math.abs(inner.frames[1].equivalentDiameterMm! - 2)).toBeLessThan(0.5);
  });

  it("excludeNear: 近傍の断面は null＋excluded（他は測る）", () => {
    const r = measureMaskCrossSections(ISO, ISO_LINE, { spacingMm: 3, maxRadiusMm: 5, excludeNear: { points: [[15, 15, 20]], radiusMm: 2 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ex = r.frames.filter((f) => f.excluded);
    expect(ex.length).toBeGreaterThan(0);
    for (const f of ex) { expect(Math.abs(f.positionWorld[2] - 20)).toBeLessThanOrEqual(2); expect(f.equivalentDiameterMm).toBeNull(); }
    expect(r.frames.some((f) => !f.excluded && f.equivalentDiameterMm !== null)).toBe(true);
  });

  it("Y 字: 経路が節点に達すると、近傍は他枝の内腔が入って過大になる（excludeNear を渡す理由）。渡せば外れる", () => {
    const trunk = cylinder([15, 15, 2], [15, 15, 22], () => 2);
    const b1 = cylinder([15, 15, 22], [27, 15, 34], () => 2);
    const b2 = cylinder([15, 15, 22], [3, 15, 34], () => 2);
    const mask = makeMask([60, 60, 80], [0.5, 0.5, 0.5], [0, 0, 0], (w) => (trunk(w) || b1(w) || b2(w) ? 1 : 0));
    const path = line([15, 15, 2], [15, 15, 22], 6);
    const bare = measureMaskCrossSections(mask, path, { spacingMm: 1, maxRadiusMm: 6 });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    const near = bare.frames.filter((f) => f.positionWorld[2] > 19.5 && f.equivalentDiameterMm !== null);
    expect(Math.max(...near.map((f) => f.equivalentDiameterMm!))).toBeGreaterThan(4.5); // 過大（検出器の自己検査）
    const ex = measureMaskCrossSections(mask, path, { spacingMm: 1, maxRadiusMm: 6, excludeNear: { points: [[15, 15, 22]], radiusMm: 4 } });
    if (!ex.ok) throw new Error(ex.error);
    for (const f of ex.frames) if (f.equivalentDiameterMm !== null) expect(Math.abs(f.equivalentDiameterMm - 4)).toBeLessThan(0.5);
  });

  describe("負例: 壊れた入力は理由つきで ok:false", () => {
    const bad: [string, () => ReturnType<typeof measureMaskCrossSections>, RegExp][] = [
      ["間隔 0", () => measureMaskCrossSections(ISO, ISO_LINE, { spacingMm: 0, maxRadiusMm: 5 }), /spacingMm/],
      ["半径 0", () => measureMaskCrossSections(ISO, ISO_LINE, { spacingMm: 1, maxRadiusMm: 0 }), /maxRadiusMm/],
      ["半径 NaN", () => measureMaskCrossSections(ISO, ISO_LINE, { spacingMm: 1, maxRadiusMm: NaN }), /maxRadiusMm/],
      ["半径が省略", () => measureMaskCrossSections(ISO, ISO_LINE, { spacingMm: 1 } as never), /maxRadiusMm/],
      ["2 点未満", () => measureMaskCrossSections(ISO, [[15, 15, 5]], { spacingMm: 1, maxRadiusMm: 5 }), /2 points/],
      ["非有限の点", () => measureMaskCrossSections(ISO, [[15, 15, 5], [NaN, 0, 0]], { spacingMm: 1, maxRadiusMm: 5 }), /finite/],
      ["データ長が合わない", () => measureMaskCrossSections({ ...ISO, dims: [60, 60, 79] }, ISO_LINE, { spacingMm: 1, maxRadiusMm: 5 }), /length/],
      ["indexToWorld が 16 要素でない", () => measureMaskCrossSections({ ...ISO, indexToWorld: [1, 0, 0] }, ISO_LINE, { spacingMm: 1, maxRadiusMm: 5 }), /indexToWorld/],
      ["長さ 0 の点列", () => measureMaskCrossSections(ISO, [[1, 1, 1], [1, 1, 1]], { spacingMm: 1, maxRadiusMm: 5 }), /zero length/],
      ["segment が範囲外", () => measureMaskCrossSections(ISO, ISO_LINE, { spacingMm: 1, maxRadiusMm: 5, segment: 0 }), /segment/],
      ["サンプルが多すぎる", () => measureMaskCrossSections(ISO, ISO_LINE, { spacingMm: 0.001, maxRadiusMm: 50 }), /too many/],
    ];
    for (const [name, call, re] of bad) {
      it(name, () => {
        const r = call();
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.error).toMatch(re);
      });
    }
  });
});

// ---- 向き付け ----
const node = (id: number, deg: number, w: V3 = [id, 0, 0]) => ({ id, degree: deg, world: w });
const br = (id: number, s: number, e: number, pts: V3[]) => ({ id, startNode: s, endNode: e, pointsWorld: pts, lengthMm: 10 });
/** 節点 0(端点)–1(分岐)–2,3(端点)。枝 10 は根→分岐、枝 11 は**逆向き**（3→1）に書く。 */
const Y: PluginCenterlineGraph = {
  nodes: [node(0, 1, [0, 0, 0]), node(1, 3, [0, 0, 10]), node(2, 1, [5, 0, 20]), node(3, 1, [-5, 0, 20])],
  branches: [
    br(10, 0, 1, [[0, 0, 0], [0, 0, 10]]),
    br(11, 3, 1, [[-5, 0, 20], [0, 0, 10]]),
    br(12, 1, 2, [[0, 0, 10], [5, 0, 20]]),
  ],
};

describe("orientCenterlineGraph", () => {
  it("Y 字: 3 区間。幹の parentId は null、枝 2 本の parentId は幹。点列は根→先", () => {
    const r = orientCenterlineGraph(Y, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const by = Object.fromEntries(r.segments.map((s) => [s.id, s]));
    expect(r.segments).toHaveLength(3);
    expect(by["10"].parentId).toBeNull();
    expect(by["11"].parentId).toBe("10");
    expect(by["12"].parentId).toBe("10");
    expect(by["11"].points[0]).toEqual([0, 0, 10]); // 逆向きに書かれた枝が反転された
    expect(by["11"].points[1]).toEqual([-5, 0, 20]);
    for (const id of ["11", "12"]) expect(by[id].points[0]).toEqual(by["10"].points[by["10"].points.length - 1]);
  });

  it("入力を書き換えても結果は変わらない（点列のコピー）", () => {
    const r = orientCenterlineGraph(Y, 0);
    (Y.branches[0].pointsWorld[0] as V3)[0] = 99;
    expect(r.ok && r.segments.find((s) => s.id === "10")!.points[0][0]).toBe(0);
    (Y.branches[0].pointsWorld[0] as V3)[0] = 0;
  });

  const cases: [string, PluginCenterlineGraph, number, RegExp][] = [
    ["存在しない根", Y, 99, /not found/],
    ["根が分岐点（degree 3）", Y, 1, /end point/],
    ["ループ（辺が多い）", { ...Y, branches: [...Y.branches, br(13, 2, 3, [[5, 0, 20], [-5, 0, 20]])] }, 0, /not a tree/],
    ["多重辺", { ...Y, branches: [...Y.branches, br(13, 1, 2, [[0, 0, 10], [4, 0, 20], [5, 0, 20]])] }, 0, /not a tree/],
    ["自己ループ", { ...Y, branches: [...Y.branches.slice(0, 2), br(12, 1, 1, [[0, 0, 10], [1, 0, 10]])] }, 0, /loop/],
    ["非連結（辺の数は合うがループ＋孤立）", { nodes: [...Y.nodes, node(4, 1), node(5, 1)], branches: [...Y.branches, br(13, 4, 5, [[0, 0, 0], [1, 0, 0]])] }, 0, /not a tree|not connected/],
    ["未知の節点を指す枝", { ...Y, branches: [...Y.branches.slice(0, 2), br(12, 1, 77, [[0, 0, 10], [5, 0, 20]])] }, 0, /unknown node/],
  ];
  for (const [name, g, root, re] of cases) {
    it(`負例: ${name}`, () => {
      const r = orientCenterlineGraph(g, root);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toMatch(re);
    });
  }
});

describe("統合: マスク → extractCenterline → orientCenterlineGraph → 計測 → 登録検査", () => {
  it("Y 字マスクから径つきの木ができ、registerVesselModel の CT 検査を通る", () => {
    const trunk = cylinder([15, 15, 2], [15, 15, 22], () => 2);
    const b1 = cylinder([15, 15, 22], [27, 15, 34], () => 1.5);
    const b2 = cylinder([15, 15, 22], [3, 15, 34], () => 1.5);
    const mask = makeMask([60, 60, 80], [0.5, 0.5, 0.5], [0, 0, 0], (w) => (trunk(w) || b1(w) || b2(w) ? 1 : 0));
    const g = extractCenterline(mask, { pruneMinLengthMm: 3 });
    expect(g).not.toBeNull();
    if (!g) return;
    const root = g.nodes.filter((n) => n.degree === 1).sort((a, b) => a.world[2] - b.world[2])[0];
    const o = orientCenterlineGraph(g, root.id);
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.segments).toHaveLength(3);
    const branchNodes = g.nodes.filter((n) => n.degree >= 3).map((n) => n.world);
    const segments = o.segments.map((s) => {
      const m = measureMaskCrossSections(mask, s.points, { spacingMm: 1, maxRadiusMm: 5, excludeNear: { points: branchNodes, radiusMm: 4 } });
      if (!m.ok) throw new Error(m.error);
      // 弧長 1 mm 間隔の測定値を、点ごとの径に載せる（最も近い測定の値。測れない点は null）。
      return { id: s.id, points: s.points, parentId: s.parentId, diameterMm: s.points.map(() => m.frames.find((f) => f.equivalentDiameterMm !== null)?.equivalentDiameterMm ?? null) };
    });
    const err = validateVesselModelInput({
      runKey: "k", stableKey: null, orientation: { proximalFirst: true, source: "user" }, kind: "ct-vessel", label: "t", segments,
      calibration: { diameterCalibrated: true, sources: [], tiers: [], diameterMethod: "mask-equivalent-area" },
      provenance: { studyUid: "1", seriesUid: "2", frameOfReferenceUid: null, voxelSpacingMm: [0.5, 0.5, 0.5], maskOrigin: { type: "plugin" } },
    } as never);
    expect(err).toBeNull();
    const trunkSeg = o.segments.find((s) => s.parentId === null)!;
    const tm = measureMaskCrossSections(mask, trunkSeg.points, { spacingMm: 2, maxRadiusMm: 5, excludeNear: { points: branchNodes, radiusMm: 4 } });
    if (!tm.ok) throw new Error(tm.error);
    const vals = tm.frames.filter((f) => f.equivalentDiameterMm !== null);
    expect(vals.length).toBeGreaterThan(3);
    for (const f of vals) expect(Math.abs(f.equivalentDiameterMm! - 4)).toBeLessThan(0.6);
  });
});
