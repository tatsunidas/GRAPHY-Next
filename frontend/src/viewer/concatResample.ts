/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 面内の格子が違う連結を、共通の格子へ再サンプルして 1 本のメモリ内ボリュームにする（MPR・3D・Slicer 用）。
 *
 * <p>各シリーズを {@link loadRegVolume}（モダリティ値に換算済みの Float32）で読み、{@link unionGrid} の共通格子へ
 * 三線形で引き直す。重なりは 2D の連結と同じく中点で切って片方のシリーズだけを採る（`midpoint`）。どのシリーズも
 * 覆わない点（小さい視野の外・余白）は、全入力の最小値で埋める（スティッチ保存の既定と同じ。NaN は残さない）。
 * DB・ファイルは変えない。
 */
import { volumeLoader } from "@cornerstonejs/core";
import { fetchInstances, type Series, type Study } from "../api";
import type { TFn } from "../i18n/i18n";
import type { ViewerMode } from "./imageId";
import { buildCorrectedMetadata, type BuildVolumeResult } from "./mpr";
import { loadRegVolume } from "./regVolumeLoader";
import { sliceGeometry } from "./sliceGeometry";
import type { ConcatPlan } from "./concatPlan";
import type { ConcatPart } from "./virtualLayout";
import { stitchBackground } from "./stitchInputs";
import { getAppliedVolumeMaxMb } from "./volumeMemory";
import { stitchSlices, unionGrid, type StitchInput } from "./volumeStitch";

/** 再サンプルを続けられない理由。読み込めなかった・枚数が合わない・共通格子が見積もりと違う。 */
export class ConcatResampleError extends Error {
  constructor(readonly reason: "loadFailed" | "missingSlices" | "gridMismatch", message: string) {
    super(message);
    this.name = "ConcatResampleError";
  }
}

export interface BuildConcatResampledArgs {
  mode: ViewerMode;
  /** `parts` と同じ順の元のシリーズ。 */
  sources: ReadonlyArray<{ study: Study; series: Series }>;
  parts: readonly ConcatPart[];
  plan: ConcatPlan;
  volumeId: string;
  /** 読み込み・再サンプルの進み具合（0〜1）。 */
  onProgress?: (fraction: number) => void;
}

/** 画面を固めないため、何枚かごとに制御を返す。 */
const YIELD_EVERY = 8;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function buildConcatResampledVolume(a: BuildConcatResampledArgs): Promise<BuildVolumeResult> {
  const n = a.parts.length;
  const inputs: StitchInput[] = [];
  let firstImageId: string | null = null;
  for (let p = 0; p < n; p++) {
    const { study, series } = a.sources[p];
    const instances = await fetchInstances(study.studyInstanceUid, series.seriesInstanceUid);
    const loaded = await loadRegVolume(
      a.mode, study.studyInstanceUid, series.seriesInstanceUid, instances, 0, 0,
      (done, total) => a.onProgress?.((p + done / total) / n * 0.5),
    );
    if (!loaded) throw new ConcatResampleError("loadFailed", `part ${p}: not loadable`);
    // loadRegVolume は読めなかった枚数を黙って飛ばす。期待枚数と合わなければ、間隔の狂った体積を作らず止める。
    if (loaded.slices.length !== a.parts[p].layout.nZ) {
      throw new ConcatResampleError("missingSlices", `part ${p}: ${loaded.slices.length}/${a.parts[p].layout.nZ}`);
    }
    if (p === 0) firstImageId = loaded.firstImageId;
    inputs.push({ volume: loaded.volume, iop: a.parts[p].iop, modality: a.parts[p].modality, patientId: a.parts[p].patientId });
  }

  const grid = unionGrid(inputs);
  if (grid.dims.some((d, i) => d !== a.plan.grid.dims[i])) {
    throw new ConcatResampleError("gridMismatch", `grid ${grid.dims.join("x")} vs plan ${a.plan.grid.dims.join("x")}`);
  }
  const bg = stitchBackground(inputs);
  const [nx, ny, nz] = grid.dims;
  const len = nx * ny;
  const data = new Float32Array(len * nz);
  let k = 0;
  for (const slice of stitchSlices(inputs, grid, { mode: "midpoint" })) {
    for (let i = 0; i < len; i++) {
      const v = slice[i];
      data[k * len + i] = Number.isNaN(v) ? bg : v;
    }
    k++;
    a.onProgress?.(0.5 + (k / nz) * 0.5);
    if (k % YIELD_EVERY === 0) await tick();
  }

  const m = grid.indexToWorld;
  const s = grid.spacing;
  // 列 0..2 は (行方向 × 列間隔, 列方向 × 行間隔, 法線 × スライス間隔)。単位ベクトルに戻す。
  const rc = [m[0] / s[0], m[4] / s[0], m[8] / s[0]];
  const rr = [m[1] / s[1], m[5] / s[1], m[9] / s[1]];
  const nrm = [m[2] / s[2], m[6] / s[2], m[10] / s[2]];
  const md = buildCorrectedMetadata(firstImageId ?? "", s, nx, ny);
  md.BitsAllocated = 32;
  md.BitsStored = 32;
  md.HighBit = 31;
  md.ImageOrientationPatient = [...rc, ...rr];
  const modality = a.parts[0].modality;
  if (modality.toUpperCase() !== "CT") {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < data.length; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi > lo) md.voiLut = [{ windowWidth: hi - lo, windowCenter: (hi + lo) / 2 }];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (volumeLoader.createLocalVolume as any)(a.volumeId, {
    metadata: md,
    dimensions: [nx, ny, nz],
    spacing: [s[0], s[1], s[2]],
    origin: [m[3], m[7], m[11]],
    direction: [...rc, ...rr, ...nrm],
    scalarData: data,
  });

  const geometry = sliceGeometry(
    Array.from({ length: nz }, (_, kk) => ({
      id: `${a.volumeId}:${kk}`,
      ipp: [m[3] + kk * m[2], m[7] + kk * m[6], m[11] + kk * m[10]],
      iop: [...rc, ...rr],
    })),
  );
  return { volumeId: a.volumeId, corrected: false, geometry };
}

const MB = 1024 * 1024;

/**
 * 出力と入力を合わせたメモリが上限を超えるなら、続けるかを確認する（スティッチ保存と同じ見積もりと文言）。
 * 超えなければ確認せず true。
 */
export function confirmConcatResampleMemory(plan: ConcatPlan, t: TFn): boolean {
  const totalMb = Math.round((plan.outBytes + plan.inBytes) / MB);
  const limitMb = getAppliedVolumeMaxMb();
  return totalMb <= limitMb || window.confirm(t("stitch.confirmMemory", { mb: totalMb, limit: limitMb }));
}

/** 再サンプルが続けられなかった理由を利用者向けの文言にする。 */
export function concatResampleErrorMessage(e: ConcatResampleError, t: TFn): string {
  return t(`series.concat.fail.resampleRun.${e.reason}`);
}
