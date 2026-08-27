/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  buildPluginMeta,
  computeCalipers,
  convexHull,
  distanceMm,
  hasShapeCalipers,
  pickPluginMeta,
  pluginMetaPrefix,
  readRoiStats,
  roiPointsPx,
  type PointPx,
} from "./roiRead";

/** 中心 (cx,cy)・半径 r(px) の円を n 点で近似（RECIST 検証用のデジタルファントムと同じ形）。 */
function circlePx(cx: number, cy: number, r: number, n: number): PointPx[] {
  const out: PointPx[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    out.push([cx + r * Math.cos(th), cy + r * Math.sin(th)]);
  }
  return out;
}

const RECT_40x20: PointPx[] = [
  [0, 0],
  [40, 0],
  [40, 20],
  [0, 20],
];

describe("convexHull", () => {
  it("内部の点を落とし、外周だけを残す", () => {
    const hull = convexHull([...RECT_40x20, [10, 10], [20, 5], [39, 19]]);
    expect(hull).toHaveLength(4);
    for (const p of RECT_40x20) {
      expect(hull.some((h) => h[0] === p[0] && h[1] === p[1])).toBe(true);
    }
  });

  it("共線の点は落とす（極点だけ残す）", () => {
    const hull = convexHull([
      [0, 0],
      [5, 0],
      [10, 0],
    ]);
    expect(hull).toHaveLength(2);
  });

  it("重複点は 1 点に畳む", () => {
    expect(convexHull([[3, 4], [3, 4], [3, 4]])).toEqual([[3, 4]]);
  });

  it("点が無い / 1 点だけでも落ちない", () => {
    expect(convexHull([])).toEqual([]);
    expect(convexHull([[1, 2]])).toEqual([[1, 2]]);
  });
});

describe("computeCalipers — 解析解と一致すること", () => {
  it("正方形: 長径=対角、短径も対角に直交する幅で等しい", () => {
    const sq: PointPx[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const c = computeCalipers(sq, 1, 1);
    expect(c).not.toBeNull();
    // 対角 = 10√2
    expect(c!.longAxisMm).toBeCloseTo(Math.SQRT2 * 10, 10);
    expect(c!.shortAxisMm).toBeCloseTo(Math.SQRT2 * 10, 10);
  });

  it("長方形 40x20: 長径=対角 √2000、短径=2wh/対角", () => {
    const diag = Math.sqrt(40 * 40 + 20 * 20);
    const c = computeCalipers(RECT_40x20, 1, 1);
    expect(c!.longAxisMm).toBeCloseTo(diag, 10);
    expect(c!.shortAxisMm).toBeCloseTo((2 * 40 * 20) / diag, 10);
  });

  it("異方性画素: mm 空間で計算する（px のまま計算していたら合わない）", () => {
    // 40x40 px を spacingX=0.5 / spacingY=1.0 で測ると mm では 20x40 の長方形。
    const sq: PointPx[] = [
      [0, 0],
      [40, 0],
      [40, 40],
      [0, 40],
    ];
    const c = computeCalipers(sq, 0.5, 1.0);
    const diag = Math.sqrt(20 * 20 + 40 * 40);
    expect(c!.longAxisMm).toBeCloseTo(diag, 10);
    expect(c!.shortAxisMm).toBeCloseTo((2 * 20 * 40) / diag, 10);
  });

  it("水平線分: 長径=長さ、短径=0", () => {
    const c = computeCalipers(
      [
        [0, 0],
        [40, 0],
      ],
      1,
      1,
    );
    expect(c!.longAxisMm).toBeCloseTo(40, 10);
    expect(c!.shortAxisMm).toBeCloseTo(0, 10);
  });

  it("円: 長径・短径ともに直径に一致する（多角形近似の誤差内）", () => {
    const c = computeCalipers(circlePx(256, 256, 20, 720), 1, 1);
    expect(c!.longAxisMm).toBeGreaterThan(39.99);
    expect(c!.longAxisMm).toBeLessThanOrEqual(40.0001);
    expect(c!.shortAxisMm).toBeGreaterThan(39.99);
    expect(c!.shortAxisMm).toBeLessThanOrEqual(40.0001);
  });

  it("実機 fixture の画素間隔で 30mm 病変を測ると 30mm になる", () => {
    // ct-basic fixture と同じ 0.644531 mm/px。半径 15mm = 23.28 px。
    const sp = 0.644531;
    const c = computeCalipers(circlePx(256, 256, 15 / sp, 720), sp, sp);
    expect(c!.longAxisMm).toBeCloseTo(30, 2);
    expect(c!.shortAxisMm).toBeCloseTo(30, 2);
  });

  it("内部の点を足しても結果が変わらない（凸包に落としている）", () => {
    const bare = computeCalipers(RECT_40x20, 1, 1)!;
    const withInterior = computeCalipers([...RECT_40x20, [10, 10], [20, 5], [1, 19]], 1, 1)!;
    expect(withInterior.longAxisMm).toBeCloseTo(bare.longAxisMm, 12);
    expect(withInterior.shortAxisMm).toBeCloseTo(bare.shortAxisMm, 12);
  });

  it("長径の両端は画素座標で返る（対角の 2 頂点）", () => {
    const ends = computeCalipers(RECT_40x20, 1, 1)!.longAxisEnds;
    const key = (p: PointPx) => `${p[0]},${p[1]}`;
    const set = new Set(ends.map(key));
    expect(set.has("0,0") || set.has("40,20")).toBe(true);
    expect(set.size).toBe(2);
  });
});

describe("computeCalipers — mm を捏造しない", () => {
  it("画素間隔が不明なら null（0mm や px 値を返さない）", () => {
    expect(computeCalipers(RECT_40x20, null, 1)).toBeNull();
    expect(computeCalipers(RECT_40x20, 1, undefined)).toBeNull();
    expect(computeCalipers(RECT_40x20, NaN, 1)).toBeNull();
  });

  it("画素間隔が 0 以下なら null", () => {
    expect(computeCalipers(RECT_40x20, 0, 1)).toBeNull();
    expect(computeCalipers(RECT_40x20, 1, -0.5)).toBeNull();
  });

  it("有効な点が 2 点未満なら null", () => {
    expect(computeCalipers([], 1, 1)).toBeNull();
    expect(computeCalipers([[1, 1]], 1, 1)).toBeNull();
    expect(computeCalipers([[1, 1], [1, 1]], 1, 1)).toBeNull();
  });

  it("非有限の座標は除外される", () => {
    const c = computeCalipers([[0, 0], [40, 0], [NaN, 5], [10, Infinity]], 1, 1);
    expect(c!.longAxisMm).toBeCloseTo(40, 10);
  });
});

describe("distanceMm", () => {
  it("異方性画素で mm 距離を返す", () => {
    expect(distanceMm([0, 0], [3, 4], 1, 1)).toBeCloseTo(5, 12);
    expect(distanceMm([0, 0], [3, 4], 2, 1)).toBeCloseTo(Math.sqrt(36 + 16), 12);
  });

  it("画素間隔が不明なら null", () => {
    expect(distanceMm([0, 0], [3, 4], null, 1)).toBeNull();
    expect(distanceMm([0, 0], [3, 4], 1, 0)).toBeNull();
  });
});

describe("readRoiStats", () => {
  it("対象 imageId のエントリを優先して拾う", () => {
    const stats = {
      "wadouri:a": { length: 10, mean: -20 },
      "wadouri:b": { length: 42.5, mean: 35, stdDev: 1 },
    };
    expect(readRoiStats(stats, "wadouri:b").length).toBe(42.5);
  });

  it("指定キーが無ければ中身のあるエントリを選ぶ（空エントリを掴まない）", () => {
    const stats = { "wadouri:a": {}, "wadouri:b": { area: 314.2 } };
    expect(readRoiStats(stats, "wadouri:zzz").area).toBe(314.2);
  });

  it("取れない項目は undefined のまま（0 で埋めない）", () => {
    const s = readRoiStats({ k: { length: 12 } });
    expect(s.length).toBe(12);
    expect(s.area).toBeUndefined();
    expect(s.mean).toBeUndefined();
  });

  it("統計の単位は modalityUnit のみ（長さの単位 mm を混ぜない）", () => {
    expect(readRoiStats({ k: { mean: 1, modalityUnit: "HU" } }).unit).toBe("HU");
    // Cornerstone の `unit` は長さの単位。ここに来ると「統計の単位が mm」になってしまう（実機で踏んだ）。
    expect(readRoiStats({ k: { length: 55.6, unit: "mm" } }).unit).toBeUndefined();
    expect(readRoiStats({ k: { length: 55.6, unit: "mm" } }).lengthUnit).toBe("mm");
  });

  it("画素間隔が無いシリーズでは lengthUnit が px として見える", () => {
    const s = readRoiStats({ k: { length: 86, unit: "px" } });
    expect(s.lengthUnit).toBe("px");
    expect(s.length).toBe(86);
  });

  it("非有限値は落とす", () => {
    const s = readRoiStats({ k: { length: NaN, area: Infinity, mean: 3 } });
    expect(s.length).toBeUndefined();
    expect(s.area).toBeUndefined();
    expect(s.mean).toBe(3);
  });

  it("空・null・非オブジェクトでも落ちない", () => {
    expect(readRoiStats(undefined)).toEqual({});
    expect(readRoiStats(null)).toEqual({});
    expect(readRoiStats({})).toEqual({});
    expect(readRoiStats("x")).toEqual({});
  });
});

describe("ROI 属性のプラグイン名前空間", () => {
  it("書いたキーは plugin.<id>. 名前空間に入る", () => {
    expect(buildPluginMeta("lesion-evanesco", { trackingId: "1" })).toEqual({
      "plugin.lesion-evanesco.trackingId": "1",
    });
    expect(pluginMetaPrefix("abc")).toBe("plugin.abc.");
  });

  it("読むと接頭辞が剥がれる（書いた通りに戻る）", () => {
    const stored = buildPluginMeta("recist", { trackingId: "3", lymphNode: "true" });
    expect(pickPluginMeta(stored, "recist")).toEqual({ trackingId: "3", lymphNode: "true" });
  });

  it("他プラグインの属性は見えない（名前空間の分離）", () => {
    const custom = {
      ...buildPluginMeta("recist", { owner: "recist" }),
      ...buildPluginMeta("other-plugin", { owner: "other", secret: "x" }),
    };
    expect(pickPluginMeta(custom, "recist")).toEqual({ owner: "recist" });
    expect(pickPluginMeta(custom, "other-plugin")).toEqual({ owner: "other", secret: "x" });
  });

  it("本体（ROI マネージャ）が付けたキーは見えない", () => {
    const custom = { label: "liver", "roiMgr.color": "#f00", ...buildPluginMeta("recist", { a: "1" }) };
    expect(pickPluginMeta(custom, "recist")).toEqual({ a: "1" });
  });

  it("id が他 id の接頭辞でも混ざらない（前方一致の取り違え防止）", () => {
    const custom = { ...buildPluginMeta("recist", { a: "1" }), ...buildPluginMeta("recist-pro", { b: "2" }) };
    // "plugin.recist." は "plugin.recist-pro." の接頭辞ではない（末尾のドットが効く）。
    expect(pickPluginMeta(custom, "recist")).toEqual({ a: "1" });
    expect(pickPluginMeta(custom, "recist-pro")).toEqual({ b: "2" });
  });

  it("値は文字列化される（プラグインは数値や boolean を渡してくる）", () => {
    const patch = { n: 5, b: true } as unknown as Record<string, string>;
    expect(buildPluginMeta("p", patch)).toEqual({ "plugin.p.n": "5", "plugin.p.b": "true" });
  });

  it("未設定・空でも落ちない", () => {
    expect(pickPluginMeta(undefined, "p")).toEqual({});
    expect(pickPluginMeta({}, "p")).toEqual({});
    expect(buildPluginMeta("p", undefined)).toEqual({});
  });
});

describe("hasShapeCalipers", () => {
  it("輪郭として意味づけられるツールでは true", () => {
    for (const t of ["EllipticalROI", "RectangleROI", "PlanarFreehandROI", "Length", "CircleROI", "SplineROI"]) {
      expect(hasShapeCalipers(t)).toBe(true);
    }
  });

  it("RectangleROI は除外されない（'angle' の部分一致に引っかけない）", () => {
    // 除外を正規表現の部分一致で書くと Rect**angle**ROI が黙って計測不能になる。実際に踏んだ罠。
    expect(hasShapeCalipers("RectangleROI")).toBe(true);
    expect(hasShapeCalipers("Angle")).toBe(false);
  });

  it("交差線分・折れ線・点・注記のツールでは false", () => {
    // Bidirectional はユーザーが引いた 2 軸が計測値であり、形状から出し直す意味が無い。
    for (const t of ["Bidirectional", "Angle", "CobbAngle", "Probe", "ArrowAnnotate"]) {
      expect(hasShapeCalipers(t)).toBe(false);
    }
  });

  it("知らないツールには出さない（許可リスト方式）", () => {
    expect(hasShapeCalipers("SomeFutureTool")).toBe(false);
    expect(hasShapeCalipers("")).toBe(false);
  });

  it("大文字小文字・前後の空白は無視する", () => {
    expect(hasShapeCalipers("  ellipticalROI ")).toBe(true);
  });
});

describe("Bidirectional のハンドルに形状キャリパを当てると誤る（除外の根拠）", () => {
  it("短軸を長軸の端寄りに引くと、ハンドル間の最遠距離が長軸を超える", () => {
    // 長軸 A(0,0)–B(100,0) = 100px。短軸を B のほぼ端（x=99）に ±20px で引いた場合。
    // |A→短軸端| = sqrt(99² + 20²) = 101.0 > 100 ＝ ユーザーが引いた長軸を超える。
    const handles: PointPx[] = [
      [0, 0],
      [100, 0],
      [99, -20],
      [99, 20],
    ];
    const cal = computeCalipers(handles, 1, 1)!;
    // ユーザーが引いた長軸は 100 なのに、頂点間の最遠距離はそれより長い。
    expect(cal.longAxisMm).toBeGreaterThan(100);
    // だからこのツールには形状キャリパを出さない。
    expect(hasShapeCalipers("Bidirectional")).toBe(false);
  });
});

describe("roiPointsPx", () => {
  const world = [
    [10, 20, 5],
    [30, 40, 5],
  ];

  it("変換器が答えれば、その画素座標をそのまま使う", () => {
    const pts = roiPointsPx(world, (w) => [w[0] / 2, w[1] / 2], 0.5, 0.5);
    expect(pts).toEqual([
      [5, 10],
      [15, 20],
    ]);
  });

  it("🚨 幾何が無いスタック（XA）で 1 点も変換できないとき、world/画素間隔 で復元する", () => {
    // これが無いと計測が丸ごと落ちる（2026-08-25 の実機事象）。
    const pts = roiPointsPx(world, () => null, 0.2, 0.4);
    expect(pts[0][0]).toBeCloseTo(50, 9);
    expect(pts[0][1]).toBeCloseTo(50, 9);
    expect(pts[1][0]).toBeCloseTo(150, 9);
    expect(pts[1][1]).toBeCloseTo(100, 9);
  });

  it("変換器が例外を投げても落ちない（フォールバックへ）", () => {
    const pts = roiPointsPx(world, () => {
      throw new Error("no imagePlaneModule");
    }, 1, 1);
    expect(pts).toEqual([
      [10, 20],
      [30, 40],
    ]);
  });

  it("画素間隔が無ければ 1 として扱う（world = 画素）", () => {
    expect(roiPointsPx(world, () => null, null, undefined)).toEqual([
      [10, 20],
      [30, 40],
    ]);
  });

  it("一部だけ変換できたときはフォールバックせず、変換できた点だけを使う", () => {
    // 「1 点でも取れたなら幾何はある」＝残りは本当に画像外などで落ちた点。
    const pts = roiPointsPx(world, (w) => (w[0] === 10 ? [1, 2] : null), 1, 1);
    expect(pts).toEqual([[1, 2]]);
  });

  it("非有限な座標は落とす", () => {
    const pts = roiPointsPx(
      [
        [1, 2, 0],
        [NaN, 3, 0],
      ],
      (w) => [w[0], w[1]],
      1,
      1,
    );
    expect(pts).toEqual([[1, 2]]);
  });
});
