/*
 * 実機検証用プラグイン（第三者プラグインと同じ経路＝plugins/ フォルダ直下に置いて
 * backend の /api/plugins から配信される ES モジュール）。
 *
 * host API H1/H2（fw/plugin-architecture.md §7）だけを使い、DOM を一切覗かずに
 * 「いま何を見ているか」を取得できることを確認する。結果は
 *   - window.__hostApiCheck  … automator が page.evaluate で読む
 *   - 画面右上のパネル        … スクリーンショットで人が読む
 * の両方へ出す。
 */
export function activate(host) {
  if (host.surface !== "viewer2d.menu" && host.surface !== "viewer2d.toolbar") return;

  const targets = host.getTargets();
  const payload = {
    at: new Date().toISOString(),
    // DOM 依存なし: 公式契約だけで対象タイルを列挙できるか。
    targets,
    // tileId 指定と省略（=対象の先頭）の両方。
    states: targets.map((t) => host.getViewState(t.tileId)),
    defaultState: host.getViewState(),
    unknownTile: host.getViewState("no-such-tile"),
  };
  window.__hostApiCheck = payload;

  const id = "hostapi-check-panel";
  document.getElementById(id)?.remove();
  const el = document.createElement("div");
  el.id = id;
  el.setAttribute("data-testid", id);
  el.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:99999;max-width:520px;padding:8px 10px;" +
    "background:#111c;color:#e8e8e8;font:11px/1.5 monospace;border:1px solid #4a90d9;" +
    "border-radius:4px;white-space:pre-wrap";
  const lines = ["[hostapi-check] targets=" + targets.length];
  for (const t of targets) {
    const v = host.getViewState(t.tileId);
    lines.push(
      "  tile=" + t.tileId +
      "\n    series=" + t.seriesLabel + " (" + t.modality + ")" +
      "\n    slice=" + (t.sliceIndex + 1) + "/" + t.sliceCount + "  c=" + t.c + " t=" + t.t +
      "\n    studyUid=" + t.studyUid +
      "\n    seriesUid=" + t.seriesUid +
      "\n    imageId=" + String(t.imageId).slice(0, 72) +
      (v
        ? "\n    W/L=" + v.windowWidth.toFixed(0) + "/" + v.windowCenter.toFixed(0) + " " + v.unit +
          "\n    lut=" + v.colormap + " invert=" + v.invert + " flipH=" + v.flipH + " flipV=" + v.flipV +
          "\n    rot=" + v.rotation + " zoom=" + v.zoom.toFixed(3) + " pan=[" + v.pan.map((n) => n.toFixed(1)).join(", ") + "]"
        : "\n    (view state unavailable)"),
    );
  }
  el.textContent = lines.join("\n");
  document.body.appendChild(el);
}
