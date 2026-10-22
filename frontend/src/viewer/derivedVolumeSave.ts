/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 任意格子のボリュームを派生シリーズとして保存する薄い層（設計: `fw/volume-regrid-design.md` §4）。
 *
 * <p>要求の組み立て（{@link buildDerivedVolumeRequest}）は純関数で、単体テストできる。
 * POST と通知だけが {@link saveDerivedVolume}。
 */
import { httpSend } from "../http";
import { emitDbChanged } from "../dbEvents";
import { encodeFrames, framePixelsBase64 } from "./derivedSeriesEncode";
import type { Grid } from "./gridResample";

export interface DerivedVolumeInput {
  readonly grid: Grid;
  /** `data[k·ny·nx + j·nx + i]`。範囲外は NaN。 */
  readonly data: Float32Array;
  readonly studyUid: string;
  readonly seriesUid: string;
  readonly seriesDescription: string;
  readonly derivationDescription: string;
  /** 元の SliceThickness。無ければ出力のスライス間隔。 */
  readonly sourceSliceThickness?: number | null;
  /**
   * SUV 校正中の乗数（SUV = modalityValue × scale）。`data` が SUV 乗数込みのときに渡す。
   * 保存前にこれで割ってモダリティ値へ戻す（Units と値の食い違い・二重 SUV 化を防ぐ）。
   */
  readonly suvScale?: number | null;
  /**
   * 指定すると Parametric Map（Modality=OT・Float32・量子化なし）として保存する。
   * 元のモダリティで解釈できない量（HU×SUV など）に使う。NaN は NaN のまま保存し、`suvScale` は使わない
   * （値は `data` のまま実際の量）。
   */
  readonly parametricMap?: {
    readonly label: string;
    readonly explanation: string;
    readonly unitCode: string;
    readonly unitMeaning: string;
  } | null;
  /** NaN を埋める値（`data` と同じ単位）。**呼び出し側が必ず明示する**（Parametric Map では使わない）。 */
  readonly background: number;
}

export interface DerivedVolumeRequest {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  seriesDescription: string;
  seriesNumber: null;
  rows: number;
  columns: number;
  pixelSpacing: [number, number];
  sliceThickness: number;
  spacingBetweenSlices: number;
  imageOrientationPatient: number[];
  derivationDescription: string;
  rescaleSlope: number;
  rescaleIntercept: number;
  pixelPaddingValue: number | null;
  parametricMap: { label: string; explanation: string; unitCode: string; unitMeaning: string } | null;
  frames: Array<{ instanceNumber: number; imagePositionPatient: number[]; pixels: string }>;
}

/** Float32Array → Base64（リトルエンディアンを明示）。backend の Parametric Map `Frame.pixels` 形式。 */
export function floatFramePixelsBase64(values: Float32Array): string {
  const bytes = new Uint8Array(values.length * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) dv.setFloat32(i * 4, values[i], true);
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** 格子と値から `/api/series/derived` の要求本体を組む。 */
export function buildDerivedVolumeRequest(input: DerivedVolumeInput): DerivedVolumeRequest {
  const { grid } = input;
  const [nx, ny, nz] = grid.dims;
  if (input.data.length !== nx * ny * nz) throw new Error("data length does not match grid dims");
  if (!input.parametricMap && !Number.isFinite(input.background)) throw new Error("background must be explicit and finite");
  const m = grid.indexToWorld;
  const [sc, sr, sk] = grid.spacing;
  const pm = input.parametricMap ?? null;

  let data = input.data;
  let background = input.background;
  const suv = input.suvScale;
  if (suv != null && !pm) {
    if (!(Number.isFinite(suv) && suv > 0)) throw new Error("invalid SUV scale");
    data = new Float32Array(input.data.length);
    for (let n = 0; n < data.length; n++) data[n] = input.data[n] / suv;
    background = input.background / suv;
  }

  const sliceLen = nx * ny;
  const slices: Float32Array[] = [];
  for (let k = 0; k < nz; k++) slices.push(data.subarray(k * sliceLen, (k + 1) * sliceLen));
  const encoded = pm ? null : encodeFrames(slices, background);

  const frames = slices.map((slice, k) => ({
    instanceNumber: k + 1,
    imagePositionPatient: [m[2] * k + m[3], m[6] * k + m[7], m[10] * k + m[11]],
    pixels: encoded ? framePixelsBase64(encoded.frames[k]) : floatFramePixelsBase64(slice),
  }));

  return {
    studyInstanceUid: input.studyUid,
    seriesInstanceUid: input.seriesUid,
    seriesDescription: input.seriesDescription,
    seriesNumber: null,
    rows: ny,
    columns: nx,
    // DICOM の PixelSpacing = [行間隔(行方向に進む=隣の行までの距離), 列間隔]
    pixelSpacing: [sr, sc],
    sliceThickness: input.sourceSliceThickness && input.sourceSliceThickness > 0 ? input.sourceSliceThickness : sk,
    spacingBetweenSlices: sk,
    // IOP = [列が進む向き(行方向余弦), 行が進む向き(列方向余弦)]
    imageOrientationPatient: [m[0] / sc, m[4] / sc, m[8] / sc, m[1] / sr, m[5] / sr, m[9] / sr],
    derivationDescription: input.derivationDescription,
    // Parametric Map は値がそのまま実際の量（Rescale・PixelPadding は使わない）。
    rescaleSlope: encoded ? encoded.slope : 1,
    rescaleIntercept: encoded ? encoded.intercept : 0,
    pixelPaddingValue: encoded ? encoded.paddingStored : null,
    parametricMap: pm,
    frames,
  };
}

/** 要求を POST し、成功したら一覧へ通知する。 */
export async function saveDerivedVolume(input: DerivedVolumeInput): Promise<{ seriesInstanceUid: string; count: number }> {
  const body = buildDerivedVolumeRequest(input);
  const res = await httpSend<{ seriesInstanceUid: string; sopInstanceUids: string[] }>(
    "/api/series/derived",
    "POST",
    body,
  );
  emitDbChanged({ reason: "series-create", studyUids: [input.studyUid] });
  return { seriesInstanceUid: res.seriesInstanceUid, count: res.sopInstanceUids.length };
}
