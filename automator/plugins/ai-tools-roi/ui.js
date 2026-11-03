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
  make_bidirectional: async (args, host) => {
    const base = host.getRois()[0];
    if (!base) return { ok: false, reason: "no-base-roi" };
    const [sx, sy] = base.spacing;
    if (!sx || !sy) return { ok: false, reason: "no-spacing" };
    const c = centroid(base.points);
    const t = ((args.tiltDeg || 0) * Math.PI) / 180;
    const k = ((args.skewDeg || 0) * Math.PI) / 180;
    // 方向は mm の世界で決め、画素へは間隔で割って戻す（異方性の間隔でも直交が保たれる）
    const toPx = (dxMm, dyMm) => [c[0] + dxMm / sx, c[1] + dyMm / sy];
    const u = [Math.cos(t), Math.sin(t)];
    const v = [-Math.sin(t + k), Math.cos(t + k)];
    const hl = args.longMm / 2;
    const hs = args.shortMm / 2;
    const req = {
      tool: "Bidirectional",
      longAxisPx: [toPx(-u[0] * hl, -u[1] * hl), toPx(u[0] * hl, u[1] * hl)],
      shortAxisPx: [toPx(-v[0] * hs, -v[1] * hs), toPx(v[0] * hs, v[1] * hs)],
    };
    return host.createRoi(undefined, req);
  },
  remove_roi: async (args, host) => ({ ok: host.removeCreatedRoi(args.roiUid) }),
};
