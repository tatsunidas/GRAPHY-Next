/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D QCA 分岐部（A6b）の**純ロジック**（`fw/angio-design.md` §21.4）。
 *
 * <h3>単一血管 QCA を 3 本に当てただけでは必ず間違う</h3>
 * 1. **カリーナ周辺は径が定義できない**（*polygon of confluence*）。内腔が 2 本に分かれる途中で、
 *    中心線に直交する 1 次元プロファイルが意味を失う。ここは**測らずに「測っていない」と出す**。
 *    内挿で埋めると、**存在しない狭窄／存在しない健常部**をどちらも作れてしまう。
 * 2. **参照径は枝ごとに立てる**。分岐前後で径が不連続に変わるのは正常なので、
 *    3 本を 1 本の回帰で通すと母血管側が過小・娘枝側が過大になる。
 * 3. **Finet / Murray は妥当性の確認にだけ使う**。経験則であり病変部では成り立たないので、
 *    **径の推定に使うと病変を平滑化して消す**。ここでは「実測と式の差」を出すだけ。
 * 4. **Medina 分類は自動で出さない**。%DS 50% の閾値で機械的に決まるが境界で跳ぶ。
 *    3 本の %DS を出して**分類は人に委ねる**。
 *
 * <h3>角度の約束（ここを取り違えると数値の意味が変わる）</h3>
 * 3 本の向きは**すべて「カリーナから出ていく向き」**に揃える（近位側は逆向きにする）。
 * この約束だと 45° で分岐する枝では
 * - `distalToSideDeg` = **45°**（＝いわゆる分岐角・angle B）
 * - `proximalToSideDeg` = **135°**（angle A）
 * - `proximalToDistalDeg` ≈ **180°**（母血管がまっすぐなら）
 * になる。**「分岐角」という 1 つの数を出さない**——どれを指しているのか読む側に分からない。
 */

import { lesionBounds, referenceDiameters } from "./qca";
import {
  dot,
  viewBasis,
  viewSeparationDeg,
  type Vec3,
  type ViewBasis,
  type XaViewGeometry,
} from "./xaGeometry";
import { foreshorteningProfile, type CrossSectionProfile } from "./xaRecon3d";

/** 枝の役割。 */
export type BranchId = "proximal" | "distal" | "side";

export interface BifurcationBranchInput {
  id: BranchId;
  /** 3D 中心線（患者 LPS mm）。 */
  points: readonly Vec3[];
  /** その中心線に沿った断面（`fuseDiameterProfile` の出力）。 */
  profile: CrossSectionProfile;
}

export interface BifurcationOptions {
  /**
   * カリーナ周辺で測らない範囲の半径 ＝ この係数 × 母血管の径。
   * 既定 1.0（＝母血管 1 径ぶん）。**UI に必ず数値で出す**（どこを測っていないかが分からないと、
   * 「病変が無い」のか「測っていない」のか区別できない）。
   */
  confluenceFactor?: number;
  /** 枝の向きを測る窓の長さ [mm]（既定 5）。臨床の分岐角も近位数 mm で測る。 */
  angleWindowMm?: number;
}

export interface BifurcationBranchResult {
  id: BranchId;
  /** 測れた点の数（除外後）。 */
  measuredPoints: number;
  /** カリーナ周辺で除外した長さ [mm]。**0 でも必ず表示する**。 */
  excludedLengthMm: number;
  mldMm: number | null;
  rvdMm: number | null;
  percentDiameterStenosis: number | null;
  lesionLengthMm: number | null;
  /** カリーナに最も近い「測れた点」での参照径 [mm]（Finet / Murray に使う）。 */
  referenceAtCarinaMm: number | null;
}

export type BifurcationWarningCode =
  /** 3 本の端点がそろっていない（別々の場所を分岐点として引いている）。 */
  | "endpointsApart"
  /** 除外域を引くと枝が短すぎて測れない。 */
  | "branchTooShort"
  /** 断面が出せない（未校正など）。 */
  | "noSections"
  /**
   * 娘枝がカリーナ側で母血管より太い＝**その枝の中心線が母血管に乗っている**。
   *
   * <p>分岐では娘枝が母血管より太くなることは無い（Finet も Murray もそれを含意する）。
   * それでも太く出るのは、投影で母血管と重なった区間を追跡・計測しているから
   * ——実機で、真値 2.1mm の側枝がカリーナ側で 3.11mm と出た（＋その枝の向きが 11° ずれた）。
   * **この状態の角度と径は信用できない**ので、黙って数値だけ出してはいけない。
   */
  | "daughterWiderThanMother";

export interface BifurcationWarning {
  code: BifurcationWarningCode;
  branch: BranchId | null;
  value: number;
  threshold: number;
}

export interface BifurcationResult {
  /** カリーナ（3 本の端点の重心）。 */
  carina: Vec3;
  /** 3 本の端点のばらつき [mm]。大きいほど「同じ分岐を指していない」。 */
  endpointSpreadMm: number;
  /** 実際に使った除外半径 [mm]。 */
  confluenceRadiusMm: number;
  branches: BifurcationBranchResult[];
  /** 角度 [deg]。**すべて「カリーナから出ていく向き」どうし**（上記の約束）。 */
  angles: {
    proximalToDistalDeg: number | null;
    proximalToSideDeg: number | null;
    /** いわゆる分岐角（angle B）。 */
    distalToSideDeg: number | null;
  };
  /**
   * 経験則との差。**推定には使わない**（§21.4）。
   * `deviationPercent` は (実測 − 式) / 式 × 100。
   */
  consistency: {
    finet: { expectedMm: number; measuredMm: number; deviationPercent: number } | null;
    murray: { expectedMm: number; measuredMm: number; deviationPercent: number } | null;
  };
  warnings: BifurcationWarning[];
}

/** 端点がこれ以上離れていたら「別の分岐を指している」と警告する [mm]。 */
export const ENDPOINT_SPREAD_LIMIT_MM = 3.0;
/** 除外後にこれ未満しか残らない枝は測らない [点]。 */
const MIN_POINTS = 3;

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function norm(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function dist(a: Vec3, b: Vec3): number {
  return norm(sub(a, b));
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 各枝の「分岐側の端」を決める。
 *
 * <p>ユーザは 3 本を別々に引くので、**どちらの端が分岐側かは決まっていない**
 * （近位母血管は終点が、娘枝は始点がカリーナ側、とは限らない）。
 * 他の 2 本の端点に近いほうを分岐側とする。
 */
function carinaEnd(branch: readonly Vec3[], others: readonly Vec3[][]): { point: Vec3; atStart: boolean } {
  const first = branch[0];
  const last = branch[branch.length - 1];
  const score = (p: Vec3): number =>
    others.reduce((acc, o) => acc + Math.min(dist(p, o[0]), dist(p, o[o.length - 1])), 0);
  return score(first) <= score(last) ? { point: first, atStart: true } : { point: last, atStart: false };
}

/**
 * カリーナから `windowMm` 以内の点で枝の向きを出す（**カリーナから出ていく向き**）。
 *
 * <p>先頭 2 点の差分では**曲率と抽出のゆらぎでいくらでも振れる**ので、窓の中の点を
 * 平均する（臨床の分岐角も近位数 mm で測る）。
 *
 * <h3>🔴 単位ベクトルの平均にしてはいけない</h3>
 * カリーナから 0.1mm の点と 5mm の点を**同じ重み**で足すと、角度が数度ずれる
 * （実機で分岐角が真値 +8.7° になった）。理由は簡単で、**カリーナのすぐ近くの点は
 * 向きの情報をほとんど持たない**——0.15mm 先の点が 0.05mm 横にずれているだけで
 * 向きは 18° 振れる。それを 5mm 先の点と対等に扱えば、平均はノイズに引かれる。
 *
 * <p>だから**正規化せずに足す**（＝窓の中の点の重心への向き）。遠い点ほど自然に重くなり、
 * 近すぎる点は自分の短さのぶんだけ黙る。真値の生成器（`bench/make_phantom_xa.py`）も
 * 同じ式に揃えてある——**約束が食い違うと、正しい実装でも不合格になる**。
 */
function directionFrom(
  points: readonly Vec3[],
  carina: Vec3,
  atStart: boolean,
  windowMm: number,
  innerMm: number,
): Vec3 | null {
  const ordered = atStart ? points : [...points].reverse();
  let acc: Vec3 = [0, 0, 0];
  let used = 0;
  for (const p of ordered) {
    const d = dist(p, carina);
    if (d < 1e-6) continue;
    if (d <= innerMm) continue;
    if (d > innerMm + windowMm) break;
    const v = sub(p, carina);
    acc = [acc[0] + v[0], acc[1] + v[1], acc[2] + v[2]];
    used++;
  }
  if (used === 0) {
    // 窓に 1 点も入らないほど粗い（または短い）中心線。除外域の外の最寄り 1 点で代用する。
    const p = ordered.find((q) => dist(q, carina) > Math.max(1e-6, innerMm));
    if (!p) return null;
    const v = sub(p, carina);
    const n = norm(v);
    return [v[0] / n, v[1] / n, v[2] / n];
  }
  const n = norm(acc);
  return n > 1e-9 ? [acc[0] / n, acc[1] / n, acc[2] / n] : null;
}

function angleDeg(a: Vec3 | null, b: Vec3 | null): number | null {
  if (!a || !b) return null;
  const c = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return (Math.acos(c) * 180) / Math.PI;
}

/**
 * 1 本の枝を、カリーナ周辺を除外して測る。
 *
 * <p>除外は**カリーナ側の端から連続**するので、残りのプロファイルは切れ目なく繋がる
 * （飛び地を作ると病変長が区間をまたいで伸びる）。
 */
function measureBranch(
  input: BifurcationBranchInput,
  carina: Vec3,
  radiusMm: number,
): { result: BifurcationBranchResult; warning: BifurcationWarning | null } {
  const { points, profile } = input;
  const positionsMm: number[] = [];
  const diametersMm: number[] = [];
  let excludedLengthMm = 0;
  let acc = 0;
  let prev: Vec3 | null = null;

  for (let i = 0; i < points.length && i < profile.sections.length; i++) {
    const p = points[i];
    if (prev) acc += dist(p, prev);
    prev = p;
    const s = profile.sections[i];
    if (dist(p, carina) <= radiusMm) {
      // カリーナ周辺。**測らない**（測れた点の数にも入れない）。
      if (s && s.equivalentDiameterMm > 0) excludedLengthMm += i > 0 ? dist(p, points[i - 1]) : 0;
      continue;
    }
    if (!s || !(s.equivalentDiameterMm > 0)) continue;
    positionsMm.push(acc);
    diametersMm.push(s.equivalentDiameterMm);
  }

  const empty: BifurcationBranchResult = {
    id: input.id,
    measuredPoints: positionsMm.length,
    excludedLengthMm,
    mldMm: null,
    rvdMm: null,
    percentDiameterStenosis: null,
    lesionLengthMm: null,
    referenceAtCarinaMm: null,
  };
  if (positionsMm.length < MIN_POINTS) {
    return {
      result: empty,
      warning: {
        code: profile.sections.some((s) => s) ? "branchTooShort" : "noSections",
        branch: input.id,
        value: positionsMm.length,
        threshold: MIN_POINTS,
      },
    };
  }

  const reference = referenceDiameters(positionsMm, diametersMm);
  let mldIdx = 0;
  for (let i = 1; i < diametersMm.length; i++) if (diametersMm[i] < diametersMm[mldIdx]) mldIdx = i;
  const rvd = reference[mldIdx];
  const ratio = rvd > 0 ? diametersMm[mldIdx] / rvd : 1;
  const { lo, hi } = lesionBounds(diametersMm, reference, mldIdx);

  // カリーナに最も近い「測れた点」の参照径。近位側は末尾、遠位側・側枝は先頭が近い。
  const carinaAtStart = dist(points[0], carina) <= dist(points[points.length - 1], carina);
  const referenceAtCarinaMm = carinaAtStart ? reference[0] : reference[reference.length - 1];

  return {
    result: {
      id: input.id,
      measuredPoints: positionsMm.length,
      excludedLengthMm,
      mldMm: diametersMm[mldIdx],
      rvdMm: rvd,
      percentDiameterStenosis: Math.max(0, (1 - ratio) * 100),
      lesionLengthMm: Math.abs(positionsMm[hi] - positionsMm[lo]),
      referenceAtCarinaMm,
    },
    warning: null,
  };
}

/**
 * 分岐部の解析。3 本（近位母血管 / 遠位母血管 / 側枝）の 3D 中心線と断面から測る。
 *
 * <p>⚠️ **3 本は同じ分岐を指していること**が前提。端点がばらついていれば
 * `endpointsApart` で警告する（黙って重心を取ると、**どこにも無い分岐**を測ることになる）。
 */
export function analyzeBifurcation(
  branches: readonly BifurcationBranchInput[],
  opts: BifurcationOptions = {},
): BifurcationResult | null {
  if (branches.length !== 3) return null;
  const byId = new Map(branches.map((b) => [b.id, b]));
  const proximal = byId.get("proximal");
  const distal = byId.get("distal");
  const side = byId.get("side");
  if (!proximal || !distal || !side) return null;
  if (branches.some((b) => b.points.length < 2)) return null;

  const warnings: BifurcationWarning[] = [];

  // ── カリーナ ────────────────────────────────────────────────────
  const ends = branches.map((b) =>
    carinaEnd(
      b.points,
      branches.filter((o) => o.id !== b.id).map((o) => o.points as Vec3[]),
    ),
  );
  const carina: Vec3 = [
    (ends[0].point[0] + ends[1].point[0] + ends[2].point[0]) / 3,
    (ends[0].point[1] + ends[1].point[1] + ends[2].point[1]) / 3,
    (ends[0].point[2] + ends[1].point[2] + ends[2].point[2]) / 3,
  ];
  const endpointSpreadMm = Math.max(...ends.map((e) => dist(e.point, carina)));
  if (endpointSpreadMm > ENDPOINT_SPREAD_LIMIT_MM) {
    warnings.push({
      code: "endpointsApart",
      branch: null,
      value: endpointSpreadMm,
      threshold: ENDPOINT_SPREAD_LIMIT_MM,
    });
  }

  // ── 除外域（母血管 1 径ぶんが既定）────────────────────────────────
  const motherDiameters = proximal.profile.sections
    .filter((s): s is NonNullable<typeof s> => !!s && s.equivalentDiameterMm > 0)
    .map((s) => s.equivalentDiameterMm);
  const motherDiameterMm = motherDiameters.length ? median(motherDiameters) : 0;
  const confluenceRadiusMm = (opts.confluenceFactor ?? 1.0) * motherDiameterMm;

  // ── 枝ごとの計測 ────────────────────────────────────────────────
  const results: BifurcationBranchResult[] = [];
  for (const b of [proximal, distal, side]) {
    const { result, warning } = measureBranch(b, carina, confluenceRadiusMm);
    results.push(result);
    if (warning) warnings.push(warning);
  }

  // ── 角度（すべて「カリーナから出ていく向き」）──────────────────────
  //
  // 🔴 **除外域の中の点は角度にも使わない。** 径をそこで測らないのは「3 本が重なっていて
  //    1 本の血管として見られない」からで、その理由は中心線にもそのまま当てはまる——
  //    投影で母血管と重なった側枝は、中心線が母血管側へ引かれる。実機で、側枝の
  //    カリーナ側の径が真値 2.1mm に対し 3.11mm（＝母血管を測っている）になり、
  //    同時に分岐角が +15.7° ずれた。**径だけ除外して角度は除外しない、は筋が通らない。**
  const windowMm = opts.angleWindowMm ?? 5;
  const dirOf = (b: BifurcationBranchInput): Vec3 | null => {
    const e = ends[branches.indexOf(b)];
    return directionFrom(b.points, carina, e.atStart, windowMm, confluenceRadiusMm);
  };
  const dp = dirOf(proximal);
  const dd = dirOf(distal);
  const dsd = dirOf(side);

  // ── 経験則との差（**推定には使わない**）──────────────────────────
  const dProx = results.find((r) => r.id === "proximal")?.referenceAtCarinaMm ?? null;
  const dDist = results.find((r) => r.id === "distal")?.referenceAtCarinaMm ?? null;
  const dSide = results.find((r) => r.id === "side")?.referenceAtCarinaMm ?? null;
  // 🚨 娘枝が母血管より太く出たら、その枝は母血管に乗っている（上の警告の説明）。
  //    角度・径・Finet/Murray がまとめて信用できなくなるので、**必ず出す**。
  //    しきい値を 1.0 のまま（余裕を付けない）にしているのは、分岐で娘枝が母血管より
  //    太いこと自体が起こらないため——「少しなら許す」は、この故障には意味が無い。
  for (const [id, d] of [
    ["distal", dDist],
    ["side", dSide],
  ] as const) {
    if (dProx && d && d > dProx) {
      warnings.push({ code: "daughterWiderThanMother", branch: id, value: d, threshold: dProx });
    }
  }

  const finet =
    dProx && dDist && dSide
      ? (() => {
          const expected = 0.678 * (dDist + dSide);
          return { expectedMm: expected, measuredMm: dProx, deviationPercent: ((dProx - expected) / expected) * 100 };
        })()
      : null;
  const murray =
    dProx && dDist && dSide
      ? (() => {
          const expected = Math.cbrt(dDist ** 3 + dSide ** 3);
          return { expectedMm: expected, measuredMm: dProx, deviationPercent: ((dProx - expected) / expected) * 100 };
        })()
      : null;

  return {
    carina,
    endpointSpreadMm,
    confluenceRadiusMm,
    branches: results,
    angles: {
      proximalToDistalDeg: angleDeg(dp, dd),
      proximalToSideDeg: angleDeg(dp, dsd),
      distalToSideDeg: angleDeg(dd, dsd),
    },
    consistency: { finet, murray },
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* ワーキングアングル（分岐部）— §21.4.4                               */
/* ------------------------------------------------------------------ */

export interface BifurcationWorkingAngle {
  primaryAngleDeg: number;
  secondaryAngleDeg: number;
  /** 枝ごとの「見えている長さの割合」（0〜1・除外域の外だけで測る）。 */
  visibleFraction: Record<BranchId, number>;
  /** 3 本のうち最も潰れている枝の割合。 */
  minVisibleFraction: number;
  /**
   * 他の枝の裏に隠れて見える長さ [mm]（最も重なっている枝の値）。**0 が理想**。
   * 除外域（カリーナ周辺）は数えない——そこは角度に関係なく必ず重なる。
   */
  overlapLengthMm: number;
  /** 最も重なっていた 2 枝。 */
  overlapPair: readonly [BranchId, BranchId];
  /** 血管の太さを考えた重なりか。径を出せない枝があると false（中心線どうしで判定）。 */
  edgeAware: boolean;
  /** 並べ替えに使った点（0〜1）。重なりが許容を超えると 0。 */
  score: number;
}

export interface BifurcationWorkingAngleOptions {
  /** 走査の刻み [deg]（既定 5）。 */
  stepDeg?: number;
  /** primary の探索範囲 ±[deg]（既定 90）。 */
  primaryRangeDeg?: number;
  /** secondary の探索範囲 ±[deg]（既定 45）。 */
  secondaryRangeDeg?: number;
  /** 返す候補の数（既定 3）。 */
  count?: number;
  /**
   * 重なりの許容 [mm]（既定 5）。これ以上重なる角度は 0 点。
   * 分岐直後は角度に依らず数 mm 重なるので、0 を要求すると候補が消える。
   */
  overlapToleranceMm?: number;
  /** 候補どうしをこれ以上離す [deg]（既定 15）。隣り合う格子点が並ぶのを防ぐ。 */
  minSpreadDeg?: number;
  /** 1 枝あたりの標本数の上限（既定 40）。 */
  maxSamples?: number;
}

interface BranchSamples {
  id: BranchId;
  points: Vec3[];
  /** 各点の半径 [mm]。分からない点は枝の中央値で埋める。全く分からなければ 0。 */
  radiiMm: number[];
  hasRadii: boolean;
}

/** 除外域の外の点を間引いて標本にする。半径は断面（等価直径）から。 */
function branchSamples(
  input: BifurcationBranchInput,
  carina: Vec3,
  confluenceRadiusMm: number,
  maxSamples: number,
): BranchSamples | null {
  const pts: Vec3[] = [];
  const radii: (number | null)[] = [];
  for (let i = 0; i < input.points.length; i++) {
    const p = input.points[i];
    if (dist(p, carina) <= confluenceRadiusMm) continue;
    const s = i < input.profile.sections.length ? input.profile.sections[i] : null;
    pts.push(p);
    radii.push(s && s.equivalentDiameterMm > 0 ? s.equivalentDiameterMm / 2 : null);
  }
  if (pts.length < 2) return null;
  const stride = Math.max(1, Math.ceil(pts.length / Math.max(2, maxSamples)));
  const outPts: Vec3[] = [];
  const outRadii: (number | null)[] = [];
  for (let i = 0; i < pts.length; i += stride) {
    outPts.push(pts[i]);
    outRadii.push(radii[i]);
  }
  // 末尾は必ず残す（枝の先端が落ちると重なりを見落とす）。
  if (outPts[outPts.length - 1] !== pts[pts.length - 1]) {
    outPts.push(pts[pts.length - 1]);
    outRadii.push(radii[radii.length - 1]);
  }
  const known = outRadii.filter((r): r is number => r != null);
  // 🔴 分からない点を 0 で埋めない。0 は「太さが無い」＝重なりを**狭く**見積もる方向で、
  //    重なっている角度を「空いている」と言ってしまう。分かっている点の中央値で埋める。
  const fill = known.length ? median(known) : 0;
  return {
    id: input.id,
    points: outPts,
    radiiMm: outRadii.map((r) => r ?? fill),
    hasRadii: known.length > 0,
  };
}

/** 投影済みの枝（重なり判定に要るものだけ）。 */
interface ProjectedBranch {
  xy: [number, number][];
  radiiMm: number[];
  /** 各区間の 3D 長さ [mm]（`segmentsMm[i]` は点 i-1 → i）。 */
  segmentsMm: number[];
}

/** 3D 点を視線方向へ平行投影した 2D 座標 [mm]（検出器の画素には落とさない）。 */
function projectOrtho(p: Vec3, basis: ViewBasis): [number, number] {
  return [dot(p, basis.u), dot(p, basis.v)];
}

/** 点 → 線分の距離と、線分上の位置（0〜1）。 */
function pointSegment2(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): { distance: number; t: number } {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (!(len2 > 0)) return { distance: Math.hypot(p[0] - a[0], p[1] - a[1]), t: 0 };
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { distance: Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t)), t };
}

/**
 * 枝 `a` のうち、投影上で枝 `b` に隠れている長さ [mm]。
 *
 * <p>区間の中点が「2 本の半径の和」より近ければ、その区間は重なっているとみなす。
 * 長さは**3D の弧長**で数える（投影長で数えると、潰れて見える角度ほど重なりが
 * 小さく出て、二重に得をしてしまう）。
 */
function hiddenLengthMm(a: ProjectedBranch, b: ProjectedBranch): number {
  let hidden = 0;
  for (let i = 1; i < a.xy.length; i++) {
    const mid: [number, number] = [(a.xy[i - 1][0] + a.xy[i][0]) / 2, (a.xy[i - 1][1] + a.xy[i][1]) / 2];
    const ra = (a.radiiMm[i - 1] + a.radiiMm[i]) / 2;
    let best = Infinity;
    for (let j = 1; j < b.xy.length; j++) {
      const { distance, t } = pointSegment2(mid, b.xy[j - 1], b.xy[j]);
      const rb = b.radiiMm[j - 1] * (1 - t) + b.radiiMm[j] * t;
      const gap = distance - (ra + rb);
      if (gap < best) best = gap;
    }
    if (best < 0) hidden += a.segmentsMm[i];
  }
  return hidden;
}

const PAIRS: readonly (readonly [BranchId, BranchId])[] = [
  ["distal", "side"],
  ["proximal", "side"],
  ["proximal", "distal"],
];

const BRANCH_ORDER: readonly BranchId[] = ["proximal", "distal", "side"];

/**
 * 分岐部が**重ならず・潰れずに**見える撮影角度を探す（ワーキングアングルの提案）。
 *
 * <h3>単一血管の `suggestWorkingAngles`（`xaRecon3d.ts`）と何が違うか</h3>
 * 単一血管では「短縮しないこと」だけが条件だった。分岐部ではそれに加えて
 * **3 本が互いに重ならないこと**が要る——側枝が母血管の裏に隠れる角度では、
 * 側枝の入口（＝治療の可否を決める場所）が見えない。短縮だけで選ぶと、
 * **潰れずにきれいに見えるが 2 本が完全に重なっている角度**が最上位に来る
 * （合成分岐で実際にそうなる。`xaBifurcation.test.ts` で固定してある）。
 *
 * <h3>重なりの測り方</h3>
 * 3D 中心線を視線方向へ**平行投影**し（透視の拡大率は重なりの判定にほとんど効かない）、
 * 「区間の中点が、相手の枝から**2 本の半径の和**より近い」区間を重なりとして数える。
 * 長さは 3D の弧長。カリーナから `confluenceRadiusMm` 以内は 3 本が本当に接しているので
 * **数えない**（ここを入れるとどの角度でも「重なっている」になる）。
 *
 * <h3>🔴 これは「見えるはず」であって「見える」ではない</h3>
 * - 装置の可動範囲・寝台・術者の立ち位置は見ていない。
 * - **他の血管・脊椎・カテーテル・横隔膜との重なりは入っていない**（3 本しか知らないため）。
 * - 元の 3D 中心線が短縮の影響で既に短ければ `visibleFraction` は過大に出る
 *   （`foreshorteningProfile` と同じ性質。「危ないと出たら間違いなく危ない」向きの指標）。
 *
 * <p>`base` からは SID/SOD 等を引き継ぐが、**判定に効くのは 2 つの角度だけ**
 * （平行投影と接線の向きしか見ないため）。
 */
export function suggestBifurcationWorkingAngles(
  branches: readonly BifurcationBranchInput[],
  carina: Vec3,
  confluenceRadiusMm: number,
  base: XaViewGeometry,
  opts: BifurcationWorkingAngleOptions = {},
): BifurcationWorkingAngle[] {
  const step = Math.max(1, opts.stepDeg ?? 5);
  const pRange = opts.primaryRangeDeg ?? 90;
  const sRange = opts.secondaryRangeDeg ?? 45;
  const count = Math.max(1, opts.count ?? 3);
  const tolerance = Math.max(1e-6, opts.overlapToleranceMm ?? 5);
  const spread = opts.minSpreadDeg ?? 15;

  const samples: BranchSamples[] = [];
  for (const id of BRANCH_ORDER) {
    const input = branches.find((b) => b.id === id);
    if (!input) return [];
    const s = branchSamples(input, carina, confluenceRadiusMm, opts.maxSamples ?? 40);
    if (!s) return [];
    samples.push(s);
  }
  const edgeAware = samples.every((s) => s.hasRadii);
  const segments = new Map<BranchId, number[]>(
    samples.map((s) => [
      s.id,
      s.points.map((p, i) => (i === 0 ? 0 : dist(p, s.points[i - 1]))),
    ]),
  );

  const all: BifurcationWorkingAngle[] = [];
  for (let p = -pRange; p <= pRange + 1e-9; p += step) {
    for (let sec = -sRange; sec <= sRange + 1e-9; sec += step) {
      const g: XaViewGeometry = { ...base, primaryAngleDeg: p, secondaryAngleDeg: sec };
      const basis = viewBasis(g);
      const projected = new Map<BranchId, ProjectedBranch>();
      const visible: Record<BranchId, number> = { proximal: 0, distal: 0, side: 0 };
      let ok = true;
      for (const s of samples) {
        const prof = foreshorteningProfile(s.points, g);
        if (!prof) {
          ok = false;
          break;
        }
        visible[s.id] = prof.visibleFraction;
        projected.set(s.id, {
          xy: s.points.map((q) => projectOrtho(q, basis)),
          radiiMm: s.radiiMm,
          segmentsMm: segments.get(s.id) ?? [],
        });
      }
      if (!ok) continue;

      let worst = 0;
      let worstPair: readonly [BranchId, BranchId] = PAIRS[0];
      for (const pair of PAIRS) {
        const a = projected.get(pair[0]);
        const b = projected.get(pair[1]);
        if (!a || !b) continue;
        const overlap = Math.max(hiddenLengthMm(a, b), hiddenLengthMm(b, a));
        if (overlap > worst) {
          worst = overlap;
          worstPair = pair;
        }
      }

      const minVisible = Math.min(visible.proximal, visible.distal, visible.side);
      // 重なりが許容を超えた候補は 0 点。**「よく見えるが重なっている」を上位に出さない**
      // ——重なった区間は測れないうえ、そこが一番見たい場所であることが多い。
      const clarity = Math.max(0, 1 - worst / tolerance);
      all.push({
        primaryAngleDeg: p,
        secondaryAngleDeg: sec,
        visibleFraction: { ...visible },
        minVisibleFraction: minVisible,
        overlapLengthMm: worst,
        overlapPair: worstPair,
        edgeAware,
        score: minVisible * clarity,
      });
    }
  }

  // 点が同じなら「より重なっていない」を上に。全部重なっていても（＝全部 0 点）
  // 重なりの少ない順に並ぶので、「一番マシな角度」は返る。
  all.sort((a, b) => b.score - a.score || a.overlapLengthMm - b.overlapLengthMm);

  const out: BifurcationWorkingAngle[] = [];
  for (const c of all) {
    // 隣り合う格子点が 3 つ並んでも候補にならない（同じ方向を 3 回言っているだけ）。
    const far = out.every(
      (o) =>
        viewSeparationDeg(
          { ...base, primaryAngleDeg: o.primaryAngleDeg, secondaryAngleDeg: o.secondaryAngleDeg },
          { ...base, primaryAngleDeg: c.primaryAngleDeg, secondaryAngleDeg: c.secondaryAngleDeg },
        ) >= spread,
    );
    if (!far) continue;
    out.push(c);
    if (out.length >= count) break;
  }
  return out;
}
