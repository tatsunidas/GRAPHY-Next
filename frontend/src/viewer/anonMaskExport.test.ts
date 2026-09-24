/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { maskPolygonFrom, withFrameScope } from "./anonMaskExport";
import type { PointPx } from "./roiRead";

const IMG = "wadouri:http://x/api/instances/1.2.840.113/file";
const XA_FRAME_3 = "wadouri:http://x/api/instances/1.2.840.999/frames/3?frame=3";

const SQUARE: PointPx[] = [
  [10, 10],
  [20, 10],
  [20, 20],
  [10, 20],
];

function polygonOf(r: ReturnType<typeof maskPolygonFrom>) {
  if (!("polygon" in r)) throw new Error(`expected polygon, got ${JSON.stringify(r)}`);
  return r.polygon;
}

function reasonOf(r: ReturnType<typeof maskPolygonFrom>) {
  if ("polygon" in r) throw new Error("expected a skip reason");
  return r.reason;
}

describe("焼き込みマスクに使える ROI の選別", () => {
  it("閉じた面 ROI は使える", () => {
    for (const tool of ["RectangleROI", "EllipticalROI", "CircleROI", "GraphyPolygonROI"]) {
      expect("polygon" in maskPolygonFrom(tool, SQUARE, true, IMG)).toBe(true);
    }
  });

  it("🔴 線・点・角度は使えない（面積を持たない）", () => {
    // 受け付けると「登録できたのに 1 画素も塗られていないのに Clean Pixel Data を申告する」
    // という新しい偽申告になる。
    for (const tool of ["Length", "GraphyPolylineROI", "Probe", "Angle"]) {
      expect(reasonOf(maskPolygonFrom(tool, SQUARE, false, IMG))).toBe("notClosedArea");
    }
  });

  it("開いたフリーハンドは使えない（閉じたものだけ）", () => {
    expect(reasonOf(maskPolygonFrom("PlanarFreehandROI", SQUARE, false, IMG))).toBe("notClosedArea");
    expect("polygon" in maskPolygonFrom("PlanarFreehandROI", SQUARE, true, IMG)).toBe(true);
  });

  it("頂点が無いものは使えない", () => {
    expect(reasonOf(maskPolygonFrom("RectangleROI", [], true, IMG))).toBe("noVertices");
  });

  it("参照画像が無いものは使えない", () => {
    expect(reasonOf(maskPolygonFrom("RectangleROI", SQUARE, true, ""))).toBe("noReference");
  });
});

describe("焼き込みマスクの中身", () => {
  it("🔴 頂点をサブピクセルのまま保つ（丸めると 1px ずれる）", () => {
    const pts: PointPx[] = [
      [10.25, 10.5],
      [20.75, 10.5],
      [20.75, 20.125],
      [10.25, 20.125],
    ];
    const p = polygonOf(maskPolygonFrom("GraphyPolygonROI", pts, true, IMG));
    expect(p.xs).toContain(10.25);
    expect(p.ys).toContain(20.125);
  });

  it("xs と ys の長さが一致し、3 頂点以上ある", () => {
    const p = polygonOf(maskPolygonFrom("GraphyPolygonROI", SQUARE, true, IMG));
    expect(p.xs.length).toBe(p.ys.length);
    expect(p.xs.length).toBeGreaterThanOrEqual(3);
  });

  it("🔴 適用先を index ではなく SOP Instance UID で指定する", () => {
    // index は並び順が変われば別スライスを塗る。
    const p = polygonOf(maskPolygonFrom("RectangleROI", SQUARE, true, IMG));
    expect(p.sopInstanceUids).toEqual(["1.2.840.113"]);
  });

  it("🔴 既定では、描いたフレームだけでなくインスタンス全体に効く", () => {
    // 焼き込み文字は全フレームの同じ位置に出るので、1 枚だけ塗ると残りに個人情報が残る。
    // 2026-09-24 の実測では 63 フレーム中 1 枚しか塗られていないのに「除去済み」と
    // 申告されていた。既定を全フレームにしたのはその再発防止。
    const p = polygonOf(maskPolygonFrom("RectangleROI", SQUARE, true, XA_FRAME_3));
    expect(p.sopInstanceUids).toEqual(["1.2.840.999"]);
    expect(p.frames).toEqual([]); // 空＝全フレーム（backend の appliesToFrame の規約）
  });

  it("明示して絞ったときだけ、描いたフレーム番号が入る（0 origin）", () => {
    const p = polygonOf(maskPolygonFrom("RectangleROI", SQUARE, true, XA_FRAME_3, "drawnFrameOnly"));
    expect(p.frames).toEqual([2]); // URL は 1 origin
  });

  it("フレーム指定の無い参照では、絞っても frames は空", () => {
    // 単一フレーム（CT/MR）はそもそもフレーム番号を持たない。ここで [null] のような
    // 値が入ると backend 側で「どのフレームにも当たらない」マスクになる。
    const p = polygonOf(maskPolygonFrom("RectangleROI", SQUARE, true, IMG, "drawnFrameOnly"));
    expect(p.frames).toEqual([]);
  });

  it("withFrameScope は頂点と適用先インスタンスを変えない", () => {
    // 匿名化ダイアログは作ったあとから範囲だけ切り替える。そのとき多角形そのものが
    // 変わってしまうと、画面の一覧と実際に塗る場所が食い違う。
    const p = polygonOf(maskPolygonFrom("RectangleROI", SQUARE, true, XA_FRAME_3));
    const narrowed = withFrameScope(p, 2, "drawnFrameOnly");
    expect(narrowed.xs).toEqual(p.xs);
    expect(narrowed.ys).toEqual(p.ys);
    expect(narrowed.sopInstanceUids).toEqual(p.sopInstanceUids);
    expect(narrowed.frames).toEqual([2]);
    expect(withFrameScope(narrowed, 2, "wholeInstance").frames).toEqual([]);
  });

  it("楕円は bbox ではなく多角形に展開される", () => {
    // 🔴 ImageJ の交換型は楕円を軸平行 bbox に潰し、回転した楕円で塗り足りなくなる。
    // ここでは「4 頂点のままではない＝多角形化されている」ことを確認する。
    const p = polygonOf(maskPolygonFrom("EllipticalROI", SQUARE, true, IMG));
    expect(p.xs.length).toBeGreaterThan(8);
  });
});
