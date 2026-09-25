/**
 * 動画のフレーム番号（1 始まり）と再生時刻の変換（`VideoViewer` のフレーム送り）。
 *
 * <p>Cornerstone の `VideoViewport.setFrameNumber(n)` は **フレームの境目** `(n-1)/fps` へシークし、
 * 読み戻しは `getFrameNumber() = 1 + round(currentTime·fps)`（3.33.5）。境目ではブラウザが描く絵が
 * n か n-1 か曖昧になり、「本当に 1 フレームずつ進んでいるのか分からない」原因になる。
 *
 * <p>そこで **フレームの 1/4 の位置** `(n - 1 + 0.25)/fps` へシークする。
 *   - ブラウザは時刻を含むフレーム（[ (n-1)/fps, n/fps ) ）を描く → 絵は n
 *   - Cornerstone の読み戻し `1 + round(n - 0.75)` = n → 番号も n
 * 半フレームちょうど（中央）にしないのは、`round` が 0.5 を切り上げて n+1 を返すため。
 */
const INTO_FRAME = 0.25;

/** フレーム n を表示させるための時刻（秒）。`duration` があれば、それを越えない。 */
export function frameToSeekTime(n: number, fps: number, duration?: number): number {
  const t = (n - 1 + INTO_FRAME) / fps;
  if (duration != null && Number.isFinite(duration) && duration > 0) {
    return Math.min(t, Math.max(0, duration - 1e-3));
  }
  return t;
}

/** Cornerstone の VideoViewport と同じ読み戻し（`1 + round(t·fps)`）。検査用に写しておく。 */
export function cornerstoneFrameOf(t: number, fps: number): number {
  return 1 + Math.round(t * fps);
}

/** 1 始まりの範囲に収める。 */
export function clampFrame(n: number, total: number): number {
  return Math.min(Math.max(1, Math.round(n)), Math.max(1, total));
}
