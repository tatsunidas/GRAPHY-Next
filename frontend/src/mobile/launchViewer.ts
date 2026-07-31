/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * モバイルシェルから 3D / MPR を開く（`fw/mobile-ui-design.md` M5・§3.2）。
 *
 * <p>デスクトップは `window.open` で別ウィンドウに出すが、モバイルブラウザでは新規タブ扱い＋
 * ポップアップブロック対象なので、**同一タブの hash 遷移**にする。`location.hash` への代入は
 * 履歴に積まれるので、**ブラウザの「戻る」でモバイルシェルへ戻れる**。
 *
 * <p>受け渡しは既存のコンテキスト方式（`graphy-mpr-ctx` / `graphy-viewer3d-ctx`）をそのまま使う。
 * **同一タブでも localStorage は普通に読めるので、この仕組みは変更不要**（§3.2）。
 * `MprScreen` / `Viewer3DScreen` はマウント時にこれを読む。
 */
import type { Series, Study } from "../api";

/** モバイルから開けるボリューム系ビューア。Slicer は非対応（§2）。 */
export type MobileVolumeViewer = "mpr" | "viewer3d";

const CTX_KEY: Record<MobileVolumeViewer, string> = {
  mpr: "graphy-mpr-ctx",
  viewer3d: "graphy-viewer3d-ctx",
};

/**
 * コンテキストを書いて同一タブで開く。
 *
 * <p>⚠️ 起動元 2D タイルの C/T を引き継ぐ `c` / `t` は、モバイルでは常に既定（0）。
 * モバイルシェルは 2D のマルチ C/T 切替 UI を持たないため。
 */
export function launchMobileVolumeViewer(
  kind: MobileVolumeViewer,
  study: Study,
  series: Series,
  now: number,
): void {
  try {
    localStorage.setItem(CTX_KEY[kind], JSON.stringify({ study, series, ts: now }));
  } catch {
    // 書けなくても遷移はする（画面側が「コンテキストなし」を表示する）。
  }
  window.location.hash = kind;
}
