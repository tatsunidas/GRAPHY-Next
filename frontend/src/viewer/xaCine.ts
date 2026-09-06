/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA/XRF シネ再生のうち、**Cornerstone のキャッシュに触る層**（`fw/angio-design.md` §5.4 / §5.5）。
 *
 * <p>時間軸の解釈そのもの（fps の決定・各フレームの開始時刻・経過時刻からの逆引き）は
 * **{@link ./xaCineTiming} に移してある**（2026-09-06）。あちらは純関数だけなので
 * プラグインへ写せる —— QFR の造影流速は「3D 弧長 ÷ 通過時間」で決まるため、
 * **フレーム番号を秒に直す規則を本体とプラグインで共有する必要がある**。
 *
 * <p>ここからは従来どおりの名前で再輸出しているので、**既存の import は変えなくてよい**。
 * ただし**新しく書くコードは `xaCineTiming` から直接取ること** ——
 * こちらを経由すると Cornerstone のローダを不要に引き込む。
 *
 * <p>描画は既存の 2D ビューア（StackViewport）に任せる。XA は encapsulated video ではなく
 * **時間軸を持った画像スタック**なので、動画経路（{@code VideoViewer}）は使わない。
 */
import { internal, wadouri } from "@cornerstonejs/dicom-image-loader";
import { xaSourceUrlOf } from "./imageId";
import type { XaCineSource } from "./xaCineTiming";

export {
  DEFAULT_XA_FPS,
  XA_PLAYBACK_RATES,
  cineDurationMs,
  frameAtElapsed,
  frameStartTimesMs,
  isUniformFrameTime,
  resolveXaFps,
  type XaCineSource,
  type XaFpsSource,
} from "./xaCineTiming";

// ── Cornerstone のキャッシュに触る層 ───────────────────────────────────────

/**
 * XA インスタンスの dataSet を**先に**ローダのキャッシュへ載せる。
 *
 * <p>🚨 **これは飾りではなく必須**。dicom-image-loader の `loadImage` は
 * - dataSet が**未キャッシュ**のとき `parsedImageId.frame`（**1 origin**）を
 * - **キャッシュ済み**のとき `parsedImageId.pixelDataFrame`（**0 origin**）を
 * それぞれ `getPixelData(dataSet, frameIndex)`（0 origin）へ渡す。つまり
 * **最初に読んだ 1 フレームだけ 1 枚ずれた画像がキャッシュに載る**。
 * 先に dataSet だけ読み込んでおけば、以後の画像ロードは必ず 0 origin の枝を通るのでずれない。
 *
 * <p>同時に、全フレームが 1 回の HTTP で賄えるようになる（§5.3 の狙いそのもの）。
 *
 * @param imageId XA フレームの imageId（`wadouri:....&frame=N`）
 */
export async function prewarmXaDataset(imageId: string): Promise<void> {
  const url = xaSourceUrlOf(imageId);
  if (!url) return;
  const cache = wadouri.dataSetCacheManager;
  if (cache.isLoaded(url)) return;
  // xhrRequest はローダ自身の既定リクエスタ。型宣言（LoadRequestFunction）の可変長引数が
  // 実装より緩く宣言されているため合致しないが、実体は同一関数なのでキャストで通す。
  const request = internal.xhrRequest as unknown as Parameters<typeof cache.load>[1];
  await cache.load(url, request, imageId);
}

/** プリウォーム済みかどうか（プリウォーム前にフレームを表示しないためのガード）。 */
export function isXaDatasetReady(imageId: string): boolean {
  const url = xaSourceUrlOf(imageId);
  return !!url && wadouri.dataSetCacheManager.isLoaded(url);
}

/**
 * プリウォーム済みの dataSet を取り出す（XA 系のタグ読み出しの共通入口）。
 * 未取得・非 wadouri の imageId では null。
 */
export function xaDataSetOf(imageId: string): ReturnType<typeof wadouri.dataSetCacheManager.get> | null {
  const url = xaSourceUrlOf(imageId);
  if (!url) return null;
  const cache = wadouri.dataSetCacheManager;
  if (!cache.isLoaded(url)) return null;
  return cache.get(url) ?? null;
}

/**
 * キャッシュ済み dataSet から fps 決定用のタグを読む。プリウォーム前は null。
 * Cornerstone の `cineModule` は FrameTime しか返さないため、生タグを直接読む。
 */
export function readXaCineSource(imageId: string): XaCineSource | null {
  const ds = xaDataSetOf(imageId);
  if (!ds) return null;
  const nf = ds.intString("x00280008");
  const rawVector = ds.string("x00181065");
  const frameTimeVectorMs = rawVector
    ? rawVector
        .split("\\")
        .map((s) => Number.parseFloat(s))
        .filter((v) => Number.isFinite(v))
    : null;
  return {
    numberOfFrames: Number.isFinite(nf) && (nf as number) > 0 ? (nf as number) : 1,
    frameTimeMs: ds.floatString("x00181063") ?? null,
    frameTimeVectorMs: frameTimeVectorMs && frameTimeVectorMs.length > 0 ? frameTimeVectorMs : null,
    cineRate: ds.floatString("x00180040") ?? null,
    recommendedDisplayFrameRate: ds.floatString("x00082144") ?? null,
  };
}
