/*
 * 実機検証用プラグイン（host.createRoi / removeCreatedRoi を AI の write ツールから呼ぶ）。
 * px モード: 最初の ROI の画素座標の重心を `centerPx` に渡す。lps モード: 前の呼び出しが返した `centerLps`（+dz）を渡す。
 */
export async function activate() {}

function centroid(points) {
  const n = points.length;
  const s = points.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  return [s[0] / n, s[1] / n];
}

export const aiTools = {
  list_roi_uids: async (args, host) => ({ uids: host.getRois().map((r) => r.roiUid) }),
  make_roi: async (args, host) => {
    const req = { tool: args.shape, radiiMm: [args.rx, args.ry] };
    if (args.mode === "lps") {
      const c = window.__roiDemoCenter;
      if (!c) return { ok: false, reason: "no-previous-center" };
      req.centerLps = [c[0], c[1], c[2] + (args.dz || 0)];
    } else {
      const base = host.getRois()[0];
      if (!base) return { ok: false, reason: "no-base-roi" };
      req.centerPx = centroid(base.points);
    }
    const r = host.createRoi(undefined, req);
    if (r.ok) window.__roiDemoCenter = r.centerLps;
    return r;
  },
  remove_roi: async (args, host) => ({ ok: host.removeCreatedRoi(args.roiUid) }),
};
