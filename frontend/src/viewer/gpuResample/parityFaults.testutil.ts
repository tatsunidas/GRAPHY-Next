/*
 * 一致検査器の負例: CPU の computeFusionSlice の写しに、実際に起きる種類の誤りを 1 つ入れた版。
 * GPU のシェーダと同じ仮定で作らない（CPU の式の写しで作る）。本番コードから import しない。
 */
import type { BackgroundSliceMeta, FusionSlice, FusionVolume } from "../fusionEngine";
import {
  composeTransforms, dvfTransform, mat4InvertAffine, linearTransform,
  type CompositeTransform, type DvfTransform, type LinearTransform, type Vec3, type WorldTransform,
} from "../regTransform";

export type Fault = "halfVoxel" | "rowColSwap" | "pushForward" | "sliceOffByOne" | "slopeOneSided" | "dvfAxisOrder";
export const FAULTS: Fault[] = ["halfVoxel", "rowColSwap", "pushForward", "sliceOffByOne", "slopeOneSided", "dvfAxisOrder"];

function leaves(xf: WorldTransform | null | undefined): WorldTransform[] {
  if (!xf || xf.kind === "identity") return [];
  if (xf.kind === "composite") return (xf as CompositeTransform).chain.flatMap(leaves);
  return [xf];
}

/** 誤りを入れる前の変換を作り替える。適用できない組合せ（その誤りの対象を含まない）は null。 */
export function faultyTransform(xf: WorldTransform | null, fault: Fault | "none"): WorldTransform | null | "n/a" {
  if (fault === "pushForward") {
    const ls = leaves(xf);
    if (ls.length !== 1 || ls[0].kind !== "linear") return "n/a";
    const inv = mat4InvertAffine((ls[0] as LinearTransform).matrix);
    return inv ? linearTransform(inv, { dof: 12 }) : "n/a";
  }
  if (fault === "dvfAxisOrder") {
    const ls = leaves(xf);
    if (!ls.some((l) => l.kind === "dvf")) return "n/a";
    return composeTransforms(...ls.map((l) => {
      if (l.kind !== "dvf") return l;
      const d = l as DvfTransform;
      const p = new Float32Array(d.displacements.length);
      for (let i = 0; i < p.length; i += 3) {
        p[i] = d.displacements[i + 1]; p[i + 1] = d.displacements[i + 2]; p[i + 2] = d.displacements[i];
      }
      return dvfTransform(p, d.dims, d.origin, d.spacing);
    }));
  }
  return xf;
}

export function computeFusionSliceWithFault(
  fg: FusionVolume, bg: BackgroundSliceMeta, xfIn: WorldTransform | null, fault: Fault | "none",
): Float32Array | "n/a" {
  const xf0 = faultyTransform(xfIn, fault);
  if (xf0 === "n/a") return "n/a";
  const xf = xf0;
  const out = new Float32Array(bg.rows * bg.cols).fill(NaN);
  const d = fg.slices.length;
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const fRr: Vec3 = [fg.iop[0], fg.iop[1], fg.iop[2]];
  const fRc: Vec3 = [fg.iop[3], fg.iop[4], fg.iop[5]];
  const fRs: Vec3 = [fRr[1] * fRc[2] - fRr[2] * fRc[1], fRr[2] * fRc[0] - fRr[0] * fRc[2], fRr[0] * fRc[1] - fRr[1] * fRc[0]];
  const bRr: Vec3 = [bg.iop[0], bg.iop[1], bg.iop[2]];
  const bRc: Vec3 = [bg.iop[3], bg.iop[4], bg.iop[5]];
  const ip0 = fg.slices[0].ipp;
  const wPos = fg.slices.map((s) => dot(sub(s.ipp, ip0), fRs));
  const xp: Vec3 = [0, 0, 0];
  const useXf = !!xf && xf.kind !== "identity";
  const W = fg.cols, H = fg.rows;

  const bil = (s: FusionSlice, u: number, v: number) => {
    const iu = Math.floor(u), iv = Math.floor(v);
    const iu1 = Math.min(iu + 1, W - 1), iv1 = Math.min(iv + 1, H - 1);
    const iu0 = Math.max(0, iu), iv0 = Math.max(0, iv);
    const uu = Math.min(1, Math.max(0, u - iu)), vv = Math.min(1, Math.max(0, v - iv));
    const p = s.pixels;
    return p[iv0 * W + iu0] * (1 - uu) * (1 - vv) + p[iv0 * W + iu1] * uu * (1 - vv) +
      p[iv1 * W + iu0] * (1 - uu) * vv + p[iv1 * W + iu1] * uu * vv;
  };

  for (let by = 0; by < bg.rows; by++) for (let bx = 0; bx < bg.cols; bx++) {
    let P: Vec3 = [
      bg.ipp[0] + by * bg.pixelSpacingRow * bRc[0] + bx * bg.pixelSpacingCol * bRr[0],
      bg.ipp[1] + by * bg.pixelSpacingRow * bRc[1] + bx * bg.pixelSpacingCol * bRr[1],
      bg.ipp[2] + by * bg.pixelSpacingRow * bRc[2] + bx * bg.pixelSpacingCol * bRr[2],
    ];
    if (useXf) { xf!.mapPoint(P[0], P[1], P[2], xp); P = [xp[0], xp[1], xp[2]]; }
    const dd = sub(P, ip0);
    let u = dot(dd, fRr) / fg.pixelSpacingCol;
    let v = dot(dd, fRc) / fg.pixelSpacingRow;
    const w = dot(dd, fRs);
    if (fault === "halfVoxel") { u += 0.5; v += 0.5; }
    // 行と列の取り違え: u を行、v を列として読む（寸法が違うので範囲判定も入れ替わる）
    const [uu, vv, Wi, Hi] = fault === "rowColSwap" ? [v, u, H, W] : [u, v, W, H];
    if (uu < -0.5 || uu > Wi - 0.5 || vv < -0.5 || vv > Hi - 0.5) continue;

    let iw = -1;
    if (w >= wPos[0]) { iw = d - 1; if (w < wPos[d - 1]) { iw = 0; while (wPos[iw + 1] <= w) iw++; } }
    if (fault === "sliceOffByOne" && iw >= 0 && iw < d - 1) iw = Math.min(iw + 1, d - 1);

    const read = (s: FusionSlice, a: number, b: number) =>
      fault === "rowColSwap" ? bilSwap(s, a, b) : bil(s, a, b);
    // 取り違え: 列数 H・行数 W の画素配列として読む
    const bilSwap = (s: FusionSlice, a: number, b: number) => {
      const ia = Math.floor(a), ib = Math.floor(b);
      const ia1 = Math.min(ia + 1, Hi - 1), ib1 = Math.min(ib + 1, Wi - 1);
      const ia0 = Math.max(0, ia), ib0 = Math.max(0, ib);
      const ta = Math.min(1, Math.max(0, a - ia)), tb = Math.min(1, Math.max(0, b - ib));
      const p = s.pixels;
      // a は「行側の座標」を列として、b は行として扱う（実装の取り違えを再現）
      return p[ib0 * W + ia0] * (1 - ta) * (1 - tb) + p[ib0 * W + Math.min(ia1, W - 1)] * ta * (1 - tb) +
        p[Math.min(ib1, H - 1) * W + ia0] * (1 - ta) * tb + p[Math.min(ib1, H - 1) * W + Math.min(ia1, W - 1)] * ta * tb;
    };

    let val: number;
    if (iw < 0) { const s = fg.slices[0]; val = read(s, uu, vv) * s.slope + s.intercept; }
    else if (iw >= d - 1) { const s = fg.slices[d - 1]; val = read(s, uu, vv) * s.slope + s.intercept; }
    else {
      const lo = fg.slices[iw], hi = fg.slices[iw + 1];
      const dw = wPos[iw + 1] - wPos[iw];
      const t = dw > 0 ? (w - wPos[iw]) / dw : 0;
      // 上下で slope が違うのに片方（lo）で両方を換算する誤り
      const sHi = fault === "slopeOneSided" ? lo : hi;
      val = (read(lo, uu, vv) * lo.slope + lo.intercept) * (1 - t) + (read(hi, uu, vv) * sHi.slope + sHi.intercept) * t;
    }
    if (!Number.isNaN(val)) out[by * bg.cols + bx] = val;
  }
  return out;
}
