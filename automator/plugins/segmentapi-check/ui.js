/*
 * H80 / H81 の実機検証用プローブ。画面は出さない。automator が Wand の前後に呼べるよう、
 * window.__segCheck に呼び出し口を置く。判定は automator 側（src/spike/segmentApiCheck.ts）。
 */
export async function activate(host) {
  const tile = () => host.getTargets()[0]?.tileId;
  window.__segCheck = {
    hasApi: typeof host.listSegments === "function" && typeof host.loadSegmentMask === "function",
    list: () => host.listSegments(),
    /** マスクの要約。値は同じタイルの getPixelData の同じ画素（スタック順の sliceIndex）から読む。 */
    async summary(segmentationId, segmentIndex) {
      const m = await host.loadSegmentMask(tile(), segmentationId, segmentIndex);
      if (m === null) return null;
      let sum = 0, n = 0, min = Infinity, max = -Infinity;
      const perSlice = [];
      for (const s of m.slices) {
        const pd = await host.getPixelData(tile(), { sliceIndex: s.sliceIndex });
        let c = 0;
        for (let i = 0; i < s.data.length; i++) {
          if (!s.data[i]) continue;
          c++;
          const v = pd.data[i];
          sum += v; n++;
          if (v < min) min = v;
          if (v > max) max = v;
        }
        perSlice.push({ sliceIndex: s.sliceIndex, count: c, sop: s.sopInstanceUid, length: s.data.length });
      }
      return { cols: m.cols, rows: m.rows, voxelCount: m.voxelCount, sliceCount: m.slices.length, perSlice, mean: n ? sum / n : null, min, max };
    },
    mask: (id, idx) => host.loadSegmentMask(tile(), id, idx),
    /** 返ってきた配列を書き換えてから、もう一度読んで、前景の数が変わらないか（コピーか）を見る。 */
    async mutateThenReload(id, idx) {
      const a = await host.loadSegmentMask(tile(), id, idx);
      if (!a) return null;
      for (const s of a.slices) s.data.fill(0);
      const b = await host.loadSegmentMask(tile(), id, idx);
      return { before: a.voxelCount, after: b ? b.voxelCount : null };
    },
  };
}
