/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA の空間校正を**シリーズ単位で残す**（`fw/angio-design.md` §7.4 の「永続化」）。
 *
 * <h3>なぜ要るのか</h3>
 * 校正はこれまで {@link ./xaCalibrationProvider} のメモリ Map にしか無く、**シリーズを閉じると消えた**。
 * 校正はカテーテル径を測って人が確定する手間のかかる作業で、消えると毎回やり直しになる。
 * しかも「前回 mm で読めたのに今日は px」という**気づきにくい退行**として現れる。
 *
 * <h3>置き場所</h3>
 * backend の設定ストア（`/api/settings`）に `xa.calibration.<SeriesInstanceUID>` の 1 キー 1 件で置く。
 * まとめて 1 キーの JSON にしないのは、値の列が 4000 文字までだから（シリーズが増えると溢れる）。
 *
 * <h3>🚨 これは環境設定ではなく症例に紐づくデータ</h3>
 * だから automator の reset は**このプレフィックスだけ**消す（`AutomatorService`）。
 * 消し残すと、前の実行で確定した校正が次の実行に効いて
 * **「未校正なら px 表示」の検証が黙って通る**。
 */
import { fetchSettings, saveSettings } from "../settings/settingsApi";
import type { XaUserCalibration } from "./xaCalibration";
import { extractCalibrations, serialize, XA_CALIBRATION_PREFIX } from "./xaCalibrationStorage";
import { clearXaCalibrationCache, setXaUserCalibration } from "./xaCalibrationProvider";

let loaded: Promise<number> | null = null;

/**
 * 保存済みの校正をメモリへ戻す（アプリ内で 1 回だけ走る）。
 *
 * @returns 復元した件数
 */
export function ensureXaCalibrationsLoaded(): Promise<number> {
  if (!loaded) {
    loaded = fetchSettings()
      .then((map) => {
        const calibs = extractCalibrations(map);
        for (const [seriesUid, calib] of calibs) {
          setXaUserCalibration(seriesUid, calib);
        }
        // 復元したら、既に解決済みのキャッシュは古い（未校正のまま覚えている）。
        clearXaCalibrationCache();
        return calibs.size;
      })
      .catch(() => 0);
  }
  return loaded;
}

/** テスト・シリーズ切替用（読み込みをやり直させる）。 */
export function resetXaCalibrationLoadState(): void {
  loaded = null;
}

/**
 * 校正を確定して**残す**。呼び出し側は必ずこちらを使う
 * （`setXaUserCalibration` を直に呼ぶと、その場では効くが次に開いたとき消えている）。
 *
 * @param calib null なら解除（保存も消す）
 */
export async function persistXaUserCalibration(
  seriesUid: string,
  calib: XaUserCalibration | null,
): Promise<void> {
  setXaUserCalibration(seriesUid, calib);
  clearXaCalibrationCache();
  if (!seriesUid) return;
  // 解除は空文字で上書きする（設定ストアに削除 API が無い。空は「無い」として読む）。
  const value = calib ? serialize(calib, new Date().toISOString()) : "";
  await saveSettings({ [`${XA_CALIBRATION_PREFIX}${seriesUid}`]: value });
}
