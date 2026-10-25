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
export type CreateRoiTool = "EllipticalROI" | "RectangleROI";
export const CREATE_ROI_TOOLS: readonly CreateRoiTool[] = ["EllipticalROI", "RectangleROI"];

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
  /** 表示の水平方向・垂直方向の半径（楕円）／半幅（矩形）。mm。 */
  radiiMm: [number, number];
  label?: string;
}

export type CreateRoiFailure = "bad-request" | "off-slice" | "no-geometry" | "too-large" | "no-image" | "thick-slab" | "failed";

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
