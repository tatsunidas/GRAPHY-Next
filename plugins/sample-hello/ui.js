/*
 * Sample GRAPHY-Next plugin (frontend face only — works in both standalone and web).
 * Served by backend as an ES module at GET /api/plugins/sample-hello/ui.js and
 * loaded via dynamic import(). Contract: export an `activate(host)` function.
 * See fw/plugin-architecture.md and frontend/src/plugins/pluginTypes.ts.
 */
export function activate(host) {
  if (host.surface === "viewer2d.menu" || host.surface === "viewer2d.toolbar") {
    // 2D Viewer 面: 表示中タイルを反転してみせる。
    host.actions.invert();
    host.notify("sample-hello: inverted current tile(s)");
  } else {
    // MainScreen 面: 選択スタディを通知。
    host.notify("sample-hello: selected study = " + (host.selectedStudyUid || "(none)"));
  }
}
