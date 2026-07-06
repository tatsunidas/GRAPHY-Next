/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ThickSlab（デジタルスライス厚）— 2D Slice ビューア専用。
 *
 * <p>GRAPHY 本家 {@code Praparat.computeThickSlabProcessor} の移植。中心スライス位置を連続実 Z に
 * 変換し、厚み ±半分の Z 範囲を面内ピクセル間隔で等方サブサンプル（最大 64 点）して
 * <b>Trilinear 補間（実装は面内格子が共通なので Z 方向 1D 線形補間に縮退）</b>で平均合成（Average
 * projection）する。MIP/MinIP は本家 ThickSlab に無いため平均のみ。
 *
 * <h3>Cornerstone への注入</h3>
 * 合成結果を <b>{@code graphy-thickslab:} スキームのカスタム画像ローダ</b>で StackViewport へ
 * オンデマンド供給する。メタデータは高優先プロバイダで<b>中心ネイティブスライスへ委譲</b>し、
 * ただし {@code modalityLutModule} だけは恒等（slope1/intercept0）にする。合成は
 * {@link readModalitySlice}（= {@code pixelCalibration} 単一入口）でモダリティ値（HU 等）に校正済みの
 * ため、GPU 側の Modality LUT を二重適用しないための恒等化である（[[pixel-calibration-single-entry]]）。
 *
 * <h3>幾何・単一幾何の鉄則</h3>
 * サンプルは「表示中スタックの近傍ネイティブスライスの画素」だけを使い、cornerstone の 3D 幾何
 * API（canvasToWorld/voxelManager 等）には一切依存しない。中心スライスの imagePlaneModule を
 * そのまま継承するため、参照線・向きマーカー・座標同期は native と同一幾何で一致する
 * （fw/cornerstone-3d-geometry-caveat.md の「表示幾何と計算幾何を混ぜない」を満たす）。
 */
import { metaData, registerImageLoader, utilities as csUtils } from "@cornerstonejs/core";
import { readModalitySlice } from "./pixelCalibration";

/** UI に出す厚み(mm)の選択肢。実スライス厚と一致した値が選ばれたら「Original（合成しない）」扱い。 */
export const THICK_SLAB_THICKNESSES = [0.1, 0.3, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0] as const;

/** 合成 imageId のスキーム（カスタムローダ登録名）。 */
const SCHEME = "graphy-thickslab";
/** サブサンプル点数の上限（本家準拠）。 */
const MAX_SUBSAMPLES = 64;
/** 「実スライス厚と一致＝Original」とみなす許容差(mm)。本家 setThickSlabThickness の 0.01 に一致。 */
const ORIGINAL_EPS_MM = 0.01;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** FNV-1a（32bit）で文字列を短いトークン片にする（スタック/並べ替えの差分検知用）。 */
function hashStr(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ── デジタル Z 写像（純関数・SeriesViewer と共有） ──────────────────────────
//
// 本家 Praparat の digitalZ↔originalZ 写像に一致。slicesPerStep = 厚み / 実スライス間隔。
// 厚み < 間隔なら slicesPerStep < 1（＝アップサンプリング＝デジタル枚数が増える）も許容する。

/** 1 デジタルステップが束ねる実スライス枚数（<1 も許容）。 */
export function slicesPerStepOf(thicknessMm: number, spacingZmm: number): number {
  return spacingZmm > 0 ? thicknessMm / spacingZmm : 1;
}

/** デジタルスライス総数 = ceil(実スライス数 / slicesPerStep)（最低 1）。 */
export function digitalCountOf(nZ: number, slicesPerStep: number): number {
  if (!(slicesPerStep > 0)) return nZ;
  return Math.max(1, Math.ceil(nZ / slicesPerStep));
}

/** デジタル Z → 連続実 Z（各デジタルスライスの中心。必ず [0, nZ-1] にクランプ）。 */
export function digitalToFractionalOriginalZ(dz: number, slicesPerStep: number, nZ: number): number {
  return clamp((dz + 0.5) * slicesPerStep, 0, nZ - 1);
}

/** デジタル Z → 最近傍の実 Z 整数（座標同期・参照線・onDimChange の native 位置写像に使う）。 */
export function digitalToNativeZ(dz: number, slicesPerStep: number, nZ: number): number {
  return clamp(Math.round(digitalToFractionalOriginalZ(dz, slicesPerStep, nZ)), 0, nZ - 1);
}

/** 実 Z → デジタル Z（ON/OFF・厚み変更時に「同じ物理スライス」を保つための逆写像）。 */
export function originalToDigitalZ(oz: number, slicesPerStep: number, digitalCount: number): number {
  if (!(slicesPerStep > 0)) return clamp(Math.round(oz), 0, digitalCount - 1);
  return clamp(Math.round(oz / slicesPerStep - 0.5), 0, digitalCount - 1);
}

/** 選んだ厚みが実スライス厚（間隔）と実質一致＝Original 表示にすべきか。 */
export function isOriginalThickness(thicknessMm: number, spacingZmm: number): boolean {
  return spacingZmm > 0 && Math.abs(thicknessMm - spacingZmm) < ORIGINAL_EPS_MM;
}

/**
 * ThickSlab の利用可否。動画(MPEG 含む) SOP・単一スライス・カラー(RGB)では無効。
 * （合成は近傍スライスの重ね合わせのため、空間的に連続したモノクロスタックでのみ意味を持つ。）
 */
export function isThickSlabAvailable(opts: { hasVideo: boolean; nZ: number; isColor?: boolean }): boolean {
  return !opts.hasVideo && !opts.isColor && opts.nZ >= 2;
}

// ── セッション登録（トークン ↔ 合成に必要な文脈） ───────────────────────────

interface ThickSlabSession {
  /** z 昇順のネイティブ imageId 配列（現在の C/T スタック）。 */
  nativeIds: string[];
  /** 実スライス間隔(mm)。 */
  spacingZmm: number;
  /** 厚み(mm)。 */
  thicknessMm: number;
  /** 厚み / 間隔。 */
  slicesPerStep: number;
}

const sessions = new Map<string, ThickSlabSession>();

/**
 * ThickSlab セッションを登録し、合成 imageId のトークンを返す。
 * 同一パラメータ（シリーズ・C/T・厚み・スタック内容）なら同じトークンになり、
 * imageId 配列が安定する（＝StackViewport の不要な再初期化を防ぐ）。
 */
export function registerThickSlabSession(params: {
  seriesUid: string;
  c: number;
  t: number;
  thicknessMm: number;
  spacingZmm: number;
  nativeIds: string[];
}): string {
  const stackHash = hashStr(params.nativeIds.join("|"));
  const rawKey = `${params.seriesUid}|${params.c}|${params.t}|${params.thicknessMm}|${params.spacingZmm.toFixed(4)}|${params.nativeIds.length}|${stackHash}`;
  const token = encodeURIComponent(rawKey); // ':' / '#' / '/' を含まない
  sessions.set(token, {
    nativeIds: params.nativeIds,
    spacingZmm: params.spacingZmm,
    thicknessMm: params.thicknessMm,
    slicesPerStep: slicesPerStepOf(params.thicknessMm, params.spacingZmm),
  });
  return token;
}

/** トークン＋デジタル Z から合成 imageId を組み立てる。 */
export function thickSlabImageId(token: string, dz: number): string {
  return `${SCHEME}:${token}#${dz}`;
}

/** 合成 imageId をトークンとデジタル Z に分解。スキーム不一致なら null。 */
function parseThickSlabImageId(imageId: string): { token: string; dz: number } | null {
  if (typeof imageId !== "string" || !imageId.startsWith(`${SCHEME}:`)) return null;
  const rest = imageId.slice(SCHEME.length + 1);
  const hash = rest.lastIndexOf("#");
  if (hash < 0) return null;
  const token = rest.slice(0, hash);
  const dz = Number(rest.slice(hash + 1));
  if (!Number.isFinite(dz)) return null;
  return { token, dz };
}

/** そのデジタル Z の合成に対応する「中心ネイティブスライス」imageId（メタデータ委譲元）。 */
function centerNativeIdFor(session: ThickSlabSession, dz: number): string {
  const nZ = session.nativeIds.length;
  const nativeZ = digitalToNativeZ(dz, session.slicesPerStep, nZ);
  return session.nativeIds[nativeZ];
}

// ── 合成本体（カスタムローダ） ──────────────────────────────────────────────

/** 中心スライスの面内ピクセル間隔の細かい方（等方サブサンプル幅の基準）。 */
function isotropicStepMm(centerNativeId: string): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plane: any = metaData.get("imagePlaneModule", centerNativeId) ?? {};
  const row = Number(plane.rowPixelSpacing);
  const col = Number(plane.columnPixelSpacing);
  const cands = [row, col].filter((v) => Number.isFinite(v) && v > 0);
  return cands.length ? Math.min(...cands) : 1;
}

/** 合成スライスの IImage を組み立てて返す（cache への put は cornerstone 側が行うため呼ばない）。 */
async function computeThickSlabImage(imageId: string): Promise<Record<string, unknown>> {
  const parsed = parseThickSlabImageId(imageId);
  if (!parsed) throw new Error(`thickslab: bad imageId ${imageId}`);
  const session = sessions.get(parsed.token);
  if (!session) throw new Error(`thickslab: session not found (${parsed.token})`);

  const { nativeIds, spacingZmm, thicknessMm, slicesPerStep } = session;
  const nZ = nativeIds.length;
  const center = digitalToFractionalOriginalZ(parsed.dz, slicesPerStep, nZ);
  const centerNativeId = centerNativeIdFor(session, parsed.dz);

  // 厚み範囲を [0, nZ-1] にクランプ（端はパディング/ミラーせず実効厚が縮む＝本家準拠）。
  const halfSlices = (thicknessMm / 2) / spacingZmm;
  const zStart = Math.max(0, center - halfSlices);
  const zEnd = Math.min(nZ - 1, center + halfSlices);

  // サブサンプル点数 = 範囲(mm)/等方ステップ（1..64）。範囲ゼロ（薄すぎ）なら 1 点。
  const rangeMm = (zEnd - zStart) * spacingZmm;
  const step = isotropicStepMm(centerNativeId);
  const n = clamp(Math.round(rangeMm / step) || 1, 1, MAX_SUBSAMPLES);
  const binWidth = n > 0 ? (zEnd - zStart) / n : 0;

  // 各ビン中心の zSample と、その floor/ceil スライス（Z 方向 1D 線形補間の 2 枚）。
  interface Bin { z0: number; z1: number; f: number }
  const bins: Bin[] = new Array(n);
  const need = new Set<number>();
  for (let k = 0; k < n; k++) {
    const zSample = clamp(zStart + binWidth * (k + 0.5), 0, nZ - 1);
    const z0 = Math.floor(zSample);
    const z1 = Math.min(z0 + 1, nZ - 1);
    bins[k] = { z0, z1, f: zSample - z0 };
    need.add(z0);
    need.add(z1);
  }

  // 必要なネイティブスライスだけ校正済み float で取得（近傍のみ＝軽量。既存プリフェッチには非依存）。
  const slices = new Map<number, Float32Array | null>();
  let width = 0;
  let height = 0;
  await Promise.all(
    Array.from(need, async (z) => {
      const s = await readModalitySlice(nativeIds[z]);
      if (s) {
        slices.set(z, s.values);
        if (!width) { width = s.width; height = s.height; }
      } else {
        slices.set(z, null);
      }
    }),
  );
  if (!width || !height) throw new Error("thickslab: no pixel data");

  // Z 方向線形補間で各ビンをサンプルし、平均（Average projection）。
  const size = width * height;
  const acc = new Float32Array(size);
  for (let k = 0; k < n; k++) {
    const { z0, z1, f } = bins[k];
    const s0 = slices.get(z0) ?? null;
    const s1 = slices.get(z1) ?? null;
    const w0 = 1 - f;
    if (s0 && s1) {
      for (let p = 0; p < size; p++) acc[p] += s0[p] * w0 + s1[p] * f;
    } else if (s0) {
      for (let p = 0; p < size; p++) acc[p] += s0[p];
    } else if (s1) {
      for (let p = 0; p < size; p++) acc[p] += s1[p];
    }
  }
  const inv = 1 / n;
  let minPixelValue = Infinity;
  let maxPixelValue = -Infinity;
  for (let p = 0; p < size; p++) {
    const v = acc[p] * inv;
    acc[p] = v;
    if (v < minPixelValue) minPixelValue = v;
    if (v > maxPixelValue) maxPixelValue = v;
  }
  if (!Number.isFinite(minPixelValue)) { minPixelValue = 0; maxPixelValue = 0; }

  // 中心スライスの spacing / VOI / FrameOfReference を継承。合成は既にモダリティ値空間なので
  // slope=1/intercept=0（Modality LUT 恒等）。VOI(voiRange) は Viewer2D が readImageInfo 経由で
  // 中心スライスの windowCenter/Width を適用するので、ここでは image.windowCenter/Width は参考値。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plane: any = metaData.get("imagePlaneModule", centerNativeId) ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const voi: any = metaData.get("voiLutModule", centerNativeId) ?? {};
  const colPS = Number(plane.columnPixelSpacing) || 1;
  const rowPS = Number(plane.rowPixelSpacing) || 1;
  const wc = Array.isArray(voi.windowCenter) ? voi.windowCenter[0] : voi.windowCenter;
  const ww = Array.isArray(voi.windowWidth) ? voi.windowWidth[0] : voi.windowWidth;

  const voxelManager = csUtils.VoxelManager.createImageVoxelManager({
    width,
    height,
    scalarData: acc,
    numberOfComponents: 1,
    id: imageId,
  });

  const image: Record<string, unknown> = {
    imageId,
    referencedImageId: centerNativeId,
    dataType: "Float32Array",
    color: false,
    rgba: false,
    numberOfComponents: 1,
    slope: 1,
    intercept: 0,
    windowCenter: Number.isFinite(wc) ? wc : 0,
    windowWidth: Number.isFinite(ww) ? ww : 0,
    minPixelValue,
    maxPixelValue,
    rows: height,
    columns: width,
    height,
    width,
    columnPixelSpacing: colPS,
    rowPixelSpacing: rowPS,
    sliceThickness: thicknessMm,
    invert: false,
    getPixelData: () => voxelManager.getScalarData(),
    getCanvas: undefined,
    voxelManager,
    sizeInBytes: acc.byteLength,
    FrameOfReferenceUID: plane.frameOfReferenceUID,
  };
  return image;
}

// ── ローダ / メタデータプロバイダの登録（1 度だけ） ─────────────────────────

let registered = false;

/**
 * {@code graphy-thickslab:} スキームの画像ローダと、中心ネイティブスライスへ委譲する
 * 高優先メタデータプロバイダを登録する。冪等（何度呼ばれても 1 回だけ）。
 * cornerstone 初期化時（ensureCornerstoneInitialized）に呼ぶ。
 */
export function registerThickSlabLoader(): void {
  if (registered) return;
  registered = true;

  registerImageLoader(SCHEME, (imageId: string) => ({
    promise: computeThickSlabImage(imageId),
  }));

  metaData.addProvider((type: string, ...query: string[]): unknown => {
    const imageId = query[0];
    const parsed = parseThickSlabImageId(imageId);
    if (!parsed) return undefined;
    const session = sessions.get(parsed.token);
    if (!session) return undefined;
    const centerNativeId = centerNativeIdFor(session, parsed.dz);

    if (type === "modalityLutModule") {
      // 合成は校正済み（HU 等）→ GPU 側 Modality LUT は恒等にして二重適用を防ぐ。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const src: any = metaData.get("modalityLutModule", centerNativeId) ?? {};
      return { rescaleSlope: 1, rescaleIntercept: 0, rescaleType: src.rescaleType };
    }
    if (type === "imagePlaneModule") {
      // 中心スライスの幾何をそのまま継承（参照線・向き・座標同期が native と一致）。厚みだけ上書き。
      const src = metaData.get("imagePlaneModule", centerNativeId);
      if (!src) return undefined;
      return { ...(src as object), sliceThickness: session.thicknessMm };
    }
    // それ以外（generalSeriesModule / voiLutModule / imagePixelModule / patientModule 等）は委譲。
    return metaData.get(type, centerNativeId);
  }, 10000);
}
