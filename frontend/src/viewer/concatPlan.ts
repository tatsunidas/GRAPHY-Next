/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 面内の格子が違う連結を、共通の格子へ再サンプルする前の見積もり（純関数。画素は読まない）。
 *
 * <p>連結に渡す各シリーズの幾何（IOP・IPP・間隔・行列数）だけから、{@link unionGrid} と同じ共通格子を作り、
 * 出力の大きさと膨らみ率を返す。読み込む前にメモリを確認し、再サンプルできないシリーズを理由つきで断るために使う。
 */
import { volumeGeometry } from "./regGeometry";
import { positionsMm, type ConcatPart } from "./virtualLayout";
import { unionGrid, type StitchGrid, type StitchInput } from "./volumeStitch";

/** 再サンプルできない理由。 */
export type ResampleRefusal =
  /** 1 本のシリーズの中に、欠けた位置（ブランクで埋められた位置）がある。 */
  | "partGaps"
  /** 1 本のシリーズの中でスライス間隔が不均一（再サンプルの前提の 1 本のボリュームにできない）。 */
  | "irregular"
  /** スライスが 1 枚しかなく、奥行きの向きが決まらない。 */
  | "single";

export interface ConcatPlan {
  grid: StitchGrid;
  /** 出力ボリュームのバイト数（Float32）。 */
  outBytes: number;
  /** 全シリーズを Float32 で読み込んだときの合計バイト数。 */
  inBytes: number;
}

export type ConcatPlanResult = { ok: true; plan: ConcatPlan } | { ok: false; reason: ResampleRefusal; part: number };

/** 隣り合うスライスの間隔が中央値から外れてよい割合（`sliceGeometry` の等間隔の判定と同じ 1%）。 */
const UNIFORM_REL_TOL = 0.01;

/**
 * 1 本のシリーズを、法線方向に昇順に並べたときの先頭の IPP と 1 枚ぶんの移動ベクトルにする。
 * `loadRegVolume` は法線方向の位置で並べ替え、最初の 2 枚の IPP の差を移動ベクトルにするので、それに合わせる。
 */
export function partSpan(
  part: ConcatPart,
): { ok: true; ipp0: [number, number, number]; step: [number, number, number] } | { ok: false; reason: ResampleRefusal } {
  const n = part.layout.nZ;
  const pos = positionsMm(part.layout);
  if (n < 2 || !pos) return { ok: false, reason: "single" };
  const gaps = part.layout.hasImage;
  if (gaps) for (let z = 0; z < n; z++) if (!gaps(0, 0, z)) return { ok: false, reason: "partGaps" };
  const idx = pos.map((_, i) => i).sort((a, b) => pos[a] - pos[b]);
  const steps: number[] = [];
  for (let i = 1; i < idx.length; i++) steps.push(pos[idx[i]] - pos[idx[i - 1]]);
  const med = steps.slice().sort((a, b) => a - b)[Math.floor(steps.length / 2)];
  if (!(med > 0) || steps.some((s) => Math.abs(s - med) > med * UNIFORM_REL_TOL)) return { ok: false, reason: "irregular" };
  const a = part.layout.ippAt?.(idx[0]);
  const b = part.layout.ippAt?.(idx[1]);
  if (!a || !b) return { ok: false, reason: "single" };
  return { ok: true, ipp0: [a[0], a[1], a[2]], step: [b[0] - a[0], b[1] - a[1], b[2] - a[2]] };
}

export function planConcatResample(parts: readonly ConcatPart[]): ConcatPlanResult {
  const inputs: StitchInput[] = [];
  let inBytes = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const span = partSpan(p);
    if (!span.ok) return { ok: false, reason: span.reason, part: i };
    const dims: [number, number, number] = [p.columns, p.rows, p.layout.nZ];
    // 画素は持たない（幾何だけ）。unionGrid は data を読まない。
    inputs.push({
      volume: { data: new Float32Array(0), dims, ...volumeGeometry(p.iop, span.ipp0, p.pixelSpacing[1], p.pixelSpacing[0], span.step) },
      iop: p.iop,
      modality: p.modality,
      patientId: p.patientId,
    });
    inBytes += dims[0] * dims[1] * dims[2] * 4;
  }
  const grid = unionGrid(inputs);
  return { ok: true, plan: { grid, outBytes: grid.voxelCount * 4, inBytes } };
}
