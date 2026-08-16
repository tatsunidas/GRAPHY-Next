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
import { type Vec3 } from "./xaGeometry";
import { type CrossSectionProfile } from "./xaRecon3d";

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
  | "noSections";

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
 * <p>先頭 2 点の差分では**曲率と抽出のゆらぎでいくらでも振れる**ので、窓の中の点への
 * 平均方向にする（臨床の分岐角も近位数 mm で測る）。
 */
function directionFrom(points: readonly Vec3[], carina: Vec3, atStart: boolean, windowMm: number): Vec3 | null {
  const ordered = atStart ? points : [...points].reverse();
  let acc: Vec3 = [0, 0, 0];
  let used = 0;
  for (const p of ordered) {
    const d = dist(p, carina);
    if (d < 1e-6) continue;
    if (d > windowMm) break;
    const v = sub(p, carina);
    const n = norm(v);
    acc = [acc[0] + v[0] / n, acc[1] + v[1] / n, acc[2] + v[2] / n];
    used++;
  }
  if (used === 0) {
    // 窓に 1 点も入らないほど粗い中心線。最寄りの 1 点で代用する。
    const p = ordered.find((q) => dist(q, carina) > 1e-6);
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
  const windowMm = opts.angleWindowMm ?? 5;
  const dirOf = (b: BifurcationBranchInput): Vec3 | null => {
    const e = ends[branches.indexOf(b)];
    return directionFrom(b.points, carina, e.atStart, windowMm);
  };
  const dp = dirOf(proximal);
  const dd = dirOf(distal);
  const dsd = dirOf(side);

  // ── 経験則との差（**推定には使わない**）──────────────────────────
  const dProx = results.find((r) => r.id === "proximal")?.referenceAtCarinaMm ?? null;
  const dDist = results.find((r) => r.id === "distal")?.referenceAtCarinaMm ?? null;
  const dSide = results.find((r) => r.id === "side")?.referenceAtCarinaMm ?? null;
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
