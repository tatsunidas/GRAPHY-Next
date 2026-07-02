/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 骨格ボクセル → 中心線グラフ抽出とグラフ操作。旧 GRAPHY
 * `centerline/{SkeletonGraphExtractor,CenterlineGraph,CenterlineBranch,CenterlineNode}` の TS 移植。
 *
 * - 26 近傍で骨格を歩き、端点（deg=1）/分岐点（deg>=3）をノード、その間の voxel 列をブランチとする。
 * - ブランチの制御点は**患者 LPS mm**（`voxelToWorld`）。Douglas-Peucker（epsilon mm）で簡略化。
 * - `extractBranch`/`extractPath`（Dijkstra 弧長重み）は **{@link Centerline3D}**（内視鏡 fly-through と共通の親パス）を返す。
 * - `prune(minLengthMm)` は短い葉ブランチを除去し deg=2 ノードを接続して非破壊で新グラフを返す。
 */
import { Centerline3D } from "./centerline";
import type { Vec3 } from "./reslice";
import { type SkeletonResult, skeletonizeLabelVolume } from "./skeletonize";
import { type LabelVolume, type VolumeGeom, voxelToWorld } from "./labelVolume";

// ── ベクトル小道具 ─────────────────────────────────────────────
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export interface CLNode {
  id: number;
  pos: Vec3;
  branchIds: number[];
}
export interface CLBranch {
  id: number;
  startNode: number;
  endNode: number;
  /** 制御点（start→end, 患者 LPS mm）。>=2 点。 */
  points: Vec3[];
  lengthMm: number;
}

function polylineLength(pts: Vec3[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i], pts[i - 1]);
  return L;
}

// ── Douglas-Peucker（mm） ──────────────────────────────────────
function perpDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const abLen2 = abx * abx + aby * aby + abz * abz;
  if (abLen2 < 1e-12) return dist(p, a);
  const t = (apx * abx + apy * aby + apz * abz) / abLen2;
  const cx = a[0] + abx * t, cy = a[1] + aby * t, cz = a[2] + abz * t;
  return Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz);
}

function douglasPeucker(points: Vec3[], epsilonMm: number): Vec3[] {
  if (points.length < 3 || epsilonMm <= 0) return points.slice();
  let maxD = 0, idx = -1;
  const a = points[0], b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDistance(points[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > epsilonMm && idx > 0) {
    const left = douglasPeucker(points.slice(0, idx + 1), epsilonMm);
    const right = douglasPeucker(points.slice(idx), epsilonMm);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

// ── 中心線グラフ ───────────────────────────────────────────────
export class CenterlineGraph {
  nodes = new Map<number, CLNode>();
  branches = new Map<number, CLBranch>();
  private nextNodeId = 0;
  private nextBranchId = 0;

  addNode(pos: Vec3): CLNode {
    const node: CLNode = { id: this.nextNodeId++, pos: [pos[0], pos[1], pos[2]], branchIds: [] };
    this.nodes.set(node.id, node);
    return node;
  }

  addBranch(startNode: number, endNode: number, points: Vec3[]): CLBranch | null {
    if (points.length < 2) return null;
    const b: CLBranch = {
      id: this.nextBranchId++,
      startNode,
      endNode,
      points: points.map((p) => [p[0], p[1], p[2]] as Vec3),
      lengthMm: polylineLength(points),
    };
    this.branches.set(b.id, b);
    this.nodes.get(startNode)?.branchIds.push(b.id);
    if (endNode !== startNode) this.nodes.get(endNode)?.branchIds.push(b.id);
    return b;
  }

  getLeafNodes(): CLNode[] {
    return [...this.nodes.values()].filter((n) => n.branchIds.length === 1);
  }
  getBranchPointNodes(): CLNode[] {
    return [...this.nodes.values()].filter((n) => n.branchIds.length >= 3);
  }
  totalLengthMm(): number {
    let L = 0;
    for (const b of this.branches.values()) L += b.lengthMm;
    return L;
  }

  /** 単一ブランチ → Centerline3D（内視鏡/CPR 共通パス）。 */
  extractBranch(branchId: number): Centerline3D | null {
    const b = this.branches.get(branchId);
    if (!b) return null;
    const cl = new Centerline3D();
    for (const p of b.points) cl.addControlPoint(p);
    return cl;
  }

  /** ノード a→b の最短路（Dijkstra, 弧長重み）を連結した Centerline3D。 */
  extractPath(nodeA: number, nodeB: number): Centerline3D | null {
    const path = this.dijkstra(nodeA, nodeB);
    if (!path) return null;
    const pts = this.concatPath(path);
    if (pts.length < 2) return null;
    const cl = new Centerline3D();
    for (const p of pts) cl.addControlPoint(p);
    return cl;
  }

  /** 最長の葉→葉パス（グラフ直径。内視鏡の既定パスに好適）。 */
  longestPath(): Centerline3D | null {
    const leaves = this.getLeafNodes();
    if (leaves.length === 0) {
      // ループのみ等: 任意ノード対で代替。
      const ids = [...this.nodes.keys()];
      if (ids.length < 2) return null;
      return this.extractPath(ids[0], ids[1]);
    }
    // 2 回 Dijkstra（末端探索）でグラフ直径を得る（木で厳密）。
    const far1 = this.farthestNode(leaves[0].id);
    if (far1 == null) return null;
    const far2 = this.farthestNode(far1);
    if (far2 == null) return null;
    return this.extractPath(far1, far2);
  }

  /** start から弧長距離が最大のノード id。 */
  private farthestNode(start: number): number | null {
    const distById = this.dijkstraDistances(start);
    let best = start, bestD = -1;
    for (const [id, d] of distById) if (d > bestD) { bestD = d; best = id; }
    return bestD >= 0 ? best : null;
  }

  private dijkstraDistances(start: number): Map<number, number> {
    const distById = new Map<number, number>();
    distById.set(start, 0);
    const visited = new Set<number>();
    while (true) {
      // 未訪問の最小距離ノード（小グラフなので線形選択）。
      let u = -1, ud = Infinity;
      for (const [id, d] of distById) if (!visited.has(id) && d < ud) { ud = d; u = id; }
      if (u === -1) break;
      visited.add(u);
      const node = this.nodes.get(u);
      if (!node) continue;
      for (const bid of node.branchIds) {
        const b = this.branches.get(bid);
        if (!b) continue;
        const other = b.startNode === u ? b.endNode : b.startNode;
        const nd = ud + b.lengthMm;
        if (nd < (distById.get(other) ?? Infinity)) distById.set(other, nd);
      }
    }
    return distById;
  }

  /** a→b の最短路（ノード id 列＋各ステップで使ったブランチ id）。 */
  private dijkstra(a: number, b: number): { nodes: number[]; branches: number[] } | null {
    const distById = new Map<number, number>([[a, 0]]);
    const prevNode = new Map<number, number>();
    const prevBranch = new Map<number, number>();
    const visited = new Set<number>();
    while (true) {
      let u = -1, ud = Infinity;
      for (const [id, d] of distById) if (!visited.has(id) && d < ud) { ud = d; u = id; }
      if (u === -1) break;
      if (u === b) break;
      visited.add(u);
      const node = this.nodes.get(u);
      if (!node) continue;
      for (const bid of node.branchIds) {
        const br = this.branches.get(bid);
        if (!br) continue;
        const other = br.startNode === u ? br.endNode : br.startNode;
        const nd = ud + br.lengthMm;
        if (nd < (distById.get(other) ?? Infinity)) {
          distById.set(other, nd);
          prevNode.set(other, u);
          prevBranch.set(other, bid);
        }
      }
    }
    if (!distById.has(b)) return null;
    const nodeSeq: number[] = [];
    const branchSeq: number[] = [];
    let cur = b;
    while (cur !== a) {
      nodeSeq.unshift(cur);
      const pb = prevBranch.get(cur);
      const pn = prevNode.get(cur);
      if (pb == null || pn == null) return null;
      branchSeq.unshift(pb);
      cur = pn;
    }
    nodeSeq.unshift(a);
    return { nodes: nodeSeq, branches: branchSeq };
  }

  /** ノード列＋ブランチ列 → 連結制御点（向きを揃え、接合ノードの重複を除く）。 */
  private concatPath(path: { nodes: number[]; branches: number[] }): Vec3[] {
    const out: Vec3[] = [];
    for (let i = 0; i < path.branches.length; i++) {
      const b = this.branches.get(path.branches[i]);
      if (!b) continue;
      const fromNode = path.nodes[i];
      // ブランチの向きを fromNode 始点に揃える。
      let pts = b.points;
      if (b.startNode !== fromNode) pts = pts.slice().reverse();
      for (const p of pts) {
        if (out.length && dist(out[out.length - 1], p) < 1e-6) continue; // 接合重複除去
        out.push([p[0], p[1], p[2]]);
      }
    }
    return out;
  }

  /**
   * 短い葉ブランチ（deg=1 端点を持ち length<min）を除去し、deg=2 ノードを接続して整理した
   * **新しいグラフ**を返す（非破壊）。
   */
  prune(minLengthMm: number): CenterlineGraph {
    // セグメント表現（startNode/endNode/points）で作業。
    interface Seg { start: number; end: number; points: Vec3[]; }
    let segs: Seg[] = [...this.branches.values()].map((b) => ({
      start: b.startNode, end: b.endNode, points: b.points.map((p) => [...p] as Vec3),
    }));
    const nodePos = new Map<number, Vec3>();
    for (const n of this.nodes.values()) nodePos.set(n.id, n.pos);

    const degreeOf = (list: Seg[]): Map<number, number> => {
      const deg = new Map<number, number>();
      for (const s of list) {
        deg.set(s.start, (deg.get(s.start) ?? 0) + 1);
        if (s.end !== s.start) deg.set(s.end, (deg.get(s.end) ?? 0) + 1);
      }
      return deg;
    };

    let changed = true;
    let guard = 0;
    while (changed && guard++ < 1000) {
      changed = false;
      const deg = degreeOf(segs);
      // 1) 短い葉セグメントを除去。
      const kept: Seg[] = [];
      for (const s of segs) {
        const leaf = deg.get(s.start) === 1 || deg.get(s.end) === 1;
        const len = polylineLength(s.points);
        if (leaf && len < minLengthMm && !(deg.get(s.start) === 1 && deg.get(s.end) === 1)) {
          changed = true; // 除去
        } else {
          kept.push(s);
        }
      }
      segs = kept;
      // 2) deg=2 ノードを接続（2 セグメントを 1 本に統合）。
      const deg2 = degreeOf(segs);
      for (const [nodeId, dg] of deg2) {
        if (dg !== 2) continue;
        const inc = segs.filter((s) => s.start === nodeId || s.end === nodeId);
        if (inc.length !== 2) continue;
        const [s1, s2] = inc;
        // s1 を nodeId が末尾になるよう、s2 が nodeId 始点になるよう並べて連結。
        const p1 = s1.end === nodeId ? s1.points : s1.points.slice().reverse();
        const p2 = s2.start === nodeId ? s2.points : s2.points.slice().reverse();
        const merged: Vec3[] = p1.concat(p2.slice(1));
        const newSeg: Seg = {
          start: s1.end === nodeId ? s1.start : s1.end,
          end: s2.start === nodeId ? s2.end : s2.start,
          points: merged,
        };
        segs = segs.filter((s) => s !== s1 && s !== s2);
        segs.push(newSeg);
        changed = true;
        break; // deg 再計算のためやり直し
      }
    }

    // 新グラフを再構築。
    const g = new CenterlineGraph();
    const idMap = new Map<number, number>(); // 旧 nodeId → 新 node
    const ensure = (oldId: number, pos: Vec3): number => {
      let nid = idMap.get(oldId);
      if (nid == null) { nid = g.addNode(pos).id; idMap.set(oldId, nid); }
      return nid;
    };
    for (const s of segs) {
      const a = ensure(s.start, nodePos.get(s.start) ?? s.points[0]);
      const b = ensure(s.end, nodePos.get(s.end) ?? s.points[s.points.length - 1]);
      g.addBranch(a, b, s.points);
    }
    return g;
  }
}

/**
 * 骨格（`skeletonize.ts` 出力）から中心線グラフを抽出する。
 * 26 近傍歩行。制御点は `voxelToWorld`（geom）で患者 LPS mm へ、Douglas-Peucker（epsilon mm）で簡略化。
 */
export function extractGraphFromSkeleton(skel: SkeletonResult, simplifyEpsilonMm = 0.5): CenterlineGraph {
  const { data, geom } = skel;
  const [w, h, d] = geom.dims;
  const slice = w * h;
  const at = (x: number, y: number, z: number): number => {
    if (x < 0 || x >= w || y < 0 || y >= h || z < 0 || z >= d) return 0;
    return data[z * slice + y * w + x];
  };
  const lin = (x: number, y: number, z: number): number => z * slice + y * w + x;
  const coordOf = (idx: number): [number, number, number] => {
    const z = Math.floor(idx / slice);
    const r = idx - z * slice;
    const y = Math.floor(r / w);
    const x = r - y * w;
    return [x, y, z];
  };
  const worldOf = (x: number, y: number, z: number): Vec3 => voxelToWorld(geom, x, y, z);

  // 26 近傍の相対オフセット。
  const off: [number, number, number][] = [];
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (dx || dy || dz) off.push([dx, dy, dz]);

  const neighborsOf = (x: number, y: number, z: number): number[] => {
    const r: number[] = [];
    for (const [dx, dy, dz] of off) if (at(x + dx, y + dy, z + dz)) r.push(lin(x + dx, y + dy, z + dz));
    return r;
  };

  const g = new CenterlineGraph();

  // node voxel（deg=1 or deg>=3）を登録。
  const nodeIdByVoxel = new Map<number, number>();
  for (let z = 0; z < d; z++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!at(x, y, z)) continue;
        const deg = neighborsOf(x, y, z).length;
        if (deg === 1 || deg >= 3) {
          const node = g.addNode(worldOf(x, y, z));
          nodeIdByVoxel.set(lin(x, y, z), node.id);
        }
      }

  const consumed = new Set<number>(); // 消費済み interior voxel
  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const doneEdges = new Set<string>();

  const addChainBranch = (startVox: number, chainVox: number[], endVox: number) => {
    const startNode = nodeIdByVoxel.get(startVox);
    const endNode = nodeIdByVoxel.get(endVox);
    if (startNode == null || endNode == null) return;
    const raw: Vec3[] = [];
    raw.push(worldOf(...coordOf(startVox)));
    for (const vx of chainVox) raw.push(worldOf(...coordOf(vx)));
    raw.push(worldOf(...coordOf(endVox)));
    const simplified = douglasPeucker(raw, simplifyEpsilonMm);
    g.addBranch(startNode, endNode, simplified.length >= 2 ? simplified : raw);
  };

  for (const [voxIdx] of nodeIdByVoxel) {
    const [x, y, z] = coordOf(voxIdx);
    for (const nb of neighborsOf(x, y, z)) {
      if (nodeIdByVoxel.has(nb)) {
        // ノード同士の直接エッジ（2 点ブランチ）。
        const key = edgeKey(voxIdx, nb);
        if (doneEdges.has(key)) continue;
        doneEdges.add(key);
        addChainBranch(voxIdx, [], nb);
        continue;
      }
      if (consumed.has(nb)) continue;
      // interior を辿って次のノードへ。
      const chain: number[] = [];
      let prev = voxIdx;
      let cur = nb;
      let reachedNode = -1;
      const localGuard = w * h * d;
      let steps = 0;
      while (steps++ < localGuard) {
        consumed.add(cur);
        chain.push(cur);
        const [cx, cy, cz] = coordOf(cur);
        const nbs = neighborsOf(cx, cy, cz);
        // 次の一歩: prev でなく、ノード優先、なければ未消費 interior。
        let next = -1;
        // ノードへの到達を優先。
        for (const n of nbs) if (n !== prev && nodeIdByVoxel.has(n)) { next = n; break; }
        if (next !== -1) { reachedNode = next; break; }
        for (const n of nbs) if (n !== prev && !nodeIdByVoxel.has(n) && !consumed.has(n)) { next = n; break; }
        if (next === -1) break; // 行き止まり（骨格の途切れ）
        prev = cur;
        cur = next;
      }
      if (reachedNode !== -1) {
        // 最後の cur は interior として chain に入っているので、reachedNode を終端に。
        addChainBranch(voxIdx, chain, reachedNode);
      }
    }
  }

  return g;
}

/** LabelVolume → 骨格化 → グラフ抽出をまとめて実行。前景なし等で null。 */
export function extractCenterlineGraph(
  lv: LabelVolume,
  opts: { simplifyEpsilonMm?: number; pruneMinLengthMm?: number } = {},
): CenterlineGraph | null {
  const skel = skeletonizeLabelVolume(lv);
  if (!skel) return null;
  let g = extractGraphFromSkeleton(skel, opts.simplifyEpsilonMm ?? 0.5);
  if (g.branches.size === 0) return null;
  if (opts.pruneMinLengthMm && opts.pruneMinLengthMm > 0) g = g.prune(opts.pruneMinLengthMm);
  return g;
}

/** グラフ幾何のデバッグ表示用（ブランチ数/ノード数/総長）。 */
export function graphSummary(g: CenterlineGraph): { nodes: number; branches: number; leaves: number; bifurcations: number; totalMm: number } {
  return {
    nodes: g.nodes.size,
    branches: g.branches.size,
    leaves: g.getLeafNodes().length,
    bifurcations: g.getBranchPointNodes().length,
    totalMm: g.totalLengthMm(),
  };
}

/** 依存の未使用警告回避（geom は skel 内で使用）。 */
export type { VolumeGeom };
