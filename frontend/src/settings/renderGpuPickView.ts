// 設定＞描画環境「描画に使う GPU」の表示の判断（純関数）。保存した値と、この起動で実際に付いた値の食い違いが再起動待ち。
import type { RenderGpuChoice, RenderPrefsState } from "../desktopBridge";

/** 再起動で反映される変更が残っているか。 */
export function needsRestart(selected: RenderGpuChoice, appliedHigh: boolean): boolean {
  return (selected === "high") !== appliedHigh;
}

/** 選択肢の「高性能 GPU」の文言のキー。Linux は NVIDIA 限定の仕組みなのでそう書く。 */
export function highLabelKey(platform: string): "renderenv.gpuPick.highLinux" | "renderenv.gpuPick.high" {
  return platform === "linux" ? "renderenv.gpuPick.highLinux" : "renderenv.gpuPick.high";
}

/** Windows・macOS は実機で効くか未確認なので、効果は環境によると添える。 */
export function showsUnverifiedNote(platform: string): boolean {
  return platform === "win32" || platform === "darwin";
}

export function visible(state: RenderPrefsState | null): state is RenderPrefsState {
  return !!state && state.supported;
}
