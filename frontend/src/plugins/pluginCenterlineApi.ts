/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * **H41 — マスク → 中心線・直交フレーム**（`fw/plugin-architecture.md` §7）。
 *
 * プラグインが作った 3D マスクを受け取り、**本体の中心線エンジンをそのまま通す**。
 * H10 が `regVolumeLoader` を公開しただけだったのと同じで、ここに新しい数式は 1 つも足していない
 * （`skeletonize.ts` の Lee-Kashyap-Chu 1994 細線化 → `centerlineGraph.ts` の 26 近傍歩行 →
 * `centerline.ts` の Catmull-Rom ＋ 弧長パラメータ化）。
 *
 * <h3>なぜプラグインに書かせないか</h3>
 *
 * H5（ROI の長径）・H33（メッシュ体積）と同じ理由。同じ量を 2 か所で計算すると、
 * **食い違ったときにどちらが正しいか言えなくなる**。3D 細線化は vtk.js にも cornerstone にも
 * 無いので（`skeletonize.ts` の冒頭）、各プラグインが自前で書くと実装がアプリ内に増え続ける。
 *
 * <h3>境界: 本体は幾何をやる。解剖は知らない</h3>
 *
 * 骨格・分岐グラフ・弧長等間隔の正規直交フレームまでが本体。
 * **どの枝がどの血管かはプラグインが決める**。本体に「脳底動脈」を教えない。
 *
 * <h3>🔴 等間隔を崩してまで本数を揃えない</h3>
 *
 * {@link sampleCenterlineFrames} は曲線の外に出る位置のフレームを**返さない**。
 * 端に丸めて要求どおりの本数を返すと、呼び出し側は「等間隔で置けた」と思ったまま
 * 実際には重なった断面で積分することになる（絵は最後までもっともらしい）。
 * 本数が足りないことは戻り値の長さで分かる。
 */
import { Centerline3D, type FrameMode } from "../viewer/centerline";
import { extractGraphFromSkeleton } from "../viewer/centerlineGraph";
import type { LabelVolume } from "../viewer/labelVolume";
import type { Vec3 } from "../viewer/reslice";
import { skeletonizeLabelVolume } from "../viewer/skeletonize";
import { geomFromIndexToWorld, type PluginMaskInput } from "./pluginMeshApi";

/** 中心線グラフの節点（端点 degree=1 / 分岐点 degree>=3）。 */
export interface PluginCenterlineNode {
  id: number;
  /** 患者 LPS mm。 */
  world: Vec3;
  /** この節点に集まる枝の数。 */
  degree: number;
}

/** 2 つの節点を結ぶ 1 本の枝。**枝の内部に分岐は無い**＝1 本の管に対応する。 */
export interface PluginCenterlineBranch {
  id: number;
  startNode: number;
  endNode: number;
  /** startNode → endNode の順の制御点（患者 LPS mm）。2 点以上。 */
  pointsWorld: Vec3[];
  lengthMm: number;
}

/** {@link extractCenterline} の戻り。Map ではなく配列で返す（プラグインとの契約は素の JSON）。 */
export interface PluginCenterlineGraph {
  nodes: PluginCenterlineNode[];
  branches: PluginCenterlineBranch[];
}

export interface PluginCenterlineOptions {
  /**
   * 制御点の簡略化（Douglas-Peucker）の許容誤差 mm。既定 0.5。
   * 0 にすると骨格ボクセルがそのまま制御点になる。
   */
  simplifyEpsilonMm?: number;
  /** 細線化前に前景 bbox へ付ける余白ボクセル。既定 2。 */
  margin?: number;
  /**
   * 短い葉枝を落とす下限 mm。既定 0（＝落とさない）。
   * 骨格化は表面のこぶから短いひげを生やすので、実データでは 2〜3 mm 程度を入れることが多い。
   */
  pruneMinLengthMm?: number;
  /**
   * 前景とみなすセグメント番号。省略すると **0 以外すべて**が前景。
   *
   * <p>🔴 複数のセグメントが入ったマスクを省略のまま渡すと、**別々の構造が 1 本に繋がった
   * 骨格**ができる（`measureMask` がセグメントごとに独立したメッシュを作るのと同じ罠）。
   */
  segment?: number;
}

/** 弧長位置での 位置 ＋ 正規直交フレーム。 */
export interface PluginCurveFrame {
  positionWorld: Vec3;
  /** 単位・接線方向。 */
  tangent: Vec3;
  /** 単位・接線に直交（出力の第 2 軸）。 */
  normal: Vec3;
  /** 単位・tangent × normal。 */
  binormal: Vec3;
  /** 曲線の始点からの弧長 mm。 */
  arcLengthMm: number;
}

export interface PluginCurveFrameOptions {
  /** フレームどうしの弧長間隔 mm。正の有限値。 */
  spacingMm: number;
  /** 生成する本数。既定 1。曲線の外に出る分は**返らない**（上記の 🔴）。 */
  count?: number;
  /**
   * この点に最も近い曲線上の位置を中心に、前後へ振り分ける。
   * 省略すると曲線の中央（全長の半分）が中心。
   */
  anchorWorld?: Vec3;
  /**
   * 第 2 軸の規約。既定 `"ROTATION_MINIMIZING"`（捩れ最小）。
   * 血管のように曲線が面外へ出る用途はこちら。`"FIXED_Z"` は曲線が 1 断面に収まる用途向け。
   */
  frameMode?: FrameMode;
}

/**
 * マスクを 3D 細線化して中心線グラフにする（H41）。
 *
 * @returns 前景が無い / 幾何が壊れている / 骨格が 1 本も繋がらない場合は `null`。
 *   **空のグラフは返さない**（「解析したが何も無かった」と「解析できなかった」を混ぜない）。
 */
export function extractCenterline(
  mask: PluginMaskInput,
  opts: PluginCenterlineOptions = {},
): PluginCenterlineGraph | null {
  const [nx, ny, nz] = mask.dims;
  const total = nx * ny * nz;
  if (!Number.isFinite(total) || total <= 0) return null;
  if (mask.data.length !== total) return null;

  const geom = geomFromIndexToWorld(mask.dims, mask.indexToWorld);
  if (!geom) return null;

  const wanted = opts.segment;
  const bin = new Uint8Array(total);
  let foreground = 0;
  for (let i = 0; i < total; i++) {
    const v = mask.data[i];
    const fg = wanted === undefined ? v !== 0 : v === wanted;
    if (fg) {
      bin[i] = 1;
      foreground++;
    }
  }
  if (foreground === 0) return null;

  const lv: LabelVolume = {
    geom,
    data: bin,
    voxelMm3: geom.spacing[0] * geom.spacing[1] * geom.spacing[2],
  };

  const skel = skeletonizeLabelVolume(lv, opts.margin ?? 2);
  if (!skel) return null;

  let graph = extractGraphFromSkeleton(skel, opts.simplifyEpsilonMm ?? 0.5);
  const prune = opts.pruneMinLengthMm ?? 0;
  if (prune > 0) graph = graph.prune(prune);
  if (graph.branches.size === 0) return null;

  const nodes: PluginCenterlineNode[] = [];
  for (const n of graph.nodes.values()) {
    nodes.push({ id: n.id, world: [n.pos[0], n.pos[1], n.pos[2]], degree: n.branchIds.length });
  }
  nodes.sort((a, b) => a.id - b.id);

  const branches: PluginCenterlineBranch[] = [];
  for (const b of graph.branches.values()) {
    branches.push({
      id: b.id,
      startNode: b.startNode,
      endNode: b.endNode,
      pointsWorld: b.points.map((p) => [p[0], p[1], p[2]] as Vec3),
      lengthMm: b.lengthMm,
    });
  }
  branches.sort((a, b) => a.id - b.id);

  return { nodes, branches };
}

/**
 * 折れ線に沿って等間隔の位置と正規直交フレームを作る（H41）。
 *
 * <p>補間は本体の {@link Centerline3D}（centripetal Catmull-Rom ＋ 弧長パラメータ化）。
 * **入力の平滑化はしない**——制御点をそのまま通る。平滑化が要るなら呼び出し側で行うこと
 * （どれだけ均すかは測る対象の性質で決まるので、本体が既定値を選ばない）。
 *
 * @returns 弧長の昇順。曲線の外に出る位置は含まないので、**`count` より短くなり得る**。
 *   制御点が 2 点未満、`spacingMm` が非正、曲線長が 0 なら空配列。
 */
export function sampleCenterlineFrames(
  polylineWorld: readonly Vec3[],
  opts: PluginCurveFrameOptions,
): PluginCurveFrame[] {
  const spacing = opts.spacingMm;
  if (!Number.isFinite(spacing) || spacing <= 0) return [];
  if (!polylineWorld || polylineWorld.length < 2) return [];

  const curve = new Centerline3D();
  for (const p of polylineWorld) {
    if (!p || p.length < 3 || !p.every((c) => Number.isFinite(c))) return [];
    curve.addControlPoint([p[0], p[1], p[2]]);
  }
  const totalMm = curve.getTotalLength();
  if (!(totalMm > 0)) return [];

  const mode: FrameMode = opts.frameMode ?? "ROTATION_MINIMIZING";
  const anchorMm = opts.anchorWorld
    ? nearestArcLength(curve, totalMm, opts.anchorWorld, spacing)
    : totalMm / 2;

  const n = Math.max(1, Math.floor(opts.count ?? 1));
  const out: PluginCurveFrame[] = [];
  for (let i = 0; i < n; i++) {
    const s = anchorMm + (i - (n - 1) / 2) * spacing;
    // 端に丸めない。丸めると等間隔でないものが等間隔の顔で返る。
    if (s < 0 || s > totalMm) continue;
    const f = curve.frameAt(s, mode);
    out.push({
      positionWorld: [f.position[0], f.position[1], f.position[2]],
      tangent: [f.tangent[0], f.tangent[1], f.tangent[2]],
      normal: [f.normal[0], f.normal[1], f.normal[2]],
      binormal: [f.binormal[0], f.binormal[1], f.binormal[2]],
      arcLengthMm: s,
    });
  }
  return out;
}

/**
 * 曲線上で `target` に最も近い点の弧長。
 *
 * <p>粗く走査してからその周りを詰める（曲線はせいぜい数百 mm、要る精度は間隔の 1/100 程度）。
 */
function nearestArcLength(
  curve: Centerline3D,
  totalMm: number,
  target: Vec3,
  spacingMm: number,
): number {
  const coarse = Math.max(0.25, Math.min(spacingMm / 4, totalMm / 200));
  let bestS = 0;
  let bestD = Infinity;
  for (let s = 0; s <= totalMm; s += coarse) {
    const d = dist2(curve.frameAt(s, "FIXED_Z").position, target);
    if (d < bestD) {
      bestD = d;
      bestS = s;
    }
  }
  const lo = Math.max(0, bestS - coarse);
  const hi = Math.min(totalMm, bestS + coarse);
  const fine = Math.max(1e-3, spacingMm / 100);
  for (let s = lo; s <= hi; s += fine) {
    const d = dist2(curve.frameAt(s, "FIXED_Z").position, target);
    if (d < bestD) {
      bestD = d;
      bestS = s;
    }
  }
  return bestS;
}

function dist2(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}
