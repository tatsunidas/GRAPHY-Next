/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * つなぎ合わせの自動位置合わせ（隣り合う組の重なり部分で剛体レジストレーション）。純関数のみ。
 * 最適化は既存の `regCore.registerRigid`（Worker では `runRigidInWorker`）をそのまま使う。
 *
 * 全体を渡すと、重なりが小さいとき fixed の標本のほとんどが moving の外に落ちて有効点が 10% を切り、
 * 類似度が 0（無情報）になる。そこで、互いの法線方向の範囲に余白を足した範囲へ切り出してから渡す。
 */
import { sampleWorld } from "./regGeometry";
import { ncc } from "./regMetrics";
import { mat4InvertAffine } from "./regTransform";
import type { RigidRequest } from "./regProtocol";
import { toPayload } from "./regWorkerClient";
import {
  MipAccumulator,
  normalOfIop,
  previewSpacing,
  stitchSlices,
  unionGrid,
  type MipImages,
  type StitchInput,
} from "./volumeStitch";

/** 切り出しに足す余白（法線方向、スライス間隔の何倍か）。探索する平行移動の分を含める。 */
export const MARGIN_SLICES = 3;

/** 入力のスライス中心の法線方向位置（k ごと）。 */
function sliceWs(input: StitchInput, n: readonly number[]): number[] {
  const m = input.volume.indexToWorld;
  const nz = input.volume.dims[2];
  const [nx, ny] = input.volume.dims;
  const ci = (nx - 1) / 2, cj = (ny - 1) / 2;
  const out: number[] = [];
  for (let k = 0; k < nz; k++) {
    const x = m[0] * ci + m[1] * cj + m[2] * k + m[3];
    const y = m[4] * ci + m[5] * cj + m[6] * k + m[7];
    const z = m[8] * ci + m[9] * cj + m[10] * k + m[11];
    out.push(n[0] * x + n[1] * y + n[2] * z);
  }
  return out;
}

/** 法線方向の位置が [lo, hi] に入るスライスだけを切り出した入力（データはコピー）。無ければ null。 */
export function cropToNormalRange(input: StitchInput, n: readonly number[], lo: number, hi: number): StitchInput | null {
  const ws = sliceWs(input, n);
  let k0 = -1, k1 = -1;
  ws.forEach((w, k) => {
    if (w >= lo && w <= hi) { if (k0 < 0) k0 = k; k1 = k; }
  });
  if (k0 < 0) return null;
  const v = input.volume;
  const [nx, ny] = v.dims;
  const i2w = Float64Array.from(v.indexToWorld);
  i2w[3] += v.indexToWorld[2] * k0;
  i2w[7] += v.indexToWorld[6] * k0;
  i2w[11] += v.indexToWorld[10] * k0;
  const w2i = mat4InvertAffine(i2w);
  if (!w2i) return null;
  const data = v.data.slice(k0 * nx * ny, (k1 + 1) * nx * ny);
  return { ...input, volume: { ...v, data, dims: [nx, ny, k1 - k0 + 1], indexToWorld: i2w, worldToIndex: w2i } };
}

/** 2 本の重なり部分（互いの法線方向の範囲に余白を足したもの）を切り出す。重なりが無ければ null。 */
export function overlapCrops(a: StitchInput, b: StitchInput): { a: StitchInput; b: StitchInput } | null {
  const n = normalOfIop(a.iop);
  const wa = sliceWs(a, n), wb = sliceWs(b, n);
  const lo = Math.max(Math.min(...wa), Math.min(...wb));
  const hi = Math.min(Math.max(...wa), Math.max(...wb));
  if (!(hi >= lo)) return null;
  const mg = MARGIN_SLICES * Math.max(a.volume.spacing[2], b.volume.spacing[2]);
  const ca = cropToNormalRange(a, n, lo - mg, hi + mg);
  const cb = cropToNormalRange(b, n, lo - mg, hi + mg);
  return ca && cb ? { a: ca, b: cb } : null;
}

/** 2 本の重なりで標本にできる最少の点数。これより少ない比較は「判定できない」とする。 */
export const MIN_OVERLAP_SAMPLES = 200;

/**
 * 重なり部分の正規化相互相関（NCC）。a の格子点を間引いて取り、b を world で引く（b の範囲外は捨てる）。
 * 点が `MIN_OVERLAP_SAMPLES` に満たなければ null。
 */
export function overlapNcc(a: StitchInput, b: StitchInput, maxSamples = 30000): { ncc: number; count: number } | null {
  const [nx, ny, nz] = a.volume.dims;
  const total = nx * ny * nz;
  const stride = Math.max(1, Math.floor(total / maxSamples));
  const m = a.volume.indexToWorld;
  const f = new Float64Array(Math.ceil(total / stride));
  const g = new Float64Array(f.length);
  let c = 0;
  for (let idx = 0; idx < total; idx += stride) {
    const k = Math.floor(idx / (nx * ny));
    const r = idx - k * nx * ny;
    const j = Math.floor(r / nx);
    const i = r - j * nx;
    const v = sampleWorld(
      b.volume,
      m[0] * i + m[1] * j + m[2] * k + m[3],
      m[4] * i + m[5] * j + m[6] * k + m[7],
      m[8] * i + m[9] * j + m[10] * k + m[11],
    );
    if (!Number.isFinite(v)) continue;
    f[c] = a.volume.data[idx];
    g[c] = v;
    c++;
  }
  if (c < MIN_OVERLAP_SAMPLES) return null;
  return { ncc: ncc({ fixed: f, moving: g, count: c, patchSize: 1 }), count: c };
}

/** 探索範囲の上限。Frame of Reference が同じなら狭く（ツールチップの説明と同じ値）。 */
export const ALIGN_LIMITS = {
  sameFrame: { translationMm: 30, rotationDeg: 10 },
  otherFrame: { translationMm: 200, rotationDeg: 45 },
} as const;

export type AlignScope = "translation" | "rigid";

export interface AlignOptions {
  scope: AlignScope;
  /** 2 本の Frame of Reference が同じか（同じなら探索範囲を狭くする）。 */
  sameFrameOfReference: boolean;
}

/** `registerRigid` / Worker に渡す要求（切り出した 2 本から作る）。 */
export function buildAlignRequest(
  fixed: StitchInput,
  moving: StitchInput,
  opts: AlignOptions,
): Omit<RigidRequest, "type" | "requestId"> {
  const step = (x: StitchInput): [number, number, number] => {
    const m = x.volume.indexToWorld;
    return [m[2], m[6], m[10]];
  };
  const base = opts.sameFrameOfReference ? ALIGN_LIMITS.sameFrame : ALIGN_LIMITS.otherFrame;
  return {
    fixed: toPayload(fixed.volume, fixed.iop, step(fixed)),
    moving: toPayload(moving.volume, moving.iop, step(moving)),
    // つなぐのは同じモダリティどうしなので NCC
    metric: "ncc",
    sameModality: true,
    sameFrameOfReference: opts.sameFrameOfReference,
    limits: opts.scope === "translation" ? { translationMm: base.translationMm, rotationDeg: 0 } : base,
  };
}

/** 結果（fixed world → moving world の 4×4）から、moving を動かす world 上の移動（その逆）を返す。 */
export function moveFromRegistration(matrix: ArrayLike<number>): Float64Array | null {
  return mat4InvertAffine(Float64Array.from(matrix));
}

/** 適用に必要な NCC の改善幅（絶対値）。 */
export const MIN_NCC_GAIN = 0.01;
/** 無相関どうしの NCC の標準偏差は 1/√N。最適化は雑音にも合わせにいくので、その 5 倍を超えるまでは「合った」とみなさない。 */
export const NULL_SIGMAS = 5;

/**
 * 適用の判定: 重なり部分の NCC が上がり、かつ雑音の揺らぎ（`NULL_SIGMAS`/√標本数）を超えたときだけ採る。
 * 無関係な内容に最適化をかけても数 % の相関は出るため、改善だけでは合ったと言えない。
 */
export function accepted(before: number, after: number, count: number): boolean {
  if (!Number.isFinite(before) || !Number.isFinite(after) || !(count > 0)) return false;
  return after >= before + MIN_NCC_GAIN && after > NULL_SIGMAS / Math.sqrt(count);
}

export interface PairOverlay {
  /** a・b それぞれの MIP（重なりの範囲のスライスだけ）。同じ格子。 */
  a: MipImages;
  b: MipImages;
  spacing: [number, number, number];
}

/**
 * ずれの確認用: 2 本の重なり部分だけを、同じ粗い格子へ別々に引いて MIP にする。
 * 重なりが無ければ null。a の軸が格子の軸。
 */
export async function pairOverlay(
  a: StitchInput,
  b: StitchInput,
  maxPx: number,
  axisRef: 0 | 1,
  isCurrent: () => boolean,
  yieldNow: () => Promise<void>,
): Promise<PairOverlay | null> {
  const n = normalOfIop(a.iop);
  const wa = sliceWs(a, n), wb = sliceWs(b, n);
  const ha = a.volume.spacing[2] / 2, hb = b.volume.spacing[2] / 2;
  const lo = Math.max(Math.min(...wa) - ha, Math.min(...wb) - hb);
  const hi = Math.min(Math.max(...wa) + ha, Math.max(...wb) + hb);
  if (!(hi > lo)) return null;
  const g = unionGrid([a, b], undefined, axisRef);
  const pg = unionGrid([a, b], previewSpacing(g, maxPx), axisRef);
  const m = pg.indexToWorld;
  const accA = new MipAccumulator(pg.dims);
  const accB = new MipAccumulator(pg.dims);
  const sa = stitchSlices([a], pg, { mode: "mean" });
  const sb = stitchSlices([b], pg, { mode: "mean" });
  for (let k = 0; k < pg.dims[2]; k++) {
    const x = sa.next().value as Float32Array;
    const y = sb.next().value as Float32Array;
    const w = n[0] * m[2] * k + n[1] * m[6] * k + n[2] * m[10] * k +
      (n[0] * m[3] + n[1] * m[7] + n[2] * m[11]);
    if (w >= lo && w <= hi) { accA.add(k, x); accB.add(k, y); }
    if (k % 2 === 1) {
      await yieldNow();
      if (!isCurrent()) return null;
    }
  }
  return { a: accA.result(), b: accB.result(), spacing: pg.spacing };
}
