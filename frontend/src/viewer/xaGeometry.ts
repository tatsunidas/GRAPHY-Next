/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA の投影幾何（`fw/angio-design.md` §10.1 / A6a）。
 *
 * <h3>🚨 ここは Cornerstone / VTK の 3D API を一切使わない</h3>
 * `fw/cornerstone-3d-geometry-caveat.md` のとおり、**患者 LPS mm の自前・単一幾何**で
 * 完結させる。ライブラリの幾何 API を混ぜると、どの座標系の話をしているのか分からなくなる。
 *
 * <h3>座標系</h3>
 * 患者 LPS 右手系（X=左, Y=後, Z=頭）。アイソセンタを原点に置く。
 * C アームの姿勢は DICOM の 2 角（primary=LAO 正・頭足軸まわり／secondary=CRA 正・頭側へ振る）:
 *
 *     d(α,β) = (sinα·cosβ, −cosα·cosβ, sinβ)     アイソセンタ → 検出器の単位ベクトル
 *     S      = −d·SOD                            線源の位置
 *     検出器平面は S から距離 SID、法線 d
 *     u = normalize(z × d)                       画像の列方向（患者の左へ）
 *     v = u × d                                  画像の行方向（足側へ）
 *
 * 確認: α=β=0 で d=(0,−1,0)＝前方（PA 像）、α=90 で患者の左、β=90 で頭側。
 *
 * <h3>⚠️ 角度定義そのものはファントムでは検証できない</h3>
 * `bench/` の GNBP-XA-3 は**この規約で生成している**ので、規約が間違っていても一致する。
 * ファントムで測れるのは「この規約のもとで三角測量とバンドル調整が正しく働くか」まで。
 * 角度定義の正しさは規格の読解と実機データでしか確かめられない（truth.json の `caveat` にも書いてある）。
 */

export type Vec3 = readonly [number, number, number];

export interface XaViewGeometry {
  /** PositionerPrimaryAngle (0018,1510) [deg]。LAO 正。 */
  primaryAngleDeg: number;
  /** PositionerSecondaryAngle (0018,1511) [deg]。CRA 正。 */
  secondaryAngleDeg: number;
  /** DistanceSourceToDetector (0018,1110) [mm]。 */
  sidMm: number;
  /** DistanceSourceToPatient (0018,1111) [mm]。 */
  sodMm: number;
  /** ImagerPixelSpacing (0018,1164) [row, col] mm（**検出器面**の画素ピッチ）。 */
  imagerSpacingMm: readonly [number, number];
  /** 主点＝光軸が当たる画素（既定は画像中心）。FOV 切り出しがあるとずれる。 */
  principalPoint: readonly [number, number];
}

/** 3D 点の 1 視点での観測。 */
export interface XaObservation {
  geometry: XaViewGeometry;
  /** 画像 px（列, 行）。 */
  pixel: readonly [number, number];
}

export interface ViewBasis {
  /** アイソセンタ → 検出器の単位ベクトル。 */
  d: Vec3;
  /** 画像の列方向（単位）。 */
  u: Vec3;
  /** 画像の行方向（単位）。 */
  v: Vec3;
  /** 線源位置。 */
  source: Vec3;
  /** 検出器中心（主点に対応する 3D 位置）。 */
  detectorCenter: Vec3;
}

const DEG = Math.PI / 180;

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function unit(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}

/** C アームの姿勢から基底を作る。 */
export function viewBasis(g: XaViewGeometry): ViewBasis {
  const a = g.primaryAngleDeg * DEG;
  const b = g.secondaryAngleDeg * DEG;
  const d = unit([Math.sin(a) * Math.cos(b), -Math.cos(a) * Math.cos(b), Math.sin(b)]);
  const z: Vec3 = [0, 0, 1];
  let u = cross(z, d);
  // β=±90（真上/真下から）で z × d が退化する。列方向を患者の左に固定して破綻を避ける。
  u = norm(u) < 1e-9 ? [1, 0, 0] : unit(u);
  const v = cross(u, d);
  const source = scale(d, -g.sodMm);
  const detectorCenter = scale(d, g.sidMm - g.sodMm);
  return { d, u, v, source, detectorCenter };
}

/**
 * 患者 LPS 点 → 画像 px。線源の後ろ（あるいは平行）なら null。
 *
 * <p>透視投影なので、**アイソセンタから外れた点は拡大率が変わる**（out-of-plane magnification）。
 * 2D 計測が単一の mm/px で済まないのはこれが理由（§21.4 の「3D にする利得」）。
 */
export function projectToPixel(point: Vec3, g: XaViewGeometry): [number, number] | null {
  const basis = viewBasis(g);
  const w = sub(point, basis.source);
  const denom = dot(w, basis.d);
  if (!(denom > 1e-6)) return null;
  const t = g.sidMm / denom;
  const q = add(basis.source, scale(w, t));
  const rel = sub(q, basis.detectorCenter);
  return [
    dot(rel, basis.u) / g.imagerSpacingMm[1] + g.principalPoint[0],
    dot(rel, basis.v) / g.imagerSpacingMm[0] + g.principalPoint[1],
  ];
}

export interface Ray {
  origin: Vec3;
  /** 単位方向ベクトル。 */
  direction: Vec3;
}

/** 画像 px → 線源から出る視線（逆投影）。 */
export function pixelToRay(pixel: readonly [number, number], g: XaViewGeometry): Ray {
  const basis = viewBasis(g);
  const du = (pixel[0] - g.principalPoint[0]) * g.imagerSpacingMm[1];
  const dv = (pixel[1] - g.principalPoint[1]) * g.imagerSpacingMm[0];
  const onDetector = add(basis.detectorCenter, add(scale(basis.u, du), scale(basis.v, dv)));
  return { origin: basis.source, direction: unit(sub(onDetector, basis.source)) };
}

export interface TriangulationResult {
  point: Vec3;
  /** 各視線までの距離の RMS [mm]。**対応付けが間違っていると大きくなる**ので、必ず見る。 */
  residualMm: number;
}

/**
 * N 本の視線に最も近い点（最小二乗）。
 *
 * <p>各視線 (o_i, n_i) への距離の 2 乗和 Σ‖(I − n_in_iᵀ)(x − o_i)‖² を最小化する。
 * 正規方程式 (Σ A_i) x = Σ A_i o_i、A_i = I − n_i n_iᵀ。
 *
 * <p>⚠️ **視線が平行に近い（＝角度差が小さい）と行列が悪条件になる**。呼び出し側で
 * 角度差を確かめること。2 方向の角度差が 30° を切ると、奥行き方向の誤差が急に増える。
 */
export function triangulateRays(rays: readonly Ray[]): TriangulationResult | null {
  if (rays.length < 2) return null;
  // 3×3 の正規方程式を素直に組む（次元が固定なので専用実装のほうが読みやすい）。
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const rhs = [0, 0, 0];
  for (const r of rays) {
    const n = r.direction;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const a = (i === j ? 1 : 0) - n[i] * n[j];
        m[i * 3 + j] += a;
        rhs[i] += a * r.origin[j];
      }
    }
  }
  const x = solve3(m, rhs);
  if (!x) return null;
  let sum = 0;
  for (const r of rays) {
    const w = sub(x, r.origin);
    const along = dot(w, r.direction);
    const perp = sub(w, scale(r.direction, along));
    sum += dot(perp, perp);
  }
  return { point: x, residualMm: Math.sqrt(sum / rays.length) };
}

/** 3×3 の線形方程式（部分ピボット付きガウス消去）。特異なら null。 */
function solve3(m: number[], b: number[]): Vec3 | null {
  const a = [
    [m[0], m[1], m[2], b[0]],
    [m[3], m[4], m[5], b[1]],
    [m[6], m[7], m[8], b[2]],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null;
    if (piv !== col) [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c < 4; c++) a[r][c] -= f * a[col][c];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

/** 観測から三角測量する。 */
export function triangulate(observations: readonly XaObservation[]): TriangulationResult | null {
  if (observations.length < 2) return null;
  return triangulateRays(observations.map((o) => pixelToRay(o.pixel, o.geometry)));
}

/** 2 視点の視線方向がなす角 [deg]（0〜90）。三角測量の条件の良さの指標。 */
export function viewSeparationDeg(a: XaViewGeometry, b: XaViewGeometry): number {
  const c = Math.abs(dot(viewBasis(a).d, viewBasis(b).d));
  return (Math.acos(Math.min(1, c)) * 180) / Math.PI;
}

/** 再投影誤差 [px]。投影できない観測は除外する。 */
export function reprojectionErrorPx(point: Vec3, observations: readonly XaObservation[]): number {
  let sum = 0;
  let n = 0;
  for (const o of observations) {
    const p = projectToPixel(point, o.geometry);
    if (!p) continue;
    sum += (p[0] - o.pixel[0]) ** 2 + (p[1] - o.pixel[1]) ** 2;
    n++;
  }
  return n > 0 ? Math.sqrt(sum / n) : NaN;
}

/** 角度にオフセットを足した幾何を返す（元を壊さない）。 */
export function withAngleOffset(g: XaViewGeometry, dPrimaryDeg: number, dSecondaryDeg: number): XaViewGeometry {
  return { ...g, primaryAngleDeg: g.primaryAngleDeg + dPrimaryDeg, secondaryAngleDeg: g.secondaryAngleDeg + dSecondaryDeg };
}

export interface BundleAdjustResult {
  /** 視点ごとの角度オフセット [deg]。**先頭は常に (0,0)**（ゲージ固定）。 */
  offsetsDeg: { primary: number; secondary: number }[];
  /** 調整前の再投影誤差 RMS [px]。 */
  beforePx: number;
  /** 調整後の再投影誤差 RMS [px]。 */
  afterPx: number;
  /** 反復回数。 */
  iterations: number;
}

/**
 * 装置角度の機械誤差を、再投影誤差の最小化で回収する（§10.2 の④）。
 *
 * <h3>なぜ要るのか</h3>
 * `PositionerPrimaryAngle` は機械誤差（±2〜5°）と C アームのたわみを含む。そのまま信じると
 * エピポーラ線が数 mm ずれ、**歪んだ 3D モデルが黙って出る**。
 *
 * <h3>やり方</h3>
 * 未知数は視点ごとの (Δprimary, Δsecondary)。**先頭の視点は固定する**（全体を回しても
 * 再投影誤差は変わらない＝ゲージ自由度があるため。固定しないと解が漂う）。
 * 目的関数は「各対応点を三角測量し、その再投影誤差を全視点で合計したもの」。
 *
 * <p>座標降下＋刻み幅の縮小で解く。未知数は 2(N−1) 個しかないので、これで十分収束する。
 * 微分を書かないぶん**決定的で読みやすく、局所解へ落ちても刻みの履歴から追える**。
 *
 * @param correspondences 各要素が「同じ 3D 点の、全視点での画素座標」。null は欠測
 */
export function bundleAdjustAngles(
  geometries: readonly XaViewGeometry[],
  correspondences: readonly (readonly ([number, number] | null)[])[],
  opts?: { maxAngleDeg?: number; iterations?: number },
): BundleAdjustResult | null {
  const nViews = geometries.length;
  if (nViews < 2 || correspondences.length === 0) return null;
  const maxAngle = opts?.maxAngleDeg ?? 8;
  const maxIter = opts?.iterations ?? 60;

  const offsets = geometries.map(() => ({ primary: 0, secondary: 0 }));

  const cost = (o: typeof offsets): number => {
    const geoms = geometries.map((g, i) => withAngleOffset(g, o[i].primary, o[i].secondary));
    let sum = 0;
    let n = 0;
    for (const corr of correspondences) {
      const obs: XaObservation[] = [];
      for (let i = 0; i < nViews; i++) {
        const px = corr[i];
        if (px) obs.push({ geometry: geoms[i], pixel: px });
      }
      if (obs.length < 2) continue;
      const tri = triangulate(obs);
      if (!tri) continue;
      const e = reprojectionErrorPx(tri.point, obs);
      if (Number.isFinite(e)) {
        sum += e * e;
        n++;
      }
    }
    return n > 0 ? Math.sqrt(sum / n) : Number.POSITIVE_INFINITY;
  };

  const before = cost(offsets);
  let best = before;
  let step = 2.0;
  let iterations = 0;
  while (step > 0.01 && iterations < maxIter) {
    let improved = false;
    // 先頭は動かさない（ゲージ固定）。
    for (let i = 1; i < nViews; i++) {
      for (const key of ["primary", "secondary"] as const) {
        for (const sign of [1, -1]) {
          const trial = offsets.map((o) => ({ ...o }));
          const next = trial[i][key] + sign * step;
          if (Math.abs(next) > maxAngle) continue;
          trial[i][key] = next;
          const c = cost(trial);
          if (c < best - 1e-9) {
            best = c;
            offsets[i][key] = next;
            improved = true;
          }
        }
      }
    }
    iterations++;
    if (!improved) step /= 2;
  }

  return { offsetsDeg: offsets, beforePx: before, afterPx: best, iterations };
}
