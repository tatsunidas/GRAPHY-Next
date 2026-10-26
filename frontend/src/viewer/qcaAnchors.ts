/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D QCA のアンカー（2 方向で「同じ場所」と分かる目印。分岐部の carina など）の**純ロジック**。
 *
 * <h3>なぜ中心線の上の 1 次元の位置なのか</h3>
 * アンカーは血管の**断面**を指す目印なので、血管に直交する線で表す。位置は常に
 * 中心線の上（弧長で 1 つの数）に置く。画面の見かけの位置と 3D へ渡す位置が一致し、
 * ドラッグも 1 次元で済む。
 *
 * <h3>なぜインデックスではなく座標で持つのか</h3>
 * 中心線（計測点）は手修正で作り直される。インデックスは**範囲内のまま別の場所を指す**ので、
 * 画像座標で持ち、中心線が変わったら最近傍の点へ付け直し、遠くなったら捨てる
 * （`qca.ts` のエッジ手修正の `token` と同じ考え方。手修正を黙って別の場所に当てない）。
 *
 * <h3>出典</h3>
 * 目印は「分岐部などの解剖学的な目印を 2 方向で 1〜3 点指定する」手順に基づく
 * （Tu S, et al. Int J Cardiovasc Imaging 2012;28:1315-1327）。補正の方法はその論文には書かれておらず、
 * ここでは目印の置き方と対応づけだけを扱う。
 *
 * <h3>番号（対応）</h3>
 * 2 方向のアンカーは**血管に沿った並びの番号**で対応づける（A の 1 番と B の 1 番は同じ解剖点）。
 * ドラッグで番号が入れ替わらないよう、動かせる範囲は両隣の間に限る。
 */

export type Pt = readonly [number, number];

/** 1 つのアンカー。位置は中心線の上（画像 px）。 */
export interface QcaAnchor {
  x: number;
  y: number;
  /**
   * 利用者が位置を確かめたか。初期の位置は等分の**仮の位置**で、確かめるまで 3D には使わない
   * （自動は提案、確定は人）。
   */
  confirmed: boolean;
}

/** アンカー数の既定と上限。上限は**暫定**（画面の混雑と操作の都合。決める数値は利用者）。 */
export const DEFAULT_ANCHOR_COUNT = 3;
export const MAX_ANCHORS = 6;
/** 隣のアンカーとの最小間隔 [px・弧長]。番号が入れ替わらないようにする。 */
export const MIN_ANCHOR_GAP_PX = 1;

/** 中心線の累積弧長。 */
export function cumulativeArcs(c: readonly Pt[]): number[] {
  const out: number[] = new Array(c.length);
  if (c.length === 0) return out;
  out[0] = 0;
  for (let i = 1; i < c.length; i++) out[i] = out[i - 1] + Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]);
  return out;
}

export interface Snapped {
  /** 弧長 [px]。 */
  s: number;
  point: [number, number];
  /** 中心線への距離 [px]。 */
  distance: number;
}

/** 点を中心線（折れ線）の最も近い位置へ付ける。 */
export function snapToCenterline(c: readonly Pt[], p: Pt): Snapped | null {
  if (c.length < 2) return null;
  const arcs = cumulativeArcs(c);
  let best: Snapped | null = null;
  for (let i = 0; i + 1 < c.length; i++) {
    const ax = c[i][0];
    const ay = c[i][1];
    const dx = c[i + 1][0] - ax;
    const dy = c[i + 1][1] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = Math.hypot(p[0] - px, p[1] - py);
    if (!best || d < best.distance) best = { s: arcs[i] + t * Math.sqrt(len2), point: [px, py], distance: d };
  }
  return best;
}

/** 弧長 s の位置の点と、そこでの単位接線。範囲外は端へ丸める。 */
export function pointAtArc(c: readonly Pt[], s: number): { point: [number, number]; tangent: [number, number] } | null {
  if (c.length < 2) return null;
  const arcs = cumulativeArcs(c);
  const total = arcs[arcs.length - 1];
  const ss = Math.max(0, Math.min(total, s));
  let i = 0;
  while (i + 2 < c.length && arcs[i + 1] < ss) i++;
  const seg = arcs[i + 1] - arcs[i];
  const t = seg === 0 ? 0 : (ss - arcs[i]) / seg;
  const point: [number, number] = [c[i][0] + t * (c[i + 1][0] - c[i][0]), c[i][1] + t * (c[i + 1][1] - c[i][1])];
  // 接線は前後の弦（1 点ぶんの折れ線の角で振れないように）。
  const a = Math.max(0, i - 2);
  const b = Math.min(c.length - 1, i + 3);
  const tx = c[b][0] - c[a][0];
  const ty = c[b][1] - c[a][1];
  const tl = Math.hypot(tx, ty) || 1;
  return { point, tangent: [tx / tl, ty / tl] };
}

/** 血管に沿った並び（弧長の昇順）に並べ替える。 */
export function orderAnchors(c: readonly Pt[], anchors: readonly QcaAnchor[]): QcaAnchor[] {
  return anchors
    .map((a) => ({ a, s: snapToCenterline(c, [a.x, a.y])?.s ?? 0 }))
    .sort((p, q) => p.s - q.s)
    .map((x) => x.a);
}

/** 中心線を等分した**仮の位置**（確認前）。両端は端点が常にアンカーなので外す。 */
export function proposeAnchors(c: readonly Pt[], n: number): QcaAnchor[] {
  const arcs = cumulativeArcs(c);
  if (arcs.length < 2 || n <= 0) return [];
  const total = arcs[arcs.length - 1];
  const out: QcaAnchor[] = [];
  for (let k = 1; k <= n; k++) {
    const at = pointAtArc(c, (total * k) / (n + 1));
    if (at) out.push({ x: at.point[0], y: at.point[1], confirmed: false });
  }
  return out;
}

/** 動かせる範囲 [最小, 最大]（弧長）。両隣との間隔と、両端の内側に限る。 */
function allowedRange(c: readonly Pt[], ordered: readonly QcaAnchor[], i: number): [number, number] {
  const arcs = cumulativeArcs(c);
  const total = arcs[arcs.length - 1] ?? 0;
  const prev = i > 0 ? snapToCenterline(c, [ordered[i - 1].x, ordered[i - 1].y])?.s ?? 0 : 0;
  const next = i + 1 < ordered.length ? snapToCenterline(c, [ordered[i + 1].x, ordered[i + 1].y])?.s ?? total : total;
  // 両端そのものは端点のアンカーと重なるので、端からも間隔を空ける。
  const lo = prev + MIN_ANCHOR_GAP_PX;
  const hi = next - MIN_ANCHOR_GAP_PX;
  return lo <= hi ? [lo, hi] : [prev, prev];
}

/**
 * i 番のアンカーを、ポインタの位置へ（中心線の上に付けて）動かす。**確認済みになる**。
 * 動かせる範囲は両隣の間。`anchors` は血管に沿った順に並んでいること。
 */
export function moveAnchorTo(c: readonly Pt[], anchors: readonly QcaAnchor[], i: number, p: Pt): QcaAnchor[] {
  if (i < 0 || i >= anchors.length) return [...anchors];
  const snap = snapToCenterline(c, p);
  if (!snap) return [...anchors];
  const [lo, hi] = allowedRange(c, anchors, i);
  const at = pointAtArc(c, Math.max(lo, Math.min(hi, snap.s)));
  if (!at) return [...anchors];
  return anchors.map((a, k) => (k === i ? { x: at.point[0], y: at.point[1], confirmed: true } : a));
}

/** i 番のアンカーを、中心線に沿って deltaPx（弧長）だけ動かす（キー操作）。 */
export function stepAnchor(c: readonly Pt[], anchors: readonly QcaAnchor[], i: number, deltaPx: number): QcaAnchor[] {
  if (i < 0 || i >= anchors.length) return [...anchors];
  const cur = snapToCenterline(c, [anchors[i].x, anchors[i].y]);
  if (!cur) return [...anchors];
  const at = pointAtArc(c, cur.s + deltaPx);
  if (!at) return [...anchors];
  return moveAnchorTo(c, anchors, i, at.point);
}

/** 最も間の空いている所の真ん中へ、仮の（未確認の）アンカーを足す。上限なら変えない。 */
export function addAnchor(c: readonly Pt[], anchors: readonly QcaAnchor[]): QcaAnchor[] {
  if (anchors.length >= MAX_ANCHORS || c.length < 2) return [...anchors];
  const arcs = cumulativeArcs(c);
  const total = arcs[arcs.length - 1];
  const s = orderAnchors(c, anchors).map((a) => snapToCenterline(c, [a.x, a.y])?.s ?? 0);
  const bounds = [0, ...s, total];
  let bestGap = -1;
  let bestMid = total / 2;
  for (let k = 0; k + 1 < bounds.length; k++) {
    const gap = bounds[k + 1] - bounds[k];
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = (bounds[k] + bounds[k + 1]) / 2;
    }
  }
  const at = pointAtArc(c, bestMid);
  if (!at) return [...anchors];
  return orderAnchors(c, [...anchors, { x: at.point[0], y: at.point[1], confirmed: false }]);
}

/**
 * ポインタの位置（中心線の上）へアンカーを足す。**確認済み**（利用者が自分で置いた）。
 * 上限・両隣との最小間隔を破るなら足さず null。足したら血管に沿った順に並べ、その番号も返す。
 */
export function insertAnchorAt(
  c: readonly Pt[],
  anchors: readonly QcaAnchor[],
  p: Pt,
): { anchors: QcaAnchor[]; index: number } | null {
  if (anchors.length >= MAX_ANCHORS) return null;
  const sn = snapToCenterline(c, p);
  if (!sn) return null;
  const arcs = cumulativeArcs(c);
  const total = arcs[arcs.length - 1];
  if (sn.s < MIN_ANCHOR_GAP_PX || sn.s > total - MIN_ANCHOR_GAP_PX) return null;
  for (const a of anchors) {
    const o = snapToCenterline(c, [a.x, a.y]);
    if (o && Math.abs(o.s - sn.s) < MIN_ANCHOR_GAP_PX) return null;
  }
  const added: QcaAnchor = { x: sn.point[0], y: sn.point[1], confirmed: true };
  const ordered = orderAnchors(c, [...anchors, added]);
  return { anchors: ordered, index: ordered.indexOf(added) };
}

/** i 番を消す。 */
export function removeAnchor(anchors: readonly QcaAnchor[], i: number): QcaAnchor[] {
  return anchors.filter((_, k) => k !== i);
}

/** i 番を確認済みにする（位置はそのまま）。 */
export function confirmAnchor(anchors: readonly QcaAnchor[], i: number): QcaAnchor[] {
  return anchors.map((a, k) => (k === i ? { ...a, confirmed: true } : a));
}

/**
 * 中心線が変わったあとに付け直す。径 `tolerancePx` より離れたものは**捨てる**（別の場所を指さない）。
 * 重なったもの（間隔が {@link MIN_ANCHOR_GAP_PX} 未満）も 1 つにまとめる。
 */
export function resnapAnchors(
  c: readonly Pt[],
  anchors: readonly QcaAnchor[],
  tolerancePx: number,
): { anchors: QcaAnchor[]; dropped: number } {
  const kept: { a: QcaAnchor; s: number }[] = [];
  let dropped = 0;
  for (const a of anchors) {
    const sn = snapToCenterline(c, [a.x, a.y]);
    if (!sn || sn.distance > tolerancePx) {
      dropped++;
      continue;
    }
    kept.push({ a: { x: sn.point[0], y: sn.point[1], confirmed: a.confirmed }, s: sn.s });
  }
  kept.sort((p, q) => p.s - q.s);
  const out: QcaAnchor[] = [];
  let lastS = -Infinity;
  for (const k of kept) {
    if (k.s - lastS < MIN_ANCHOR_GAP_PX) {
      dropped++;
      continue;
    }
    out.push(k.a);
    lastS = k.s;
  }
  return { anchors: out, dropped };
}

/**
 * アンカーを表す線分（中心線に**直交**）。半分の長さは、その位置の血管の
 * 半径に余白を足したもの。`halfWidthPx` は呼び出し側が局所のエッジから決める。
 */
export function anchorLine(
  c: readonly Pt[],
  a: QcaAnchor,
  halfLengthPx: number,
): { center: [number, number]; normal: [number, number]; p0: [number, number]; p1: [number, number] } | null {
  const sn = snapToCenterline(c, [a.x, a.y]);
  if (!sn) return null;
  const at = pointAtArc(c, sn.s);
  if (!at) return null;
  const n: [number, number] = [-at.tangent[1], at.tangent[0]];
  return {
    center: at.point,
    normal: n,
    p0: [at.point[0] - n[0] * halfLengthPx, at.point[1] - n[1] * halfLengthPx],
    p1: [at.point[0] + n[0] * halfLengthPx, at.point[1] + n[1] * halfLengthPx],
  };
}

/** 位置 s の近くの血管の半径（エッジのオフセットの最大絶対値の中央付近）。 */
export function localRadiusPx(
  c: readonly Pt[],
  edgeOffsets: readonly { left: number; right: number }[],
  s: number,
  windowPx = 6,
): number {
  const arcs = cumulativeArcs(c);
  const vals: number[] = [];
  for (let i = 0; i < c.length && i < edgeOffsets.length; i++) {
    if (Math.abs(arcs[i] - s) <= windowPx) vals.push((edgeOffsets[i].right - edgeOffsets[i].left) / 2);
  }
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}

/** アンカー線の見える長さの余白（半径に対する割合）。表示だけの量で、数値の結果には影響しない。 */
export const ANCHOR_LINE_MARGIN = 0.75;

/**
 * 2 方向のアンカーを**番号**で組にする。両方で確認済みの番号だけを使う。
 * `mismatch` は、番号の数が 2 方向で違う（使えない番号がある）こと。
 */
export function pairAnchors(
  a: readonly QcaAnchor[],
  b: readonly QcaAnchor[],
): { pairs: { a: [number, number]; b: [number, number]; index: number }[]; mismatch: boolean } {
  const n = Math.min(a.length, b.length);
  const pairs: { a: [number, number]; b: [number, number]; index: number }[] = [];
  for (let k = 0; k < n; k++) {
    if (a[k].confirmed && b[k].confirmed) pairs.push({ a: [a[k].x, a[k].y], b: [b[k].x, b[k].y], index: k });
  }
  return { pairs, mismatch: a.length !== b.length };
}

/** 番号ごとの色。2 方向で同じ番号は同じ色（対応が一目で分かる）。表示だけの量。 */
export const ANCHOR_COLORS = ["#ff8a3d", "#3dd6c6", "#c77dff", "#ffd23d", "#7dd35a", "#ff6fa8"] as const;
export const anchorColor = (index: number): string => ANCHOR_COLORS[index % ANCHOR_COLORS.length];
