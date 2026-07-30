/*
 * 実機検証用プラグイン（H4b）。表示中スライスの HU から閾値マスクを作り、
 * 派生シリーズとして保存する。保存前に**本体が**確認ダイアログを出すので、
 * automator はそのダイアログを操作して「承諾／拒否」の両方を検証する。
 *
 * 結果は window.__hostApiCheck.save / .saveMismatch に置く（page.evaluate で読む）。
 */
export async function activate(host) {
  if (host.surface !== "viewer2d.menu" && host.surface !== "viewer2d.toolbar") return;
  const px = await host.getPixelData();
  if (!px) {
    window.__hostApiCheck = { save: { ok: false, error: "no pixels" } };
    return;
  }
  const mask = new Float32Array(px.data.length);
  for (let i = 0; i < px.data.length; i++) {
    mask[i] = px.data[i] >= 300 ? px.data[i] : NaN;
  }

  // 格子が合わないフレームは**同意を求める前に**拒否されるべき（幾何を偽装できない）。
  const saveMismatch = await host.saveDerivedSeries(px.tileId, {
    seriesDescription: "should be rejected",
    frames: [{ sliceIndex: px.sliceIndex, data: new Float32Array(4) }],
    rows: 2,
    cols: 2,
  });

  const save = await host.saveDerivedSeries(px.tileId, {
    seriesDescription: "Bone mask",
    derivationDescription: "Threshold >= 300 HU",
    frames: [{ sliceIndex: px.sliceIndex, data: mask }],
    rows: px.rows,
    cols: px.cols,
    unit: px.unit,
  });

  window.__hostApiCheck = { save, saveMismatch };
}
