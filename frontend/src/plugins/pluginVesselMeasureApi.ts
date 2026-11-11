/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * host API（H76・H77。いずれも仮番号）: CT の血管モデルを作る素材。
 *
 * - `measureMaskCrossSections` … 中心線に直交する断面でマスクの内腔を測る（面積・等価径・最小幅）。
 * - `orientCenterlineGraph` … H41 の中心線グラフを根から向き付け、`registerVesselModel` の区間（木）にする。
 *
 * <h3>本体は幾何だけを測る</h3>
 * マスクは 0/1 として扱う。HU・造影濃度・石灰化・「どの枝がどの血管か」は解釈しない（プラグインの責務）。
 * 径の値はマスクの作り方に依存し、ボクセル間隔より細い血管は測れない。
 */
import { Centerline3D, type FrameMode } from "../viewer/centerline";
import { worldToVoxel } from "../viewer/labelVolume";
import type { Vec3 } from "../viewer/reslice";
import { measureCrossSection } from "../viewer/crossSectionMeasure";
import type { PluginCenterlineGraph } from "./pluginCenterlineApi";
import { geomFromIndexToWorld, type PluginMaskInput } from "./pluginMeshApi";

/** 1 回の呼び出しで引くセルの総数の上限（資源保護。超えたら黙って間引かず拒否する）。 */
export const MAX_CROSS_SECTION_CELLS = 50_000_000;

export interface CrossSectionOptions {
  /** 断面どうしの弧長間隔 mm。正の有限値。 */
  spacingMm: number;
  /** 断面の走査半径 mm。正の有限値。**既定値は無い**（血管の太さは呼び出し側が知っている）。 */
  maxRadiusMm: number;
  /** 指定するとその値のセルだけを前景とする。省略すると 0 以外すべて。 */
  segment?: number;
  /** 第 2 軸の規約。既定 `"ROTATION_MINIMIZING"`。 */
  frameMode?: FrameMode;
  /** 断面格子の刻み mm。既定はマスクの最小ボクセル間隔の 1/2。 */
  gridStepMm?: number;
  /** この点列の近傍（半径 radiusMm 以内）の断面は測らない（全値 null）。分岐点の近傍を外すのに使う。 */
  excludeNear?: { points: Vec3[]; radiusMm: number };
}

export interface CrossSectionFrame {
  arcLengthMm: number;
  positionWorld: Vec3;
  /** 中心がマスクの外（偽のとき他の値は null）。 */
  centerInMask: boolean;
  /** 中心を含む成分が走査範囲の縁に触れた（真のとき他の値は null）。 */
  touchesBoundary: boolean;
  /** `excludeNear` で外した（真のとき計測値は null）。 */
  excluded: boolean;
  areaMm2: number | null;
  equivalentDiameterMm: number | null;
  minWidthMm: number | null;
}

export type CrossSectionResult = { ok: true; frames: CrossSectionFrame[] } | { ok: false; error: string };

const isPos = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
const finite3 = (p: unknown): p is Vec3 => Array.isArray(p) && p.length === 3 && p.every((c) => typeof c === "number" && Number.isFinite(c));

export function measureMaskCrossSections(
  mask: PluginMaskInput,
  polylineWorld: readonly Vec3[],
  opts: CrossSectionOptions,
): CrossSectionResult {
  if (!mask || !(mask.data instanceof Uint8Array) || !Array.isArray(mask.dims) || mask.dims.length !== 3) return { ok: false, error: "mask is required" };
  const [nx, ny, nz] = mask.dims;
  if (![nx, ny, nz].every((d) => Number.isInteger(d) && d > 0) || mask.data.length !== nx * ny * nz) return { ok: false, error: "mask.data length must equal dims product" };
  const geom = geomFromIndexToWorld(mask.dims, mask.indexToWorld);
  if (!geom) return { ok: false, error: "mask.indexToWorld must be a valid 4x4 matrix" };
  if (!Array.isArray(polylineWorld) || polylineWorld.length < 2) return { ok: false, error: "polyline needs at least 2 points" };
  if (!polylineWorld.every(finite3)) return { ok: false, error: "polyline points must be finite [x,y,z]" };
  if (!opts || !isPos(opts.spacingMm)) return { ok: false, error: "spacingMm must be a positive finite number" };
  if (!isPos(opts.maxRadiusMm)) return { ok: false, error: "maxRadiusMm must be a positive finite number" };
  if (opts.gridStepMm !== undefined && !isPos(opts.gridStepMm)) return { ok: false, error: "gridStepMm must be a positive finite number" };
  if (opts.segment !== undefined && !(Number.isInteger(opts.segment) && opts.segment > 0 && opts.segment <= 255)) return { ok: false, error: "segment must be an integer in 1..255" };
  const ex = opts.excludeNear;
  if (ex !== undefined && !(ex && Array.isArray(ex.points) && ex.points.every(finite3) && isPos(ex.radiusMm))) return { ok: false, error: "excludeNear needs finite points and a positive radiusMm" };

  const curve = new Centerline3D();
  for (const p of polylineWorld) curve.addControlPoint([p[0], p[1], p[2]]);
  const total = curve.getTotalLength();
  if (!(total > 0)) return { ok: false, error: "polyline has zero length" };

  const step = opts.gridStepMm ?? Math.min(...geom.spacing) / 2;
  const half = Math.ceil(opts.maxRadiusMm / step);
  const n = 2 * half + 1;
  const count = Math.floor(total / opts.spacingMm + 1e-9) + 1;
  if ((count + 1) * n * n > MAX_CROSS_SECTION_CELLS) {
    return { ok: false, error: `too many samples (${count} frames x ${n}x${n} cells > ${MAX_CROSS_SECTION_CELLS}); increase spacingMm / gridStepMm or reduce maxRadiusMm` };
  }

  const mode: FrameMode = opts.frameMode ?? "ROTATION_MINIMIZING";
  const seg = opts.segment;
  const grid = new Uint8Array(n * n);
  const frames: CrossSectionFrame[] = [];
  // 弧長 0, spacing, 2·spacing, … に加えて、終点が間隔の倍数でなければ終点（最後だけ間隔が短い）。
  // 区間の全長を覆う（終点の手前で打ち切ると、子の区間との間に隙間ができる）。
  const arcs = Array.from({ length: count }, (_, f) => f * opts.spacingMm);
  if (total - arcs[arcs.length - 1] > 1e-9) arcs.push(total);
  for (const s of arcs) {
    const fr = curve.frameAt(s, mode);
    const pos: Vec3 = [fr.position[0], fr.position[1], fr.position[2]];
    const base = { arcLengthMm: s, positionWorld: pos };
    if (ex && ex.points.some((q) => Math.hypot(q[0] - pos[0], q[1] - pos[1], q[2] - pos[2]) <= ex.radiusMm)) {
      frames.push({ ...base, centerInMask: false, touchesBoundary: false, excluded: true, areaMm2: null, equivalentDiameterMm: null, minWidthMm: null });
      continue;
    }
    // 断面の格子: u = normal 方向、v = binormal 方向。範囲外のセルは背景。
    for (let j = 0; j < n; j++) {
      const v = (j - half) * step;
      for (let i = 0; i < n; i++) {
        const u = (i - half) * step;
        const w: Vec3 = [
          pos[0] + fr.normal[0] * u + fr.binormal[0] * v,
          pos[1] + fr.normal[1] * u + fr.binormal[1] * v,
          pos[2] + fr.normal[2] * u + fr.binormal[2] * v,
        ];
        const [fi, fj, fk] = worldToVoxel(geom, w);
        const xi = Math.round(fi);
        const yj = Math.round(fj);
        const zk = Math.round(fk);
        let on = 0;
        if (xi >= 0 && yj >= 0 && zk >= 0 && xi < nx && yj < ny && zk < nz) {
          const val = mask.data[zk * nx * ny + yj * nx + xi];
          on = (seg === undefined ? val !== 0 : val === seg) ? 1 : 0;
        }
        grid[j * n + i] = on;
      }
    }
    frames.push({ ...base, excluded: false, ...measureCrossSection(grid, n, step) });
  }
  return { ok: true, frames };
}

export interface OrientedSegment {
  /** `String(branchId)`。 */
  id: string;
  /** 根 → 先の向き（患者 LPS mm）。 */
  points: Vec3[];
  /** 根の側でつながる区間の id。根の区間は null。 */
  parentId: string | null;
  lengthMm: number;
}
export type OrientResult = { ok: true; segments: OrientedSegment[] } | { ok: false; error: string };

export function orientCenterlineGraph(graph: PluginCenterlineGraph, rootNodeId: number): OrientResult {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.branches)) return { ok: false, error: "graph is required" };
  const nodes = new Map(graph.nodes.map((nd) => [nd.id, nd]));
  const root = nodes.get(rootNodeId);
  if (!root) return { ok: false, error: `root node ${String(rootNodeId)} not found` };
  const incident = new Map<number, number[]>();
  for (const b of graph.branches) {
    if (!nodes.has(b.startNode) || !nodes.has(b.endNode)) return { ok: false, error: `branch ${b.id} refers to an unknown node` };
    if (b.startNode === b.endNode) return { ok: false, error: `branch ${b.id} is a loop` };
    if (!Array.isArray(b.pointsWorld) || b.pointsWorld.length < 2) return { ok: false, error: `branch ${b.id} needs at least 2 points` };
    for (const nid of [b.startNode, b.endNode]) incident.set(nid, [...(incident.get(nid) ?? []), b.id]);
  }
  // 木 = 連結で、辺の数が節点の数 - 1（ループ・多重辺があれば超える）。
  if (graph.branches.length !== graph.nodes.length - 1) return { ok: false, error: "graph is not a tree (loop, multi-edge or disconnected)" };
  if ((incident.get(rootNodeId) ?? []).length !== 1) return { ok: false, error: "root node must be an end point (degree 1)" };

  const byId = new Map(graph.branches.map((b) => [b.id, b]));
  const out: OrientedSegment[] = [];
  const visitedNodes = new Set<number>([rootNodeId]);
  const queue: { node: number; viaBranch: number | null }[] = [{ node: rootNodeId, viaBranch: null }];
  while (queue.length) {
    const { node, viaBranch } = queue.shift() as { node: number; viaBranch: number | null };
    for (const bid of incident.get(node) ?? []) {
      if (bid === viaBranch) continue;
      const b = byId.get(bid)!;
      const forward = b.startNode === node;
      const far = forward ? b.endNode : b.startNode;
      if (visitedNodes.has(far)) return { ok: false, error: "graph is not a tree (loop)" };
      visitedNodes.add(far);
      const pts = (forward ? b.pointsWorld : [...b.pointsWorld].reverse()).map((p) => [p[0], p[1], p[2]] as Vec3);
      out.push({ id: String(bid), points: pts, parentId: viaBranch === null ? null : String(viaBranch), lengthMm: b.lengthMm });
      queue.push({ node: far, viaBranch: bid });
    }
  }
  if (visitedNodes.size !== graph.nodes.length) return { ok: false, error: "graph is not connected" };
  return { ok: true, segments: out };
}
