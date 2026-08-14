/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA/XRF シネ再生の土台（`fw/angio-design.md` §5.4 / §5.5）。
 *
 * <p>ここに置くのは「時間軸の解釈」だけで、描画は既存の 2D ビューア（StackViewport）に任せる。
 * XA は encapsulated video ではなく**時間軸を持った画像スタック**なので、動画経路
 * （{@code VideoViewer}）は使わない。
 *
 * <p>純関数（{@link resolveXaFps} / {@link frameStartTimesMs} / {@link frameAtElapsed}）と、
 * Cornerstone のキャッシュに触る薄い層（{@link prewarmXaDataset} / {@link readXaCineSource}）を分けてある。
 */
import { internal, wadouri } from "@cornerstonejs/dicom-image-loader";
import { xaSourceUrlOf } from "./imageId";

/** fps を決める材料（DICOM タグ由来）。 */
export interface XaCineSource {
  numberOfFrames: number;
  /** FrameTime (0018,1063) [ms]。 */
  frameTimeMs?: number | null;
  /** FrameTimeVector (0018,1065) [ms]。フレームごとに間隔が違う収集（可変レート DSA）。 */
  frameTimeVectorMs?: number[] | null;
  /** CineRate (0018,0040) [fps]。 */
  cineRate?: number | null;
  /** RecommendedDisplayFrameRate (0008,2144) [fps]。 */
  recommendedDisplayFrameRate?: number | null;
}

/** fps の決定根拠（UI に出して「なぜこの速度なのか」を説明できるようにする）。 */
export type XaFpsSource =
  | "frameTimeVector"
  | "frameTime"
  | "cineRate"
  | "recommendedDisplayFrameRate"
  | "default";

/** どのタグも無いときの既定 fps。 */
export const DEFAULT_XA_FPS = 15;

/** 再生速度の選択肢（実時間 = 1.0x）。 */
export const XA_PLAYBACK_RATES = [0.25, 0.5, 1.0, 1.5, 2.0] as const;

function positive(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * fps を決める（`fw/angio-design.md` §5.4 の優先順位）。
 * FrameTimeVector → FrameTime → CineRate → RecommendedDisplayFrameRate → 既定 15fps。
 *
 * <p>FrameTimeVector がある場合の fps は「平均」であり、再生そのものは
 * {@link frameStartTimesMs} の可変間隔で駆動する（等間隔で再生すると時間軸が歪む）。
 */
export function resolveXaFps(src: XaCineSource): { fps: number; source: XaFpsSource } {
  const vec = usableFrameTimeVector(src);
  if (vec) {
    const total = vec.reduce((a, b) => a + b, 0);
    const avg = total / vec.length;
    const fps = positive(1000 / avg);
    if (fps) return { fps, source: "frameTimeVector" };
  }
  const ft = positive(src.frameTimeMs);
  if (ft) return { fps: 1000 / ft, source: "frameTime" };
  const cr = positive(src.cineRate);
  if (cr) return { fps: cr, source: "cineRate" };
  const rd = positive(src.recommendedDisplayFrameRate);
  if (rd) return { fps: rd, source: "recommendedDisplayFrameRate" };
  return { fps: DEFAULT_XA_FPS, source: "default" };
}

/**
 * 使える FrameTimeVector（正の増分だけを持ち、フレーム数に足りている）を返す。
 * 先頭要素は「1 フレーム目までの時間」で 0 のことが多いため、増分としては 2 番目以降を使う。
 */
function usableFrameTimeVector(src: XaCineSource): number[] | null {
  const v = src.frameTimeVectorMs;
  const n = Math.max(1, Math.floor(src.numberOfFrames));
  if (!v || v.length < n || n < 2) return null;
  const incs = v.slice(1, n).filter((x) => Number.isFinite(x) && x > 0);
  return incs.length === n - 1 ? incs : null;
}

/**
 * 各フレームの開始時刻 [ms]（0 起点・長さ = フレーム数）。
 * FrameTimeVector があれば可変間隔、無ければ 1000/fps の等間隔。
 */
export function frameStartTimesMs(src: XaCineSource): number[] {
  const n = Math.max(1, Math.floor(src.numberOfFrames));
  const out = new Array<number>(n);
  const vec = usableFrameTimeVector(src);
  if (vec) {
    out[0] = 0;
    for (let i = 1; i < n; i++) out[i] = out[i - 1] + vec[i - 1];
    return out;
  }
  const { fps } = resolveXaFps(src);
  const step = 1000 / fps;
  for (let i = 0; i < n; i++) out[i] = i * step;
  return out;
}

/** 1 巡の総時間 [ms]（最終フレームの表示時間も含む）。 */
export function cineDurationMs(src: XaCineSource): number {
  const times = frameStartTimesMs(src);
  const n = times.length;
  if (n <= 1) return 1000 / resolveXaFps(src).fps;
  const lastStep = times[n - 1] - times[n - 2];
  return times[n - 1] + lastStep;
}

/**
 * 経過時刻からフレーム番号を引く（0 origin）。
 * 等間隔・可変間隔のどちらも同じコードで扱えるようにするための唯一の入口。
 *
 * @param times   {@link frameStartTimesMs} の結果
 * @param totalMs {@link cineDurationMs} の結果
 * @param loop    true ならラップ、false なら最終フレームで止まる
 */
export function frameAtElapsed(
  times: number[],
  totalMs: number,
  elapsedMs: number,
  loop: boolean,
): number {
  const n = times.length;
  if (n <= 1) return 0;
  let t = elapsedMs;
  if (loop) {
    if (!(totalMs > 0)) return 0;
    t = ((t % totalMs) + totalMs) % totalMs;
  } else if (t >= times[n - 1]) {
    return n - 1;
  }
  if (t <= 0) return 0;
  // 単調増加なので二分探索（数百フレームでも毎フレーム線形走査しない）。
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

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
 * キャッシュ済み dataSet から fps 決定用のタグを読む。プリウォーム前は null。
 * Cornerstone の `cineModule` は FrameTime しか返さないため、生タグを直接読む。
 */
export function readXaCineSource(imageId: string): XaCineSource | null {
  const url = xaSourceUrlOf(imageId);
  if (!url) return null;
  const cache = wadouri.dataSetCacheManager;
  if (!cache.isLoaded(url)) return null;
  const ds = cache.get(url);
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
