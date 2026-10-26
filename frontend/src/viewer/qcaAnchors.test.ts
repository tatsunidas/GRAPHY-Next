import { describe, expect, it } from "vitest";
import {
  MAX_ANCHORS,
  MIN_ANCHOR_GAP_PX,
  addAnchor,
  anchorLine,
  anchorStripColumn,
  confirmAnchor,
  insertAnchorAt,
  cumulativeArcs,
  localRadiusPx,
  moveAnchorTo,
  orderAnchors,
  pairAnchors,
  pointAtArc,
  proposeAnchors,
  removeAnchor,
  resnapAnchors,
  snapToCenterline,
  stepAnchor,
  type Pt,
  type QcaAnchor,
} from "./qcaAnchors";

/** 半径 R の 1/4 円弧（曲がった血管の代わり）。1 px ほどの間隔の折れ線。 */
function arc(R: number, n = 200): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const t = ((Math.PI / 2) * i) / (n - 1);
    return [R * Math.sin(t), R * (1 - Math.cos(t))] as [number, number];
  });
}
const line = (len: number): [number, number][] => Array.from({ length: len + 1 }, (_, i) => [i, 0] as [number, number]);
const sOf = (c: readonly Pt[], a: QcaAnchor) => snapToCenterline(c, [a.x, a.y])!.s;

describe("snapToCenterline / pointAtArc", () => {
  it("直線: 中心線の外の点は直下へ付き、距離が出る", () => {
    const sn = snapToCenterline(line(100), [40.4, 7])!;
    expect(sn.s).toBeCloseTo(40.4, 6);
    expect(sn.point[1]).toBeCloseTo(0, 6);
    expect(sn.distance).toBeCloseTo(7, 6);
  });
  it("端の外は端へ丸める", () => {
    expect(snapToCenterline(line(100), [-20, 0])!.s).toBe(0);
    expect(snapToCenterline(line(100), [300, 0])!.s).toBeCloseTo(100, 6);
  });
  it("弧長 → 点 → 弧長で戻る（曲線）", () => {
    const c = arc(60);
    const total = cumulativeArcs(c).at(-1)!;
    const at = pointAtArc(c, total * 0.37)!;
    expect(snapToCenterline(c, at.point)!.s).toBeCloseTo(total * 0.37, 3);
  });
  it("点が 2 未満なら null", () => {
    expect(snapToCenterline([[0, 0]], [1, 1])).toBeNull();
  });
});

describe("proposeAnchors（仮の位置は確認前）", () => {
  it("n 個を等分し、すべて未確認", () => {
    const c = line(100);
    const a = proposeAnchors(c, 3);
    expect(a).toHaveLength(3);
    expect(a.every((x) => !x.confirmed)).toBe(true);
    expect(a.map((x) => Math.round(sOf(c, x)))).toEqual([25, 50, 75]);
  });
  it("0 以下なら空", () => {
    expect(proposeAnchors(line(10), 0)).toEqual([]);
  });
});

describe("anchorLine（中心線に直交する線）", () => {
  it("曲線の途中でも、線分は接線に直交し、長さは指定どおり", () => {
    const c = arc(60);
    const a = proposeAnchors(c, 3)[1];
    const l = anchorLine(c, a, 7)!;
    const at = pointAtArc(c, sOf(c, a))!;
    const dot = (l.p1[0] - l.p0[0]) * at.tangent[0] + (l.p1[1] - l.p0[1]) * at.tangent[1];
    expect(Math.abs(dot)).toBeLessThan(1e-9);
    expect(Math.hypot(l.p1[0] - l.p0[0], l.p1[1] - l.p0[1])).toBeCloseTo(14, 6);
    // 中心は中心線の上。
    expect(snapToCenterline(c, l.center)!.distance).toBeLessThan(1e-9);
  });
});

describe("moveAnchorTo / stepAnchor", () => {
  const c = line(100);
  const base = (): QcaAnchor[] => [
    { x: 25, y: 0, confirmed: false },
    { x: 50, y: 0, confirmed: false },
    { x: 75, y: 0, confirmed: false },
  ];
  it("ポインタが中心線の外でも、中心線の上に付き、確認済みになる", () => {
    const r = moveAnchorTo(c, base(), 1, [55.3, 9]);
    expect(r[1].confirmed).toBe(true);
    expect(r[1].y).toBeCloseTo(0, 9);
    expect(r[1].x).toBeCloseTo(55.3, 6);
    // 他は変わらない。
    expect(r[0]).toEqual(base()[0]);
    expect(r[2]).toEqual(base()[2]);
  });
  it("★負例: 隣を追い越さない（番号が入れ替わらない）", () => {
    const r = moveAnchorTo(c, base(), 1, [90, 0]);
    expect(sOf(c, r[1])).toBeCloseTo(75 - MIN_ANCHOR_GAP_PX, 6);
    const r2 = moveAnchorTo(c, base(), 1, [-10, 0]);
    expect(sOf(c, r2[1])).toBeCloseTo(25 + MIN_ANCHOR_GAP_PX, 6);
  });
  it("端点の外へは出ない", () => {
    const r = moveAnchorTo(c, base(), 0, [-50, 0]);
    expect(sOf(c, r[0])).toBeGreaterThanOrEqual(MIN_ANCHOR_GAP_PX - 1e-9);
  });
  it("キー操作: 1 px ずつ動く。範囲外の番号は変えない", () => {
    const r = stepAnchor(c, base(), 1, 1);
    expect(sOf(c, r[1])).toBeCloseTo(51, 6);
    expect(stepAnchor(c, base(), 7, 1)).toEqual(base());
  });
});

describe("addAnchor / removeAnchor / confirmAnchor", () => {
  const c = line(100);
  it("最も空いた間の真ん中へ、未確認で足す", () => {
    const a: QcaAnchor[] = [{ x: 10, y: 0, confirmed: true }];
    const r = addAnchor(c, a);
    expect(r).toHaveLength(2);
    expect(sOf(c, r[1])).toBeCloseTo(55, 6);
    expect(r[1].confirmed).toBe(false);
    expect(r[0].confirmed).toBe(true);
  });
  it("★負例: 上限を超えて足せない", () => {
    let a: QcaAnchor[] = [];
    for (let k = 0; k < MAX_ANCHORS + 3; k++) a = addAnchor(c, a);
    expect(a).toHaveLength(MAX_ANCHORS);
  });
  it("消す・確認する", () => {
    const a = proposeAnchors(c, 3);
    expect(removeAnchor(a, 1)).toHaveLength(2);
    expect(confirmAnchor(a, 0)[0].confirmed).toBe(true);
    expect(confirmAnchor(a, 0)[1].confirmed).toBe(false);
  });
});

describe("insertAnchorAt（クリックで足す）", () => {
  const c = line(100);
  it("中心線の上へ確認済みで足し、血管に沿った順の番号を返す", () => {
    const a: QcaAnchor[] = [
      { x: 20, y: 0, confirmed: true },
      { x: 80, y: 0, confirmed: true },
    ];
    const r = insertAnchorAt(c, a, [50, 6])!;
    expect(r.index).toBe(1);
    expect(r.anchors.map((x) => Math.round(x.x))).toEqual([20, 50, 80]);
    expect(r.anchors[1].confirmed).toBe(true);
    expect(r.anchors[1].y).toBeCloseTo(0, 9);
  });
  it("★負例: 隣に近すぎる・端点・上限では足さない", () => {
    const a: QcaAnchor[] = [{ x: 50, y: 0, confirmed: true }];
    expect(insertAnchorAt(c, a, [50.3, 0])).toBeNull();
    expect(insertAnchorAt(c, a, [0, 0])).toBeNull();
    expect(insertAnchorAt(c, a, [100, 0])).toBeNull();
    let full: QcaAnchor[] = [];
    for (let k = 0; k < MAX_ANCHORS; k++) full = insertAnchorAt(c, full, [10 + 10 * k, 0])!.anchors;
    expect(insertAnchorAt(c, full, [95, 0])).toBeNull();
  });
});

describe("resnapAnchors（中心線が変わったとき）", () => {
  it("少しずれた中心線へは付け直す（確認状態は保つ）", () => {
    const a: QcaAnchor[] = [{ x: 50, y: 0, confirmed: true }];
    const shifted: [number, number][] = line(100).map(([x, y]) => [x, y + 2]);
    const r = resnapAnchors(shifted, a, 5);
    expect(r.dropped).toBe(0);
    expect(r.anchors[0].y).toBeCloseTo(2, 9);
    expect(r.anchors[0].confirmed).toBe(true);
  });
  it("★負例: 径より離れた別の場所へは付けず、捨てる（別の場所を指さない）", () => {
    const a: QcaAnchor[] = [{ x: 50, y: 0, confirmed: true }];
    const far: [number, number][] = line(100).map(([x, y]) => [x, y + 30]);
    const r = resnapAnchors(far, a, 5);
    expect(r.anchors).toHaveLength(0);
    expect(r.dropped).toBe(1);
  });
  it("重なったものは 1 つにまとめる", () => {
    const a: QcaAnchor[] = [
      { x: 50, y: 0, confirmed: true },
      { x: 50.2, y: 0, confirmed: true },
    ];
    const r = resnapAnchors(line(100), a, 5);
    expect(r.anchors).toHaveLength(1);
    expect(r.dropped).toBe(1);
  });
});

describe("orderAnchors / pairAnchors", () => {
  it("血管に沿った順に並べ替える", () => {
    const c = line(100);
    const r = orderAnchors(c, [
      { x: 80, y: 0, confirmed: true },
      { x: 20, y: 0, confirmed: true },
    ]);
    expect(r.map((x) => x.x)).toEqual([20, 80]);
  });
  it("両方で確認済みの番号だけを組にする", () => {
    const a: QcaAnchor[] = [
      { x: 10, y: 0, confirmed: true },
      { x: 20, y: 0, confirmed: false },
      { x: 30, y: 0, confirmed: true },
    ];
    const b: QcaAnchor[] = [
      { x: 11, y: 1, confirmed: true },
      { x: 21, y: 1, confirmed: true },
      { x: 31, y: 1, confirmed: true },
    ];
    const r = pairAnchors(a, b);
    expect(r.pairs.map((p) => p.index)).toEqual([0, 2]);
    expect(r.mismatch).toBe(false);
  });
  it("★負例: 未確認のアンカーは 3D に出ない（全部未確認なら 0 組）", () => {
    const u = proposeAnchors(line(100), 3);
    expect(pairAnchors(u, u).pairs).toHaveLength(0);
  });
  it("数が違えば少ないほうに合わせ、食い違いを知らせる", () => {
    const a = proposeAnchors(line(100), 3).map((x) => ({ ...x, confirmed: true }));
    const b = proposeAnchors(line(100), 2).map((x) => ({ ...x, confirmed: true }));
    const r = pairAnchors(a, b);
    expect(r.pairs).toHaveLength(2);
    expect(r.mismatch).toBe(true);
  });
});

describe("anchorStripColumn（ストレート像の列）", () => {
  // 曲線（1/4 円弧）。列は弧長に比例（`qcaStraighten` の indexToCol と同じ作り）。
  const c = arc(60);
  const arcs = cumulativeArcs(c);
  const step = 0.5;
  const indexToCol = Float32Array.from(arcs.map((s) => s / step));
  it("列は弧長 ÷ 刻みに一致し、アンカーを動かすと単調に動く", () => {
    const total = arcs[arcs.length - 1];
    let prev = -Infinity;
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const at = pointAtArc(c, total * f)!;
      const col = anchorStripColumn(c, indexToCol, { x: at.point[0], y: at.point[1], confirmed: true })!;
      expect(col).toBeCloseTo((total * f) / step, 1);
      expect(col).toBeGreaterThan(prev);
      prev = col;
    }
  });
  it("中心線の外の点は直下の列に付く（線の外へ出ても列は連続）", () => {
    const at = pointAtArc(c, 40)!;
    const on = anchorStripColumn(c, indexToCol, { x: at.point[0], y: at.point[1], confirmed: true })!;
    const off = anchorStripColumn(c, indexToCol, { x: at.point[0] + at.tangent[1] * 3, y: at.point[1] - at.tangent[0] * 3, confirmed: true })!;
    expect(Math.abs(on - off)).toBeLessThan(0.3);
  });
  it("★負例: 中心線が 2 点未満・列のデータが足りなければ null（0 列に黙って置かない）", () => {
    expect(anchorStripColumn([[0, 0]], indexToCol, { x: 0, y: 0, confirmed: true })).toBeNull();
    expect(anchorStripColumn(c, new Float32Array(1), { x: 5, y: 5, confirmed: true })).toBeNull();
  });
});

describe("localRadiusPx", () => {
  it("近くのエッジから半径（径の半分）を出す", () => {
    const c = line(100);
    const offs = c.map(() => ({ left: -4, right: 4 }));
    expect(localRadiusPx(c, offs, 50)).toBeCloseTo(4, 9);
  });
  it("データが無い範囲では 0", () => {
    expect(localRadiusPx(line(100), [], 50)).toBe(0);
  });
});
