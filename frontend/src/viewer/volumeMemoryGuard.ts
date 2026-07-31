/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ボリューム構築前のメモリ量ガード（`fw/volume-memory-guard.md` V2）の**画面側の入口**。
 *
 * <p>予測式そのものは {@link ./volumeMemory}（依存ゼロ・単体テスト対象）にある。こちらは
 * 環境設定の読み出しと `window.confirm` という副作用を持つため分けてある。
 *
 * <p>UI の流儀は既存の先例（`viewer/SeriesViewer.tsx` の「スライス 100 枚超でグリッド表示するとき
 * `window.confirm` で警告し、キャンセルなら状態を変えない」＝`series.grid.warnMany`）をそのまま踏襲する。
 * `window.confirm` を使うと Electron のネイティブダイアログ後のフォーカス喪失対策
 * （`desktopNativeDialogFix.ts` のラッパ → `desktop().refocus()`）が自動で効く。
 */
import type { SeriesLayoutDto } from "../api";
import { fetchSettings } from "../settings/settingsApi";
import { getAppliedVolumeMaxMb, projectVolumeBytes, type VolumeProjection } from "./volumeMemory";

/** 環境設定の警告トグル（既定 ON）。取得できなければ ON 扱い（安全側）。 */
async function isWarnEnabled(): Promise<boolean> {
  try {
    const m = await fetchSettings();
    return m["viewer.volumeWarnBeforeBuild"] !== "false";
  } catch {
    return true;
  }
}

/** {@link confirmVolumeMemory} / {@link projectVolumeMemory} の共通引数。 */
export interface VolumeMemoryGuardArgs {
  /**
   * 対象シリーズのレイアウト。面内サイズとピクセル形式をここから読む。
   * **null なら予測しない**（layout 取得に失敗したフォールバック経路）。
   */
  layout: SeriesLayoutDto | null | undefined;
  /**
   * 実際に volume 化されるスライス数。**`nZ` ではなく、構築に渡す `imageIds` の件数**を渡すこと
   * （マルチ C/T シリーズでは (c,t) で絞った件数になる）。
   */
  sliceCount: number;
  modality: string | null;
  target: "mpr" | "viewer3d";
}

/** 予測だけを行う（確認は出さない）。予測できなければ null。 */
export function projectVolumeMemory(args: VolumeMemoryGuardArgs): VolumeProjection | null {
  const layout = args.layout;
  if (!layout) return null;
  return projectVolumeBytes({
    imageWidth: layout.imageWidth,
    imageHeight: layout.imageHeight,
    sliceCount: args.sliceCount,
    pixelFormat: layout.pixelFormat,
    target: args.target,
    modality: args.modality,
  });
}

/** {@link confirmVolumeMemory} の判定結果。 */
export interface VolumeMemoryDecision {
  /** ボリューム構築へ進んでよいか。false なら呼び出し側は構築せずに戻る。 */
  proceed: boolean;
  /**
   * `buildMprVolume` の第 4 引数 `opts.maxBytes` にそのまま渡す値（二重防御）。
   *
   * <p>**予測できなかったときだけ数値が入る。** 予測できたうえで利用者が「続行」を選んだ場合は
   * `undefined` にして二段目を無効化する（確認したのに後段で無条件に止められたら筋が通らない）。
   */
  enforceMaxBytes?: number;
}

/**
 * ボリューム構築の直前に必要量を予測し、バジェットを超えるなら確認を出す。
 *
 * <p>**予測できない場合・警告 OFF の場合も `proceed: true`**（＝V1 のエラー識別に委ねる。
 * 予測は best-effort、防御は二段という設計）。
 */
export async function confirmVolumeMemory(
  args: VolumeMemoryGuardArgs & { t18n: (key: string, params?: Record<string, string>) => string },
): Promise<VolumeMemoryDecision> {
  const budgetMb = getAppliedVolumeMaxMb();
  const projection = projectVolumeMemory(args);
  if (!projection) {
    // 予測不能（layout 未取得など）。ロード後に寸法が確定してから二段目で見る。
    return { proceed: true, enforceMaxBytes: budgetMb * 1024 * 1024 };
  }
  if (projection.mb <= budgetMb) return { proceed: true };
  if (!(await isWarnEnabled())) return { proceed: true };
  const ok = window.confirm(
    args.t18n("common.volumeMemWarn", {
      needMb: String(projection.mb),
      budgetMb: String(budgetMb),
    }),
  );
  // 利用者が「続行」を選んだのだから、二段目で止め直さない。
  return { proceed: ok };
}
