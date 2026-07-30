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
/** Float32Array の要約（生配列を全部持ち回らずに検証できるようにする）。 */
function summarize(px) {
  if (!px) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of px.data) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const n = px.data.length;
  return {
    imageId: px.imageId,
    sliceIndex: px.sliceIndex,
    rows: px.rows,
    cols: px.cols,
    unit: px.unit,
    spacing: px.spacing,
    length: n,
    isFloat32: px.data instanceof Float32Array,
    min,
    max,
    mean: sum / n,
    // 中央画素（body 内部＝空気ではないはず）。
    center: px.data[Math.floor(px.rows / 2) * px.cols + Math.floor(px.cols / 2)],
  };
}

export async function activate(host) {
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
    // H3: 校正済み画素。表示中スライス / 別スライス指定 / 範囲外 / 未知タイル。
    pixels: summarize(await host.getPixelData()),
    pixelsSlice0: summarize(await host.getPixelData(targets[0]?.tileId, { sliceIndex: 0 })),
    pixelsOutOfRange: await host.getPixelData(targets[0]?.tileId, { sliceIndex: 9999 }),
    pixelsUnknownTile: await host.getPixelData("no-such-tile"),
  };

  // H4a: 読んだ画素から閾値マスクを作って重ねる（NaN=透明）。サイズ不一致は拒否されること。
  const px = await host.getPixelData();
  if (px) {
    const mask = new Float32Array(px.data.length);
    let hit = 0;
    for (let i = 0; i < px.data.length; i++) {
      if (px.data[i] >= 300) {
        mask[i] = px.data[i];
        hit++;
      } else {
        mask[i] = NaN;
      }
    }
    payload.overlay = {
      shown: host.showOverlay(px.tileId, {
        data: mask,
        rows: px.rows,
        cols: px.cols,
        window: { center: 800, width: 1000 },
        // 本体の LUT 資産で色付けさせる（白い骨の上に白を重ねても人には見えないため）。
        colormap: "Hot_Iron",
        opacity: 0.6,
      }),
      hit,
      // 格子が合わないマップは拒否されるべき（勝手に伸縮しない）。
      mismatchRejected:
        host.showOverlay(px.tileId, { data: new Float32Array(4), rows: 2, cols: 2 }) === false,
      unknownTileRejected: host.showOverlay("no-such-tile", {
        data: mask,
        rows: px.rows,
        cols: px.cols,
      }) === false,
    };
  }
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
  const p = payload.pixels;
  const lines = ["[hostapi-check] targets=" + targets.length];
  if (p) {
    lines.push(
      "  pixels: " + p.cols + "x" + p.rows + " " + p.unit +
      " min=" + p.min.toFixed(0) + " max=" + p.max.toFixed(0) +
      " mean=" + p.mean.toFixed(1) + " center=" + p.center.toFixed(0) +
      "\n    spacing=[" + p.spacing.join(", ") + "] float32=" + p.isFloat32,
    );
  }
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
