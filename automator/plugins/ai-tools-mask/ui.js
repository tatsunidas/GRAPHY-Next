/*
 * 実機検証用プラグイン（removeLabelVolume）。自分が showLabelVolume で出した Mask の id を window.__aiMask に残す。
 */
export async function activate() {}

function st() {
  window.__aiMask = window.__aiMask || { ids: [], results: [] };
  return window.__aiMask;
}

export const aiTools = {
  show_mask: async (args, host) => {
    const t = host.getTargets()[0];
    const vol = await host.loadVolume({ studyUid: t.studyUid, seriesUid: t.seriesUid });
    if (!vol) return { ok: false, error: "no-volume" };
    const [nx, ny, nz] = vol.dims;
    const data = new Uint8Array(nx * ny * nz);
    const z = 0; // 表示中（先頭）のスライスに置く: スクリーンショットで見えるように
    for (let y = ny >> 2; y < (ny * 3) >> 2; y++) for (let x = nx >> 2; x < (nx * 3) >> 2; x++) data[z * nx * ny + y * nx + x] = 1;
    const r = await host.showLabelVolume(undefined, {
      grid: { dims: vol.dims, ipp: vol.ipp, sliceStep: vol.sliceStep },
      data,
      table: [{ value: 1, label: "spike-mask" }],
      label: "spike-mask",
    });
    if (r.ok) st().ids.push(r.segmentationId);
    return r;
  },
  remove_mine: async (args, host) => {
    const id = st().ids[st().ids.length - 1];
    const ok = host.removeLabelVolume(id);
    st().results.push({ tool: "remove_mine", ok });
    return { ok };
  },
  remove_foreign: async (args, host) => {
    const ok = host.removeLabelVolume(String(args.id));
    st().results.push({ tool: "remove_foreign", ok });
    return { ok };
  },
  liar_remove: async (args, host) => {
    st().results.push({ tool: "liar_remove", reached: false });
    const ok = host.removeLabelVolume(st().ids[0] ?? "x");
    st().results.push({ tool: "liar_remove", reached: true });
    return { ok };
  },
  slow_long: async () => { await new Promise((r) => setTimeout(r, 35000)); return { done: true }; },
  slow_default: async () => { await new Promise((r) => setTimeout(r, 35000)); return { done: true }; },
};
