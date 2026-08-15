/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * `xaRecon3d.ts` の検証（A6a・`fw/angio-design.md` §10.2）。
 *
 * <h3>⚠️ ここで検証できないもの</h3>
 * DICOM の角度定義そのもの。ファントムも本テストも `xaGeometry.ts` と同じ規約で投影を作るので、
 * **規約が間違っていても一致する**。測れるのは「その規約のもとで対応付けと三角測量が働くか」まで。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { type Vec3, type XaViewGeometry, projectToPixel, viewSeparationDeg } from "./xaGeometry";
import {
  type DiameterProfile,
  type ReconAnchor,
  type XaCenterline2D,
  anchorReprojection,
  foreshorteningProfile,
  fuseCrossSection,
  fuseDiameterProfile,
  matchCenterlines,
  polylineLength,
  rayDistanceMm,
  reconstructCenterline3d,
  reconstructWithRefinement,
  refineGeometryWithAnchors,
  resampleByArcLengthN,
  smoothPolyline3d,
  suggestWorkingAngles,
  tangents3d,
} from "./xaRecon3d";

/* ---------------- 共通のヘルパ ---------------- */

/** GNBP-XA-3 と同じ装置定数（truth.json の `geometry`）。 */
function geom(primaryAngleDeg: number, secondaryAngleDeg: number): XaViewGeometry {
  return {
    primaryAngleDeg,
    secondaryAngleDeg,
    sidMm: 1000,
    sodMm: 750,
    imagerSpacingMm: [0.3, 0.3],
    principalPoint: [256, 256],
  };
}

function project(points: readonly Vec3[], g: XaViewGeometry): [number, number][] {
  const out: [number, number][] = [];
  for (const p of points) {
    const px = projectToPixel(p, g);
    expect(px).not.toBeNull();
    out.push(px!);
  }
  return out;
}

/** 点から折れ線への最短距離 [mm]。再標本化で点がずれても比較できるようにこれで測る。 */
function distanceToPolyline(p: Vec3, poly: readonly Vec3[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const len2 = abx * abx + aby * aby + abz * abz;
    let t = len2 > 0 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t), p[2] - (a[2] + abz * t));
    if (d < best) best = d;
  }
  return best;
}

/** 再構成点の、真値中心線への距離の RMS [mm]。 */
function centerlineRmsMm(recon: readonly Vec3[], truth: readonly Vec3[]): number {
  let s = 0;
  for (const p of recon) s += distanceToPolyline(p, truth) ** 2;
  return Math.sqrt(s / recon.length);
}

/** 螺旋（GNBP-XA-3 の主枝と同じ性格。投影で自己交差する）。 */
function helix(count: number): Vec3[] {
  const out: Vec3[] = [];
  for (let k = 0; k < count; k++) {
    const t = k / (count - 1);
    const theta = 2.2 * Math.PI * t;
    const r = 25 - 8 * t;
    out.push([r * Math.cos(theta), r * Math.sin(theta) * 0.6, 40 - 80 * t]);
  }
  return out;
}

function centerline(points3d: readonly Vec3[], g: XaViewGeometry, resampleTo: number): XaCenterline2D {
  const px = project(points3d, g);
  const s = resampleByArcLengthN(px, resampleTo).map((p) => [p[0], p[1]] as [number, number]);
  return { geometry: g, points: s };
}

/* ---------------- 幾何の小道具 ---------------- */

describe("rayDistanceMm", () => {
  it("交わる 2 直線は 0", () => {
    const a = { origin: [0, 0, 0] as Vec3, direction: [1, 0, 0] as Vec3 };
    const b = { origin: [5, -3, 0] as Vec3, direction: [0, 1, 0] as Vec3 };
    expect(rayDistanceMm(a, b)).toBeCloseTo(0, 9);
  });

  it("ねじれの位置にある 2 直線の距離", () => {
    const a = { origin: [0, 0, 0] as Vec3, direction: [1, 0, 0] as Vec3 };
    const b = { origin: [0, 0, 7] as Vec3, direction: [0, 1, 0] as Vec3 };
    expect(rayDistanceMm(a, b)).toBeCloseTo(7, 9);
  });

  it("平行な 2 直線でも破綻せず、垂直距離を返す", () => {
    const a = { origin: [0, 0, 0] as Vec3, direction: [1, 0, 0] as Vec3 };
    const b = { origin: [100, 4, 3] as Vec3, direction: [1, 0, 0] as Vec3 };
    expect(rayDistanceMm(a, b)).toBeCloseTo(5, 9);
  });
});

describe("resampleByArcLengthN / polylineLength / smoothPolyline3d", () => {
  it("直線を等間隔に割り直す（2D）", () => {
    const out = resampleByArcLengthN([[0, 0] as const, [10, 0] as const], 5);
    expect(out.map((p) => p[0])).toEqual([0, 2.5, 5, 7.5, 10]);
  });

  it("3D でも弧長で等分する", () => {
    const out = resampleByArcLengthN([[0, 0, 0] as const, [0, 0, 3] as const, [0, 4, 3] as const], 8);
    expect(out).toHaveLength(8);
    const seg: number[] = [];
    for (let i = 1; i < out.length; i++) {
      seg.push(Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1], out[i][2] - out[i - 1][2]));
    }
    for (const s of seg) expect(s).toBeCloseTo(1, 6);
  });

  it("長さは折れ線の総和", () => {
    expect(polylineLength([[0, 0, 0], [0, 3, 0], [4, 3, 0]])).toBeCloseTo(7, 9);
  });

  it("平滑化は窓 1 で恒等、端では窓を縮める", () => {
    const p: Vec3[] = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 0, 0],
    ];
    expect(smoothPolyline3d(p, 1)).toEqual(p);
    const s = smoothPolyline3d(p, 3);
    expect(s[0][0]).toBeCloseTo(5, 9);
    expect(s[1][0]).toBeCloseTo(10 / 3, 9);
  });

  it("接線は中央差分で単位ベクトル", () => {
    const t = tangents3d([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    for (const v of t) expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 9);
    expect(t[1]).toEqual([1, 0, 0]);
  });
});

/* ---------------- 対応付け ---------------- */

describe("matchCenterlines", () => {
  const truth = helix(400);
  const gA = geom(-30, 0);
  const gB = geom(60, 20);

  it("2 方向の標本密度が違っても単調な対応を作る", () => {
    const a = centerline(truth, gA, 137);
    const b = centerline(truth, gB, 211);
    const m = matchCenterlines(a, b, { samples: 200 })!;
    expect(m).not.toBeNull();
    for (let i = 1; i < m.indexB.length; i++) expect(m.indexB[i]).toBeGreaterThanOrEqual(m.indexB[i - 1]);
    // エピポーラ距離は「同じ 3D 点を見ている」ことの直接の指標。
    const meanEpi = m.epipolarMm.reduce((s, v) => s + v, 0) / m.epipolarMm.length;
    expect(meanEpi).toBeLessThan(0.5);
  });

  it("🚨 対応は恒等写像ではない（＝テストが自明に通っていない）", () => {
    const a = centerline(truth, gA, 137);
    const b = centerline(truth, gB, 211);
    const m = matchCenterlines(a, b, { samples: 200 })!;
    // 透視投影とフォアショートニングで 2 方向の弧長の進み方が違うので、i と indexB[i] はずれる。
    // ここがずれないなら、対応付けを通さなくても正解が出てしまう＝この検証には意味がない。
    let maxShift = 0;
    for (let i = 0; i < m.indexB.length; i++) maxShift = Math.max(maxShift, Math.abs(m.indexB[i] - i));
    expect(maxShift).toBeGreaterThan(3);
  });

  it("片方の端が余分に伸びていても、許容ぶんは読み飛ばす", () => {
    const a = centerline(truth, gA, 200);
    // B は遠位が 12% 余分（トレースし過ぎ）。
    const longer = helix(400).concat(
      Array.from({ length: 40 }, (_, k): Vec3 => {
        const last = truth[truth.length - 1];
        const prev = truth[truth.length - 2];
        const s = (k + 1) * 0.5;
        return [
          last[0] + (last[0] - prev[0]) * s,
          last[1] + (last[1] - prev[1]) * s,
          last[2] + (last[2] - prev[2]) * s,
        ];
      }),
    );
    const b = centerline(longer, gB, 200);
    const m = matchCenterlines(a, b, { samples: 200, endToleranceFraction: 0.2 })!;
    expect(m.endSkip[1]).toBeGreaterThan(0.02);
  });
});

/* ---------------- 再構成（合成データ） ---------------- */

describe("reconstructCenterline3d", () => {
  const truth = helix(400);

  it("直交 2 方向から 1mm 未満で復元する", () => {
    const gA = geom(-30, 0);
    const gB = geom(60, 20);
    expect(viewSeparationDeg(gA, gB)).toBeGreaterThan(80);
    const r = reconstructCenterline3d(centerline(truth, gA, 137), centerline(truth, gB, 211), { samples: 200 })!;
    expect(r).not.toBeNull();
    expect(r.acceptable).toBe(true);
    expect(centerlineRmsMm(r.points, truth)).toBeLessThan(1.0);
    expect(Math.abs(r.lengthMm - polylineLength(truth)) / polylineLength(truth)).toBeLessThan(0.03);
  });

  it("視点が近すぎると blocking 警告を出し、acceptable=false になる", () => {
    const gA = geom(-30, 0);
    const gB = geom(-25, 2);
    const r = reconstructCenterline3d(centerline(truth, gA, 200), centerline(truth, gB, 200), { samples: 120 })!;
    expect(r.separationDeg).toBeLessThan(30);
    expect(r.acceptable).toBe(false);
    expect(r.warnings.find((w) => w.code === "insufficientSeparation")?.blocking).toBe(true);
  });

  it("角度が狂っていればアンカーの再投影誤差が跳ね上がり、結果を出さない", () => {
    const gA = geom(-30, 0);
    const gB = geom(60, 20);
    const a = centerline(truth, gA, 200);
    const b = centerline(truth, gB, 200);
    // B の角度タグだけ 4° 狂わせる（画像＝点列は真の角度のまま）。
    const wrong: XaCenterline2D = { ...b, geometry: geom(64, 22) };
    const r = reconstructCenterline3d(a, wrong, { samples: 150 })!;
    expect(r.anchorReprojectionPx).toBeGreaterThan(2.0);
    expect(r.acceptable).toBe(false);
  });

  it("🔴 対応付けの再投影誤差は角度誤差にほとんど反応しない（＝品質判定に使えない）", () => {
    // これは仕様ではなく**測定された事実**。ここが崩れたら、対応付けを固定できるように
    // なった（＝設計を見直せる）か、テストが壊れたかのどちらか。
    const gA = geom(-30, 0);
    const a = centerline(truth, gA, 200);
    const rows = [0, 2, 4, 8].map((err) => {
      const gB = geom(60 + err, 20 - err);
      const b: XaCenterline2D = { geometry: gB, points: centerline(truth, geom(60, 20), 200).points };
      const r = reconstructCenterline3d(a, b, { samples: 150 })!;
      return { err, match: r.matchReprojectionPx, anchor: r.anchorReprojectionPx };
    });
    // 対応付けの再投影は 8° 狂っても数 px に届かない。
    expect(rows[3].match).toBeLessThan(3);
    // 一方でアンカーは角度誤差に比例して増える。
    expect(rows[0].anchor).toBeLessThan(0.01);
    expect(rows[1].anchor).toBeGreaterThan(rows[0].anchor);
    expect(rows[2].anchor).toBeGreaterThan(rows[1].anchor);
    expect(rows[3].anchor).toBeGreaterThan(rows[2].anchor);
    expect(rows[3].anchor).toBeGreaterThan(5);
  });

  it("アンカーが無ければ（端をずらす設定）結果を出さない", () => {
    const gA = geom(-30, 0);
    const gB = geom(60, 20);
    const r = reconstructCenterline3d(centerline(truth, gA, 200), centerline(truth, gB, 200), {
      samples: 150,
      endToleranceFraction: 0.1,
    })!;
    expect(r.anchorCount).toBe(0);
    expect(r.acceptable).toBe(false);
    expect(r.warnings.find((w) => w.code === "geometryUnverified")?.blocking).toBe(true);
  });
});

/* ---------------- バンドル調整との接続 ---------------- */

describe("アンカーによる角度補正（refineGeometryWithAnchors）", () => {
  const truth = helix(400);
  const gA = geom(-30, 0);
  const gB = geom(60, 20);

  /** 解剖学的に同定できる点（起始部・分岐・末端など）を模したアンカー。 */
  function anchorsAt(fractions: readonly number[], geomB: XaViewGeometry): ReconAnchor[] {
    return fractions.map((f) => {
      const p = truth[Math.round(f * (truth.length - 1))];
      return { pixelA: projectToPixel(p, gA)!, pixelB: projectToPixel(p, geomB)! };
    });
  }

  it("🚨 アンカー 2 点では角度を推定しない（残差 0 の解が必ず存在するため）", () => {
    expect(refineGeometryWithAnchors(gA, geom(57.5, 22), anchorsAt([0, 1], gB))).toBeNull();
  });

  it("5 点あれば狂った角度を回収し、注入した誤差と符号ごと一致する", () => {
    const taggedB = geom(60 - 2.5, 20 + 2.0); // 装置の機械誤差（GNBP-XA-3 と同じ量）
    // アンカーの画素は**真の角度で撮られた画像**から取る。狂っているのはタグだけ。
    const anchors = anchorsAt([0, 0.25, 0.5, 0.75, 1], gB);
    const before = anchorReprojection(anchors, gA, taggedB);
    expect(before).toBeGreaterThan(0.5);

    const ref = refineGeometryWithAnchors(gA, taggedB, anchors)!;
    expect(ref).not.toBeNull();
    expect(ref.afterPx).toBeLessThan(before / 10);
    // 視点 A が正しいときに限り、回収したオフセットは注入量の符号違いになる。
    expect(ref.offsetDeg.primary).toBeCloseTo(2.5, 0);
    expect(ref.offsetDeg.secondary).toBeCloseTo(-2.0, 0);

    const a = centerline(truth, gA, 200);
    const b = centerline(truth, gB, 200);
    const after = reconstructCenterline3d(a, { ...b, geometry: ref.geometryB }, { samples: 150, anchors })!;
    expect(after.acceptable).toBe(true);
    expect(centerlineRmsMm(after.points, truth)).toBeLessThan(1.0);
  });

  it("🚨 回収されるのは視点 A との相対であって、患者座標系での姿勢ではない", () => {
    // 先頭視点を固定する（ゲージ固定）以上、先頭の角度誤差はモデル全体の姿勢誤差として残る。
    // 「再投影誤差が下がった＝患者座標が正しい」ではないことを、ここで固定しておく。
    const taggedA = geom(-30 + 1.5, 0 - 1.0);
    const taggedB = geom(60 - 2.5, 20 + 2.0);
    const anchors = anchorsAt([0, 0.25, 0.5, 0.75, 1], gB);
    const ref = refineGeometryWithAnchors(taggedA, taggedB, anchors)!;
    expect(ref.afterPx).toBeLessThan(1.0);

    const a = centerline(truth, gA, 200);
    const b = centerline(truth, gB, 200);
    const after = reconstructCenterline3d(
      { ...a, geometry: taggedA },
      { ...b, geometry: ref.geometryB },
      { samples: 150, anchors },
    )!;
    // 長さ（＝姿勢に依らない量）は合う。
    expect(Math.abs(after.lengthMm - polylineLength(truth)) / polylineLength(truth)).toBeLessThan(0.03);
    // しかし患者座標での位置は、先頭視点の誤差ぶんだけ系統的にずれたまま。
    expect(centerlineRmsMm(after.points, truth)).toBeGreaterThan(0.5);
  });
});

/* ---------------- 断面の合成 ---------------- */

describe("fuseCrossSection", () => {
  const gA = geom(-30, 0);
  const gB = geom(60, 20);

  it("円断面なら測定方向によらず面積が一致する", () => {
    const tangent: Vec3 = [0, 0, 1];
    const f = fuseCrossSection(3.0, 3.0, tangent, gA, gB)!;
    expect(f.areaMm2).toBeCloseTo((Math.PI / 4) * 9, 9);
    expect(f.equivalentDiameterMm).toBeCloseTo(3.0, 9);
  });

  it("2 方向の測定方向がなす角を返す（90° から離れるほど楕円の仮定が効く）", () => {
    const f = fuseCrossSection(3.0, 2.0, [0, 0, 1], gA, gB)!;
    expect(f.measurementAngleDeg).toBeGreaterThan(0);
    expect(f.measurementAngleDeg).toBeLessThanOrEqual(90);
    expect(f.areaMm2).toBeCloseTo((Math.PI / 4) * 6, 9);
  });

  it("血管が視線と平行（フォアショートニング極大）なら測れないので null", () => {
    // 視線 d に沿った接線。径を測る向きが定まらない。
    const dA: Vec3 = [Math.sin((-30 * Math.PI) / 180), -Math.cos((-30 * Math.PI) / 180), 0];
    expect(fuseCrossSection(3, 3, dA, gA, gB)).toBeNull();
  });
});

/* ---------------- ファントム GNBP-XA-3（真値との突き合わせ） ---------------- */

interface XaTruth {
  recon3d: {
    views: { truePrimaryAngleDeg: number; trueSecondaryAngleDeg: number; angleError: { taggedPrimaryAngleDeg: number; taggedSecondaryAngleDeg: number } }[];
    branches: { id: string; lengthMm: number; pointsLps: number[][] }[];
    targets: { centerlineRmsMm: number; segmentLengthErrorPercent: number };
  };
}

const truthPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bench/phantom/GNBP-XA/truth.json");
let phantom: XaTruth | null = null;
try {
  phantom = JSON.parse(readFileSync(truthPath, "utf8")) as XaTruth;
} catch {
  phantom = null;
}

describe.skipIf(!phantom)("GNBP-XA-3 の真値中心線で再構成する", () => {
  const t = phantom!.recon3d;
  const main = t.branches.find((b) => b.id === "main")!;
  const truth = main.pointsLps.map((p) => [p[0], p[1], p[2]] as Vec3);
  const v1 = t.views[0];
  const v2 = t.views[1];
  const gA = geom(v1.truePrimaryAngleDeg, v1.trueSecondaryAngleDeg);
  const gB = geom(v2.truePrimaryAngleDeg, v2.trueSecondaryAngleDeg);

  it("設計の目標（中心線 RMS < 1.0mm / 区間長誤差 < 3%）を満たす", () => {
    const r = reconstructCenterline3d(centerline(truth, gA, 137), centerline(truth, gB, 211), { samples: 250 })!;
    expect(r.acceptable).toBe(true);
    expect(centerlineRmsMm(r.points, truth)).toBeLessThan(t.targets.centerlineRmsMm);
    // 長さは truth.json の宣言値（900 点で積算）ではなく、**入力に使った 60 点の折れ線長**と比べる。
    // 60 点は 15 点おきの間引きなので、それ自体が真の弧長より 1.5% 短い。再構成が復元できるのは
    // 与えられた折れ線までであり、間引きの損失まで背負わせるのは筋が違う。
    const feedable = polylineLength(truth);
    expect(feedable).toBeLessThan(main.lengthMm);
    const err = (Math.abs(r.lengthMm - feedable) / feedable) * 100;
    expect(err).toBeLessThan(t.targets.segmentLengthErrorPercent);
  });

  it("娘枝（短く曲率が強い）でも成立する", () => {
    const d = t.branches.find((b) => b.id === "daughter")!;
    const dt = d.pointsLps.map((p) => [p[0], p[1], p[2]] as Vec3);
    const r = reconstructCenterline3d(centerline(dt, gA, 90), centerline(dt, gB, 140), { samples: 200 })!;
    expect(r.acceptable).toBe(true);
    expect(centerlineRmsMm(r.points, dt)).toBeLessThan(t.targets.centerlineRmsMm);
  });

  it("🔴 タグの角度をそのまま信じると、閾値を通ったまま形が 1.7mm 歪む", () => {
    // **これが「無言で歪んだモデルが出る」の実測。** 2px の閾値は粗い誤りの検出器であって、
    // 装置の機械誤差（2〜3°）は素通りする。だから閾値ではなく補正で対処する。
    const tagA = geom(v1.angleError.taggedPrimaryAngleDeg, v1.angleError.taggedSecondaryAngleDeg);
    const tagB = geom(v2.angleError.taggedPrimaryAngleDeg, v2.angleError.taggedSecondaryAngleDeg);
    const a = { ...centerline(truth, gA, 137), geometry: tagA };
    const b = { ...centerline(truth, gB, 211), geometry: tagB };
    const r = reconstructCenterline3d(a, b, { samples: 250 })!;
    expect(r.anchorReprojectionPx).toBeLessThan(2.0);
    expect(r.acceptable).toBe(true); // ← 通ってしまう
    expect(centerlineRmsMm(r.points, truth)).toBeGreaterThan(t.targets.centerlineRmsMm);
  });

  it("アンカーで補正してから再構成すれば、タグが狂っていても目標を満たす", () => {
    const tagA = geom(v1.angleError.taggedPrimaryAngleDeg, v1.angleError.taggedSecondaryAngleDeg);
    const tagB = geom(v2.angleError.taggedPrimaryAngleDeg, v2.angleError.taggedSecondaryAngleDeg);
    const a = { ...centerline(truth, gA, 137), geometry: tagA };
    const b = { ...centerline(truth, gB, 211), geometry: tagB };
    // 起始部・分岐・末端など、2 方向で同定できる 5 点。
    const anchors = [0, 0.25, 0.45, 0.75, 1].map((f) => {
      const p = truth[Math.round(f * (truth.length - 1))];
      return { pixelA: projectToPixel(p, gA)!, pixelB: projectToPixel(p, gB)! };
    });
    const { result, refinement } = reconstructWithRefinement(a, b, { samples: 250, anchors });
    expect(refinement).not.toBeNull();
    expect(refinement!.afterPx).toBeLessThan(0.2);
    expect(result!.acceptable).toBe(true);
    expect(centerlineRmsMm(result!.points, truth)).toBeLessThan(t.targets.centerlineRmsMm);
  });

  it("アンカーが 2 点しか無ければ補正せず、足りないことを警告する", () => {
    const r = reconstructCenterline3d(centerline(truth, gA, 137), centerline(truth, gB, 211), { samples: 250 })!;
    expect(r.anchorCount).toBe(2);
    expect(r.warnings.some((w) => w.code === "tooFewAnchors")).toBe(true);
  });
});

/* ---------------- 短縮（フォアショートニング） ---------------- */

describe("foreshorteningProfile / suggestWorkingAngles", () => {
  /** Z 軸（頭足方向）に真っ直ぐ伸びた血管。 */
  const straightZ: Vec3[] = Array.from({ length: 41 }, (_, i): Vec3 => [0, 0, -40 + 2 * i]);

  it("視線に垂直なら見える割合は 1", () => {
    // α=β=0 は前方視（d=(0,−1,0)）。Z 軸の血管は視線に垂直＝完全に見える。
    const p = foreshorteningProfile(straightZ, geom(0, 0))!;
    expect(p.visibleFraction).toBeCloseTo(1, 6);
    expect(p.severeFraction).toBeCloseTo(0, 6);
  });

  it("視線に平行なら見える割合は 0（点に潰れる）", () => {
    // β=90 は頭側から見る（d=(0,0,1)）。Z 軸の血管は視線に平行。
    const p = foreshorteningProfile(straightZ, geom(0, 90))!;
    expect(p.visibleFraction).toBeCloseTo(0, 6);
    expect(p.severeFraction).toBeCloseTo(1, 6);
  });

  it("45° 傾けると sin45 ぶんだけ見える", () => {
    const p = foreshorteningProfile(straightZ, geom(0, 45))!;
    expect(p.visibleFraction).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it("最も短縮の少ない角度を提案できる", () => {
    // Z 軸の血管は secondary=0（頭足方向に振らない）なら primary によらず完全に見える。
    const best = suggestWorkingAngles(straightZ, geom(0, 0), { stepDeg: 5, count: 3 });
    expect(best[0].visibleFraction).toBeCloseTo(1, 4);
    for (const b of best) expect(Math.abs(b.secondaryAngleDeg)).toBeLessThan(1);
  });

  it("🔴 短縮していると再構成が警告を出す（ただし結果は止めない）", () => {
    // 止めてしまうと「短縮している」という事実自体が見えなくなり、次にどの角度で
    // 撮り直せばよいかも分からなくなる。だから blocking にしない。
    const truth = helix(400);
    const gA = geom(-30, 0);
    const gB = geom(60, 20);
    const r = reconstructCenterline3d(centerline(truth, gA, 200), centerline(truth, gB, 200), {
      samples: 150,
      // 実際には潰れていないので、閾値のほうを上げて警告経路を通す。
      minVisibleFraction: 0.999,
    })!;
    const w = r.warnings.find((x) => x.code === "severeForeshortening");
    expect(w).toBeDefined();
    expect(w!.blocking).toBe(false);
    expect(r.acceptable).toBe(true);
    expect(r.foreshortening.a!.visibleFraction).toBeGreaterThan(0.5);
  });
});

/* ---------------- 3D 断面プロファイル ---------------- */

describe("fuseDiameterProfile", () => {
  const truth = helix(200);
  const gA = geom(-30, 0);
  const gB = geom(60, 20);
  const a = centerline(truth, gA, 200);
  const b = centerline(truth, gB, 200);
  const recon = reconstructCenterline3d(a, b, { samples: 120 })!;

  /** 一定径のプロファイル（中心線全体を覆う）。 */
  function flat(d: number, unit: "mm" | "px" = "mm"): DiameterProfile {
    const n = 60;
    return {
      diameters: Array.from({ length: n }, () => d),
      pathIndices: Array.from({ length: n }, (_, i) => Math.round((i / (n - 1)) * 199)),
      pointCount: 200,
      unit,
    };
  }

  it("一定径 3mm どうしなら、断面は円として面積 π/4·9 になる", () => {
    const p = fuseDiameterProfile(
      recon.points,
      { geometry: gA, profile: flat(3) },
      { geometry: gB, profile: flat(3) },
      recon.match,
    );
    expect(p.unavailable).toBeNull();
    expect(p.minEquivalentDiameterMm).toBeCloseTo(3, 6);
    expect(p.minAreaMm2).toBeCloseTo((Math.PI / 4) * 9, 6);
  });

  it("🚨 片方でも未校正なら断面を出さない（px の径を掛けない）", () => {
    const p = fuseDiameterProfile(
      recon.points,
      { geometry: gA, profile: flat(3) },
      { geometry: gB, profile: flat(30, "px") },
      recon.match,
    );
    expect(p.unavailable).toBe("uncalibrated");
    expect(p.minAreaMm2).toBeNull();
    expect(p.sections.every((s) => s === null)).toBe(true);
  });

  it("狭窄を入れるとその位置で最小になる", () => {
    const n = 60;
    // 1 点だけの切れ込みにしない。線形内挿と対応付けのわずかなずれで薄まってしまい、
    // 「合成が正しいか」ではなく「内挿の鋭さ」を測るテストになる（最初にそれで落ちた）。
    const prof: DiameterProfile = {
      diameters: Array.from({ length: n }, (_, i) => (Math.abs(i - 30) <= 2 ? 1.5 : 3)),
      pathIndices: Array.from({ length: n }, (_, i) => Math.round((i / (n - 1)) * 199)),
      pointCount: 200,
      unit: "mm",
    };
    const p = fuseDiameterProfile(
      recon.points,
      { geometry: gA, profile: prof },
      { geometry: gB, profile: prof },
      recon.match,
    );
    expect(p.minEquivalentDiameterMm).toBeLessThan(2.2);
    // 位置がおおよそ中央付近（対応付けでずれるので厳密一致は求めない）。
    const frac = p.minIndex! / (p.sections.length - 1);
    expect(frac).toBeGreaterThan(0.35);
    expect(frac).toBeLessThan(0.65);
  });

  it("🚨 計測点が覆っていない範囲は外挿せず null", () => {
    // 中心線の 40〜60% しか計測点が無いプロファイル。
    const prof: DiameterProfile = {
      diameters: [3, 3, 3],
      pathIndices: [80, 100, 120],
      pointCount: 200,
      unit: "mm",
    };
    const p = fuseDiameterProfile(
      recon.points,
      { geometry: gA, profile: prof },
      { geometry: gB, profile: prof },
      recon.match,
    );
    expect(p.sections[0]).toBeNull();
    expect(p.sections[p.sections.length - 1]).toBeNull();
    expect(p.sections.some((s) => s !== null)).toBe(true);
  });
});
