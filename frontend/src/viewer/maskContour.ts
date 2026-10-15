/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * マスク（ラベルマップの 1 スライス）→ 輪郭（ROI）。純関数（`fw/roi-mask-model.md` §10）。
 *
 * <p>輪郭は<b>画素の境界</b>をなぞる（頂点は画素の角。画素 (c, r) は [c, c+1] × [r, r+1]）。
 * 画素の中心は境界に乗らないので、{@link fillPolygonsEvenOdd}（画素中心の偶奇判定）で塗り直すと
 * <b>元と同じ画素に戻る</b>。穴は別の輪郭として返し、偶奇で塗ると穴として抜ける。
 *
 * <p>連結は 4 近傍。角だけで接する画素は、別の成分（別の外周）になる。
 */

export type Pt = [number, number];

export interface MaskContour {
  /** 外周（画面座標で時計回り＝符号付き面積が正）。 */
  outer: Pt[];
  /** この成分の穴（反時計回り）。 */
  holes: Pt[][];
}

/**
 * 1 スライスの前景をなぞって、4 近傍の成分ごとに外周と穴を返す。
 * `segment` を渡すとその番号だけ、省略すると 0 より大きい画素すべてを前景にする。
 */
export function traceMaskContours(
  labels: ArrayLike<number>,
  width: number,
  height: number,
  segment?: number,
): MaskContour[] {
  const n = width * height;
  const fg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = labels[i];
    fg[i] = segment === undefined ? (v > 0 ? 1 : 0) : v === segment ? 1 : 0;
  }
  const comp = labelComponents4(fg, width, height);
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < width && y < height ? fg[y * width + x] : 0);

  // 境界の辺を、前景を右手に見る向きで並べる（画面座標 y 下向きで、画素のまわりを時計回り）。
  const W1 = width + 1;
  const vid = (x: number, y: number) => y * W1 + x;
  const edgeTo: number[] = [];
  const edgeComp: number[] = [];
  const outEdges = new Map<number, number[]>();
  const addEdge = (x0: number, y0: number, x1: number, y1: number, c: number) => {
    const e = edgeTo.length;
    edgeTo.push(vid(x1, y1));
    edgeComp.push(c);
    const from = vid(x0, y0);
    const list = outEdges.get(from);
    if (list) list.push(e);
    else outEdges.set(from, [e]);
    edgeFrom.push(from);
  };
  const edgeFrom: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!fg[y * width + x]) continue;
      const c = comp[y * width + x];
      if (!at(x, y - 1)) addEdge(x, y, x + 1, y, c);
      if (!at(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1, c);
      if (!at(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1, c);
      if (!at(x - 1, y)) addEdge(x, y + 1, x, y, c);
    }
  }

  // 辺をつないで閉じた輪郭にする。角だけで接する所（出る辺が 2 本）では右に曲がる＝今の画素に沿う。
  const used = new Uint8Array(edgeTo.length);
  const dirOf = (e: number): Pt => {
    const a = edgeFrom[e], b = edgeTo[e];
    return [(b % W1) - (a % W1), Math.floor(b / W1) - Math.floor(a / W1)];
  };
  const loops: { pts: Pt[]; comp: number }[] = [];
  for (let s = 0; s < edgeTo.length; s++) {
    if (used[s]) continue;
    const pts: Pt[] = [];
    let e = s;
    while (!used[e]) {
      used[e] = 1;
      const a = edgeFrom[e];
      pts.push([a % W1, Math.floor(a / W1)]);
      const cands = (outEdges.get(edgeTo[e]) ?? []).filter((k) => !used[k] || k === s);
      if (!cands.length) break;
      if (cands.length === 1) {
        e = cands[0];
        continue;
      }
      const [dx, dy] = dirOf(e);
      const right: Pt = [-dy, dx];
      const pick = cands.find((k) => {
        const [kx, ky] = dirOf(k);
        return kx === right[0] && ky === right[1];
      });
      e = pick ?? cands[0];
    }
    loops.push({ pts: simplify(pts), comp: edgeComp[s] });
  }

  const byComp = new Map<number, MaskContour>();
  const holesFirst: { pts: Pt[]; comp: number }[] = [];
  for (const l of loops) {
    if (signedArea(l.pts) > 0) byComp.set(l.comp, { outer: l.pts, holes: [] });
    else holesFirst.push(l);
  }
  for (const h of holesFirst) byComp.get(h.comp)?.holes.push(h.pts);
  return [...byComp.keys()].sort((a, b) => a - b).map((k) => byComp.get(k) as MaskContour);
}

/** 同じ向きに続く頂点を落とす（画素ごとの角を、曲がり角だけにする）。 */
function simplify(pts: Pt[]): Pt[] {
  if (pts.length < 4) return pts;
  const out: Pt[] = [];
  const m = pts.length;
  for (let i = 0; i < m; i++) {
    const p = pts[(i - 1 + m) % m], c = pts[i], q = pts[(i + 1) % m];
    const cross = (c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0]);
    if (cross !== 0) out.push(c);
  }
  return out;
}

/** 符号付き面積（画面座標。時計回りが正）。 */
export function signedArea(pts: ReadonlyArray<Pt>): number {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return s / 2;
}

function labelComponents4(fg: Uint8Array, width: number, height: number): Int32Array {
  const comp = new Int32Array(fg.length);
  let next = 0;
  const stack: number[] = [];
  for (let i = 0; i < fg.length; i++) {
    if (!fg[i] || comp[i]) continue;
    comp[i] = ++next;
    stack.push(i);
    while (stack.length) {
      const cur = stack.pop() as number;
      const y = Math.floor(cur / width), x = cur - y * width;
      const nb = [
        x > 0 ? cur - 1 : -1,
        x < width - 1 ? cur + 1 : -1,
        y > 0 ? cur - width : -1,
        y < height - 1 ? cur + width : -1,
      ];
      for (const j of nb) if (j >= 0 && fg[j] && !comp[j]) { comp[j] = next; stack.push(j); }
    }
  }
  return comp;
}

/**
 * 多角形の集まりを、画素中心の偶奇判定で塗る（どれかの輪郭を奇数回またぐ画素が前景）。
 * 判定は `roiBooleanOps.rasterizeRoi` の点の内外判定（半開区間のレイキャスト）と同じ。
 */
export function fillPolygonsEvenOdd(polys: ReadonlyArray<ReadonlyArray<Pt>>, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    const xs: number[] = [];
    for (const poly of polys) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
        if ((yi > py) !== (yj > py)) xs.push(((xj - xi) * (py - yi)) / (yj - yi) + xi);
      }
    }
    if (!xs.length) continue;
    xs.sort((a, b) => a - b);
    // 画素中心 px より右にある交点の数が奇数なら内側（レイキャストと同じ数え方）。
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      let k = 0;
      while (k < xs.length && xs[k] <= px) k++;
      if ((xs.length - k) % 2 === 1) out[y * width + x] = 1;
    }
  }
  return out;
}
