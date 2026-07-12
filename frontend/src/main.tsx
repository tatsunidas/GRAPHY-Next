/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./i18n/i18n";
import { ErrorBoundary } from "./ErrorBoundary";
import { verifyToolIcons } from "./icons/toolIcons";
import { installLevelSetDebug } from "./viewer/levelSetsDebug";
import { installNativeDialogFocusFix } from "./desktopNativeDialogFix";

// dev のみ: アイコン未登録のツールを起動時に警告（本番では no-op）。
verifyToolIcons();
// Electron: ネイティブダイアログ（confirm/alert/prompt）後に入力フォーカスが失われる
// 既知挙動への対処（デスクトップのみ有効・web では no-op）。
installNativeDialogFocusFix();
// 診断: Level Sets Worker が起動するか Console で `__graphyLevelSetSelfTest()` を実行して確認。
// Cornerstone 初期化に依存しないため、Viewer を開かなくても（起動直後から）呼べる。
installLevelSetDebug();

// 注意: React.StrictMode は付けない。
// StrictMode は開発時に「mount → cleanup → remount」と effect を二重実行するが、
// Cornerstone3D（命令的 WebGL / 単一共有 RenderingEngine）はこの二重マウントに弱く、
// 同一 element に対する enableElement→setStack の競合でビューポートのカメラ fit が壊れ、
// CT 等が「初回正常→直後に極小スケールで真っ黒」になる（parallelScale が ~200倍に暴走）。
// 本番ビルドは元々単一マウントのため影響なし。StrictMode を外して dev を本番挙動に揃える。
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <I18nProvider>
      <App />
    </I18nProvider>
  </ErrorBoundary>,
);
