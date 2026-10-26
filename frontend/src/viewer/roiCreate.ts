/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグインが ROI（楕円・矩形）を作るときの、ハンドル点の組み立て（純関数）。
 *
 * <p>入力は**患者座標 LPS（mm）**の中心と、表示の水平・垂直方向の半径（mm）。ハンドルは Cornerstone の規約どおり
 * 表示（canvas）の軸に揃えて作る（楕円・矩形は canvas 軸に揃う描画・統計の定義なので、画像の軸ではなく表示の軸に合わせないと
 * 回転・反転した表示で形がずれる）。canvas ↔ world の変換は呼び出し側が渡す（Cornerstone を import しない＝単体テストできる）。
 *
 * <p>ハンドルの並び（Cornerstone3D の `EllipticalROITool` / `RectangleROITool` の規約。canvas は y が下向き）:
 * 楕円 `[bottom, top, left, right]`（辺の中点）、矩形 `[bottomLeft, bottomRight, topLeft, topRight]`。
 */
export type CreateRoiTool = "EllipticalROI" | "RectangleROI" | "PolygonROI" | "FreehandROI";
/** 中心と半径で作る形（`buildRoiHandles`）。 */
export const CREATE_ROI_TOOLS: readonly CreateRoiTool[] = ["EllipticalROI", "RectangleROI"];
/** 頂点で作る閉じた輪郭（`buildContourVertices`）。多角形は直線で結ぶ。自由曲線は点が密な閉曲線。 */
export const CREATE_CONTOUR_TOOLS: readonly CreateRoiTool[] = ["PolygonROI", "FreehandROI"];
export const isContourCreateTool = (t: unknown): boolean => CREATE_CONTOUR_TOOLS.includes(t as CreateRoiTool);
/** 頂点数の範囲。暫定値（モデルが 1 回に指せる点の数と、自己交差の検査 O(n²) の上限から）。 */
export const MIN_CONTOUR_VERTICES = 3;
export const MAX_CONTOUR_VERTICES: Record<string, number> = { PolygonROI: 64, FreehandROI: 256 };

export interface CreateRoiRequest {
  tool: CreateRoiTool;
  /** 中心（患者座標 LPS, mm）。表示中のスライスの面内にあること。`centerPx` とどちらか**一方だけ**。 */
  centerLps?: [number, number, number];
  /**
   * 中心（表示中のスライスの画素座標 `[列, 行]`。`getRois()` の `points` と同じ座標）。2D の画素だけを扱うプラグイン用で、
   * 本体が LPS へ変換する（スライスの面内なので面外にはならない）。`centerLps` とどちらか**一方だけ**。
   */
  centerPx?: [number, number];
  /**
   * 中心（表示キャンバスに対する割合 `[0〜1, 0〜1]`、左上原点）。**画面に見えている位置**で指す（回転・反転・拡大の後でも見たまま）。
   * 本体が表示中の面上の LPS へ変換する（`Viewer2D.createRoi`）。他の中心指定とは併用できない。アシスタント用。
   */
  centerView?: [number, number];
  /** 表示の水平方向・垂直方向の半径（楕円）／半幅（矩形）。mm。多角形・自由曲線では使わない。 */
  radiiMm?: [number, number];
  /**
   * 多角形・自由曲線の頂点（順に結ぶ。閉じるので始点を繰り返さない）。次の 3 つのどれか**一方だけ**:
   * 患者座標 LPS（mm）／表示中のスライスの画素座標／表示キャンバスに対する割合（左上原点・アシスタント用）。
   * 全頂点が表示中のスライスの面内であること。自己交差・面積ゼロは拒否。
   */
  verticesLps?: [number, number, number][];
  verticesPx?: [number, number][];
  verticesView?: [number, number][];
  label?: string;
}

export type CreateRoiFailure = "bad-request" | "off-slice" | "no-geometry" | "too-large" | "no-image" | "thick-slab" | "self-intersecting" | "degenerate" | "failed";

export interface RoiCreateGeometry {
  worldToCanvas(p: number[]): [number, number] | null;
  canvasToWorld(c: [number, number]): [number, number, number] | null;
  /** 表示中のスライスの画素座標 → 患者座標（`centerPx` を受けるときだけ要る）。 */
  pixelToWorld?(p: [number, number]): number[] | null;
  /** 表示中のスライスの面（カメラの focalPoint を通り、viewPlaneNormal が法線）。 */
  focalPoint: number[];
  viewPlaneNormal: number[];
  /** 「このスライスの上」とみなす面外の距離（mm）。呼び出し側がスライス間隔から導く。 */
  sliceToleranceMm: number;
  /** ROI の半径の上限（mm）。呼び出し側が画像の大きさから導く。 */
  maxExtentMm: number;
}

const finite3 = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
const sub = (a: number[], b: number[]): number[] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: number[]): number => Math.hypot(a[0], a[1], a[2]);
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** ハンドル点（world, mm）。拒否は理由つき。 */
export function buildRoiHandles(
  req: CreateRoiRequest,
  g: RoiCreateGeometry,
): { ok: true; points: number[][]; centerLps: [number, number, number] } | { ok: false; reason: CreateRoiFailure } {
  if (!req || !CREATE_ROI_TOOLS.includes(req.tool)) return { ok: false, reason: "bad-request" };
  const hasLps = req.centerLps !== undefined;
  const hasPx = req.centerPx !== undefined;
  if (hasLps === hasPx) return { ok: false, reason: "bad-request" }; // 一方だけ
  if (hasLps && !finite3(req.centerLps)) return { ok: false, reason: "bad-request" };
  if (hasPx && !(Array.isArray(req.centerPx) && req.centerPx.length === 2 && req.centerPx.every((n) => typeof n === "number" && Number.isFinite(n)))) {
    return { ok: false, reason: "bad-request" };
  }
  const r = req.radiiMm;
  if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)) return { ok: false, reason: "bad-request" };
  if (!(g.maxExtentMm > 0) || !(g.sliceToleranceMm > 0) || !finite3(g.focalPoint) || !finite3(g.viewPlaneNormal)) return { ok: false, reason: "no-geometry" };
  if (r[0] > g.maxExtentMm || r[1] > g.maxExtentMm) return { ok: false, reason: "too-large" };
  const nLen = norm(g.viewPlaneNormal);
  if (!(nLen > 0)) return { ok: false, reason: "no-geometry" };
  let center: number[];
  if (hasPx) {
    const w = g.pixelToWorld?.(req.centerPx as [number, number]);
    if (!w || !finite3(w)) return { ok: false, reason: "no-geometry" };
    center = w;
  } else {
    center = req.centerLps as number[];
  }
  // 面外の距離（符号なし）。中心が表示中のスライスの面に乗っていなければ、別のスライスへ作ることになるので拒否する。
  const off = Math.abs(dot(sub(center, g.focalPoint), g.viewPlaneNormal)) / nLen;
  if (off > g.sliceToleranceMm) return { ok: false, reason: "off-slice" };

  const c = g.worldToCanvas(center);
  if (!c) return { ok: false, reason: "no-geometry" };
  const w0 = g.canvasToWorld(c);
  const wx = g.canvasToWorld([c[0] + 1, c[1]]);
  const wy = g.canvasToWorld([c[0], c[1] + 1]);
  if (!w0 || !wx || !wy) return { ok: false, reason: "no-geometry" };
  // canvas 1 px あたりの mm（水平・垂直）。表示倍率・画素間隔に依らず、world 側の実距離から求める。
  const sx = norm(sub(wx, w0));
  const sy = norm(sub(wy, w0));
  if (!(sx > 0) || !(sy > 0) || !Number.isFinite(sx) || !Number.isFinite(sy)) return { ok: false, reason: "no-geometry" };
  const rx = r[0] / sx;
  const ry = r[1] / sy;
  const at = (dx: number, dy: number): number[] | null => g.canvasToWorld([c[0] + dx, c[1] + dy]);
  const pts =
    req.tool === "EllipticalROI"
      ? [at(0, ry), at(0, -ry), at(-rx, 0), at(rx, 0)]
      : [at(-rx, ry), at(rx, ry), at(-rx, -ry), at(rx, -ry)];
  if (pts.some((p) => !p || !finite3(p))) return { ok: false, reason: "no-geometry" };
  return { ok: true, points: pts as number[][], centerLps: [center[0], center[1], center[2]] };
}

/**
 * 「表示中のスライスの上」とみなす面外の距離（mm）を、スタックのスライス間隔から導く: 隣のスライスまでの距離の半分。
 * 隣が無い・同じ位置（マルチフレームの全フレームが同一位置など）のときは `fallbackMm`（画素間隔など）の半分。
 * どちらも無ければ null（捏造しない）。
 */
export function sliceToleranceFromStack(
  here: number[] | undefined,
  neighbor: number[] | undefined,
  fallbackMm: number | null,
): number | null {
  if (finite3(here) && finite3(neighbor)) {
    const d = norm(sub(here, neighbor));
    if (d > 1e-6) return d / 2;
  }
  return typeof fallbackMm === "number" && Number.isFinite(fallbackMm) && fallbackMm > 0 ? fallbackMm / 2 : null;
}

/** ROI の半径の上限（mm）: 画像の対角の長さ。画像の大きさから導く。不正なら null。 */
export function maxExtentFromImage(rows: unknown, columns: unknown, rowSpacingMm: unknown, columnSpacingMm: unknown): number | null {
  const ok = [rows, columns, rowSpacingMm, columnSpacingMm].every((n) => typeof n === "number" && Number.isFinite(n) && n > 0);
  if (!ok) return null;
  return Math.hypot((rows as number) * (rowSpacingMm as number), (columns as number) * (columnSpacingMm as number));
}

const cross2 = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const onSeg = (a: [number, number], b: [number, number], p: [number, number]): boolean =>
  Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);

/** 線分 ab と cd が交わる（端点で触れる・重なるを含む）。 */
function segmentsTouch(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const d1 = cross2(c, d, a);
  const d2 = cross2(c, d, b);
  const d3 = cross2(a, b, c);
  const d4 = cross2(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && onSeg(c, d, a)) || (d2 === 0 && onSeg(c, d, b)) || (d3 === 0 && onSeg(a, b, c)) || (d4 === 0 && onSeg(a, b, d));
}

/** 閉じた多角形（canvas 座標）が自分自身と交わるか。隣り合う辺は端点を共有するので除く。 */
export function isSelfIntersecting(c: [number, number][]): boolean {
  const n = c.length;
  for (let i = 0; i < n; i++) {
    const a = c[i];
    const b = c[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue; // 隣り合う辺
      if (segmentsTouch(a, b, c[j], c[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * 多角形・自由曲線の頂点（world, mm）。拒否は理由つき。頂点は LPS か画素で受ける（割合 `verticesView` は呼び出し側が LPS へ変換して渡す）。
 * 連続する同一点は 1 つにする。自己交差・面積ゼロは拒否する（面積・統計の定義が崩れる形を作らない）。
 */
export function buildContourVertices(
  req: CreateRoiRequest,
  g: RoiCreateGeometry,
): { ok: true; points: number[][]; centerLps: [number, number, number] } | { ok: false; reason: CreateRoiFailure } {
  if (!req || !isContourCreateTool(req.tool)) return { ok: false, reason: "bad-request" };
  const hasLps = req.verticesLps !== undefined;
  const hasPx = req.verticesPx !== undefined;
  if (hasLps === hasPx) return { ok: false, reason: "bad-request" };
  const raw = (hasLps ? req.verticesLps : req.verticesPx) as unknown;
  const max = MAX_CONTOUR_VERTICES[req.tool];
  if (!Array.isArray(raw) || raw.length < MIN_CONTOUR_VERTICES || raw.length > max) return { ok: false, reason: "bad-request" };
  if (!(g.sliceToleranceMm > 0) || !(g.maxExtentMm > 0) || !finite3(g.focalPoint) || !finite3(g.viewPlaneNormal)) return { ok: false, reason: "no-geometry" };
  const nLen = norm(g.viewPlaneNormal);
  if (!(nLen > 0)) return { ok: false, reason: "no-geometry" };
  const world: number[][] = [];
  for (const v of raw) {
    let w: number[] | null | undefined;
    if (hasLps) {
      if (!finite3(v)) return { ok: false, reason: "bad-request" };
      w = v as number[];
    } else {
      if (!(Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n)))) return { ok: false, reason: "bad-request" };
      w = g.pixelToWorld?.(v as [number, number]);
      if (!w || !finite3(w)) return { ok: false, reason: "no-geometry" };
    }
    if (Math.abs(dot(sub(w, g.focalPoint), g.viewPlaneNormal)) / nLen > g.sliceToleranceMm) return { ok: false, reason: "off-slice" };
    const prev = world[world.length - 1];
    if (prev && norm(sub(w, prev)) <= 1e-6) continue; // 浮動小数点の誤差程度の重複
    world.push([w[0], w[1], w[2]]);
  }
  if (world.length > 1 && norm(sub(world[0], world[world.length - 1])) <= 1e-6) world.pop();
  if (world.length < MIN_CONTOUR_VERTICES) return { ok: false, reason: "degenerate" };
  const canvas: [number, number][] = [];
  for (const w of world) {
    const c = g.worldToCanvas(w);
    if (!c) return { ok: false, reason: "no-geometry" };
    canvas.push(c);
  }
  // 大きさ: 頂点を囲む直方体の対角が画像の対角以下
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const w of world) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
  const diag = norm(sub(hi, lo));
  if (diag > g.maxExtentMm) return { ok: false, reason: "too-large" };
  // 自己交差を先に見る（左右対称の蝶ネクタイは符号付き面積が 0 になり、面積の検査だと理由を取り違える）
  if (isSelfIntersecting(canvas)) return { ok: false, reason: "self-intersecting" };
  // 面積ゼロ（共線）: 面の法線方向の成分で測った多角形の面積。誤差の範囲（対角の 1e-9 倍の二乗）以下なら拒否
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < world.length; i++) {
    const a = world[i];
    const b = world[(i + 1) % world.length];
    sx += a[1] * b[2] - a[2] * b[1];
    sy += a[2] * b[0] - a[0] * b[2];
    sz += a[0] * b[1] - a[1] * b[0];
  }
  const area = Math.abs(sx * g.viewPlaneNormal[0] + sy * g.viewPlaneNormal[1] + sz * g.viewPlaneNormal[2]) / (2 * nLen);
  if (!(area > (1e-9 * diag) ** 2)) return { ok: false, reason: "degenerate" };
  const m = [0, 0, 0];
  for (const w of world) for (let k = 0; k < 3; k++) m[k] += w[k] / world.length;
  return { ok: true, points: world, centerLps: [m[0], m[1], m[2]] };
}
