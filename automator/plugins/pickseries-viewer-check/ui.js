/*
 * 実機検証用プラグイン（2D ビューアの menu から host.db.pickSeries を呼ぶ）。
 * automator が window.__pickInput（pickSeries の引数）を置いてから起動し、結果は window.__pickState に置く。
 * 2D ビューアと main は別ウィンドウ（別の window）なので、結果は呼んだ側のウィンドウに出る。
 */
export async function activate(host) {
  const st = (window.__pickState = { called: true, picked: null, error: null });
  try {
    st.picked = await host.db.pickSeries(window.__pickInput || {});
  } catch (e) {
    st.error = String(e);
  }
}
