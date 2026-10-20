/*
 * 実機検証用プラグイン: host.roiTimeSeries() を呼び、結果を window.__roiTsCheck に書く
 * （automator が page.evaluate で読む）。ROI は読み取りだけで、作らない。
 */
export async function activate(host) {
  if (host.surface !== "viewer2d.menu" && host.surface !== "viewer2d.toolbar") return;
  const rois = host.getRois();
  const area = rois.filter((r) => r.tool === "EllipticalROI" || r.tool === "RectangleROI");
  const payload = {
    at: new Date().toISOString(),
    roiCount: rois.length,
    roiTools: rois.map((r) => r.tool),
    series: [],
    unknownRoi: await host.roiTimeSeries(undefined, "no-such-roi"),
  };
  for (const r of area) {
    payload.series.push({
      roiUid: r.roiUid,
      tool: r.tool,
      sliceIndex: r.sliceIndex,
      t: r.t,
      ownMean: r.measurements.mean === undefined ? null : r.measurements.mean,
      result: await host.roiTimeSeries(r.tileId, r.roiUid),
    });
  }
  window.__roiTsCheck = payload;
}
