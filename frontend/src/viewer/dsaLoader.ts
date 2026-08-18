/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DSA の合成画像を StackViewport へ供給するカスタムローダ（`fw/angio-design.md` §6.1）。
 *
 * <p>`graphy-thickslab:` と**同じ型**。差分そのものは {@link ./dsa} の純関数が計算し、
 * ここは「セッション管理」「Cornerstone への注入」「メタデータの委譲」だけを担う。
 *
 * <h3>メタデータの扱い</h3>
 * ネイティブフレームへ委譲するが、**`modalityLutModule` は恒等**にする。差分は既に
 * モダリティ値空間で完結しているので、GPU 側で Rescale を再適用させない
 * （ThickSlab と同じ罠。[[pixel-calibration-single-entry]]）。
 * `voiLutModule` はセッション作成時に差分のヒストグラムから決めた値を返す — 差分は 0 を
 * 中心とする符号付きなので、元画像の VOI（例 WC 2048 / WW 4096）をそのまま使うと真っ黒になる。
 */
import { metaData, registerImageLoader, utilities as csUtils } from "@cornerstonejs/core";
import { readModalitySlice } from "./pixelCalibration";
import {
  averageFrames,
  backgroundRms,
  contrastDropSignal,
  estimateShift,
  needsLogTransform,
  pickMaskFrames,
  subtractFrames,
  type DsaOptions,
} from "./dsa";
import { xaDataSetOf } from "./xaCine";

const SCHEME = "graphy-dsa";

/** DICOM Mask Subtraction Module の読み取り結果（装置が書いた既定値）。 */
export interface XaDsaTags {
  /** PixelIntensityRelationship (0028,1040)。LOG / LIN。 */
  pixelIntensityRelationship: string | null;
  /** MaskFrameNumbers (0028,6110) を 0 origin にしたもの。 */
  maskFrames: number[] | null;
  /** MaskSubPixelShift (0028,6114)。DICOM は [row, column] なので {dy, dx} に読み替える。 */
  dx: number;
  dy: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * US（符号なし 16bit）の全要素を読む。
 *
 * 🚨 **`dataSet.string()` で読んではいけない**。`MaskFrameNumbers (0028,6110)` は VR=US の
 * **バイナリ**で、文字列として読むとバイト列がそのまま文字になり意味を成さない
 * （実データ〈Rubo の XA サンプル〉で発覚）。
 */
function readUS(ds: any, tag: string): number[] | null {
  const el = ds?.elements?.[tag];
  if (!el || !el.length) return null;
  const n = Math.floor(el.length / 2);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = ds.uint16(tag, i);
    if (typeof v === "number") out.push(v);
  }
  return out.length ? out : null;
}

/** FL（32bit 浮動小数）の全要素を読む。US と同じ理由で `string()` は使えない。 */
function readFL(ds: any, tag: string): number[] | null {
  const el = ds?.elements?.[tag];
  if (!el || !el.length) return null;
  const n = Math.floor(el.length / 4);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = ds.float(tag, i);
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out.length ? out : null;
}

/**
 * 装置が書いたサブトラクションの既定値を読む（`fw/angio-design.md` §6.3）。
 * 既定値として採用し、UI から上書きできるようにする。プリウォーム前は null。
 *
 * <p>⚠️ 実データでは <b>{@code MaskOperation = "NONE"}／{@code MaskFrameNumbers = 0}</b>
 * （0 は 1 origin として不正）という「シーケンスはあるが中身は空」の書かれ方が普通にある。
 * その場合は装置指定なしとして扱い、自動選択へ落とす。
 */
export function readXaDsaTags(imageId: string): XaDsaTags | null {
  const ds: any = xaDataSetOf(imageId);
  if (!ds) return null;
  const seqItem = ds.elements?.x00286100?.items?.[0]?.dataSet;
  const operation: string | undefined = seqItem?.string?.("x00286101");
  const usable = !!seqItem && (!operation || operation.trim().toUpperCase() !== "NONE");

  // MaskSubPixelShift は FL [row(=縦), column(=横)]。内部表現は {dx=横, dy=縦}。
  const shift = usable ? readFL(seqItem, "x00286114") : null;
  const dy = shift && Number.isFinite(shift[0]) ? shift[0] : 0;
  const dx = shift && Number.isFinite(shift[1]) ? shift[1] : 0;

  // MaskFrameNumbers は US、**1 origin**。0 以下は不正なので捨てる（実データに 0 が入っていた）。
  const rawFrames = usable ? readUS(seqItem, "x00286110") : null;
  const maskFrames = rawFrames ? rawFrames.filter((v) => v >= 1).map((v) => v - 1) : null;

  return {
    // PixelIntensityRelationship (0028,1040) は VR=CS なので文字列で正しい。
    pixelIntensityRelationship: ds.string?.("x00281040") ?? null,
    maskFrames: maskFrames && maskFrames.length ? maskFrames : null,
    dx,
    dy,
  };
}

interface DsaSession {
  /** ネイティブフレームの imageId（t 昇順）。 */
  frameIds: string[];
  /** 平均してマスクにするフレーム（0 origin）。 */
  maskFrames: number[];
  /** マスク平均（サイズ = width*height）。 */
  mask: Float32Array;
  width: number;
  height: number;
  logarithmic: boolean;
  dx: number;
  dy: number;
  /** 差分から決めた表示 VOI。 */
  voi: { windowCenter: number; windowWidth: number };
  /** 自動選択が判断した造影到達フレーム（UI の説明用）。 */
  onset: number | null;
}

const sessions = new Map<string, DsaSession>();
let seq = 0;

export interface DsaSessionParams {
  /** ネイティブフレームの imageId（t 昇順・全フレーム）。 */
  frameIds: string[];
  /** マスクフレーム。省略時は自動選択。 */
  maskFrames?: number[] | null;
  /** 対数変換（PixelIntensityRelationship = LIN のとき true）。 */
  pixelIntensityRelationship?: string | null;
  /** 初期ピクセルシフト（MaskSubPixelShift 由来）。 */
  dx?: number;
  dy?: number;
}

/** セッションの現在状態（UI 表示用）。 */
export interface DsaSessionState {
  maskFrames: number[];
  onset: number | null;
  dx: number;
  dy: number;
  logarithmic: boolean;
  /** 現在のシフトでの背景 RMS（小さいほど合っている）。 */
  backgroundRms: number;
}

async function readFrames(ids: string[]): Promise<{ values: Float32Array[]; width: number; height: number } | null> {
  const slices = await Promise.all(ids.map((id) => readModalitySlice(id)));
  const values: Float32Array[] = [];
  let width = 0;
  let height = 0;
  for (const s of slices) {
    if (!s) return null;
    values.push(s.values);
    if (!width) {
      width = s.width;
      height = s.height;
    }
  }
  return width && height ? { values, width, height } : null;
}

/**
 * DSA セッションを用意する（マスク平均と表示 VOI をここで確定させる）。
 *
 * <p>**同期的にトークンだけ配らない**のは、マスク平均を作る前に描画が始まると
 * 「一瞬もとの画像が出てから差分に変わる」ちらつきになるため。UI は await してから切り替える。
 *
 * @returns セッショントークン（{@link dsaImageId} に渡す）。失敗時は null。
 */
export async function prepareDsaSession(params: DsaSessionParams): Promise<string | null> {
  const { frameIds } = params;
  if (frameIds.length < 2) return null;
  const logarithmic = needsLogTransform(params.pixelIntensityRelationship);

  // マスク候補の決定に全フレームの平均輝度が要る。フレーム数ぶん読むことになるが、
  // XA のフレームは既にローダのキャッシュに乗っている（同一ファイル＝1 回の HTTP）ので安い。
  const all = await readFrames(frameIds);
  if (!all) return null;
  const { values, width, height } = all;

  let maskFrames = params.maskFrames?.filter((i) => i >= 0 && i < values.length) ?? null;
  let onset: number | null = null;
  if (!maskFrames || maskFrames.length === 0) {
    // 🚨 **フレーム単独の暗部テールでは足りない**（骨が濃いと造影が埋もれる）。
    //    ラン先頭との差で見る（{@link contrastDropSignal} の警告）。
    const picked = pickMaskFrames(contrastDropSignal(values));
    maskFrames = picked.frames;
    onset = picked.onset;
  }
  const mask = averageFrames(maskFrames.map((i) => values[i]));
  if (!mask) return null;

  const dx = params.dx ?? 0;
  const dy = params.dy ?? 0;

  // 表示 VOI: 造影が最も濃いであろうフレーム（onset 以降の中間）で差分を作り、その分布から決める。
  const probeIdx = onset != null ? Math.min(values.length - 1, onset + Math.floor((values.length - onset) / 2)) : values.length - 1;
  const probe = subtractFrames(mask, values[probeIdx], width, height, { dx, dy, logarithmic });
  const voi = probe ? voiFromDiff(probe) : { windowCenter: 0, windowWidth: 1 };

  const token = `dsa${++seq}`;
  sessions.set(token, { frameIds, maskFrames, mask, width, height, logarithmic, dx, dy, voi, onset });
  return token;
}

/**
 * 差分画像の表示 VOI。中央値 ±3σ 相当（外れ値に強いようパーセンタイルで取る）。
 * 差分は 0 を中心とする符号付きなので、元画像の VOI をそのまま使ってはいけない。
 */
function voiFromDiff(diff: Float32Array): { windowCenter: number; windowWidth: number } {
  const sorted = Float32Array.from(diff).sort();
  const at = (q: number) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * q)))];
  const lo = at(0.02);
  const hi = at(0.98);
  const width = Math.max(hi - lo, 1e-6);
  return { windowCenter: (hi + lo) / 2, windowWidth: width };
}

/**
 * セッションの imageId。t は 0 origin のフレーム番号。
 *
 * <p>`version` は合成パラメータ（ピクセルシフト・マスク）の版番号。**imageId に混ぜる**ことで、
 * パラメータを変えたら別 imageId ＝ Cornerstone の画像キャッシュを避けて必ず再合成される
 * （ThickSlab のセッショントークンと同じ考え方）。
 */
export function dsaImageId(token: string, t: number, version = 0): string {
  return `${SCHEME}:${token}/${version}#${t}`;
}

function parseDsaImageId(imageId: string): { token: string; t: number } | null {
  if (!imageId.startsWith(`${SCHEME}:`)) return null;
  const rest = imageId.slice(SCHEME.length + 1);
  const hash = rest.lastIndexOf("#");
  if (hash < 0) return null;
  const t = Number(rest.slice(hash + 1));
  if (!Number.isFinite(t)) return null;
  const head = rest.slice(0, hash);
  const slash = head.lastIndexOf("/");
  return { token: slash >= 0 ? head.slice(0, slash) : head, t };
}

/** ピクセルシフトを更新する（imageId は変えず、呼び出し側で画像キャッシュを捨てて再描画する）。 */
export function setDsaShift(token: string, dx: number, dy: number): void {
  const s = sessions.get(token);
  if (s) {
    s.dx = dx;
    s.dy = dy;
  }
}

/** マスクフレームを差し替える（自動選択を人が直すとき）。 */
export function setDsaMaskFrames(token: string, frames: number[]): boolean {
  const s = sessions.get(token);
  if (!s) return false;
  const valid = frames.filter((i) => i >= 0 && i < s.frameIds.length);
  if (!valid.length) return false;
  // マスク平均を作り直すために、対象フレームだけ読み直す（キャッシュ済みなので安い）。
  s.maskFrames = valid;
  return true;
}

/** マスク平均を作り直す（{@link setDsaMaskFrames} の後に呼ぶ）。 */
export async function rebuildDsaMask(token: string): Promise<boolean> {
  const s = sessions.get(token);
  if (!s) return false;
  const read = await readFrames(s.maskFrames.map((i) => s.frameIds[i]));
  if (!read) return false;
  const mask = averageFrames(read.values);
  if (!mask) return false;
  s.mask = mask;
  return true;
}

/** 現在のシフトでの背景 RMS を測る（UI に数値で出し、目視でなく数値で判断できるようにする）。 */
export async function measureDsaResidual(token: string, t: number): Promise<number | null> {
  const s = sessions.get(token);
  if (!s) return null;
  const live = await readModalitySlice(s.frameIds[Math.max(0, Math.min(s.frameIds.length - 1, t))]);
  if (!live) return null;
  const diff = subtractFrames(s.mask, live.values, s.width, s.height, opts(s));
  return diff ? backgroundRms(diff) : null;
}

/** ピクセルシフトを自動推定して適用する。戻り値は推定結果。 */
export async function autoAlignDsa(token: string, t: number): Promise<{ dx: number; dy: number; rms: number } | null> {
  const s = sessions.get(token);
  if (!s) return null;
  const live = await readModalitySlice(s.frameIds[Math.max(0, Math.min(s.frameIds.length - 1, t))]);
  if (!live) return null;
  const best = estimateShift(s.mask, live.values, s.width, s.height, s.logarithmic);
  s.dx = best.dx;
  s.dy = best.dy;
  return best;
}

/** セッションの現在状態（UI 表示用）。 */
export function dsaSessionState(token: string): DsaSessionState | null {
  const s = sessions.get(token);
  if (!s) return null;
  return {
    maskFrames: [...s.maskFrames],
    onset: s.onset,
    dx: s.dx,
    dy: s.dy,
    logarithmic: s.logarithmic,
    backgroundRms: 0,
  };
}

/** 対数変換の ON/OFF を切り替える（装置が LOG/LIN を書いていない時の手動切替）。 */
export function setDsaLogarithmic(token: string, logarithmic: boolean): void {
  const s = sessions.get(token);
  if (s) s.logarithmic = logarithmic;
}

/** セッションを破棄する（シリーズ切替・DSA OFF）。 */
export function releaseDsaSession(token: string): void {
  sessions.delete(token);
}

function opts(s: DsaSession): DsaOptions {
  return { dx: s.dx, dy: s.dy, logarithmic: s.logarithmic };
}

/** 合成画像の IImage を組み立てる（cache への put は cornerstone 側が行う）。 */
async function computeDsaImage(imageId: string): Promise<Record<string, unknown>> {
  const parsed = parseDsaImageId(imageId);
  if (!parsed) throw new Error(`dsa: bad imageId ${imageId}`);
  const s = sessions.get(parsed.token);
  if (!s) throw new Error(`dsa: session not found (${parsed.token})`);

  const nativeId = s.frameIds[Math.max(0, Math.min(s.frameIds.length - 1, parsed.t))];
  const live = await readModalitySlice(nativeId);
  if (!live) throw new Error("dsa: no pixel data");
  const diff = subtractFrames(s.mask, live.values, s.width, s.height, opts(s));
  if (!diff) throw new Error("dsa: size mismatch");

  let minPixelValue = Infinity;
  let maxPixelValue = -Infinity;
  for (let i = 0; i < diff.length; i++) {
    const v = diff[i];
    if (v < minPixelValue) minPixelValue = v;
    if (v > maxPixelValue) maxPixelValue = v;
  }
  if (!Number.isFinite(minPixelValue)) {
    minPixelValue = 0;
    maxPixelValue = 0;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plane: any = metaData.get("imagePlaneModule", nativeId) ?? {};
  const voxelManager = csUtils.VoxelManager.createImageVoxelManager({
    width: s.width,
    height: s.height,
    scalarData: diff,
    numberOfComponents: 1,
    id: imageId,
  });

  return {
    imageId,
    referencedImageId: nativeId,
    dataType: "Float32Array",
    color: false,
    rgba: false,
    numberOfComponents: 1,
    slope: 1,
    intercept: 0,
    windowCenter: s.voi.windowCenter,
    windowWidth: s.voi.windowWidth,
    minPixelValue,
    maxPixelValue,
    rows: s.height,
    columns: s.width,
    height: s.height,
    width: s.width,
    columnPixelSpacing: Number(plane.columnPixelSpacing) || undefined,
    rowPixelSpacing: Number(plane.rowPixelSpacing) || undefined,
    invert: false,
    getPixelData: () => voxelManager.getScalarData(),
    getCanvas: undefined,
    voxelManager,
    sizeInBytes: diff.byteLength,
  };
}

let registered = false;

/** ローダとメタデータプロバイダを登録する。冪等。cornerstone 初期化時に呼ぶ。 */
export function registerDsaLoader(): void {
  if (registered) return;
  registered = true;

  registerImageLoader(SCHEME, (imageId: string) => ({
    promise: computeDsaImage(imageId),
  }));

  metaData.addProvider((type: string, ...query: string[]): unknown => {
    const parsed = parseDsaImageId(query[0]);
    if (!parsed) return undefined;
    const s = sessions.get(parsed.token);
    if (!s) return undefined;
    const nativeId = s.frameIds[Math.max(0, Math.min(s.frameIds.length - 1, parsed.t))];

    if (type === "modalityLutModule") {
      // 差分は既に値空間で完結。GPU 側 Modality LUT は恒等にして二重適用を防ぐ。
      return { rescaleSlope: 1, rescaleIntercept: 0 };
    }
    if (type === "voiLutModule") {
      // 差分は 0 を中心とする符号付き。元画像の VOI を使うと真っ黒になる。
      return { windowCenter: [s.voi.windowCenter], windowWidth: [s.voi.windowWidth] };
    }
    return metaData.get(type, nativeId);
  }, 11000);
}
