/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 奥行き（スライス間隔）の共通の決め方。純関数（`fw/slice-depth-policy.md`）。
 *
 * <h3>奥行きの求め方（上から優先）</h3>
 * <ol>
 *   <li><b>ipp</b>: IPP を法線（行の向き × 列の向き）へ射影した位置。スライス間の直交した実空間距離。</li>
 *   <li><b>sbs</b>: SpacingBetweenSlices（中心どうしの距離。厚み ± ギャップ・重なりを含んだ値）。</li>
 *   <li><b>thickness</b>: SliceThickness。連続している（ギャップ 0）と仮定した<b>推定</b>。</li>
 *   <li><b>unknown</b>: 何も無い。1 mm として描くが、mm・mL は出さない。</li>
 * </ol>
 * SliceLocation は基準点が実装ごとに違うので使わない。
 *
 * <h3>並びの分類</h3>
 * 許容値 = max(0.01 mm, 公称間隔の 1%)。0.01 mm は IPP の DS 値の丸め誤差の大きさ、1% は 1 ボクセルの 1/100。
 */

export type V3 = [number, number, number];

export interface SliceInfo {
  id: string;
  sop?: string | null;
  ipp?: ArrayLike<number> | null;
  iop?: ArrayLike<number> | null;
  sliceThickness?: number | null;
  spacingBetweenSlices?: number | null;
}

export type DepthSource = "ipp" | "sbs" | "thickness" | "unknown";
export type SliceLayoutKind = "uniform" | "missing" | "irregular" | "duplicates" | "single";

export interface SliceGeometry {
  /** 奥行きの順（法線方向に増える）に並べた入力の添字。 */
  order: number[];
  /** order の各スライスの法線方向の位置（mm。先頭を 0 にしない実座標の射影）。 */
  positions: number[];
  /** 隣どうしの間隔（mm）。 */
  steps: number[];
  /** 公称の間隔 Δ̄ = (d_last − d_0)/(N−1)。1 枚なら sbs → thickness → 1。 */
  nominalSpacing: number;
  /** 最小の間隔（均一な格子に取り直すときの間隔）。 */
  minSpacing: number;
  source: DepthSource;
  kind: SliceLayoutKind;
  /** 等間隔の格子からのずれの最大値（mm）。 */
  maxDeviationMm: number;
  /** 欠けたスライスの枚数（kind が missing のとき）。 */
  missingCount: number;
  /** スライスごとの幅（前後への距離の半分ずつ。端の外側は最小の間隔の半分）。order の順。 */
  widths: number[];
  /** IOP の法線と、先頭→末尾の IPP の向きのなす角（度）。 */
  shearDeg: number;
  /** 法線（単位ベクトル）。IOP が無ければ null。 */
  normal: V3 | null;
  /** 全スライスの IOP が 1e-4 以内でそろっているか。 */
  iopConsistent: boolean;
}

const POS_TOL_MM = 0.01;
const REL_TOL = 0.01;
const IOP_TOL = 1e-4;
const MISSING_REL_TOL = 0.1;

const finite3 = (v: ArrayLike<number> | null | undefined): v is ArrayLike<number> =>
  !!v && v.length >= 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
const finite6 = (v: ArrayLike<number> | null | undefined): v is ArrayLike<number> =>
  !!v && v.length >= 6 && Array.from(v).slice(0, 6).every(Number.isFinite);
const pos = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

function normalOf(iop: ArrayLike<number>): V3 | null {
  const r = [iop[0], iop[1], iop[2]], c = [iop[3], iop[4], iop[5]];
  const n: V3 = [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]];
  const l = Math.hypot(n[0], n[1], n[2]);
  return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : null;
}

/** IPP が無いときの 1 枚あたりの間隔（sbs → thickness → unknown）。 */
function fallbackSpacing(slices: ReadonlyArray<SliceInfo>): { spacing: number; source: DepthSource } {
  for (const s of slices) {
    const sbs = s.spacingBetweenSlices;
    // NM では符号付き（負は最初の画像の手前へ並ぶ）。間隔の大きさとして使う。
    if (typeof sbs === "number" && Number.isFinite(sbs) && Math.abs(sbs) > 0) return { spacing: Math.abs(sbs), source: "sbs" };
  }
  for (const s of slices) if (pos(s.sliceThickness)) return { spacing: s.sliceThickness, source: "thickness" };
  return { spacing: 1, source: "unknown" };
}

/** 1 つのスタック（同じ series・C/T）の奥行きを決める。 */
export function sliceGeometry(slices: ReadonlyArray<SliceInfo>): SliceGeometry {
  const n = slices.length;
  const firstIop = slices.find((s) => finite6(s.iop))?.iop ?? null;
  const normal = firstIop ? normalOf(firstIop) : null;
  const iopConsistent =
    !!firstIop &&
    slices.every((s) => finite6(s.iop) && Array.from({ length: 6 }, (_, i) => Math.abs(s.iop![i] - firstIop[i])).every((d) => d <= IOP_TOL));
  const allIpp = slices.every((s) => finite3(s.ipp));

  let order: number[];
  let positions: number[];
  let source: DepthSource;
  const fb = fallbackSpacing(slices);
  if (n >= 2 && normal && allIpp) {
    const d = slices.map((s) => s.ipp![0] * normal[0] + s.ipp![1] * normal[1] + s.ipp![2] * normal[2]);
    order = d.map((_, i) => i).sort((a, b) => d[a] - d[b]);
    positions = order.map((i) => d[i]);
    source = "ipp";
  } else {
    // 位置が分からない: 入力の順（InstanceNumber 等で並べた順）を信じ、代わりの間隔で並べる。
    order = slices.map((_, i) => i);
    const base = n && normal && finite3(slices[0].ipp)
      ? slices[0].ipp![0] * normal[0] + slices[0].ipp![1] * normal[1] + slices[0].ipp![2] * normal[2]
      : 0;
    positions = order.map((k) => base + k * fb.spacing);
    source = fb.source;
  }

  const steps: number[] = [];
  for (let i = 1; i < positions.length; i++) steps.push(positions[i] - positions[i - 1]);
  const nominalSpacing = n >= 2 ? (positions[n - 1] - positions[0]) / (n - 1) : fb.spacing;
  const tol = Math.max(POS_TOL_MM, Math.abs(nominalSpacing) * REL_TOL);

  let kind: SliceLayoutKind;
  let maxDeviationMm = 0;
  let missingCount = 0;
  const nonDup = steps.filter((s) => Math.abs(s) > POS_TOL_MM);
  const minSpacing = nonDup.length ? Math.min(...nonDup.map(Math.abs)) : Math.abs(nominalSpacing) || fb.spacing;
  if (n < 2) {
    kind = "single";
  } else if (steps.some((s) => Math.abs(s) <= POS_TOL_MM)) {
    kind = "duplicates";
  } else {
    for (let i = 0; i < n; i++) {
      maxDeviationMm = Math.max(maxDeviationMm, Math.abs(positions[i] - (positions[0] + i * nominalSpacing)));
    }
    if (maxDeviationMm <= tol) {
      kind = "uniform";
    } else {
      const ks = steps.map((s) => s / minSpacing);
      const allInteger = ks.every((k) => Math.abs(k - Math.round(k)) <= MISSING_REL_TOL);
      if (allInteger) {
        kind = "missing";
        missingCount = ks.reduce((a, k) => a + Math.round(k) - 1, 0);
      } else {
        kind = "irregular";
      }
    }
  }

  // スライスごとの幅（体積の計算に使う）。等間隔なら全部が間隔に等しく、合計 = N × 間隔。
  // 端のスライスの外側は「最小の間隔の半分」まで（画像の体積＝補間した格子の端と同じ）。
  // 内側の隣までの距離の半分を外側にも取ると、間隔の広い側の端で ROI が画像からはみ出す（実例: 24 mm 先の隣 → 外へ 12 mm）。
  const widths: number[] = positions.map((_, i) => {
    if (n < 2) return fb.spacing;
    if (i === 0) return Math.abs(positions[1] - positions[0]) / 2 + minSpacing / 2;
    if (i === n - 1) return Math.abs(positions[n - 1] - positions[n - 2]) / 2 + minSpacing / 2;
    return Math.abs(positions[i + 1] - positions[i - 1]) / 2;
  });

  let shearDeg = 0;
  if (n >= 2 && normal && allIpp) {
    const a = slices[order[0]].ipp!, b = slices[order[n - 1]].ipp!;
    const v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(v[0], v[1], v[2]);
    if (l > 0) {
      const c = Math.abs((v[0] * normal[0] + v[1] * normal[1] + v[2] * normal[2]) / l);
      shearDeg = (Math.acos(Math.min(1, c)) * 180) / Math.PI;
    }
  }

  return {
    order,
    positions,
    steps,
    nominalSpacing,
    minSpacing,
    source,
    kind,
    maxDeviationMm,
    missingCount,
    widths,
    shearDeg,
    normal,
    iopConsistent,
  };
}

/**
 * 不均一な並びを取り直す均一な格子（間隔 = 最小の間隔）。
 * gridIndexOf[i] は order の i 番目の元スライスが当たる格子の番号（最寄り）。
 */
export function regularGrid(g: SliceGeometry): { count: number; spacing: number; origin: number; gridIndexOf: number[] } {
  const spacing = g.minSpacing;
  const origin = g.positions[0] ?? 0;
  const span = (g.positions[g.positions.length - 1] ?? origin) - origin;
  const count = Math.max(1, Math.round(span / spacing) + 1);
  const gridIndexOf = g.positions.map((p) => Math.min(count - 1, Math.max(0, Math.round((p - origin) / spacing))));
  return { count, spacing, origin, gridIndexOf };
}
