/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 2 方向の中心線から 3D 中心線を作る（`fw/angio-design.md` §10.2 の ①〜③・⑤ / A6a）。
 *
 * <h3>🚨 ここも Cornerstone / VTK の 3D API を使わない</h3>
 * `fw/cornerstone-3d-geometry-caveat.md` のとおり、患者 LPS mm の自前・単一幾何で完結させる。
 * 投影の定義は {@link ./xaGeometry} 側にあり、本ファイルはその上の「対応付け」だけを担う。
 *
 * <h3>なぜ「最寄りのエピポーラ交点」ではなく単調対応（DTW）なのか</h3>
 * 蛇行した血管は**投影すると自己交差する**。ある点のエピポーラ線は相手の中心線と
 * 何度も交わり、しかもどの交点も幾何的には正しい。「最寄りを採る」ような局所判定は、
 * ここで**黙って別の場所へ飛ぶ**（そして三角測量は飛んだ先でも解けてしまうので、
 * 誤りが再投影誤差にすら出ないことがある）。
 *
 * 使えるのは局所情報ではなく**順序**である。中心線は近位→遠位に並んだ曲線なので、
 * 対応は弧長について**単調増加**でなければならない。単調性を制約として持つ対応付け
 * （＝DTW）は、自己交差があっても定義から飛べない。ファントム GNBP-XA-3 を
 * わざと自己交差する螺旋にしてあるのは、この違いを検出するためである（§16.3）。
 *
 * <h3>🔴 対応付けの再投影誤差は、幾何の正しさの検査にならない</h3>
 * 実測（`xaRecon3d.test.ts`／GNBP-XA-3）:
 *
 * | 角度誤差 | 対応付けの再投影 | 形状の誤差 | **固定点の再投影** |
 * | :- | :- | :- | :- |
 * | 0° | 0.36 px | 1.38 mm | 0.00 px |
 * | 2° | 0.30 px | 2.11 mm | 1.53 px |
 * | 4° | 0.33 px | 3.13 mm | 3.05 px |
 * | 8° | 0.83 px | 4.15 mm | 6.10 px |
 *
 * **角度を 8° 狂わせても、対応付けの再投影誤差はほとんど増えない。** 中心線は 1 次元多様体で、
 * エピポーラ拘束が奪う自由度も 1 つしかない。つまりどんな幾何を与えても、相手の曲線上に
 * 「エピポーラ線と交わる点」がだいたい存在する。対応付けは幾何の誤差を**自分がずれることで
 * 吸収してしまう**。その結果、**再投影誤差は小さいまま、モデルだけが歪む**。
 * §10.3 が言う「無言で歪んだモデルを出さない」の"無言"は、まさにこれ。
 *
 * したがって、
 * - 品質判定にもバンドル調整にも、**対応がずれない固定点（アンカー）**を使う。
 *   既定のアンカーは 2 本の中心線の**両端**＝「同じ解剖学的位置から同じ位置まで辿ること」を
 *   利用者に要求する（臨床の 3D QCA が始点・終点の指定を求めるのはこのため）。
 * - アンカーが 1 つも無いときは**結果を出さない**（検算する手段が無いため）。
 * - 🚨 **アンカー 2 点でのバンドル調整は退化する。** 未知数が (Δprimary, Δsecondary) の 2 つ、
 *   アンカー 1 点が与える拘束が 1 つなので、2 点では残差 0 に必ず落ちて何でも「回収」できる。
 *   角度を推定するなら**3 点以上**（`refineGeometryWithAnchors` が本数を確認する）。
 *
 * <h3>⚠️ この対応付けが仮定していること</h3>
 * - 2 本の中心線が**同じ血管区間**を辿っている（既定では両端を固定する。`endToleranceFraction`
 *   を上げると端をずらせるが、そのぶん端をアンカーに使えなくなる）。
 * - 2 方向が**同じ心位相**である（非同時収集の位相ずれは補正しない。§10.4）。
 * - 局所の弧長比（フォアショートニング比）が極端でない。`slopePenaltyMm` はその事前分布で、
 *   **測定ではなく仮定**。上げるほど弧長に比例した素直な対応になる。
 */

import {
  type Ray,
  type Vec3,
  type XaObservation,
  type XaViewGeometry,
  bundleAdjustAngles,
  cross,
  dot,
  norm,
  pixelToRay,
  reprojectionErrorPx,
  triangulateRays,
  viewSeparationDeg,
  withAngleOffset,
} from "./xaGeometry";
import { referenceDiameters } from "./qca";

export type Vec2 = readonly [number, number];

/** 1 方向で抽出した中心線。 */
export interface XaCenterline2D {
  geometry: XaViewGeometry;
  /** 画像 px（列, 行）。**近位→遠位の順**。 */
  points: readonly Vec2[];
  /** 各点の径 [px]（QCA の D(s)）。無ければ径の合成をしない。 */
  diametersPx?: readonly number[];
}

export type ReconWarningCode =
  /** 視線の角度差が小さく、奥行きが決まらない。**結果を出してはいけない**。 */
  | "insufficientSeparation"
  /** **アンカーの**再投影誤差が閾値超え。角度が間違っている。 */
  | "highReprojectionError"
  /** アンカーが無く、幾何を検算できない。**結果を出してはいけない**。 */
  | "geometryUnverified"
  /** アンカーが 2 点以下。角度の推定（バンドル調整）には足りない。 */
  | "tooFewAnchors"
  /** 端の対応が食い違う。2 本が同じ区間を辿っていない疑い。 */
  | "endpointMismatch"
  /** 対応が一部で退化（片方が停滞）。フォアショートニングが強いか、対応が破綻している。 */
  | "degenerateCorrespondence"
  /** どちらかの方向で血管が視線方向に潰れている。**長さが系統的に短く出る**（§10.3.1）。 */
  | "severeForeshortening";

export interface ReconWarning {
  code: ReconWarningCode;
  /** 判断した実測値。 */
  value: number;
  /** 比較した閾値。 */
  threshold: number;
  /** true なら結果を出さない（§10.3「無言で歪んだモデルを出さない」）。 */
  blocking: boolean;
}

/** 2 方向で「同じ場所」と分かっている点（起始部・分岐・ステント端など）。 */
export interface ReconAnchor {
  pixelA: Vec2;
  pixelB: Vec2;
}

export interface ReconOptions {
  /** これを下回る視点角度差は棄却 [deg]。既定 30（§10.1 の注意書き）。 */
  minSeparationDeg?: number;
  /** 許容する**アンカーの**再投影誤差 RMS [px]。既定 2.0。 */
  maxReprojectionPx?: number;
  /**
   * 対応がずれない固定点。省略時は**両中心線の端点 2 組**を使う
   * （`endToleranceFraction` が 0 のときだけ。端をずらす設定では端点が対応しないため）。
   */
  anchors?: readonly ReconAnchor[];
  /**
   * 両端で対応を自由にずらせる割合。既定 **0**（＝端を固定する）。
   * 上げると端点をアンカーに使えなくなるので、`anchors` を別に渡すこと。
   */
  endToleranceFraction?: number;
  /**
   * 端を読み飛ばす 1 標本あたりのコスト [mm]。既定 1.0。
   * 🚨 **0 にしてはいけない。** 読み飛ばしが只だと、DP は経路を短くするだけでコストを下げられる。
   * 実際にこれを入れる前は、`slopePenaltyMm` の罰則から逃げるために端が最大限に切り捨てられ、
   * **長さが 8% 短く出た**（RMS 0.09mm → 1.38mm）。
   */
  endSkipCostMm?: number;
  /** 弧長比が 1 から外れることへの罰則 [mm]。**仮定であって測定ではない**。既定 0.1。 */
  slopePenaltyMm?: number;
  /** 対応付けに使う標本数（両曲線をこの数へ弧長等分で再標本化）。既定 200。 */
  samples?: number;
  /** 3D 点列の平滑化窓（奇数、1 で無効）。既定 5。 */
  smoothWindow?: number;
  /**
   * これを下回る「見えている長さの割合」を短縮として警告する。既定 0.8。
   * 実機では方向 B の割合が下がった区間で 2D 中心線が 9.5% 短く出た（§10.3.1）。
   */
  minVisibleFraction?: number;
}

export interface CenterlineMatch {
  /** 標本 i（曲線 A）に対応する曲線 B の標本番号。 */
  indexB: number[];
  /** 各対応のエピポーラ距離 [mm]（2 本の視線の最近接距離）。 */
  epipolarMm: number[];
  /** 先頭で読み飛ばした割合（A, B）。 */
  startSkip: readonly [number, number];
  /** 末尾で読み飛ばした割合（A, B）。 */
  endSkip: readonly [number, number];
  /** 対応の最大停滞長（同じ indexB が続いた数）。退化の指標。 */
  maxStall: number;
  /** 再標本化後の 2D 点列（A, B）。 */
  sampledA: Vec2[];
  sampledB: Vec2[];
}

export interface Recon3DResult {
  /** 3D 中心線（患者 LPS mm）。曲線 A の標本ごとに 1 点。 */
  points: Vec3[];
  /** 各点の三角測量残差 [mm]。 */
  residualMm: number[];
  /**
   * 対応付けの結果に対する再投影誤差 RMS [px]。
   * 🔴 **幾何の正しさの指標として使ってはいけない**（冒頭の表）。参考値として出すだけ。
   */
  matchReprojectionPx: number;
  /** アンカーの再投影誤差 RMS [px]。**これが幾何の検算**。アンカーが無ければ NaN。 */
  anchorReprojectionPx: number;
  /** 使ったアンカーの数。 */
  anchorCount: number;
  /** 視点の角度差 [deg]。 */
  separationDeg: number;
  /** 3D 中心線の全長 [mm]。 */
  lengthMm: number;
  match: CenterlineMatch;
  /** 各方向での短縮の度合い。**精度を一番左右する量**（§10.3.1）。 */
  foreshortening: { a: ForeshorteningProfile | null; b: ForeshorteningProfile | null };
  warnings: ReconWarning[];
  /** blocking な警告が無いか。false なら**結果を表示しない**。 */
  acceptable: boolean;
}

/* ------------------------------------------------------------------ */
/* 幾何の小道具                                                        */
/* ------------------------------------------------------------------ */

/**
 * 2 本の視線（ねじれの位置にある直線）の最近接距離 [mm]。
 *
 * <p>対応付けのコストにこれを使う。px のエピポーラ線距離ではなく mm にしたのは、
 * (1) 2 視点で単位が揃う（px は検出器ピッチと拡大率で意味が変わる）、
 * (2) エピポーラ線の描画（＝線源を相手へ投影する）が退化する配置を通らない、ため。
 */
export function rayDistanceMm(a: Ray, b: Ray): number {
  const n = cross(a.direction, b.direction);
  const len = norm(n);
  const w: Vec3 = [a.origin[0] - b.origin[0], a.origin[1] - b.origin[1], a.origin[2] - b.origin[2]];
  if (len < 1e-9) {
    // 平行。視線に垂直な成分がそのまま距離。
    const along = dot(w, a.direction);
    const perp: Vec3 = [
      w[0] - a.direction[0] * along,
      w[1] - a.direction[1] * along,
      w[2] - a.direction[2] * along,
    ];
    return norm(perp);
  }
  return Math.abs(dot(w, n)) / len;
}

/**
 * 点列を弧長で等分に再標本化する（次元によらない）。
 *
 * <p>`qlv.ts` にも 2D 版があるが、あちらは壁運動の弦の対応付け専用で検証済みなので触らない。
 * ここは 2D（px）と 3D（mm）の両方に要るため次元非依存で持つ。
 */
export function resampleByArcLengthN<T extends readonly number[]>(points: readonly T[], count: number): number[][] {
  if (points.length < 2 || count < 2) return points.map((p) => [...p]);
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    let s = 0;
    for (let k = 0; k < points[i].length; k++) s += (points[i][k] - points[i - 1][k]) ** 2;
    cum.push(cum[i - 1] + Math.sqrt(s));
  }
  const total = cum[cum.length - 1];
  if (!(total > 0)) return points.map((p) => [...p]);
  const out: number[][] = [];
  let seg = 1;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / (count - 1);
    while (seg < cum.length - 1 && cum[seg] < target) seg++;
    const t0 = cum[seg - 1];
    const t1 = cum[seg];
    const u = t1 > t0 ? (target - t0) / (t1 - t0) : 0;
    const a = points[seg - 1];
    const b = points[seg];
    out.push(a.map((v, d) => v + (b[d] - v) * u));
  }
  return out;
}

/** 折れ線の長さ（次元によらない）。 */
export function polylineLength(points: readonly (readonly number[])[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    let s = 0;
    for (let k = 0; k < points[i].length; k++) s += (points[i][k] - points[i - 1][k]) ** 2;
    total += Math.sqrt(s);
  }
  return total;
}

/** 移動平均で 3D 点列を平滑化する（端は窓を縮める）。 */
export function smoothPolyline3d(points: readonly Vec3[], window: number): Vec3[] {
  const w = Math.max(1, Math.floor(window));
  if (w <= 1 || points.length < 3) return points.map((p) => [...p] as unknown as Vec3);
  const half = Math.floor(w / 2);
  return points.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(points.length - 1, i + half);
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = lo; k <= hi; k++) {
      x += points[k][0];
      y += points[k][1];
      z += points[k][2];
    }
    const n = hi - lo + 1;
    return [x / n, y / n, z / n] as Vec3;
  });
}

/* ------------------------------------------------------------------ */
/* 対応付け（単調 DP）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 2 方向の中心線を、弧長について単調な対応で結ぶ。
 *
 * <p>コストは各対のエピポーラ距離 [mm]。遷移は (i−1,j−1) / (i−1,j) / (i,j−1) の 3 通りで、
 * 斜め以外には `slopePenaltyMm` を課す（＝弧長比が 1 から外れることへの事前分布）。
 * 両端は `endToleranceFraction` の範囲だけ読み飛ばしを許し、**読み飛ばした標本 1 つにつき
 * `endSkipCostMm` を課す**。
 *
 * <p>🚨 **読み飛ばしを只にしてはいけない。** 経路が短いほど累積コストが小さくなるので、
 * DP は「対応を良くする」のではなく「経路を切り詰める」ことでコストを下げてしまう。
 * 実際、罰則を課す前は端が許容いっぱいまで切り捨てられ、**3D 長さが 8% 短く出た**。
 * 読み飛ばしに料金を付ければ、経路の長短にかかわらず総額で比較できる。
 */
export function matchCenterlines(
  a: XaCenterline2D,
  b: XaCenterline2D,
  opts?: ReconOptions,
): CenterlineMatch | null {
  const samples = Math.max(4, Math.floor(opts?.samples ?? 200));
  if (a.points.length < 2 || b.points.length < 2) return null;

  const sampledA = resampleByArcLengthN(a.points as readonly Vec2[], samples).map((p) => [p[0], p[1]] as Vec2);
  const sampledB = resampleByArcLengthN(b.points as readonly Vec2[], samples).map((p) => [p[0], p[1]] as Vec2);
  const raysA = sampledA.map((p) => pixelToRay(p, a.geometry));
  const raysB = sampledB.map((p) => pixelToRay(p, b.geometry));

  const n = sampledA.length;
  const m = sampledB.length;
  const cost = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) cost[i * m + j] = rayDistanceMm(raysA[i], raysB[j]);
  }

  const penalty = Math.max(0, opts?.slopePenaltyMm ?? 0.1);
  const skipCost = Math.max(0, opts?.endSkipCostMm ?? 1.0);
  const tol = Math.min(0.5, Math.max(0, opts?.endToleranceFraction ?? 0));
  const iTol = Math.floor(tol * (n - 1));
  const jTol = Math.floor(tol * (m - 1));

  const INF = Number.POSITIVE_INFINITY;
  const dp = new Float64Array(n * m).fill(INF);
  const from = new Int8Array(n * m).fill(-1); // 0=斜め, 1=上(i−1,j), 2=左(i,j−1)

  // 開始は (0,0) のほか、片方の先頭を許容ぶんだけ読み飛ばせる（読み飛ばした数だけ課金）。
  for (let j = 0; j <= jTol; j++) dp[j] = j * skipCost + cost[j];
  for (let i = 0; i <= iTol; i++) {
    const idx = i * m;
    const c = i * skipCost + cost[idx];
    if (c < dp[idx]) dp[idx] = c;
  }

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const idx = i * m + j;
      if (i === 0 && j === 0) continue;
      let best = dp[idx]; // 開始点として初期化済みならそれを保つ
      let bestFrom = -1;
      const consider = (prev: number, extra: number, dir: number) => {
        if (dp[prev] === INF) return;
        const c = dp[prev] + cost[idx] + extra;
        if (c < best) {
          best = c;
          bestFrom = dir;
        }
      };
      if (i > 0 && j > 0) consider(idx - m - 1, 0, 0);
      if (i > 0) consider(idx - m, penalty, 1);
      if (j > 0) consider(idx - 1, penalty, 2);
      if (bestFrom >= 0) {
        dp[idx] = best;
        from[idx] = bestFrom;
      }
    }
  }

  // 終端も同じだけ読み飛ばしを許す。読み飛ばしに課金してあるので総額のまま比べられる。
  let endI = n - 1;
  let endJ = m - 1;
  let bestTotal = INF;
  const tryEnd = (i: number, j: number) => {
    const idx = i * m + j;
    if (dp[idx] === INF) return;
    const total = dp[idx] + (n - 1 - i) * skipCost + (m - 1 - j) * skipCost;
    if (total < bestTotal) {
      bestTotal = total;
      endI = i;
      endJ = j;
    }
  };
  for (let j = m - 1 - jTol; j < m; j++) tryEnd(n - 1, j);
  for (let i = n - 1 - iTol; i < n; i++) tryEnd(i, m - 1);
  if (bestTotal === INF) return null;

  // 逆順にたどる。
  const path: [number, number][] = [];
  let ci = endI;
  let cj = endJ;
  for (;;) {
    path.push([ci, cj]);
    const dir = from[ci * m + cj];
    if (dir < 0) break;
    if (dir === 0) {
      ci--;
      cj--;
    } else if (dir === 1) {
      ci--;
    } else {
      cj--;
    }
  }
  path.reverse();

  // 曲線 A の標本ごとに 1 つの相手を決める（複数対応するときは中央値）。
  const perI = new Map<number, number[]>();
  for (const [i, j] of path) {
    const list = perI.get(i);
    if (list) list.push(j);
    else perI.set(i, [j]);
  }
  const indexB: number[] = [];
  const epipolarMm: number[] = [];
  const covered: number[] = [];
  for (const i of [...perI.keys()].sort((x, y) => x - y)) {
    const js = perI.get(i)!.sort((x, y) => x - y);
    const j = js[Math.floor(js.length / 2)];
    covered.push(i);
    indexB.push(j);
    epipolarMm.push(cost[i * m + j]);
  }

  // 停滞長（同じ j が続いた回数）＝退化の指標。
  let maxStall = 1;
  let run = 1;
  for (let k = 1; k < indexB.length; k++) {
    run = indexB[k] === indexB[k - 1] ? run + 1 : 1;
    if (run > maxStall) maxStall = run;
  }

  const first = path[0];
  const last = path[path.length - 1];
  return {
    indexB,
    epipolarMm,
    startSkip: [first[0] / (n - 1), first[1] / (m - 1)],
    endSkip: [(n - 1 - last[0]) / (n - 1), (m - 1 - last[1]) / (m - 1)],
    maxStall,
    // 対応が付いた範囲だけを返す（読み飛ばした端は含めない）。
    sampledA: covered.map((i) => sampledA[i]),
    sampledB: indexB.map((j) => sampledB[j]),
  };
}

/* ------------------------------------------------------------------ */
/* 3D 再構成                                                           */
/* ------------------------------------------------------------------ */

/**
 * 2 方向の中心線から 3D 中心線を作る。
 *
 * <p>§10.3 のとおり、**閾値を超えたら結果を出さない**。ここでは投げずに
 * `acceptable:false` と `warnings` を返し、表示するかどうかは呼び出し側が決める
 * （数値を見せずに「できません」とだけ言うと、何が悪いのか誰にも分からなくなるため）。
 */
export function reconstructCenterline3d(
  a: XaCenterline2D,
  b: XaCenterline2D,
  opts?: ReconOptions,
): Recon3DResult | null {
  const match = matchCenterlines(a, b, opts);
  if (!match || match.sampledA.length < 2) return null;

  const separationDeg = viewSeparationDeg(a.geometry, b.geometry);
  const minSeparation = opts?.minSeparationDeg ?? 30;
  const maxReproj = opts?.maxReprojectionPx ?? 2.0;

  const raw: Vec3[] = [];
  const residualMm: number[] = [];
  let reprojSum = 0;
  let reprojN = 0;
  for (let k = 0; k < match.sampledA.length; k++) {
    const pa = match.sampledA[k];
    const pb = match.sampledB[k];
    const tri = triangulateRays([pixelToRay(pa, a.geometry), pixelToRay(pb, b.geometry)]);
    if (!tri) return null;
    raw.push(tri.point);
    residualMm.push(tri.residualMm);
    const obs: XaObservation[] = [
      { geometry: a.geometry, pixel: pa },
      { geometry: b.geometry, pixel: pb },
    ];
    const e = reprojectionErrorPx(tri.point, obs);
    if (Number.isFinite(e)) {
      reprojSum += e * e;
      reprojN++;
    }
  }
  const points = smoothPolyline3d(raw, opts?.smoothWindow ?? 5);
  const matchReprojectionPx = reprojN > 0 ? Math.sqrt(reprojSum / reprojN) : NaN;

  const anchors = opts?.anchors ?? defaultAnchors(a, b, opts);
  const anchorReprojectionPx = anchorReprojection(anchors, a.geometry, b.geometry);

  const warnings: ReconWarning[] = [];
  if (separationDeg < minSeparation) {
    warnings.push({ code: "insufficientSeparation", value: separationDeg, threshold: minSeparation, blocking: true });
  }
  if (anchors.length === 0) {
    // 検算する手段が無い。§10.3 の「無言で歪んだモデルを出さない」に従い、ここで止める。
    warnings.push({ code: "geometryUnverified", value: 0, threshold: 1, blocking: true });
  } else if (!(anchorReprojectionPx <= maxReproj)) {
    warnings.push({ code: "highReprojectionError", value: anchorReprojectionPx, threshold: maxReproj, blocking: true });
  }
  if (anchors.length > 0 && anchors.length < 3) {
    // 角度の推定には足りない（未知数 2 に対し拘束 2 で必ず残差 0 になる）。表示は許す。
    warnings.push({ code: "tooFewAnchors", value: anchors.length, threshold: 3, blocking: false });
  }
  const skip = Math.max(match.startSkip[0], match.startSkip[1], match.endSkip[0], match.endSkip[1]);
  if (skip > 0.05) {
    warnings.push({ code: "endpointMismatch", value: skip, threshold: 0.05, blocking: false });
  }
  const stallLimit = Math.max(3, Math.round(match.sampledA.length * 0.1));
  if (match.maxStall > stallLimit) {
    warnings.push({ code: "degenerateCorrespondence", value: match.maxStall, threshold: stallLimit, blocking: false });
  }

  // 🔴 短縮は「結果を止める」のではなく「値が系統的に短いことを知らせる」種類の問題。
  //    止めてしまうと、短縮している事実そのものが利用者に見えなくなる（次にどの角度で
  //    撮り直せばよいかも分からない）。だから blocking にはせず、必ず数値で出す。
  const minVisible = opts?.minVisibleFraction ?? 0.8;
  const foreshortening = {
    a: foreshorteningProfile(points, a.geometry),
    b: foreshorteningProfile(points, b.geometry),
  };
  const worstVisible = Math.min(
    foreshortening.a?.visibleFraction ?? 1,
    foreshortening.b?.visibleFraction ?? 1,
  );
  if (worstVisible < minVisible) {
    warnings.push({ code: "severeForeshortening", value: worstVisible, threshold: minVisible, blocking: false });
  }

  return {
    points,
    residualMm,
    matchReprojectionPx,
    anchorReprojectionPx,
    anchorCount: anchors.length,
    separationDeg,
    lengthMm: polylineLength(points),
    match,
    foreshortening,
    warnings,
    acceptable: !warnings.some((w) => w.blocking),
  };
}

/**
 * 既定のアンカー＝2 本の中心線の両端。
 * **端をずらす設定（`endToleranceFraction > 0`）では端点が対応する保証が無い**ので使わない。
 */
export function defaultAnchors(a: XaCenterline2D, b: XaCenterline2D, opts?: ReconOptions): ReconAnchor[] {
  if ((opts?.endToleranceFraction ?? 0) > 0) return [];
  if (a.points.length < 2 || b.points.length < 2) return [];
  return [
    { pixelA: a.points[0], pixelB: b.points[0] },
    { pixelA: a.points[a.points.length - 1], pixelB: b.points[b.points.length - 1] },
  ];
}

/** アンカーを三角測量して再投影したときの誤差 RMS [px]。 */
export function anchorReprojection(
  anchors: readonly ReconAnchor[],
  a: XaViewGeometry,
  b: XaViewGeometry,
): number {
  if (anchors.length === 0) return NaN;
  let sum = 0;
  let n = 0;
  for (const an of anchors) {
    const obs: XaObservation[] = [
      { geometry: a, pixel: an.pixelA },
      { geometry: b, pixel: an.pixelB },
    ];
    const tri = triangulateRays(obs.map((o) => pixelToRay(o.pixel, o.geometry)));
    if (!tri) continue;
    const e = reprojectionErrorPx(tri.point, obs);
    if (Number.isFinite(e)) {
      sum += e * e;
      n++;
    }
  }
  return n > 0 ? Math.sqrt(sum / n) : NaN;
}

/**
 * UI から呼ぶ入口。**アンカーで角度を補正してから**再構成する。
 *
 * <h3>なぜ「補正してから」なのか — 閾値だけでは足りない（実測）</h3>
 * GNBP-XA-3 のタグ角度（誤差 (1.5,−1.0)° と (−2.5,+2.0)°）をそのまま信じると:
 *
 * | | アンカー再投影 | 形状 RMS | 判定 |
 * | :- | :- | :- | :- |
 * | 真の角度 | 0.00 px | 0.09 mm | 合格 |
 * | タグの角度のまま | **1.61 px** | **1.68 mm** | **閾値 2px を通ってしまう** |
 * | アンカー 5 点で補正後 | 0.03 px | 0.78 mm | 合格 |
 *
 * つまり **2px の閾値は「粗い誤りの検出器」であって、精度の保証書ではない**。
 * 装置の機械誤差の程度（2〜3°）は閾値をすり抜けるので、閾値を頼りにするのではなく
 * **常に補正を掛ける**。補正できない（アンカーが 3 点未満）ときは、そのことを警告に出す。
 *
 * <p>💡 回収されるオフセットは「注入した誤差の符号違い」にはならない。視点 A を固定するので、
 * B は**歪んだ A と辻褄が合う位置**へ動く（実測で primary +6.7°）。数値の大きさに驚かないこと。
 */
export function reconstructWithRefinement(
  a: XaCenterline2D,
  b: XaCenterline2D,
  opts?: ReconOptions & { maxAngleDeg?: number },
): { result: Recon3DResult | null; refinement: GeometryRefinement | null } {
  const anchors = opts?.anchors ?? defaultAnchors(a, b, opts);
  const refinement = refineGeometryWithAnchors(a.geometry, b.geometry, anchors, { maxAngleDeg: opts?.maxAngleDeg });
  const fixedB = refinement ? { ...b, geometry: refinement.geometryB } : b;
  return { result: reconstructCenterline3d(a, fixedB, { ...opts, anchors }), refinement };
}

export interface GeometryRefinement {
  /** 補正後の視点 B の幾何。視点 A は動かさない（ゲージ固定）。 */
  geometryB: XaViewGeometry;
  /** 補正前後のアンカー再投影誤差 [px]。 */
  beforePx: number;
  afterPx: number;
  /** 回収した角度オフセット [deg]。 */
  offsetDeg: { primary: number; secondary: number };
}

/**
 * アンカーから視点 B の角度誤差を回収する（§10.2 の ④ を A6a の文脈で使う形）。
 *
 * <p>🚨 **アンカーが 3 点未満なら null を返す。** 未知数 2 に対して拘束が 2 以下では
 * 残差 0 の解が必ず存在し、「回収した」という数値だけが得られて中身が無い。
 *
 * <p>⚠️ 回収されるのは**視点 A との相対**である。A 自身の角度誤差はモデル全体の姿勢誤差として
 * 残る（＝形は合うが患者座標での向きは合わない）。これは 2 方向では原理的に外せない。
 */
export function refineGeometryWithAnchors(
  a: XaViewGeometry,
  b: XaViewGeometry,
  anchors: readonly ReconAnchor[],
  opts?: { maxAngleDeg?: number },
): GeometryRefinement | null {
  if (anchors.length < 3) return null;
  const corr = anchors.map((an) => [an.pixelA, an.pixelB] as (readonly [number, number] | null)[]);
  const adj = bundleAdjustAngles([a, b], corr, { maxAngleDeg: opts?.maxAngleDeg ?? 8 });
  if (!adj) return null;
  const offset = adj.offsetsDeg[1];
  const geometryB = withAngleOffset(b, offset.primary, offset.secondary);
  return {
    geometryB,
    beforePx: anchorReprojection(anchors, a, b),
    afterPx: anchorReprojection(anchors, a, geometryB),
    offsetDeg: offset,
  };
}

/* ------------------------------------------------------------------ */
/* 断面の合成（§10.2 の ⑤）                                            */
/* ------------------------------------------------------------------ */

export interface FusedCrossSection {
  /** 視点 A で測った径 [mm]。 */
  diameterAMm: number;
  /** 視点 B で測った径 [mm]。 */
  diameterBMm: number;
  /** 楕円断面を仮定した面積 [mm²]。 */
  areaMm2: number;
  /** 面積から求めた等価円直径 [mm]。 */
  equivalentDiameterMm: number;
  /**
   * 断面内での 2 つの測定方向がなす角 [deg]。
   * **90° から離れるほど楕円の仮定が効いてくる**。
   */
  measurementAngleDeg: number;
}

/**
 * 2 方向の径から断面積を合成する（楕円断面モデル）。
 *
 * <h3>⚠️ これは測定ではなく仮定である</h3>
 * 断面の楕円は 3 自由度（長径・短径・向き）あるのに、2 方向からは**幅が 2 つ**しか
 * 得られない。**原理的に決まらない**。ここでは「楕円の主軸が 2 つの測定方向に一致する」
 * と仮定して `A = π/4·d_A·d_B` とする。この式は
 * - 断面が**円**なら測定方向によらず厳密（どの方向でも幅 = 直径）
 * - 断面が楕円で 2 方向が**直交**しているなら厳密
 * であり、それ以外では誤差を持つ。`measurementAngleDeg` が 90° から離れているときは
 * 呼び出し側で警告すること。
 *
 * <h3>🔴 系統誤差が乗る</h3>
 * 入力の径は QCA の半値法由来で、円柱断面では **約 13% 過小**（§16.4）。面積はその 2 乗で
 * 効くので **約 24% 過小**になる。合成しても消えない。§16.4 の作り直しが前提。
 *
 * @param tangent 3D 中心線の接線（単位ベクトルでなくてよい）
 */
export function fuseCrossSection(
  diameterAMm: number,
  diameterBMm: number,
  tangent: Vec3,
  a: XaViewGeometry,
  b: XaViewGeometry,
): FusedCrossSection | null {
  const t = norm(tangent) > 1e-9 ? tangent : null;
  if (!t) return null;
  const dirA = measurementDirection(t, a);
  const dirB = measurementDirection(t, b);
  if (!dirA || !dirB) return null;
  const c = Math.min(1, Math.abs(dot(dirA, dirB)));
  const areaMm2 = (Math.PI / 4) * diameterAMm * diameterBMm;
  return {
    diameterAMm,
    diameterBMm,
    areaMm2,
    equivalentDiameterMm: 2 * Math.sqrt(Math.max(0, areaMm2) / Math.PI),
    measurementAngleDeg: (Math.acos(c) * 180) / Math.PI,
  };
}

/**
 * ある視点で径を測っている方向（＝断面内で、視線にも接線にも垂直な向き）。
 * 視線と接線が平行に近いと決まらない（＝真正面から見た血管。フォアショートニング極大）。
 */
function measurementDirection(tangent: Vec3, g: XaViewGeometry): Vec3 | null {
  // 視線 d と接線 t の両方に垂直な向き。画像上の「幅」はこの向きに現れる。
  const d = viewDirection(g);
  const n = cross(d, tangent);
  const len = norm(n);
  if (len < 1e-6) return null;
  return [n[0] / len, n[1] / len, n[2] / len];
}

function viewDirection(g: XaViewGeometry): Vec3 {
  const DEG = Math.PI / 180;
  const a = g.primaryAngleDeg * DEG;
  const bb = g.secondaryAngleDeg * DEG;
  return [Math.sin(a) * Math.cos(bb), -Math.cos(a) * Math.cos(bb), Math.sin(bb)];
}

/** 3D 点列の各点での接線（中央差分）。 */
export function tangents3d(points: readonly Vec3[]): Vec3[] {
  return points.map((_, i) => {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[Math.min(points.length - 1, i + 1)];
    const v: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const n = norm(v);
    return n > 1e-9 ? ([v[0] / n, v[1] / n, v[2] / n] as Vec3) : ([0, 0, 1] as Vec3);
  });
}

/* ------------------------------------------------------------------ */
/* 短縮（フォアショートニング）— §10.3.1 の主因                        */
/* ------------------------------------------------------------------ */

export interface ForeshorteningProfile {
  /**
   * その方向で見えている長さの割合（0〜1）。
   * 1 = 視線に完全に垂直（実長どおり見える）／0 = 視線に平行（点に潰れる）。
   */
  visibleFraction: number;
  /** 局所で最も潰れている点の割合。 */
  worstLocal: number;
  /** 潰れている（局所割合が `severeBelow` 未満）区間の長さの割合。 */
  severeFraction: number;
}

/**
 * 3D 中心線が、ある方向でどれだけ短縮して見えるかを測る。
 *
 * <h3>なぜこれを出すのか — 精度を一番左右するのはここ</h3>
 * 実機検証（§10.3.1）で分かったこと: **視線方向に潰れた区間では、2D の自動追跡が
 * 原理的に弧長を取りこぼす**。抽出された中心線は真値から RMS 0.66px しか離れていない
 * （＝血管の上には乗っている）のに、弧長が 9.5% 足りなかった。潰れた区間では
 * **投影が自分自身の上を往復する**ので、直進する近道も最初から最後まで血管画素の上を通る。
 * 人が見ても辿れない。**対策はアルゴリズムではなく、短縮しない 2 方向を選ぶこと**
 * （＝臨床で言うワーキングアングル）。
 *
 * <p>局所の見え方は接線 t と視線 d のなす角で決まり、見える長さの割合は `|t × d|`。
 * これを弧長で重み付けして平均したものが {@link ForeshorteningProfile.visibleFraction}。
 *
 * <p>⚠️ **これは 3D 中心線から計算するので、その中心線が既に短縮の影響で短いと過小評価になる。**
 * 「大丈夫だと出たから正しい」ではなく、「危ないと出たら間違いなく危ない」向きの指標として読む。
 */
export function foreshorteningProfile(
  points: readonly Vec3[],
  g: XaViewGeometry,
  opts?: { severeBelow?: number },
): ForeshorteningProfile | null {
  if (points.length < 2) return null;
  const severeBelow = opts?.severeBelow ?? 0.5;
  const d = viewDirection(g);
  const tans = tangents3d(points);
  let total = 0;
  let visible = 0;
  let severe = 0;
  let worst = 1;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
      points[i][2] - points[i - 1][2],
    );
    if (!(seg > 0)) continue;
    // 区間の向きは端点の接線の平均で見る（中央差分の接線をそのまま使うより素直）。
    const t: Vec3 = [
      (tans[i - 1][0] + tans[i][0]) / 2,
      (tans[i - 1][1] + tans[i][1]) / 2,
      (tans[i - 1][2] + tans[i][2]) / 2,
    ];
    const n = norm(t);
    if (!(n > 1e-9)) continue;
    const local = Math.min(1, norm(cross([t[0] / n, t[1] / n, t[2] / n], d)));
    total += seg;
    visible += seg * local;
    if (local < severeBelow) severe += seg;
    if (local < worst) worst = local;
  }
  if (!(total > 0)) return null;
  return { visibleFraction: visible / total, worstLocal: worst, severeFraction: severe / total };
}

export interface WorkingAngleSuggestion {
  primaryAngleDeg: number;
  secondaryAngleDeg: number;
  /** その方向での見える割合。 */
  visibleFraction: number;
}

/**
 * 短縮が最も小さい撮影角度を探す（ワーキングアングルの提案）。
 *
 * <p>3D 中心線が一度でも得られれば、**任意の角度での見え方を計算できる**。
 * 「次はこの角度で撮ると短縮が少ない」を数値で言えるのが 3D 再構成の実利のひとつ。
 *
 * <p>⚠️ **装置が到達できる角度かどうかは考えていない**（C アームの可動範囲・寝台・術者の立ち位置）。
 * 提案であって指示ではない。また、**血管が他の血管と重ならないか**（オーバーラップ）は
 * 別の問題で、ここでは見ていない。
 *
 * @param count 返す候補の数（見える割合の大きい順）
 */
export function suggestWorkingAngles(
  points: readonly Vec3[],
  base: XaViewGeometry,
  opts?: { stepDeg?: number; primaryRangeDeg?: number; secondaryRangeDeg?: number; count?: number },
): WorkingAngleSuggestion[] {
  const step = Math.max(1, opts?.stepDeg ?? 5);
  const pRange = opts?.primaryRangeDeg ?? 90;
  const sRange = opts?.secondaryRangeDeg ?? 45;
  const out: WorkingAngleSuggestion[] = [];
  for (let p = -pRange; p <= pRange + 1e-9; p += step) {
    for (let s = -sRange; s <= sRange + 1e-9; s += step) {
      const prof = foreshorteningProfile(points, { ...base, primaryAngleDeg: p, secondaryAngleDeg: s });
      if (!prof) continue;
      out.push({ primaryAngleDeg: p, secondaryAngleDeg: s, visibleFraction: prof.visibleFraction });
    }
  }
  out.sort((a, b) => b.visibleFraction - a.visibleFraction);
  return out.slice(0, Math.max(1, opts?.count ?? 3));
}

/* ------------------------------------------------------------------ */
/* 3D 断面プロファイル（§10.2 の ⑤ を中心線全体へ）                    */
/* ------------------------------------------------------------------ */

/** 1 方向の径プロファイル（QCA の出力そのまま）。 */
export interface DiameterProfile {
  /** 各計測点の径。単位は `unit`。 */
  diameters: readonly number[];
  /** 各計測点が対応する中心線インデックス（`XaCenterline2D.points` の添字）。 */
  pathIndices: readonly number[];
  /**
   * 元の中心線の点数。
   * 🚨 **これが要る。** 計測点は中心線の部分集合なので、`pathIndices` の最大値は
   * 中心線の末尾とは限らない。「割合 → 中心線インデックス」の換算に末尾の計測点を使うと、
   * **計測していない範囲まで測ったことにしてしまう**（テストで捕捉した）。
   */
  pointCount: number;
  unit: "mm" | "px";
}

export interface CrossSectionProfile {
  /** 3D 中心線の点ごとの断面。測れなかった点は null。 */
  sections: (FusedCrossSection | null)[];
  /** 最小の等価直径 [mm]（3D MLD）。測れなければ null。 */
  minEquivalentDiameterMm: number | null;
  /** その位置（`sections` の添字）。 */
  minIndex: number | null;
  /** 最小断面積 [mm²]。 */
  minAreaMm2: number | null;
  /** 2 方向の測定方向がなす角の中央値 [deg]。90° から離れるほど楕円の仮定が効く。 */
  medianMeasurementAngleDeg: number | null;
  /** 断面を出せなかった理由（出せたなら null）。 */
  unavailable: "uncalibrated" | "noDiameters" | "noTangent" | null;
}

/**
 * 2 方向の径プロファイルを、3D 中心線に沿った断面へ合成する。
 *
 * <h3>🚨 出せない条件は黙って埋めない</h3>
 * どちらかの方向が**未校正（px）**なら断面積は出せない。px の径を掛け合わせると
 * 「mm² に見える無意味な数」になる。`unavailable: "uncalibrated"` を返して**何も出さない**。
 *
 * <h3>🔴 系統誤差</h3>
 * 入力の径は半値法由来で **約 13% 過小**（§16.4）。面積は 2 乗で効くので **約 24% 過小**。
 * 合成しても消えない。§16.4 の作り直しが前提。
 */
export function fuseDiameterProfile(
  points: readonly Vec3[],
  a: { geometry: XaViewGeometry; profile: DiameterProfile },
  b: { geometry: XaViewGeometry; profile: DiameterProfile },
  match: CenterlineMatch,
): CrossSectionProfile {
  const empty: CrossSectionProfile = {
    sections: points.map(() => null),
    minEquivalentDiameterMm: null,
    minIndex: null,
    minAreaMm2: null,
    medianMeasurementAngleDeg: null,
    unavailable: null,
  };
  if (a.profile.unit !== "mm" || b.profile.unit !== "mm") return { ...empty, unavailable: "uncalibrated" };
  if (a.profile.diameters.length === 0 || b.profile.diameters.length === 0) {
    return { ...empty, unavailable: "noDiameters" };
  }

  const tans = tangents3d(points);
  const sections: (FusedCrossSection | null)[] = [];
  const angles: number[] = [];
  let minEq: number | null = null;
  let minIdx: number | null = null;
  let minArea: number | null = null;

  for (let k = 0; k < points.length; k++) {
    // 3D 点 k は「曲線 A の標本 k」に対応する。標本は弧長等分なので、元の中心線の
    // どの位置かは割合で戻せる（対応が付いた範囲だけを再標本化してある）。
    const fracA = points.length > 1 ? k / (points.length - 1) : 0;
    const idxB = match.indexB[k];
    const fracB = match.indexB.length > 1 && idxB != null
      ? idxB / (match.sampledB.length - 1 || 1)
      : fracA;
    const dA = sampleProfileByFraction(a.profile, fracA);
    const dB = sampleProfileByFraction(b.profile, fracB);
    if (dA == null || dB == null) {
      sections.push(null);
      continue;
    }
    const f = fuseCrossSection(dA, dB, tans[k], a.geometry, b.geometry);
    sections.push(f);
    if (!f) continue;
    angles.push(f.measurementAngleDeg);
    if (minEq == null || f.equivalentDiameterMm < minEq) {
      minEq = f.equivalentDiameterMm;
      minIdx = k;
      minArea = f.areaMm2;
    }
  }
  if (angles.length === 0) return { ...empty, sections, unavailable: "noTangent" };
  const sorted = [...angles].sort((x, y) => x - y);
  return {
    sections,
    minEquivalentDiameterMm: minEq,
    minIndex: minIdx,
    minAreaMm2: minArea,
    medianMeasurementAngleDeg: sorted[Math.floor(sorted.length / 2)],
    unavailable: null,
  };
}

/**
 * 径プロファイルを「中心線に沿った割合」で引く。
 *
 * <p>QCA の計測点は中心線の**部分集合**（`pathIndices`）なので、割合はその範囲で線形に読む。
 * 範囲外（計測点が中心線の一部しか覆っていない領域）は null を返す —— **端を外挿しない**。
 * 外挿した径は「測っていない値」なのに測ったのと同じ顔で出てしまう。
 */
function sampleProfileByFraction(p: DiameterProfile, frac: number): number | null {
  const n = p.diameters.length;
  if (n === 0) return null;
  if (n === 1) return p.diameters[0];
  const idx = p.pathIndices;
  const lo = idx[0];
  const hi = idx[n - 1];
  if (!(hi > lo)) return p.diameters[0];
  // frac は「中心線全体に対する割合」。中心線の添字へ写してから、計測点の範囲と比べる。
  const targetPath = frac * Math.max(1, p.pointCount - 1);
  if (targetPath < lo || targetPath > hi) return null;
  let j = 1;
  while (j < n - 1 && idx[j] < targetPath) j++;
  const t0 = idx[j - 1];
  const t1 = idx[j];
  const u = t1 > t0 ? (targetPath - t0) / (t1 - t0) : 0;
  return p.diameters[j - 1] + (p.diameters[j] - p.diameters[j - 1]) * u;
}

/* ------------------------------------------------------------------ */
/* 3D の狭窄率（§10 / A6a）                                            */
/* ------------------------------------------------------------------ */

export interface Stenosis3DResult {
  /** 断面を測れた点の、3D 中心線に沿った位置 [mm]。 */
  positionsMm: number[];
  /** 同じ点での等価直径 [mm]。 */
  diametersMm: number[];
  /** 参照径の当てはめ [mm]。 */
  referenceMm: number[];
  /** `positionsMm` 上の添字。3D 点列の添字へ戻すのに使う。 */
  pointIndices: number[];
  mldMm: number;
  /** MLD の位置（3D 点列の添字）。 */
  mldPointIndex: number;
  rvdMm: number;
  percentDiameterStenosis: number;
  percentAreaStenosis: number;
  lesionLengthMm: number;
}

/**
 * 3D 断面プロファイルから狭窄率を出す。
 *
 * <h3>参照径は 2D QCA と同じ当てはめを使う</h3>
 * `qca.ts` の {@link referenceDiameters}（狭窄側を捨てる反復 1 次回帰）をそのまま呼ぶ。
 * **2D と 3D で別々の参照径モデルを持たない**——同じ名前の量が別の定義で出ると、
 * どちらを見ているのか分からなくなる。
 *
 * <h3>🔑 半値法の 13% 過小は、%DS では（ほぼ）打ち消される</h3>
 * 参照径の当てはめは径について 1 次同次で、狭窄側を捨てる判定
 * （`d ≥ a·s + b`）も径を一律に定数倍しても変わらない。したがって
 * **径をすべて k 倍しても %DS と %AS は厳密に不変**（vitest で固定してある）。
 * 実際には係数が半径に依存する（§16.4）ぶんだけ残るが、MLD/RVD の絶対値ほどには効かない。
 *
 * <p>⚠️ 断面を測れない点（`sections` が null）は**飛ばす**。詰めて計算すると
 * 位置がずれるので、位置は 3D 中心線に沿った実距離で持つ。
 */
export function stenosis3d(
  points: readonly Vec3[],
  profile: CrossSectionProfile,
): Stenosis3DResult | null {
  // 3D 中心線に沿った累積距離。
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(
      cum[i - 1] +
        Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]),
    );
  }
  const positionsMm: number[] = [];
  const diametersMm: number[] = [];
  const pointIndices: number[] = [];
  for (let i = 0; i < profile.sections.length && i < points.length; i++) {
    const s = profile.sections[i];
    if (!s || !(s.equivalentDiameterMm > 0)) continue;
    positionsMm.push(cum[i]);
    diametersMm.push(s.equivalentDiameterMm);
    pointIndices.push(i);
  }
  if (diametersMm.length < 3) return null;

  const referenceMm = referenceDiameters(positionsMm, diametersMm);

  let mldIdx = 0;
  let mld = Number.POSITIVE_INFINITY;
  for (let i = 0; i < diametersMm.length; i++) {
    if (diametersMm[i] < mld) {
      mld = diametersMm[i];
      mldIdx = i;
    }
  }
  const rvd = referenceMm[mldIdx] ?? mld;
  const ratio = rvd > 0 ? mld / rvd : 1;

  // 病変長 = MLD を含む「径が参照径を下回る」連続区間（2D と同じ定義）。
  let lo = mldIdx;
  while (lo - 1 >= 0 && diametersMm[lo - 1] < referenceMm[lo - 1]) lo--;
  let hi = mldIdx;
  while (hi + 1 < diametersMm.length && diametersMm[hi + 1] < referenceMm[hi + 1]) hi++;

  return {
    positionsMm,
    diametersMm,
    referenceMm,
    pointIndices,
    mldMm: mld,
    mldPointIndex: pointIndices[mldIdx],
    rvdMm: rvd,
    percentDiameterStenosis: Math.max(0, (1 - ratio) * 100),
    percentAreaStenosis: Math.max(0, (1 - ratio * ratio) * 100),
    lesionLengthMm: Math.abs((positionsMm[hi] ?? 0) - (positionsMm[lo] ?? 0)),
  };
}
