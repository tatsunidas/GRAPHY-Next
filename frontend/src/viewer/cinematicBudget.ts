/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// シネマティック（パストレース）の 3D テクスチャの大きさを、GPU の予算から決める純関数群。DOM・WebGL に触らない。
//
// - `planCinematicGrid`: 予算（テクセル数）と 3D テクスチャの上限から、間引き後の格子（mm で決める）を返す。
// - `gpuBudget`: 予算（バイト）を、分かる量だけから作る。GPU のメモリ量はブラウザ・Electron から取れないので、
//   分からないときは「不明」とし、推測の値で埋めない（`fw/render-environment-design.md`）。
// - `resampleSlabs`: 箱平均の間引き（覆う元のボクセルの面積加重平均）。最近傍は細い構造が位置で消える・残るため使わない。
//
// 座標は元ボリュームの箱（端から端）を保つ。間引いても箱は動かないので、world→tex の式（端から端）はそのまま使える。

export type Vec3 = [number, number, number];

/** R16F（半精度）の 1 テクセルのバイト数。 */
export const TEXEL_BYTES = 2;
const MIB = 1024 * 1024;

export type GridReason = "full" | "budget" | "max3d";

export interface GridPlan {
  dims: Vec3;
  /** 間引き後の 1 テクセルの間隔 mm（箱の長さ ÷ 寸法。元の箱と同じ長さを保つ）。 */
  spacingMm: Vec3;
  /** 共通の目標間隔 Δ*（mm）。間引かなかったときは元の最小間隔。 */
  targetMm: number;
  reason: GridReason;
  texels: number;
  bytes: number;
}

const safeSpacing = (s: number): number => (Number.isFinite(s) && s > 0 ? s : 1);

/**
 * 予算に収まる格子を決める。
 * 共通の目標間隔 Δ* を二分探索で求め（Π ceil(n_i·s_i / max(s_i, Δ*)) ≤ 予算のテクセル数 となる最小の Δ*）、
 * **元が Δ* より粗い軸は触らない**（細かい軸から削る）。各軸は 3D テクスチャの上限 max3d も超えない。
 * @param budgetTexels null なら予算なし（max3d だけ守る）
 */
export function planCinematicGrid(a: {
  dims: Vec3;
  spacingMm: Vec3;
  budgetTexels: number | null;
  max3d: number | null;
}): GridPlan {
  const n = a.dims.map((d) => Math.max(1, Math.floor(d))) as Vec3;
  const s = a.spacingMm.map(safeSpacing) as Vec3;
  const cap = a.max3d !== null && a.max3d > 0 ? Math.floor(a.max3d) : Number.POSITIVE_INFINITY;
  const clamped = n.map((d) => Math.min(d, cap)) as Vec3;
  const maxClamped = clamped.some((d, i) => d < n[i]);
  const dimsAt = (delta: number): Vec3 =>
    n.map((ni, i) => Math.max(1, Math.min(clamped[i], Math.ceil((ni * s[i]) / Math.max(s[i], delta) - 1e-9)))) as Vec3;
  const prod = (d: Vec3) => d[0] * d[1] * d[2];
  const sMin = Math.min(...s);
  let dims = dimsAt(sMin);
  let target = sMin;
  let reason: GridReason = maxClamped ? "max3d" : "full";
  const nMax = a.budgetTexels === null ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(a.budgetTexels));
  if (prod(dims) > nMax) {
    reason = "budget";
    let lo = sMin;
    let hi = Math.max(...n.map((ni, i) => ni * s[i])); // これ以上粗くすると全軸 1
    for (let it = 0; it < 80; it++) {
      const mid = (lo + hi) / 2;
      if (prod(dimsAt(mid)) <= nMax) hi = mid;
      else lo = mid;
    }
    target = hi;
    dims = dimsAt(hi);
  }
  const spacingMm = n.map((ni, i) => (ni * s[i]) / dims[i]) as Vec3;
  const texels = prod(dims);
  return { dims, spacingMm, targetMm: target, reason, texels, bytes: texels * TEXEL_BYTES };
}

export type BudgetSource = "user" | "shared" | "record" | "unknown";

export interface GpuRecord {
  /** 描けた最大のテクスチャのバイト数。 */
  okMaxBytes?: number;
  /** 失敗した最小のテクスチャのバイト数。 */
  failMinBytes?: number;
}

export interface GpuBudget {
  /** テクスチャに使ってよいバイト数。null＝予算なし（不明）。 */
  textureBytes: number | null;
  source: BudgetSource;
}

/**
 * テクスチャの予算（バイト）。上から順に最初に決まったものを使う:
 *  1. `user`: 設定の GPU メモリ（MB）− vtk が持つ分 − パストレーサの内部バッファ。本人が知っている値。
 *  2. `shared`: 内蔵 GPU（テクスチャはシステムメモリに載る）。本体のボリューム構築の上限から、元ボリュームのコピー群を引いた残り。
 *  3. `unknown`: 予算なし（元の解像度で試す。失敗したら記録して次から下げる）。
 * 失敗の記録（この GPU で失敗した量）があれば、どの出どころでもその量未満に抑える。
 */
export function gpuBudget(a: {
  userMb: number | null;
  shared: boolean;
  /** 本体のボリューム構築の上限（バイト）。`shared` のときだけ使う。 */
  appliedVolumeMaxBytes: number | null;
  /** 元ボリュームのスカラー配列のバイト数。 */
  srcBytes: number;
  /** 元ボリュームが同時に生きるコピーの数（vtk 用・cornerstone・image キャッシュなど）。 */
  srcCopies: number;
  /** vtk が GPU に持つ 3D テクスチャの見積もり（バイト）。 */
  vtkBytes: number;
  /** パストレーサの内部バッファ（RGBA32F の ping-pong など）。 */
  internalBytes: number;
  record?: GpuRecord | null;
}): GpuBudget {
  let bytes: number | null = null;
  let source: BudgetSource = "unknown";
  if (a.userMb !== null && Number.isFinite(a.userMb) && a.userMb > 0) {
    bytes = Math.max(0, a.userMb * MIB - a.vtkBytes - a.internalBytes);
    source = "user";
  } else if (a.shared && a.appliedVolumeMaxBytes !== null && a.appliedVolumeMaxBytes > 0) {
    bytes = Math.max(0, a.appliedVolumeMaxBytes - a.srcBytes * a.srcCopies - a.internalBytes);
    source = "shared";
  }
  const rec = a.record;
  if (rec && rec.failMinBytes !== undefined && rec.failMinBytes > 0) {
    const ok = rec.okMaxBytes !== undefined && rec.okMaxBytes > 0 && rec.okMaxBytes < rec.failMinBytes ? rec.okMaxBytes : null;
    const cap = ok ?? Math.floor(rec.failMinBytes / 2);
    if (bytes === null) {
      bytes = cap;
      source = "record";
    } else if (cap < bytes) {
      bytes = cap;
    }
  }
  return { textureBytes: bytes, source };
}

/** 内蔵 GPU（システムメモリを使う）か。ANGLE の描画名で見る（`ANGLE (Intel, …)`・`Apple M…`）。Arc は専用メモリを持つので除く。 */
export function isSharedMemoryGpu(rendererName: string | null | undefined): boolean {
  if (!rendererName) return false;
  if (/\bArc\b/i.test(rendererName)) return false;
  return /\b(Intel|Apple)\b/i.test(rendererName);
}

// ── 半精度（R16F）の丸め ──────────────────────────────────────────────────────

/** 値を半精度（IEEE binary16）に丸めた値（最近接偶数）。[0, 65504] の範囲だけを扱う（テクスチャは [0,1] に正規化済み）。 */
export function halfRound(v: number): number {
  if (!(v > 0)) return 0;
  const e = Math.floor(Math.log2(v));
  if (e < -14) {
    const q = 2 ** -24; // 非正規数の刻み
    return Math.round(v / q) * q;
  }
  const q = 2 ** (e - 10);
  const r = v / q;
  const f = Math.floor(r);
  const diff = r - f;
  const even = diff === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(r);
  return even * q;
}

/** 値 v の半精度の刻み（ulp）。丸め誤差の上限は ulp/2。 */
export function halfUlp(v: number): number {
  if (!(v > 0)) return 2 ** -24;
  const e = Math.floor(Math.log2(v));
  return e < -14 ? 2 ** -24 : 2 ** (e - 10);
}

// ── 箱平均の間引き ───────────────────────────────────────────────────────────

/** 1 軸の重み: 目標セル j は、元の n 個のセルのうち [start[j], start[j]+weights[j].length) を重み（合計 1）で平均する。 */
export function axisWeights(n: number, t: number): { start: number[]; weights: number[][] } {
  const start: number[] = [];
  const weights: number[][] = [];
  const ratio = n / t;
  for (let j = 0; j < t; j++) {
    const lo = j * ratio;
    const hi = (j + 1) * ratio;
    const k0 = Math.floor(lo + 1e-9);
    const k1 = Math.min(n, Math.ceil(hi - 1e-9));
    const w: number[] = [];
    for (let k = k0; k < k1; k++) w.push(Math.max(0, Math.min(k + 1, hi) - Math.max(k, lo)) / ratio);
    const sum = w.reduce((x, y) => x + y, 0) || 1;
    start.push(k0);
    weights.push(w.map((x) => x / sum));
  }
  return { start, weights };
}

/**
 * [z][y][x]（x が最速）の元ボリュームを、箱平均で {@link tdims} に間引き、z の板（tx×ty の Float32Array）ごとに {@link emit} へ渡す。
 * 値は (v − dmin) / span に正規化する。寸法が同じ軸は 1 対 1。一時配列は 1 スライス＋板 1 枚の大きさだけ。
 * {@link emit} が渡す配列は次の呼び出しで使い回される（コピーせずに GPU へ上げてよい）。
 */
export function resampleSlabs(
  data: ArrayLike<number>,
  dims: Vec3,
  tdims: Vec3,
  dmin: number,
  span: number,
  emit: (z: number, slab: Float32Array) => void,
): void {
  const [nx, ny, nz] = dims;
  const [tx, ty, tz] = tdims;
  const wx = axisWeights(nx, tx);
  const wy = axisWeights(ny, ty);
  const wz = axisWeights(nz, tz);
  const inv = 1 / (span || 1);
  const identityXY = tx === nx && ty === ny;
  const rowTmp = new Float32Array(ny * tx);
  const reducedCache = new Map<number, Float32Array>();
  const reduce = (k: number): Float32Array => {
    const hit = reducedCache.get(k);
    if (hit) return hit;
    const out = new Float32Array(tx * ty);
    const base = k * nx * ny;
    if (identityXY) {
      for (let i = 0; i < nx * ny; i++) out[i] = (data[base + i] - dmin) * inv;
    } else {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < tx; x++) {
          const w = wx.weights[x];
          const s0 = wx.start[x];
          let acc = 0;
          for (let q = 0; q < w.length; q++) acc += w[q] * ((data[base + y * nx + s0 + q] - dmin) * inv);
          rowTmp[y * tx + x] = acc;
        }
      }
      for (let y = 0; y < ty; y++) {
        const w = wy.weights[y];
        const s0 = wy.start[y];
        for (let x = 0; x < tx; x++) {
          let acc = 0;
          for (let q = 0; q < w.length; q++) acc += w[q] * rowTmp[(s0 + q) * tx + x];
          out[y * tx + x] = acc;
        }
      }
    }
    reducedCache.set(k, out);
    return out;
  };
  const slab = new Float32Array(tx * ty);
  for (let z = 0; z < tz; z++) {
    const w = wz.weights[z];
    const s0 = wz.start[z];
    slab.fill(0);
    for (let q = 0; q < w.length; q++) {
      const r = reduce(s0 + q);
      const wq = w[q];
      for (let i = 0; i < slab.length; i++) slab[i] += wq * r[i];
    }
    emit(z, slab);
    // 次の板で使わない元スライスのキャッシュを捨てる（メモリを 1〜2 枚に抑える）
    const nextStart = z + 1 < tz ? wz.start[z + 1] : Infinity;
    for (const key of Array.from(reducedCache.keys())) if (key < nextStart) reducedCache.delete(key);
  }
}

// ── GPU ごとの失敗の記録（描けた最大・失敗した最小。この PC のこの GPU で学習する）────────────────

export type GpuRecords = Record<string, GpuRecord>;

/** 保存した JSON を読む。壊れていれば空（落とさない）。 */
export function parseGpuRecords(json: string | null | undefined): GpuRecords {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as unknown;
    if (!o || typeof o !== "object") return {};
    const out: GpuRecords = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const r = v as Record<string, unknown>;
      const rec: GpuRecord = {};
      if (typeof r.okMaxBytes === "number" && r.okMaxBytes > 0) rec.okMaxBytes = r.okMaxBytes;
      if (typeof r.failMinBytes === "number" && r.failMinBytes > 0) rec.failMinBytes = r.failMinBytes;
      if (rec.okMaxBytes !== undefined || rec.failMinBytes !== undefined) out[k] = rec;
    }
    return out;
  } catch {
    return {};
  }
}

/** 記録を更新した新しい表を返す（描けた最大は大きいほう、失敗した最小は小さいほうを残す）。 */
export function updateGpuRecord(
  records: GpuRecords,
  gpuName: string,
  event: { ok?: number; fail?: number },
): GpuRecords {
  const cur = records[gpuName] ?? {};
  const next: GpuRecord = { ...cur };
  if (event.ok !== undefined && event.ok > 0) next.okMaxBytes = Math.max(cur.okMaxBytes ?? 0, event.ok);
  if (event.fail !== undefined && event.fail > 0) next.failMinBytes = Math.min(cur.failMinBytes ?? Infinity, event.fail);
  return { ...records, [gpuName]: next };
}
