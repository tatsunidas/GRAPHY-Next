/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ボリューム構築のメモリガード（設計: `fw/volume-memory-guard.md`）。
 *
 * <p>ボリューム構築（MPR / 3D / Slicer / Curved MPR が通る `viewer/mpr.ts` の `buildMprVolume`）は
 * 本アプリで最もメモリを食う処理だが、従来は<b>上限設定・事前予測・エラー識別のいずれも無かった</b>。
 * 超過時は cornerstone の生メッセージ（`CACHE_SIZE_EXCEEDED` / `... is not cacheable.`）が
 * そのまま画面に出るか、無言で描画に失敗していた。
 *
 * <p>このモジュールは <b>cornerstone を import しない</b>（vitest の node 環境で読めるようにするため）。
 * 実際の `cache.setMaxCacheSize()` 呼び出しは {@link ../viewer/cornerstoneSetup} 側にあり、
 * 適用済みの値をここへ {@link setAppliedVolumeMaxMb} で預ける。
 *
 * <p>V1 の範囲は「上限の明示設定 ＋ 超過エラーの識別」まで。事前予測（V2）・物理メモリ調達（V3）・
 * 3D テクスチャ寸法ガード（V4）は同設計書の後続フェーズ。
 */

/** 設定 `viewer.volumeMaxMb` の既定値（MB）。`settings/registry.ts` の default と一致させること。 */
export const DEFAULT_VOLUME_MAX_MB = 2048;
/** 設定 `viewer.volumeMaxMb` の下限（MB）。 */
export const MIN_VOLUME_MAX_MB = 128;
/** 設定 `viewer.volumeMaxMb` の上限（MB）。 */
export const MAX_VOLUME_MAX_MB = 32768;

const MB = 1024 * 1024;

/**
 * 設定値（backend の KV は常に文字列）を有効な MB 値へ正規化する。
 * 数値でない・範囲外・非有限はすべて既定値に倒す（設定が壊れていても起動を止めない）。
 */
export function normalizeVolumeMaxMb(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n)) return DEFAULT_VOLUME_MAX_MB;
  const i = Math.floor(n);
  if (i < MIN_VOLUME_MAX_MB || i > MAX_VOLUME_MAX_MB) return DEFAULT_VOLUME_MAX_MB;
  return i;
}

/** MB → バイト。`cache.setMaxCacheSize()` へ渡す値。 */
export function volumeMaxBytes(mb: number): number {
  return normalizeVolumeMaxMb(mb) * MB;
}

let appliedMaxMb = DEFAULT_VOLUME_MAX_MB;

/** 実際に cornerstone へ適用した上限（MB）を記録する。呼ぶのは `cornerstoneSetup` のみ。 */
export function setAppliedVolumeMaxMb(mb: number): void {
  appliedMaxMb = normalizeVolumeMaxMb(mb);
}

/**
 * 現在適用されている上限（MB）。超過エラーのメッセージに埋め込む。
 * 設定の取得前に呼ばれた場合は既定値を返す。
 */
export function getAppliedVolumeMaxMb(): number {
  return appliedMaxMb;
}

/**
 * 例外が「cornerstone のキャッシュ上限超過」由来か。
 *
 * <p>判別の流儀は既存の `isWebGLContextUnavailable`（`viewer/vtkVolumeView.ts`）に合わせ、
 * 専用エラークラスが無いためメッセージの正規表現で吸収する。対象は 2 種:
 * <ul>
 *   <li>`CACHE_SIZE_EXCEEDED` … `cache.js` の `_putImageCommon` / `_putGeometryCommon` が
 *       `Events.CACHE_SIZE_EXCEEDED` の<b>文字列値そのもの</b>を投げる。
 *       ⚠️ 実際の値は大文字スネークケース（設計書の `cacheSizeExceeded` は誤り）。
 *       将来のキャメルケース化にも耐えるよう区切り無しでも拾う。</li>
 *   <li>`... is not cacheable.` … `volumeLoader.js` の `createLocalVolume`
 *       （＝CT ガントリチルト補正経路が使う）。原文の typo "Cannot created" 込み。</li>
 * </ul>
 */
export function isCacheSizeExceeded(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e ?? "");
  return /cache[_\s-]?size[_\s-]?exceeded/i.test(m) || /is not cacheable/i.test(m);
}

// ── V4: 3D テクスチャ寸法のハードガード ─────────────────────────────────────

/**
 * ボリュームの寸法のうち 3D テクスチャ上限を超えているもの（最大のもの）を返す。超過が無ければ null。
 *
 * <p>RAM のバジェット（§2）とは**別の天井**。GPU 側の `MAX_3D_TEXTURE_SIZE` を超えると
 * テクスチャ確保に失敗し、警告も例外も無く<b>真っ黒</b>になる。そのため警告ではなくエラーで止める。
 *
 * @param maxDim {@link getMax3dTextureSize} の戻り。null（取得不能）なら判定しない＝常に null を返す。
 */
export function findExceeding3dTextureDim(
  dimensions: ArrayLike<number> | null | undefined,
  maxDim: number | null,
): number | null {
  if (maxDim === null || !Number.isFinite(maxDim) || maxDim <= 0) return null;
  if (!dimensions || dimensions.length === 0) return null;
  let worst: number | null = null;
  for (let i = 0; i < dimensions.length; i++) {
    const d = dimensions[i];
    if (Number.isFinite(d) && d > maxDim && (worst === null || d > worst)) worst = d;
  }
  return worst;
}

let cachedMax3dTextureSize: number | null | undefined;

/**
 * GPU の 3D テクスチャ寸法上限（WebGL2 の `MAX_3D_TEXTURE_SIZE`。GPU により 1024〜16384、
 * 多くは 2048）。取得できなければ null。
 *
 * <p>問い合わせ専用の使い捨てコンテキストを 1 度だけ作り、値をキャッシュする。WebGL の同時
 * コンテキスト数には上限（多くのブラウザで 16）があるため、取得後すぐ `WEBGL_lose_context` で解放する。
 * 判定の流儀は `viewer/cinematicPathTracer.ts` の GPU ケーパビリティ判定（取れなければ null）に倣う。
 */
export function getMax3dTextureSize(): number | null {
  if (cachedMax3dTextureSize !== undefined) return cachedMax3dTextureSize;
  cachedMax3dTextureSize = probeMax3dTextureSize();
  return cachedMax3dTextureSize;
}

function probeMax3dTextureSize(): number | null {
  try {
    if (typeof document === "undefined") return null; // 単体テスト（node 環境）
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const v = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as unknown;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
