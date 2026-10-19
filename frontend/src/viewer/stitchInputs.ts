/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * つなぎ合わせダイアログの入出力の組み立て（純関数。DOM も cornerstone も import しない）。
 * 設計: `fw/volume-regrid-design.md`「結合」。
 */
import type { RegVolume } from "./regGeometry";
import type { SuvParams } from "./suv";
import { BLEND_MEAN, type BlendOptions, type StitchGrid, type StitchInput, type StitchPetInfo } from "./volumeStitch";

/** `LoadedRegVolume` のうち結合が使う部分（loader を import しないための構造的な型）。 */
export interface StitchLoaded {
  readonly volume: RegVolume;
  readonly iop: number[];
  readonly modality: string;
}

export function toStitchInput(loaded: StitchLoaded, patientId: string, pet?: StitchPetInfo): StitchInput {
  return {
    volume: loaded.volume,
    iop: loaded.iop,
    modality: loaded.modality,
    patientId,
    pet,
  };
}

/** 減衰補正の基準時刻は `scanTimeMs`（`extractSuvParams` が DecayCorrection=START の基準として解決する値）。 */
export function petInfoFromSuvParams(p: SuvParams): StitchPetInfo {
  return {
    decayCorrection: p.decayCorrection,
    referenceTimeMs: p.scanTimeMs,
    units: p.units,
    halfLifeSec: p.halfLifeSec,
    totalDoseBq: p.totalDoseBq,
  };
}

/** 入力の値を `scale` で割ったコピー（SUV 乗数込みの値をモダリティ値へ戻す）。元は変えない。 */
export function divideInput(input: StitchInput, scale: number): StitchInput {
  if (!(Number.isFinite(scale) && scale > 0)) throw new Error("invalid scale");
  const src = input.volume.data;
  const data = new Float32Array(src.length);
  for (let n = 0; n < data.length; n++) data[n] = src[n] / scale;
  return { ...input, volume: { ...input.volume, data } };
}

/** `stitchSlices` の出力を 1 本の Float32Array（`data[k·nx·ny + j·nx + i]`）にする。枚数が合わなければ例外。 */
export function concatSlices(
  slices: Iterable<Float32Array>,
  grid: Pick<StitchGrid, "dims">,
): Float32Array {
  const [nx, ny, nz] = grid.dims;
  const len = nx * ny;
  const out = new Float32Array(len * nz);
  let k = 0;
  for (const s of slices) {
    if (k >= nz) throw new Error("concatSlices: スライスが格子より多い");
    if (s.length !== len) throw new Error("concatSlices: スライスの大きさが格子と合わない");
    out.set(s, k * len);
    k++;
  }
  if (k !== nz) throw new Error(`concatSlices: スライスが足りない (${k}/${nz})`);
  return out;
}

/** 全入力の有限な値の最小。無ければ 0。 */
export function stitchBackground(inputs: readonly StitchInput[]): number {
  let m = Infinity;
  for (const x of inputs) {
    const d = x.volume.data;
    for (let n = 0; n < d.length; n++) if (d[n] < m) m = d[n]; // NaN は比較が偽で無視される
  }
  return Number.isFinite(m) ? m : 0;
}

export function stitchDerivation(
  seriesUids: readonly string[],
  grid: Pick<StitchGrid, "dims" | "spacing">,
  blend: BlendOptions = BLEND_MEAN,
  /** 入力と同じ順の位置合わせの記述（`describePlacement`）。空文字は動かしていない入力。 */
  placements: readonly string[] = [],
): string {
  const [nx, ny, nz] = grid.dims;
  const [a, b, k] = grid.spacing;
  const how = blend.mode === "linear" ? `linear, range ${((blend.fraction ?? 1) * 100).toFixed(0)}%` : "mean";
  const gains = blend.gains ? `, gains [${blend.gains.map((g) => g.toFixed(3)).join(", ")}]` : "";
  const moved = placements
    .map((d, n) => (d ? `${seriesUids[n]}: ${d}` : ""))
    .filter(Boolean);
  const align = moved.length > 0 ? `, alignment {${moved.join("; ")}}` : "";
  return (
    `Stitched (overlap: ${how}${gains}${align}) from ${seriesUids.length} series [${seriesUids.join(", ")}] ` +
    `to ${nx}x${ny}x${nz}, spacing ${a.toFixed(3)}x${b.toFixed(3)}x${k.toFixed(3)} mm (col x row x slice)`
  );
}
