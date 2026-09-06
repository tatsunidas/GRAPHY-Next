/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA/XRF シネの**時間軸**（`fw/angio-design.md` §5.4 / §5.5）。**純関数だけ**。
 *
 * <h3>なぜ `xaCine.ts` から分けたか（2026-09-06）</h3>
 * `xaCine.ts` は先頭で `@cornerstonejs/dicom-image-loader` を import しているため、
 * **プラグインへ写せない**（`graphy-next-plugin-angio-quant/tools/syncCore.mjs` は
 * 本体依存が混ざったモジュールを写せない）。QFR の造影流速は「3D 弧長 ÷ 通過時間」で
 * 決まるので、**フレーム番号を秒に直す規則をプラグインと共有する必要がある**。
 *
 * <p>🔴 **規則を 2 つ持たないこと。** ここが本体（TIMI フレームカウント・シネ再生）と
 * プラグイン（QFR）の**唯一の定義**である。片方だけ直すと、同じ製品の中で
 * 「同じランの fps が画面と解析で違う」という、目視では気づけない壊れ方をする。
 *
 * <p>Cornerstone のキャッシュに触る層（`prewarmXaDataset` / `readXaCineSource` /
 * `xaDataSetOf`）は `xaCine.ts` に残っている。既存の import を壊さないため、
 * `xaCine.ts` はここの公開名を**そのまま再輸出**している。
 */

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

/**
 * フレーム間隔が一様か（可変レート収集の検出）。
 *
 * <p>可変レートのランでは「フレーム差 × 1/fps」が実時間と合わない。TIMI フレームカウント
 * （本体）も QFR の造影流速（プラグイン）も、経過時間は {@link frameStartTimesMs} の差で取る。
 */
export function isUniformFrameTime(cine: XaCineSource): boolean {
  const times = frameStartTimesMs(cine);
  if (times.length < 3) return true;
  const first = times[1] - times[0];
  if (!(first > 0)) return false;
  for (let i = 2; i < times.length; i++) {
    const step = times[i] - times[i - 1];
    // 1/1000 の相対差までは同じ間隔とみなす（浮動小数の丸め）。
    if (Math.abs(step - first) > first * 1e-3) return false;
  }
  return true;
}
