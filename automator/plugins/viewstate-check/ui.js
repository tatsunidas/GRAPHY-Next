/*
 * 実機検証用プラグイン（第三者プラグインと同じ経路＝plugins/ フォルダ直下に置いて
 * backend から配信される ES モジュール）。
 *
 * 目的: host API H2 の `getViewState().visibleRegion` が、ビューアの**拡大・パン・回転に
 * 実際に追従しているか**を、DOM を一切覗かずに測る。
 *
 * <p>なぜ要るか: Art of Imaging の「Image to be sent」は visibleRegion だけを見て切り出す。
 * ここが画面と食い違っていても**例外は出ず、送られる絵の構図が違うだけ**なので、
 * 画面を見ても気付けない（2026-09-24 に利用者が「拡大・パンが反映されない」と報告）。
 *
 * <p>🔑 **1 回起動したらサンプラーを window に置く。** メニューを押すたびに 1 回だけ測る形だと、
 * 「拡大する前 / した後」を同じ条件で比べにくい。`window.__viewStateSample()` を呼べば
 * いつでも現在値が取れるようにして、automator 側が操作の前後で自由に測れるようにする。
 */

/** 四隅を小数 2 桁に丸める（そのまま比較・印字できるように）。 */
function roundCorners(corners) {
  return corners.map((c) => [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100]);
}

/**
 * 表示状態の要約。
 *
 * <p>`spanCols` / `spanRows` は「見えている範囲が元画像の何画素ぶんか」。
 * **拡大すればこれが小さくなる**のが期待で、判定はこの 1 つで足りる。
 */
function summarize(host) {
  const targets = host.getTargets();
  if (!targets.length) return { error: "no target" };
  const t = targets[0];
  const v = host.getViewState(t.tileId);
  if (!v) return { error: "no view state" };
  const r = v.visibleRegion;
  const out = {
    tileId: t.tileId,
    modality: t.modality,
    imageId: String(t.imageId).slice(-48),
    zoom: v.zoom,
    pan: v.pan,
    rotation: v.rotation,
    flipH: v.flipH,
    flipV: v.flipV,
    windowWidth: v.windowWidth,
    windowCenter: v.windowCenter,
    hasVisibleRegion: !!r,
  };
  if (r) {
    const [tl, tr, bl] = r.corners;
    out.corners = roundCorners(r.corners);
    out.screenWidth = Math.round(r.screenWidth);
    out.screenHeight = Math.round(r.screenHeight);
    // 辺の長さ＝覆っている元画像の画素数（斜めでも成立する測り方）。
    out.spanCols = Math.round(Math.hypot(tr[0] - tl[0], tr[1] - tl[1]) * 100) / 100;
    out.spanRows = Math.round(Math.hypot(bl[0] - tl[0], bl[1] - tl[1]) * 100) / 100;
  }
  return out;
}

export async function activate(host) {
  window.__viewStateSample = () => {
    try {
      return summarize(host);
    } catch (e) {
      return { error: String(e) };
    }
  };
  const first = window.__viewStateSample();
  window.__viewStateCheck = { started: true, first };

  const el = document.getElementById("viewstate-check-panel") || document.createElement("pre");
  el.id = "viewstate-check-panel";
  el.dataset.testid = "viewstate-check-panel";
  el.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:99999;max-width:46vw;white-space:pre-wrap;" +
    "background:rgba(0,0,0,.82);color:#d7e2ec;font:11px/1.45 monospace;padding:8px;border-radius:6px";
  el.textContent = JSON.stringify(first, null, 2);
  document.body.appendChild(el);
  host.notify("viewstate-check: window.__viewStateSample() で現在の表示状態を取れます");
}
