/// <reference path="./graphy-plugin.d.ts" />
// @ts-check
/*
 * GRAPHY-Next プラグインのフロント面（ES モジュール）。ビルド不要でそのまま配布できる。
 * メニュークリック時に activate(host) が呼ばれる。host はサーフェス別のコンテキスト。
 * 型補完は同梱の graphy-plugin.d.ts による（上の reference / @ts-check）。
 */

/** @param {import('./graphy-plugin').PluginHost} host */
export function activate(host) {
  if (host.surface === "mainscreen.menu") {
    // MainScreen 面: 選択中スタディを通知。
    host.notify("my-plugin: study = " + (host.selectedStudyUid || "(none)"));
  } else {
    // 2D Viewer 面（viewer2d.menu / viewer2d.toolbar）: 表示中タイルを白黒反転して通知。
    host.actions.invert();
    host.notify("my-plugin: inverted current tile(s)");

    // 「いま何を見ているか」を問い合わせたい場合（GRAPHY-Next 0.1.9 以降）。
    // 使うなら plugin.json の engines.graphy を ">=0.1.9" に上げること。
    //
    //   for (const target of host.getTargets()) {
    //     const view = host.getViewState(target.tileId);
    //     host.notify(
    //       target.seriesLabel + " slice " + (target.sliceIndex + 1) + "/" + target.sliceCount +
    //       (view ? " W/L " + view.windowWidth + "/" + view.windowCenter + " " + view.unit : "")
    //     );
    //   }
  }
}
