/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import {
  ELLIPSE_MESH_SEGMENTS,
  buildRoiMesh,
  computeRoiStatsFrom,
  meshAreaMm2,
  meshAreaPx2,
  meshBBoxPx,
  meshCentroidPx,
  meshLength,
  meshLengthMm,
  pickSampleKind,
  polygonizeCircle,
  polygonizeEllipse,
  sampleAlongMesh,
  sampleInsideMesh,
  summarizeValues,
  type RoiMesh,
} from "./roiStats";
import type { PointPx } from "./roiRead";

const closedMesh = (pts: PointPx[]): RoiMesh => ({ pointsPx: pts, closed: true });
const openMesh = (pts: PointPx[]): RoiMesh => ({ pointsPx: pts, closed: false });

/** w×h の一様スライス。 */
function uniform(w: number, h: number, v: number): Float32Array {
  return new Float32Array(w * h).fill(v);
}

/** 値が x（列 index）と等しいスライス（補間・サンプリングの検算用）。 */
function rampX(w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = x;
  return out;
}

describe("pickSampleKind", () => {
  it("面 ROI は area、開いていれば line へ落ちる", () => {
    expect(pickSampleKind("RectangleROI", undefined)).toBe("area");
    expect(pickSampleKind("GraphyPolygonROI", true)).toBe("area");
    expect(pickSampleKind("GraphyPolylineROI", false)).toBe("line");
    expect(pickSampleKind("GraphyFreeLineROI", false)).toBe("line");
    expect(pickSampleKind("PlanarFreehandROI", false)).toBe("line");
  });

  it("Length は line、Probe は point", () => {
    expect(pickSampleKind("Length", undefined)).toBe("line");
    expect(pickSampleKind("Probe", undefined)).toBe("point");
  });

  it("Bidirectional / Angle / 未知のツールには値を出さない", () => {
    // 交差する 2 線分・折れ線なので、頂点列としてサンプルすると意味を成さない。
    expect(pickSampleKind("Bidirectional", undefined)).toBe("none");
    expect(pickSampleKind("Angle", undefined)).toBe("none");
    expect(pickSampleKind("CobbAngle", undefined)).toBe("none");
    expect(pickSampleKind("ArrowAnnotate", undefined)).toBe("none");
    expect(pickSampleKind("SomeFutureTool", undefined)).toBe("none");
  });

  it("大文字小文字・前後の空白を無視する", () => {
    expect(pickSampleKind("  rectangleroi ", undefined)).toBe("area");
  });
});

describe("メッシュ（面積・長さ）", () => {
  it("シューレース面積: 10×20 の矩形 = 200 px²", () => {
    const m = closedMesh([
      [0, 0],
      [10, 0],
      [10, 20],
      [0, 20],
    ]);
    expect(meshAreaPx2(m)).toBeCloseTo(200, 9);
  });

  it("頂点の向き（時計/反時計）で符号が変わらない", () => {
    const cw = closedMesh([
      [0, 0],
      [0, 20],
      [10, 20],
      [10, 0],
    ]);
    expect(meshAreaPx2(cw)).toBeCloseTo(200, 9);
  });

  it("開いた輪郭には面積を出さない", () => {
    expect(
      meshAreaPx2(
        openMesh([
          [0, 0],
          [10, 0],
          [10, 20],
        ]),
      ),
    ).toBeNull();
  });

  it("異方性画素: 面積は sx·sy 倍（ヤコビアン）", () => {
    const m = closedMesh([
      [0, 0],
      [10, 0],
      [10, 20],
      [0, 20],
    ]);
    // 200 px² × 0.5 × 2.0 = 200 mm²
    expect(meshAreaMm2(m, 0.5, 2.0)).toBeCloseTo(200, 9);
    expect(meshAreaMm2(m, 0.5, 0.5)).toBeCloseTo(50, 9);
  });

  it("画素間隔が無ければ mm を出さない（捏造しない）", () => {
    const m = closedMesh([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
    expect(meshAreaMm2(m, null, 0.5)).toBeNull();
    expect(meshAreaMm2(m, 0.5, undefined)).toBeNull();
    expect(meshAreaMm2(m, 0, 0.5)).toBeNull();
    expect(meshLengthMm(m, null, null)).toBeNull();
  });

  it("長さ: 閉なら周長、開なら折れ線長（同じ 1 本の関数）", () => {
    const pts: PointPx[] = [
      [0, 0],
      [3, 0],
      [3, 4],
    ];
    // 開: 3 + 4 = 7 / 閉: + 斜辺 5 = 12
    expect(meshLength(openMesh(pts))).toBeCloseTo(7, 9);
    expect(meshLength(closedMesh(pts))).toBeCloseTo(12, 9);
  });

  it("長さも異方性画素を辺ごとに正しく効かせる", () => {
    const pts: PointPx[] = [
      [0, 0],
      [3, 0],
      [3, 4],
    ];
    // x 方向 2mm/px, y 方向 0.5mm/px → 6 + 2 = 8
    expect(meshLength(openMesh(pts), 2, 0.5)).toBeCloseTo(8, 9);
  });

  it("重心: 矩形は中心", () => {
    const c = meshCentroidPx(
      closedMesh([
        [0, 0],
        [10, 0],
        [10, 20],
        [0, 20],
      ]),
    );
    expect(c?.[0]).toBeCloseTo(5, 9);
    expect(c?.[1]).toBeCloseTo(10, 9);
  });

  it("bbox", () => {
    expect(
      meshBBoxPx(
        openMesh([
          [3, -1],
          [10, 20],
          [-2, 4],
        ]),
      ),
    ).toEqual([-2, -1, 10, 20]);
  });
});

describe("楕円・円のメッシュ化", () => {
  it("楕円の面積が πab に一致する（相対誤差 < 1e-4）", () => {
    // handles = [bottom, top, left, right]（Cornerstone の EllipticalROI の並び）
    const a = 8; // 縦半径
    const b = 5; // 横半径
    const poly = polygonizeEllipse([
      [10, 10 - a],
      [10, 10 + a],
      [10 - b, 10],
      [10 + b, 10],
    ]);
    expect(poly.length).toBe(ELLIPSE_MESH_SEGMENTS);
    const area = meshAreaPx2(closedMesh(poly))!;
    expect(Math.abs(area / (Math.PI * a * b) - 1)).toBeLessThan(1e-4);
  });

  it("回転した楕円でも半軸ベクトルで正しく面積が出る", () => {
    // 45° 回した半軸 a=8, b=5。中心 (10,10)。
    const c = Math.SQRT1_2;
    const poly = polygonizeEllipse([
      [10 - 8 * c, 10 - 8 * c],
      [10 + 8 * c, 10 + 8 * c],
      [10 + 5 * c, 10 - 5 * c],
      [10 - 5 * c, 10 + 5 * c],
    ]);
    const area = meshAreaPx2(closedMesh(poly))!;
    expect(Math.abs(area / (Math.PI * 8 * 5) - 1)).toBeLessThan(1e-4);
  });

  it("円の面積が πr² に一致する", () => {
    const poly = polygonizeCircle([
      [10, 10],
      [10, 4],
    ]);
    const area = meshAreaPx2(closedMesh(poly))!;
    expect(Math.abs(area / (Math.PI * 36) - 1)).toBeLessThan(1e-4);
  });

  it("退化した入力（点が足りない/半径 0）は空を返す", () => {
    expect(polygonizeEllipse([[0, 0]])).toEqual([]);
    expect(
      polygonizeCircle([
        [5, 5],
        [5, 5],
      ]),
    ).toEqual([]);
  });
});

describe("buildRoiMesh", () => {
  it("矩形はハンドルの並び順に依らず正しい 4 角形になる", () => {
    // RectangleROITool は操作したハンドルによって points の並びを組み替える。
    const corners: PointPx[] = [
      [2, 3],
      [12, 3],
      [12, 9],
      [2, 9],
    ];
    const shuffled: PointPx[] = [corners[0], corners[2], corners[1], corners[3]];
    const m = buildRoiMesh("RectangleROI", shuffled, undefined)!;
    expect(m.closed).toBe(true);
    expect(meshAreaPx2(m)).toBeCloseTo(60, 9);
  });

  it("輪郭系は polyline をそのまま使い、closed を尊重する", () => {
    const pts: PointPx[] = [
      [0, 0],
      [4, 0],
      [4, 4],
    ];
    expect(buildRoiMesh("GraphyPolygonROI", pts, true)!.closed).toBe(true);
    expect(buildRoiMesh("GraphyPolylineROI", pts, false)!.closed).toBe(false);
  });

  it("計測できないツールは null", () => {
    expect(buildRoiMesh("Bidirectional", [[0, 0]], undefined)).toBeNull();
    expect(buildRoiMesh("RectangleROI", [], undefined)).toBeNull();
  });
});

describe("sampleInsideMesh", () => {
  it("矩形の内部画素だけを拾う", () => {
    const w = 10;
    const h = 10;
    const values = rampX(w, h);
    // 画素中心 (x+0.5) が 2..5 に入るのは x = 2,3,4
    const m = closedMesh([
      [2, 1],
      [5, 1],
      [5, 4],
      [2, 4],
    ]);
    const s = sampleInsideMesh(m, values, w, h);
    expect(s.length).toBe(3 * 3);
    expect(Array.from(new Set(Array.from(s))).sort()).toEqual([2, 3, 4]);
  });

  it("画像の外へはみ出しても落ちない（内側だけ拾う）", () => {
    const w = 4;
    const h = 4;
    const s = sampleInsideMesh(
      closedMesh([
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ]),
      uniform(w, h, 7),
      w,
      h,
    );
    expect(s.length).toBe(16);
  });

  it("1 画素も入らない極小 ROI は最寄り 1 画素で代表する（n=1 が表に出る）", () => {
    const w = 8;
    const h = 8;
    const s = sampleInsideMesh(
      closedMesh([
        [3.51, 3.51],
        [3.6, 3.51],
        [3.6, 3.6],
        [3.51, 3.6],
      ]),
      rampX(w, h),
      w,
      h,
    );
    expect(s.length).toBe(1);
    expect(s[0]).toBe(3);
  });

  it("開いた輪郭には使わない（空を返す）", () => {
    expect(
      sampleInsideMesh(
        openMesh([
          [0, 0],
          [4, 0],
        ]),
        uniform(8, 8, 1),
        8,
        8,
      ).length,
    ).toBe(0);
  });
});

describe("sampleAlongMesh", () => {
  it("水平線に沿った双一次補間が ramp と一致する", () => {
    const w = 20;
    const h = 4;
    const pr = sampleAlongMesh(
      openMesh([
        [2.5, 1.5],
        [10.5, 1.5],
      ]),
      rampX(w, h),
      w,
      h,
      1,
      1,
      1, // 1px 刻み
    )!;
    expect(pr.distanceUnit).toBe("mm");
    // 画素中心 (2.5,1.5) の値は 2、1px 進むごとに +1。
    expect(pr.values[0]).toBeCloseTo(2, 6);
    expect(pr.values[1]).toBeCloseTo(3, 6);
    expect(pr.values[pr.values.length - 1]).toBeCloseTo(10, 6);
    expect(pr.distance[pr.distance.length - 1]).toBeCloseTo(8, 6);
  });

  it("サンプル間隔は mm 空間で等間隔（異方性画素）", () => {
    const w = 20;
    const h = 20;
    // y 方向のみの線。sy=2mm/px なので 10px = 20mm。
    const pr = sampleAlongMesh(
      openMesh([
        [5.5, 0.5],
        [5.5, 10.5],
      ]),
      uniform(w, h, 3),
      w,
      h,
      0.5,
      2,
      1,
    )!;
    // step = 1px × min(0.5, 2) = 0.5mm、全長 20mm → 41 サンプル
    expect(pr.distance[pr.distance.length - 1]).toBeCloseTo(20, 6);
    expect(pr.distance[1] - pr.distance[0]).toBeCloseTo(0.5, 6);
  });

  it("画素間隔が無ければ距離は px 単位だと明示する", () => {
    const pr = sampleAlongMesh(
      openMesh([
        [0.5, 0.5],
        [4.5, 0.5],
      ]),
      rampX(8, 8),
      8,
      8,
      null,
      null,
    )!;
    expect(pr.distanceUnit).toBe("px");
    expect(pr.distance[pr.distance.length - 1]).toBeCloseTo(4, 6);
  });

  it("頂点が 1 点しかなければ null", () => {
    expect(sampleAlongMesh(openMesh([[1, 1]]), uniform(4, 4, 0), 4, 4, 1, 1)).toBeNull();
  });
});

describe("summarizeValues", () => {
  it("既知の並びで一次統計量が合う", () => {
    // 1..9: mean=5, 母分散=20/3 → sd≈2.581989, median=5
    const s = summarizeValues(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]), "HU")!;
    expect(s.n).toBe(9);
    expect(s.mean).toBeCloseTo(5, 9);
    expect(s.sd).toBeCloseTo(Math.sqrt(20 / 3), 6);
    expect(s.min).toBe(1);
    expect(s.max).toBe(9);
    expect(s.median).toBeCloseTo(5, 9);
    expect(s.sum).toBeCloseTo(45, 6);
    expect(s.unit).toBe("HU");
  });

  it("中央値・分位点はソートした実値から出す（ビン推定ではない）", () => {
    const s = summarizeValues(Float32Array.from([1, 2, 3, 4]), "HU")!;
    expect(s.median).toBeCloseTo(2.5, 9);
    const t = summarizeValues(Float32Array.from([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]), "HU")!;
    expect(t.p5).toBeCloseTo(5, 6);
    expect(t.p95).toBeCloseTo(95, 6);
  });

  it("左右対称なら歪度 0、一様値なら SD 0・エントロピー 0", () => {
    const sym = summarizeValues(Float32Array.from([-2, -1, 0, 1, 2]), "HU")!;
    expect(sym.skewness).toBeCloseTo(0, 9);

    const flat = summarizeValues(uniform(4, 4, 42), "HU")!;
    expect(flat.mean).toBeCloseTo(42, 9);
    expect(flat.sd).toBeCloseTo(0, 9);
    expect(flat.entropy).toBeCloseTo(0, 9);
  });

  it("NaN / Inf は母集団から外す", () => {
    const s = summarizeValues(Float32Array.from([1, NaN, 3, Infinity, 5]), "HU")!;
    expect(s.n).toBe(3);
    expect(s.mean).toBeCloseTo(3, 9);
  });

  it("空・全て非有限なら null（0 で埋めない）", () => {
    expect(summarizeValues(new Float32Array(0), "HU")).toBeNull();
    expect(summarizeValues(Float32Array.from([NaN, NaN]), "HU")).toBeNull();
  });
});

describe("computeRoiStatsFrom", () => {
  const slice = { values: uniform(32, 32, 100), width: 32, height: 32 };

  it("閉 ROI: 面積はメッシュから、統計はラスタ画素から（別物として両方出る）", () => {
    const r = computeRoiStatsFrom({
      roiUid: "a",
      tool: "RectangleROI",
      imageId: "wadouri:x",
      pointsPx: [
        [4, 4],
        [14, 4],
        [14, 14],
        [4, 14],
      ],
      slice,
      unit: "HU",
      spacingX: 0.5,
      spacingY: 0.5,
    });
    expect(r.geometry.kind).toBe("area");
    expect(r.geometry.areaPx2).toBeCloseTo(100, 9);
    expect(r.geometry.areaMm2).toBeCloseTo(25, 9); // 100 px² × 0.25 mm²/px²
    expect(r.geometry.sampleCount).toBe(100);
    expect(r.geometry.perimeterMm).toBeCloseTo(20, 9);
    expect(r.values?.mean).toBeCloseTo(100, 9);
    expect(r.values?.sd).toBeCloseTo(0, 9);
    expect(r.values?.unit).toBe("HU");
    expect(r.warnings).not.toContain("no-spacing");
  });

  it("開 ROI（ポリゴンライン）でも長さと画素統計が出る", () => {
    const r = computeRoiStatsFrom({
      roiUid: "b",
      tool: "GraphyPolylineROI",
      imageId: "wadouri:x",
      pointsPx: [
        [2.5, 2.5],
        [12.5, 2.5],
      ],
      closed: false,
      slice: { values: rampX(32, 32), width: 32, height: 32 },
      unit: "HU",
      spacingX: 1,
      spacingY: 1,
      withProfile: true,
    });
    expect(r.geometry.kind).toBe("line");
    expect(r.geometry.areaMm2).toBeUndefined(); // 開いた線に面積は無い
    expect(r.geometry.perimeterMm).toBeCloseTo(10, 9);
    expect(r.values).toBeDefined();
    expect(r.values!.min).toBeCloseTo(2, 6);
    expect(r.values!.max).toBeCloseTo(12, 6);
    expect(r.profile?.distanceUnit).toBe("mm");
    expect(r.profile!.values.length).toBeGreaterThan(10);
  });

  it("プローブは 1 画素", () => {
    const r = computeRoiStatsFrom({
      roiUid: "c",
      tool: "Probe",
      imageId: "wadouri:x",
      pointsPx: [[5.5, 5.5]],
      slice: { values: rampX(32, 32), width: 32, height: 32 },
      unit: "HU",
      spacingX: 1,
      spacingY: 1,
    });
    expect(r.geometry.kind).toBe("point");
    expect(r.geometry.sampleCount).toBe(1);
    expect(r.values?.mean).toBeCloseTo(5, 9);
  });

  it("画素間隔が無ければ mm を出さず no-spacing を立てる（px は出る）", () => {
    const r = computeRoiStatsFrom({
      roiUid: "d",
      tool: "RectangleROI",
      imageId: "wadouri:x",
      pointsPx: [
        [4, 4],
        [14, 4],
        [14, 14],
        [4, 14],
      ],
      slice,
      unit: "raw",
      spacingX: null,
      spacingY: null,
    });
    expect(r.warnings).toContain("no-spacing");
    expect(r.geometry.spatiallyCalibrated).toBe(false);
    expect(r.geometry.areaMm2).toBeUndefined();
    expect(r.geometry.areaPx2).toBeCloseTo(100, 9);
    expect(r.geometry.longAxisMm).toBeUndefined();
    expect(r.values?.mean).toBeCloseTo(100, 9); // 画素値は校正と無関係に読める
  });

  it("画素が無ければ幾何だけ返す", () => {
    const r = computeRoiStatsFrom({
      roiUid: "e",
      tool: "RectangleROI",
      imageId: "wadouri:x",
      pointsPx: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      slice: null,
      unit: "HU",
      spacingX: 1,
      spacingY: 1,
    });
    expect(r.warnings).toContain("no-pixels");
    expect(r.values).toBeUndefined();
    expect(r.geometry.areaMm2).toBeCloseTo(100, 9);
  });

  it("計測できないツールは unsupported-tool を立てて値を出さない", () => {
    const r = computeRoiStatsFrom({
      roiUid: "f",
      tool: "Bidirectional",
      imageId: "wadouri:x",
      pointsPx: [
        [0, 0],
        [10, 10],
        [0, 10],
        [10, 0],
      ],
      slice,
      unit: "HU",
      spacingX: 1,
      spacingY: 1,
    });
    expect(r.geometry.kind).toBe("none");
    expect(r.warnings).toContain("unsupported-tool");
    expect(r.values).toBeUndefined();
  });

  it("楕円 ROI の面積は πab（ラスタ画素数ではない）", () => {
    const r = computeRoiStatsFrom({
      roiUid: "g",
      tool: "EllipticalROI",
      imageId: "wadouri:x",
      pointsPx: [
        [16, 8],
        [16, 24],
        [10, 16],
        [22, 16],
      ],
      slice,
      unit: "HU",
      spacingX: 1,
      spacingY: 1,
    });
    const truth = Math.PI * 8 * 6;
    expect(Math.abs(r.geometry.areaPx2! / truth - 1)).toBeLessThan(1e-4);
    // ラスタ画素数は量子化のぶんだけ必ずずれる＝別項目で持つのが正しい。
    expect(r.geometry.sampleCount).not.toBe(Math.round(truth));
    expect(r.geometry.longAxisMm).toBeCloseTo(16, 1);
  });
});

describe("退化した形（描いている最中の輪郭）", () => {
  const slice = { values: uniform(32, 32, 100), width: 32, height: 32 };

  it("2 点未満の面型・線型では何も測らない（周囲長 0 のような値を作らない）", () => {
    for (const tool of ["GraphyFreehandROI", "GraphyPolylineROI", "RectangleROI"]) {
      const r = computeRoiStatsFrom({
        roiUid: "a",
        tool,
        imageId: "wadouri:x",
        pointsPx: [[4, 4]],
        slice,
        unit: "HU",
        spacingX: 1,
        spacingY: 1,
      });
      expect(r.warnings, tool).toContain("empty-mesh");
      expect(r.values, tool).toBeUndefined();
      expect(r.geometry.perimeterMm, tool).toBeUndefined();
      expect(r.geometry.areaMm2, tool).toBeUndefined();
    }
  });

  it("プローブは 1 点でよい", () => {
    const r = computeRoiStatsFrom({
      roiUid: "a",
      tool: "Probe",
      imageId: "wadouri:x",
      pointsPx: [[4, 4]],
      slice,
      unit: "HU",
      spacingX: 1,
      spacingY: 1,
    });
    expect(r.warnings).not.toContain("empty-mesh");
    expect(r.values?.mean).toBeCloseTo(100, 9);
  });
});
