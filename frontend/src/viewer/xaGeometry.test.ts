/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA 投影幾何の検査（`fw/angio-design.md` §10.1 / A6a）。
 *
 * <h3>ここで確かめられること / 確かめられないこと</h3>
 * 投影 → 逆投影 → 三角測量の**往復**は、規約が何であれ内部整合するので強い検査になる。
 * 一方で **DICOM の角度定義そのものは検査できない**（規約を自分で定義して自分で使っている）。
 * `bench/` の GNBP-XA-3 も同じ規約で生成しているので同様。角度定義の正しさは規格の読解と
 * 実機データでしか確かめられない。**「テストが通る＝角度定義が正しい」と読まないこと。**
 */
import { describe, expect, it } from "vitest";
import {
  bundleAdjustAngles,
  cross,
  dot,
  norm,
  pixelToRay,
  projectToPixel,
  reprojectionErrorPx,
  triangulate,
  viewBasis,
  viewSeparationDeg,
  withAngleOffset,
  type Vec3,
  type XaViewGeometry,
} from "./xaGeometry";

/** GNBP-XA-3 と同じ装置定数。 */
function geom(primary: number, secondary: number): XaViewGeometry {
  return {
    primaryAngleDeg: primary,
    secondaryAngleDeg: secondary,
    sidMm: 1000,
    sodMm: 750,
    imagerSpacingMm: [0.3, 0.3],
    principalPoint: [256, 256],
  };
}

/** GNBP-XA-3 の 4 視点。 */
const VIEWS = [geom(-30, 0), geom(60, 20), geom(-10, -30), geom(30, 30)];

describe("視点の基底", () => {
  it("正面（0/0）は前方を向き、列は患者の左・行は足側", () => {
    const b = viewBasis(geom(0, 0));
    expect(b.d[0]).toBeCloseTo(0, 9);
    expect(b.d[1]).toBeCloseTo(-1, 9); // 前方（Y=後 なので −Y）
    expect(b.d[2]).toBeCloseTo(0, 9);
    expect(b.u[0]).toBeCloseTo(1, 9); // 患者の左
    expect(b.v[2]).toBeCloseTo(-1, 9); // 足側
  });

  it("LAO 90 は患者の左から、CRA 90 は頭側から見る", () => {
    expect(viewBasis(geom(90, 0)).d[0]).toBeCloseTo(1, 9);
    expect(viewBasis(geom(0, 90)).d[2]).toBeCloseTo(1, 9);
  });

  it("基底は正規直交系", () => {
    for (const g of VIEWS) {
      const b = viewBasis(g);
      expect(norm(b.d)).toBeCloseTo(1, 9);
      expect(norm(b.u)).toBeCloseTo(1, 9);
      expect(norm(b.v)).toBeCloseTo(1, 9);
      expect(dot(b.d, b.u)).toBeCloseTo(0, 9);
      expect(dot(b.d, b.v)).toBeCloseTo(0, 9);
      expect(dot(b.u, b.v)).toBeCloseTo(0, 9);
      // 🔑 **u × v = −d**（+d ではない）。画面の「奥」は視線方向 d ではなく **−d**
      //    ＝ 検出器から線源へ向かう向きだから。画像は検出器側から線源を見る向きで
      //    表示する（正面像で患者の左が画像の右に来る）ので、これで整合している。
      //    ここを +d だと思い込むと、以降の外積が全部裏返る。
      const c = cross(b.u, b.v);
      expect(dot(c, b.d)).toBeCloseTo(-1, 9);
    }
  });

  it("β=±90 の退化でも破綻しない", () => {
    for (const b of [viewBasis(geom(0, 90)), viewBasis(geom(45, -90))]) {
      expect(Number.isFinite(norm(b.u))).toBe(true);
      expect(norm(b.u)).toBeCloseTo(1, 9);
      expect(dot(b.u, b.d)).toBeCloseTo(0, 9);
    }
  });

  it("線源はアイソセンタから SOD、検出器中心は SID−SOD の位置", () => {
    const g = geom(-30, 0);
    const b = viewBasis(g);
    expect(norm(b.source)).toBeCloseTo(g.sodMm, 6);
    expect(norm(b.detectorCenter)).toBeCloseTo(g.sidMm - g.sodMm, 6);
    // 線源 → 検出器中心の距離が SID。
    expect(
      Math.hypot(
        b.detectorCenter[0] - b.source[0],
        b.detectorCenter[1] - b.source[1],
        b.detectorCenter[2] - b.source[2],
      ),
    ).toBeCloseTo(g.sidMm, 6);
  });
});

describe("投影", () => {
  it("アイソセンタは主点に落ちる", () => {
    for (const g of VIEWS) {
      const p = projectToPixel([0, 0, 0], g)!;
      expect(p[0]).toBeCloseTo(256, 6);
      expect(p[1]).toBeCloseTo(256, 6);
    }
  });

  it("★アイソセンタ面の 1mm は mm/px = ImagerPixelSpacing×SOD/SID に対応する", () => {
    // §7.2 の P4（幾何近似）が返すべき値そのもの。
    const g = geom(0, 0);
    const p0 = projectToPixel([0, 0, 0], g)!;
    const p1 = projectToPixel([1, 0, 0], g)!; // 患者の左へ 1mm
    const mmPerPx = (0.3 * g.sodMm) / g.sidMm;
    expect(p1[0] - p0[0]).toBeCloseTo(1 / mmPerPx, 6);
    expect(p1[1] - p0[1]).toBeCloseTo(0, 9);
  });

  it("★奥行きで拡大率が変わる（out-of-plane magnification）", () => {
    // 2D 計測が単一の mm/px で済まない理由。3D にする利得の 1 つ（§21.4）。
    const g = geom(0, 0);
    const near = projectToPixel([1, 30, 0], g)!; // 線源に近い側（Y=後 が線源側）
    const far = projectToPixel([1, -30, 0], g)!;
    const at = projectToPixel([1, 0, 0], g)!;
    expect(Math.abs(near[0] - 256)).toBeGreaterThan(Math.abs(at[0] - 256));
    expect(Math.abs(far[0] - 256)).toBeLessThan(Math.abs(at[0] - 256));
  });

  it("線源より後ろの点は投影しない（null）", () => {
    const g = geom(0, 0);
    // 線源は (0, +750, 0)。その更に後ろ。
    expect(projectToPixel([0, 900, 0], g)).toBeNull();
  });

  it("画像の向き: 患者の左は列が増える方向、頭は行が減る方向", () => {
    const g = geom(0, 0);
    const c = projectToPixel([0, 0, 0], g)!;
    expect(projectToPixel([20, 0, 0], g)![0]).toBeGreaterThan(c[0]); // 左 → 右へ
    expect(projectToPixel([0, 0, 20], g)![1]).toBeLessThan(c[1]); // 頭 → 上へ
  });
});

describe("逆投影と三角測量", () => {
  const POINTS: Vec3[] = [
    [0, 0, 0],
    [12, -8, 25],
    [-30, 18, -20],
    [5, 40, 38],
    [-22, -35, 12],
  ];

  it("視線は線源から出て、その画素を通る", () => {
    const g = geom(-30, 0);
    const ray = pixelToRay([300, 200], g);
    const b = viewBasis(g);
    expect(ray.origin).toEqual(b.source);
    expect(norm(ray.direction)).toBeCloseTo(1, 9);
    // 視線上の点を投影すると元の画素に戻る。
    const far: Vec3 = [
      ray.origin[0] + ray.direction[0] * 800,
      ray.origin[1] + ray.direction[1] * 800,
      ray.origin[2] + ray.direction[2] * 800,
    ];
    const back = projectToPixel(far, g)!;
    expect(back[0]).toBeCloseTo(300, 6);
    expect(back[1]).toBeCloseTo(200, 6);
  });

  it("★★投影 → 三角測量で元の 3D 点に戻る（2 方向）", () => {
    for (const p of POINTS) {
      const obs = [VIEWS[0], VIEWS[1]].map((g) => ({ geometry: g, pixel: projectToPixel(p, g)! }));
      const tri = triangulate(obs)!;
      expect(tri.residualMm).toBeLessThan(1e-6);
      for (let i = 0; i < 3; i++) expect(tri.point[i]).toBeCloseTo(p[i], 6);
    }
  });

  it("4 方向でも同じ点に収束する", () => {
    for (const p of POINTS) {
      const obs = VIEWS.map((g) => ({ geometry: g, pixel: projectToPixel(p, g)! }));
      const tri = triangulate(obs)!;
      expect(tri.residualMm).toBeLessThan(1e-6);
      for (let i = 0; i < 3; i++) expect(tri.point[i]).toBeCloseTo(p[i], 6);
    }
  });

  it("1 方向では三角測量できない", () => {
    expect(triangulate([{ geometry: VIEWS[0], pixel: [256, 256] }])).toBeNull();
  });

  it("🚨 対応付けを間違えると残差が大きくなる（気づける）", () => {
    // 残差を見ないと、間違った対応でも「それらしい 3D 点」が必ず出る。
    const a = POINTS[1];
    const b = POINTS[2];
    const wrong = [
      { geometry: VIEWS[0], pixel: projectToPixel(a, VIEWS[0])! },
      { geometry: VIEWS[1], pixel: projectToPixel(b, VIEWS[1])! },
    ];
    expect(triangulate(wrong)!.residualMm).toBeGreaterThan(1.0);
  });

  it("🚨 視線が平行に近いと奥行きが決まらない", () => {
    // 角度差が小さい 2 方向は三角測量が退化する。実データ（Rubo 0009/0012）が
    // 「同じ角度の 2 本」でまさにこれ（§21.3）。
    const near1 = geom(-30, 0);
    const near2 = geom(-28, 1);
    expect(viewSeparationDeg(near1, near2)).toBeLessThan(3);
    const p: Vec3 = [10, 20, -15];
    const obs = [near1, near2].map((g) => ({ geometry: g, pixel: projectToPixel(p, g)! }));
    // 画素を 0.5px だけ揺らすと 3D 位置が大きく動く。
    obs[1].pixel = [obs[1].pixel[0] + 0.5, obs[1].pixel[1]];
    const tri = triangulate(obs)!;
    const err = Math.hypot(tri.point[0] - p[0], tri.point[1] - p[1], tri.point[2] - p[2]);
    expect(err).toBeGreaterThan(2);
  });

  it("角度差の大きい 2 方向なら同じ揺らぎでも誤差が小さい", () => {
    const p: Vec3 = [10, 20, -15];
    const obs = [VIEWS[0], VIEWS[1]].map((g) => ({ geometry: g, pixel: projectToPixel(p, g)! }));
    obs[1].pixel = [obs[1].pixel[0] + 0.5, obs[1].pixel[1]];
    const tri = triangulate(obs)!;
    const err = Math.hypot(tri.point[0] - p[0], tri.point[1] - p[1], tri.point[2] - p[2]);
    expect(err).toBeLessThan(0.5);
    expect(viewSeparationDeg(VIEWS[0], VIEWS[1])).toBeGreaterThan(60);
  });

  it("視点間の角度は 0〜90 に畳まれる（向きの反転を同一視する）", () => {
    expect(viewSeparationDeg(geom(0, 0), geom(180, 0))).toBeCloseTo(0, 6);
    expect(viewSeparationDeg(geom(0, 0), geom(90, 0))).toBeCloseTo(90, 6);
  });
});

describe("★バンドル調整（装置角度の機械誤差の回収）", () => {
  /** GNBP-XA-3 と同じ既知誤差。 */
  const ERRORS = [
    { primary: 0, secondary: 0 },
    { primary: -2.5, secondary: 2.0 },
    { primary: 3.0, secondary: 1.5 },
    { primary: -1.0, secondary: -2.5 },
  ];
  /** 真の 3D 点群（螺旋。GNBP-XA-3 の主枝に近い形）。 */
  const TRUE_POINTS: Vec3[] = Array.from({ length: 24 }, (_, i) => {
    const t = i / 23;
    const th = 2.2 * Math.PI * t;
    return [(30 - 12 * t) * Math.cos(th) - 5, 22 * Math.sin(th), 40 - 70 * t] as Vec3;
  });

  /** 真の角度で投影した画素（＝ファントムの画像が持つ情報）。 */
  const observedPixels = TRUE_POINTS.map((p) => VIEWS.map((g) => projectToPixel(p, g)));

  /** タグに書かれている（狂った）角度。 */
  const taggedGeoms = VIEWS.map((g, i) => withAngleOffset(g, ERRORS[i].primary, ERRORS[i].secondary));

  it("タグの角度をそのまま信じると再投影誤差が残る", () => {
    let worst = 0;
    for (let k = 0; k < TRUE_POINTS.length; k++) {
      const obs = taggedGeoms.map((g, i) => ({ geometry: g, pixel: observedPixels[k][i]! }));
      const tri = triangulate(obs)!;
      worst = Math.max(worst, reprojectionErrorPx(tri.point, obs));
    }
    expect(worst).toBeGreaterThan(3);
  });

  it("★★バンドル調整で再投影誤差が桁で下がる", () => {
    const res = bundleAdjustAngles(taggedGeoms, observedPixels)!;
    expect(res.afterPx).toBeLessThan(res.beforePx / 5);
    expect(res.afterPx).toBeLessThan(1.0);
  });

  it("★回収したオフセットが注入した誤差の符号を打ち消す", () => {
    const res = bundleAdjustAngles(taggedGeoms, observedPixels)!;
    for (let i = 1; i < VIEWS.length; i++) {
      // 先頭視点を固定しているので、回収されるのは「先頭との相対」。
      const expectedP = -(ERRORS[i].primary - ERRORS[0].primary);
      const expectedS = -(ERRORS[i].secondary - ERRORS[0].secondary);
      expect(res.offsetsDeg[i].primary).toBeCloseTo(expectedP, 0);
      expect(res.offsetsDeg[i].secondary).toBeCloseTo(expectedS, 0);
    }
  });

  it("先頭視点は必ず固定される（ゲージ自由度で解が漂わない）", () => {
    const res = bundleAdjustAngles(taggedGeoms, observedPixels)!;
    expect(res.offsetsDeg[0]).toEqual({ primary: 0, secondary: 0 });
  });

  it("誤差が無ければ何も動かさない", () => {
    const clean = TRUE_POINTS.map((p) => VIEWS.map((g) => projectToPixel(p, g)));
    const res = bundleAdjustAngles(VIEWS, clean)!;
    expect(res.beforePx).toBeLessThan(1e-6);
    for (const o of res.offsetsDeg) {
      expect(Math.abs(o.primary)).toBeLessThan(0.02);
      expect(Math.abs(o.secondary)).toBeLessThan(0.02);
    }
  });

  it("欠測（一部の視点に写っていない点）があっても動く", () => {
    const withGaps = observedPixels.map((row, k) => row.map((px, i) => (k % 3 === 0 && i === 3 ? null : px)));
    const res = bundleAdjustAngles(taggedGeoms, withGaps)!;
    expect(res.afterPx).toBeLessThan(res.beforePx / 3);
  });

  it("視点が 1 つ、または対応点が無ければ null", () => {
    expect(bundleAdjustAngles([VIEWS[0]], observedPixels)).toBeNull();
    expect(bundleAdjustAngles(VIEWS, [])).toBeNull();
  });

  it("決定的（同じ入力なら同じ結果）", () => {
    const a = bundleAdjustAngles(taggedGeoms, observedPixels)!;
    const b = bundleAdjustAngles(taggedGeoms, observedPixels)!;
    expect(b.offsetsDeg).toEqual(a.offsetsDeg);
    expect(b.afterPx).toBe(a.afterPx);
  });
});

describe("★別実装（ファントム生成器）との突き合わせ", () => {
  /**
   * `bench/make_phantom_xa.py` の `_project_points()` が出した画素座標。
   *
   * <p>🔑 **同じ規約を 2 つの言語で独立に実装して一致を見る**。ここが合わないと、
   * ファントムの画像と TypeScript の再構成が違う幾何を指していることになり、
   * **精度検証そのものが無意味になる**（画像は Python が作り、解析は TS がする）。
   *
   * <p>⚠️ これは「規約が同じこと」の確認であって、**規約が DICOM の定義として
   * 正しいこと**の確認ではない（両方とも同じ思い違いをしている可能性は消えない）。
   */
  const EXPECTED: Record<string, [number, number][]> = {
    "-30/0": [
      [256.0, 256.0],
      [319.8867, 145.0262],
      [100.4079, 344.9587],
      [182.7276, 78.3117],
      [249.46, 205.451],
    ],
    "60/20": [
      [256.0, 256.0],
      [251.9926, 175.827],
      [258.7616, 288.0514],
      [421.4524, 73.0552],
      [73.0414, 203.7075],
    ],
    "-10/-30": [
      [256.0, 256.0],
      [315.2887, 145.7986],
      [110.6376, 360.9133],
      [246.3185, 194.8111],
      [189.1407, 129.3139],
    ],
    "30/30": [
      [256.0, 256.0],
      [283.5401, 190.5715],
      [176.6702, 265.4663],
      [365.4229, 35.7186],
      [98.3216, 252.8214],
    ],
  };
  const POINTS: Vec3[] = [
    [0, 0, 0],
    [12, -8, 25],
    [-30, 18, -20],
    [5, 40, 38],
    [-22, -35, 12],
  ];

  it("4 視点すべてで画素座標が一致する（1/1000 px 以内）", () => {
    for (const [key, expected] of Object.entries(EXPECTED)) {
      const [p, s] = key.split("/").map(Number);
      const g = geom(p, s);
      POINTS.forEach((pt, i) => {
        const got = projectToPixel(pt, g)!;
        expect(got[0], `${key} #${i} col`).toBeCloseTo(expected[i][0], 3);
        expect(got[1], `${key} #${i} row`).toBeCloseTo(expected[i][1], 3);
      });
    }
  });
});
