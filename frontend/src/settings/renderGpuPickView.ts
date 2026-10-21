// 設定＞描画環境「描画に使う GPU」の表示の判断（純関数）。保存した値と、この起動で実際に付いた値の食い違いが再起動待ち。
import type { RenderGpuChoice, RenderPrefsState } from "../desktopBridge";

/** 再起動で反映される変更が残っているか。 */
export function needsRestart(selected: RenderGpuChoice, appliedHigh: boolean): boolean {
  return (selected === "high") !== appliedHigh;
}

/** 実機で効くことを確かめていない経路（Windows・macOS・Linux の AMD）では、検証中の注記を出す。 */
export function showsUnverifiedNote(state: RenderPrefsState): boolean {
  return state.unverified;
}

/** GPU が見つからない起動でも、選択が高性能なら（理由を伝えるために）節を出す。 */
export function visible(state: RenderPrefsState | null): state is RenderPrefsState {
  return !!state && (state.supported || state.prefs.gpu === "high" || state.fallback !== null);
}

/** 付けなかった理由の文言キー。［もう一度試す］が意味を持つのは、GPU が見つからないとき以外。 */
export function fallbackKey(f: RenderPrefsState["fallback"]): "renderenv.gpuPick.fallback.missing" | "renderenv.gpuPick.fallback.unconfirmed" | "renderenv.gpuPick.fallback.failed" | null {
  return f === null ? null : (`renderenv.gpuPick.fallback.${f}` as const);
}
export function canRetry(f: RenderPrefsState["fallback"]): boolean {
  return f === "unconfirmed" || f === "failed";
}
