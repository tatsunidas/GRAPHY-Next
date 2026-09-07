/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { maskPolygonFrom } from "./anonMaskExport";
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

  it("XA のようにフレームがある参照ではフレーム番号も持つ（0 origin）", () => {
    // XA の 1 ラン数十〜数百フレームは全部同じ SOP なので、SOP だけでは足りない。
    const p = polygonOf(maskPolygonFrom("RectangleROI", SQUARE, true, XA_FRAME_3));
    expect(p.sopInstanceUids).toEqual(["1.2.840.999"]);
    expect(p.frames).toEqual([2]); // URL は 1 origin
  });

  it("フレーム指定の無い参照では frames は空（全フレーム扱い）", () => {
    const p = polygonOf(maskPolygonFrom("RectangleROI", SQUARE, true, IMG));
    expect(p.frames).toEqual([]);
  });

  it("楕円は bbox ではなく多角形に展開される", () => {
    // 🔴 ImageJ の交換型は楕円を軸平行 bbox に潰し、回転した楕円で塗り足りなくなる。
    // ここでは「4 頂点のままではない＝多角形化されている」ことを確認する。
    const p = polygonOf(maskPolygonFrom("EllipticalROI", SQUARE, true, IMG));
    expect(p.xs.length).toBeGreaterThan(8);
  });
});
