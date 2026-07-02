/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Slicer コア（P2 改2）。**MPR 3 面（AX/COR/SAG）＋ 独立スラブボックス**方式。
 * リスライス断面（スラブ）は viewport カメラから独立した幾何（center/normal/rowDir/colDir）として持ち、
 * 各面に描いたボックスの **中央ハンドル=平行移動 / 四隅ハンドル=回転** で直接操作する
 * （旧 GRAPHY のリスライスライン方式）。設計 `fw/slicer-design.md` §3・§6。
 *
 * - 各スライスの立方体を全 MPR 面へバンド（交差ポリゴン）投影（`computeSlabBands`）。
 * - スラブ中心・FOV 四隅を canvas 座標のハンドルとして返す（`computeSlabHandles`）。
 * - 平行移動 `translateGeomInPlane` / 面内回転 `rotateGeomInPlane`（対象面の法線軸まわり, Rodrigues）。
 * - 再構成スタックはローカルボリューム化して右下ビューポートに表示（`displayReconStack`）。
 * - 確定リスライスは `reslice.ts`（`createReslicer` でスライス単位＝進捗バー対応）。
 */
import {
  Enums,
  utilities as csUtilities,
  volumeLoader,
  cache,
  type Types,
  type RenderingEngine,
} from "@cornerstonejs/core";
import {
  ToolGroupManager,
  SynchronizerManager,
  StackScrollTool,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { buildMprVolume, type BuildVolumeResult } from "./mpr";
import { getOrCreateVoiSync } from "./sync";
import type { ReslicePlane, ResliceVolume, Vec3 } from "./reslice";

export { buildMprVolume };
export type { BuildVolumeResult };

const { ViewportType, OrientationAxis } = Enums;
const { MouseBindings } = csToolsEnums;

/** Slicer の VOI(W/L) 同期 ID（元 3 面のみ）。 */
export const SLICER_VOI_SYNC_ID = "graphy-slicer-voi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

export interface SlicerVpIds {
  axial: string;
  coronal: string;
  sagittal: string;
  recon: string;
}
export interface SlicerEls {
  axial: HTMLDivElement;
  coronal: HTMLDivElement;
  sagittal: HTMLDivElement;
  recon: HTMLDivElement;
}

/** リスライス基準の断面幾何（world, LPS）。viewport から独立して保持・操作する。 */
export interface SlicerGeometry {
  center: Vec3; // 断面中心（world, mm）
  normal: Vec3; // スタック法線（正規化）
  rowDir: Vec3; // 面内 行方向（正規化）
  colDir: Vec3; // 面内 列方向（正規化）
}

/** スラブ（枚数・厚み・Gap）と面内 FOV。 */
export interface SlabParams {
  numSlices: number;
  thickness: number;
  gap: number;
  fovWidth: number;
  fovHeight: number;
}

/** canvas 座標のポリゴン。空配列＝交差なし。 */
export type BandPolygon = Array<[number, number]>;

/** 1 面ぶんの操作ハンドル（canvas 座標）。 */
export interface SlabHandles {
  center: [number, number] | null;
  corners: Array<[number, number]>; // 中央スライス FOV 矩形の 4 隅（TL,TR,BR,BL）
}

// ── ベクトル小道具 ────────────────────────────────────────────
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]) || 1;
const normalize = (a: Vec3): Vec3 => {
  const n = norm(a);
  return [a[0] / n, a[1] / n, a[2] / n];
};
/** Rodrigues: 単位軸 k まわりに v を θ 回転。 */
const rotateAboutAxis = (v: Vec3, k: Vec3, theta: number): Vec3 => {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
};

/**
 * AX/COR/SAG（volume）＋ recon（空）の 4 ビューポートを有効化。W/L・Pan・Zoom・スライス送りを配線。
 * Crosshairs は使わず、スラブ操作は SVG ハンドル（画面側）で行う。左ボタンは未割当（ハンドル専用）。
 */
export async function setupSlicerMpr(
  engine: RenderingEngine,
  engineId: string,
  els: SlicerEls,
  ids: SlicerVpIds,
  volumeId: string,
  toolGroupId: string,
): Promise<void> {
  engine.setViewports([
    { viewportId: ids.axial, type: ViewportType.ORTHOGRAPHIC, element: els.axial, defaultOptions: { orientation: OrientationAxis.AXIAL, background: [0, 0, 0] as Types.Point3 } },
    { viewportId: ids.coronal, type: ViewportType.ORTHOGRAPHIC, element: els.coronal, defaultOptions: { orientation: OrientationAxis.CORONAL, background: [0, 0, 0] as Types.Point3 } },
    { viewportId: ids.sagittal, type: ViewportType.ORTHOGRAPHIC, element: els.sagittal, defaultOptions: { orientation: OrientationAxis.SAGITTAL, background: [0, 0, 0] as Types.Point3 } },
    { viewportId: ids.recon, type: ViewportType.ORTHOGRAPHIC, element: els.recon, defaultOptions: { orientation: OrientationAxis.AXIAL, background: [0, 0, 0] as Types.Point3 } },
  ]);

  const srcIds = [ids.axial, ids.coronal, ids.sagittal];
  await Promise.all(
    srcIds.map(async (id) => {
      const vp = engine.getViewport(id) as Types.IVolumeViewport;
      await vp.setVolumes([{ volumeId }]);
    }),
  );

  let tg = ToolGroupManager.getToolGroup(toolGroupId);
  if (tg) ToolGroupManager.destroyToolGroup(toolGroupId);
  tg = ToolGroupManager.createToolGroup(toolGroupId);
  if (!tg) return;
  tg.addTool(WindowLevelTool.toolName);
  tg.addTool(PanTool.toolName);
  tg.addTool(ZoomTool.toolName);
  tg.addTool(StackScrollTool.toolName);
  for (const id of [...srcIds, ids.recon]) tg.addViewport(id, engineId);
  tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
  tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
  tg.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });

  const voiSync = getOrCreateVoiSync(SLICER_VOI_SYNC_ID);
  for (const id of srcIds) voiSync.add({ renderingEngineId: engineId, viewportId: id });

  engine.renderViewports([...srcIds, ids.recon]);
}

/**
 * ビューポートのカメラから初期スラブ幾何を得る（Axial 整列）。
 * DICOM 規約に合わせ **colDir = 画面下（row インデックス増加方向）= −viewUp** とする。こうすると
 * 出力フレームが自然な向きになり、再構成表示が上下反転しない。normal = rowDir × colDir（右手系）。
 */
export function readSlicerGeometry(engine: RenderingEngine, viewportId: string): SlicerGeometry | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = engine.getViewport(viewportId) as any;
    const cam = vp.getCamera() as AnyObj;
    const vpn = normalize(cam.viewPlaneNormal as Vec3);
    const up = normalize(cam.viewUp as Vec3);
    const rowDir = normalize(cross(up, vpn)); // 画面右（列インデックス増加）
    const colDir = normalize([-up[0], -up[1], -up[2]]); // 画面下（行インデックス増加）
    const normal = normalize(cross(rowDir, colDir)); // 右手系
    const fp = cam.focalPoint as Vec3;
    return { center: [fp[0], fp[1], fp[2]], normal, rowDir, colDir };
  } catch {
    return null;
  }
}

/**
 * 各 MPR 面（AX/COR/SAG）の表示スライスを world 座標の `center` に合わせる。
 * カメラを **viewPlaneNormal（面奥行き）方向にだけ** 平行移動し、面内 pan/zoom は保持したまま
 * 「center を通る断面」を表示する（クロスヘア相当）。これをしないと各面は volume 中心
 * （＝index 中心）のスライスに固定され、AX で置いた center が COR/SAG では別深さの断面に
 * 投影されて解剖学的にずれて見える。
 *
 * 併せて `computeSlabBands` の切断面（cam.focalPoint）も center 上へ移るため、バンドも整合する。
 */
export function syncViewsToCenter(engine: RenderingEngine, viewportIds: string[], center: Vec3): void {
  for (const id of viewportIds) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vp = engine.getViewport(id) as any;
      const cam = vp.getCamera() as AnyObj;
      const n = normalize(cam.viewPlaneNormal as Vec3);
      const fp = cam.focalPoint as Vec3;
      const pos = cam.position as Vec3;
      // 現在の焦点面から center までの奥行き差（法線方向成分）だけシフトする。
      const d = dot(sub(center, fp), n);
      if (Math.abs(d) < 1e-6) continue;
      const shift = scale(n, d);
      vp.setCamera({ focalPoint: add(fp, shift), position: add(pos, shift) });
      vp.render();
    } catch {
      /* ignore（当該面はスキップ） */
    }
  }
}

/**
 * スラブ幾何から出力平面 `ReslicePlane` を直接構成する（buildReslicePlane の up 再導出を使わず、
 * geom の rowDir/colDir/normal をそのまま採用＝バンド表示・番号・reslicer で完全一貫）。
 * center が画像中心に来るよう左上(0,0)ピクセル中心へ origin を配置。
 */
export function planeFromGeometry(
  geom: SlicerGeometry,
  fovWidth: number,
  fovHeight: number,
  colSpacing: number,
  rowSpacing: number,
): ReslicePlane {
  const cols = Math.max(1, Math.round(fovWidth / colSpacing));
  const rows = Math.max(1, Math.round(fovHeight / rowSpacing));
  const halfW = ((cols - 1) / 2) * colSpacing;
  const halfH = ((rows - 1) / 2) * rowSpacing;
  const origin: Vec3 = [
    geom.center[0] - geom.rowDir[0] * halfW - geom.colDir[0] * halfH,
    geom.center[1] - geom.rowDir[1] * halfW - geom.colDir[1] * halfH,
    geom.center[2] - geom.rowDir[2] * halfW - geom.colDir[2] * halfH,
  ];
  return { origin, rowDir: geom.rowDir, colDir: geom.colDir, cols, rows, colSpacing, rowSpacing };
}

/** 平面(点 p0・法線 n)で線分(a,b)を切断した交点。無ければ null。 */
function edgePlaneHit(a: Vec3, b: Vec3, p0: Vec3, n: Vec3): Vec3 | null {
  const da = dot(n, sub(a, p0));
  const db = dot(n, sub(b, p0));
  if ((da > 0 && db > 0) || (da < 0 && db < 0)) return null;
  const denom = da - db;
  if (Math.abs(denom) < 1e-9) return null;
  const t = da / denom;
  return add(a, scale(sub(b, a), t));
}

// 立方体 8 頂点のビット (bit0=rowDir±, bit1=colDir±, bit2=normal±)。1 ビットだけ違う対を辺とする。
const BOX_EDGES: Array<[number, number]> = (() => {
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) {
    const j = i | bit;
    if (j !== i && j > i) edges.push([i, j]);
  }
  return edges;
})();

/** 各スライス箱を対象 MPR 面で切断し、交差ポリゴン（canvas 座標）を返す。 */
export function computeSlabBands(
  engine: RenderingEngine,
  viewportId: string,
  geom: SlicerGeometry,
  slab: SlabParams,
): BandPolygon[] {
  const out: BandPolygon[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = engine.getViewport(viewportId) as any;
    const cam = vp.getCamera() as AnyObj;
    const Pv = cam.focalPoint as Vec3;
    const Nv = normalize(cam.viewPlaneNormal as Vec3);
    const w2c = (w: Vec3): [number, number] => {
      const p = vp.worldToCanvas(w as Types.Point3) as [number, number];
      return [p[0], p[1]];
    };
    const n = Math.max(1, Math.floor(slab.numSlices));
    const hr = scale(geom.rowDir, slab.fovWidth / 2);
    const hc = scale(geom.colDir, slab.fovHeight / 2);
    const step = slab.thickness + slab.gap;
    for (let s = 0; s < n; s++) {
      const centerOff = (s - (n - 1) / 2) * step;
      const cp = add(geom.center, scale(geom.normal, centerOff));
      const hn = scale(geom.normal, slab.thickness / 2);
      const corners: Vec3[] = [];
      for (let i = 0; i < 8; i++) {
        const sr = i & 1 ? 1 : -1;
        const sc = i & 2 ? 1 : -1;
        const sn = i & 4 ? 1 : -1;
        corners.push(add(add(add(cp, scale(hr, sr)), scale(hc, sc)), scale(hn, sn)));
      }
      const pts: Vec3[] = [];
      for (const [i, j] of BOX_EDGES) {
        const hit = edgePlaneHit(corners[i], corners[j], Pv, Nv);
        if (hit) pts.push(hit);
      }
      if (pts.length < 3) {
        out.push([]);
        continue;
      }
      const cpts = pts.map(w2c);
      let cx = 0;
      let cy = 0;
      for (const p of cpts) {
        cx += p[0];
        cy += p[1];
      }
      cx /= cpts.length;
      cy /= cpts.length;
      cpts.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
      const dedup: BandPolygon = [];
      for (const p of cpts) {
        const last = dedup[dedup.length - 1];
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.5) dedup.push(p);
      }
      out.push(dedup.length >= 3 ? dedup : []);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** スラブ中央スライスの FOV 矩形の中心＋4 隅を canvas 座標のハンドルとして返す。 */
export function computeSlabHandles(engine: RenderingEngine, viewportId: string, geom: SlicerGeometry, slab: SlabParams): SlabHandles {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = engine.getViewport(viewportId) as any;
    const w2c = (w: Vec3): [number, number] => {
      const p = vp.worldToCanvas(w as Types.Point3) as [number, number];
      return [p[0], p[1]];
    };
    const hr = scale(geom.rowDir, slab.fovWidth / 2);
    const hc = scale(geom.colDir, slab.fovHeight / 2);
    const c = geom.center;
    const corners: Array<[number, number]> = [
      w2c(sub(sub(c, hr), hc)), // TL
      w2c(sub(add(c, hr), hc)), // TR
      w2c(add(add(c, hr), hc)), // BR
      w2c(add(sub(c, hr), hc)), // BL  (c - hr + hc)
    ];
    return { center: w2c(c), corners };
  } catch {
    return { center: null, corners: [] };
  }
}

/** 対象面内でスラブ中心を平行移動（canvas last→now の world 差分を center に加算）。 */
export function translateGeomInPlane(engine: RenderingEngine, viewportId: string, geom: SlicerGeometry, last: [number, number], now: [number, number]): SlicerGeometry | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = engine.getViewport(viewportId) as any;
    const wl = vp.canvasToWorld(last) as Vec3;
    const wn = vp.canvasToWorld(now) as Vec3;
    const delta = sub(wn, wl);
    return { ...geom, center: add(geom.center, delta) };
  } catch {
    return null;
  }
}

/** 対象面の法線軸まわりにスラブを回転（center は不動、canvas last→now の world 角度差で rowDir/colDir/normal を回す）。 */
export function rotateGeomInPlane(engine: RenderingEngine, viewportId: string, geom: SlicerGeometry, last: [number, number], now: [number, number]): SlicerGeometry | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = engine.getViewport(viewportId) as any;
    const cam = vp.getCamera() as AnyObj;
    const axis = normalize(cam.viewPlaneNormal as Vec3);
    const a = normalize(sub(vp.canvasToWorld(last) as Vec3, geom.center));
    const b = normalize(sub(vp.canvasToWorld(now) as Vec3, geom.center));
    const theta = Math.atan2(dot(cross(a, b), axis), dot(a, b));
    if (!Number.isFinite(theta) || theta === 0) return geom;
    return {
      center: geom.center,
      normal: normalize(rotateAboutAxis(geom.normal, axis, theta)),
      rowDir: normalize(rotateAboutAxis(geom.rowDir, axis, theta)),
      colDir: normalize(rotateAboutAxis(geom.colDir, axis, theta)),
    };
  } catch {
    return null;
  }
}

/** 再構成スタック（frames+幾何）をローカルボリューム化して recon ビューポートに表示する。 */
export async function displayReconStack(
  engine: RenderingEngine,
  viewportId: string,
  volumeId: string,
  recon: {
    frames: Int16Array[];
    cols: number;
    rows: number;
    numSlices: number;
    origin: Vec3;
    rowDir: Vec3;
    colDir: Vec3;
    normal: Vec3;
    colSpacing: number;
    rowSpacing: number;
    spacingBetweenSlices: number;
    modality: string;
  },
): Promise<void> {
  const { frames, cols, rows, numSlices } = recon;
  const sliceLen = cols * rows;
  const data = new Int16Array(sliceLen * numSlices);
  let min = Infinity;
  let max = -Infinity;
  for (let z = 0; z < numSlices; z++) {
    data.set(frames[z], z * sliceLen);
  }
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 1;
  }
  const metadata: AnyObj = {
    BitsAllocated: 16,
    BitsStored: 16,
    SamplesPerPixel: 1,
    HighBit: 15,
    PhotometricInterpretation: "MONOCHROME2",
    PixelRepresentation: 1,
    Modality: recon.modality || "OT",
    ImageOrientationPatient: [recon.rowDir[0], recon.rowDir[1], recon.rowDir[2], recon.colDir[0], recon.colDir[1], recon.colDir[2]],
    PixelSpacing: [recon.rowSpacing, recon.colSpacing],
    Columns: cols,
    Rows: rows,
    voiLut: [{ windowWidth: Math.max(1, max - min), windowCenter: (max + min) / 2 }],
  };
  try {
    if (cache.getVolume(volumeId)) cache.removeVolumeLoadObject(volumeId);
  } catch {
    /* ignore */
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (volumeLoader.createLocalVolume as any)(volumeId, {
    metadata,
    dimensions: [cols, rows, numSlices],
    spacing: [recon.colSpacing, recon.rowSpacing, recon.spacingBetweenSlices],
    origin: recon.origin,
    direction: [recon.rowDir[0], recon.rowDir[1], recon.rowDir[2], recon.colDir[0], recon.colDir[1], recon.colDir[2], recon.normal[0], recon.normal[1], recon.normal[2]],
    scalarData: data,
  });
  const vp = engine.getViewport(viewportId) as Types.IVolumeViewport;
  await vp.setVolumes([{ volumeId }]);
  // 再構成面の法線方向から見る（ACQUISITION）。AXIAL(world z) のままだと斜め束を横断してストライプ状に途切れる。
  try {
    vp.setOrientation(OrientationAxis.ACQUISITION);
  } catch {
    /* ignore */
  }
  try {
    vp.setProperties({ voiRange: { lower: min, upper: max } });
  } catch {
    /* ignore */
  }
  try {
    vp.resetCamera();
  } catch {
    /* ignore */
  }
  vp.render();
}

/**
 * cornerstone のボリューム状データ（getImageData() の戻り、またはキャッシュ済み volume オブジェクト）から
 * `reslice.ts` 用の `ResliceVolume`（world 幾何）を構築する。両者は dimensions/spacing/origin/direction/
 * voxelManager/scalarData を同形に持つ。
 */
function resliceFromVolumeData(data: AnyObj | undefined | null): ResliceVolume | null {
  try {
    if (!data || !data.dimensions || !data.spacing || !data.origin || !data.direction) return null;
    // 全ボクセル配列の取得。ボリューム種別で権威ある取得元が異なる:
    //  - streaming volume（createImageVolumeVoxelManager）: `voxelManager.getCompleteScalarDataArray()`。
    //    その生配列レイアウトは index = i + j*W + k*W*H（cornerstone の `toIndex` そのもの）で、
    //    `voxelManager.getAtIJK` / `probeMpr` と同一・`makeWorldSampler` の data[k*W*H + j*W + i] 仮定と一致する。
    //    なお `scalarData` getter（=voxelManager.getScalarData()）は streaming では "No scalar data available"
    //    を throw するため使えない。
    //  - local volume（チルト補正 createLocalVolume）: getCompleteScalarDataArray は未定義なので、投入済みの
    //    HU 配列 `data.scalarData` をそのまま使う（レイアウトは我々が構築したとおり）。
    // 重要: streaming で getCompleteScalarDataArray が使えるのに空配列を返す場合（＝未ロード）は、
    // vtk 側の `data.scalarData` が未確定/ステールでレイアウトが getAtIJK とずれることがある（旧 Curved MPR の
    // 不具合原因）。そのステール読みは避け、fallback せず null を返して失敗させる。
    let scalarData: ArrayLike<number> | undefined;
    const getComplete = data.voxelManager?.getCompleteScalarDataArray;
    if (typeof getComplete === "function") {
      // streaming: 権威ある経路。空＝未ロードとみなし、ステールな data.scalarData にはフォールバックしない。
      try {
        scalarData = getComplete.call(data.voxelManager) as ArrayLike<number> | undefined;
      } catch {
        scalarData = undefined;
      }
    } else {
      // local volume: getCompleteScalarDataArray を持たない。投入済み scalarData（getter は throw しない）。
      try {
        scalarData = data.scalarData as ArrayLike<number> | undefined;
      } catch {
        scalarData = undefined;
      }
    }
    if (!scalarData || scalarData.length === 0) return null;
    const dir = Array.from(data.direction as ArrayLike<number>).map(Number);
    // FOV 外（ボリュームからはみ出す）ボクセルは「スタック内最小値」でパディングする（＝ソース最小値。
    // 再構成スタックはソースの部分集合なので両者は一致）。境界のトリリニア混合もこの最小値に収束する。
    const arr = scalarData;
    let min = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v < min) min = v;
    }
    if (!Number.isFinite(min)) min = 0;
    return {
      data: scalarData,
      dimensions: [data.dimensions[0], data.dimensions[1], data.dimensions[2]] as Vec3,
      spacing: [data.spacing[0], data.spacing[1], data.spacing[2]] as Vec3,
      origin: [data.origin[0], data.origin[1], data.origin[2]] as Vec3,
      direction: dir,
      airValue: min,
    };
  } catch {
    return null;
  }
}

/** VolumeViewport から `reslice.ts` 用の `ResliceVolume`（world 幾何）を抽出する（確定生成で使用）。 */
export function extractResliceVolume(engine: RenderingEngine, viewportId: string): ResliceVolume | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = engine.getViewport(viewportId) as any;
    return resliceFromVolumeData(vp.getImageData?.() as AnyObj | undefined);
  } catch {
    return null;
  }
}

/**
 * cornerstone キャッシュ済みボリューム（volumeId）から `ResliceVolume` を構築する。
 * ビューポート不要（world 座標だけで自前 MPR 描画する Slicer で使用）。
 */
export function resliceVolumeFromCache(volumeId: string): ResliceVolume | null {
  try {
    return resliceFromVolumeData(cache.getVolume(volumeId) as AnyObj | undefined);
  } catch {
    return null;
  }
}

/** キャッシュ済みボリュームの既定 VOI（W/L）。voiLut があれば採用、無ければ null（呼び側でデータ範囲へフォールバック）。 */
export function volumeDefaultVoi(volumeId: string): { center: number; width: number } | null {
  try {
    const v = cache.getVolume(volumeId) as AnyObj | undefined;
    const voi = v?.metadata?.voiLut?.[0];
    const ww = Number(voi?.windowWidth);
    const wc = Number(voi?.windowCenter);
    if (Number.isFinite(ww) && Number.isFinite(wc) && ww > 0) return { center: wc, width: ww };
  } catch {
    /* ignore */
  }
  return null;
}

/** ボリュームの Modality を得る。 */
export function volumeModality(engine: RenderingEngine, viewportId: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = engine.getViewport(viewportId) as any;
    return String(vp.getImageData?.()?.metadata?.Modality ?? "");
  } catch {
    return "";
  }
}

/** ボリュームの spacing の最小値（サブサンプル/出力既定間隔）。取得不可なら 1。 */
export function volumeMinSpacing(engine: RenderingEngine, viewportId: string): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = engine.getViewport(viewportId) as any;
    const sp = vp.getImageData?.()?.spacing as ArrayLike<number> | undefined;
    if (!sp) return 1;
    return Math.min(sp[0], sp[1], sp[2]) || 1;
  } catch {
    return 1;
  }
}

/** transformWorldToIndex（ボクセル座標 IJK を得る）。 */
export function worldToIndex(engine: RenderingEngine, viewportId: string, world: Vec3): number[] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = engine.getViewport(viewportId) as any;
    const data = vp.getImageData?.();
    if (!data?.imageData) return null;
    return csUtilities.transformWorldToIndex(data.imageData, world) as number[];
  } catch {
    return null;
  }
}

/** transformIndexToWorld（ボクセル座標 IJK → world）。 */
export function indexToWorld(engine: RenderingEngine, viewportId: string, ijk: Vec3): Vec3 | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = engine.getViewport(viewportId) as any;
    const data = vp.getImageData?.();
    if (!data?.imageData) return null;
    const w = csUtilities.transformIndexToWorld(data.imageData, ijk) as number[];
    return [w[0], w[1], w[2]];
  } catch {
    return null;
  }
}

// ── 回転角（XYZ Euler, deg）⇔ 断面ジオメトリ ────────────────────────────────
// 基準フレーム base（起動時の Axial 整列 rowDir/colDir/normal）に対する回転を Euler(XYZ) で表す。
// R = Rz(γ)·Ry(β)·Rx(α)（外因性 X→Y→Z）。current = R·base。

type Mat3 = number[]; // 9, 行優先 R[row*3+col]

/** Euler(度) → 回転行列 R = Rz·Ry·Rx。 */
function eulerToMat(degX: number, degY: number, degZ: number): Mat3 {
  const a = (degX * Math.PI) / 180;
  const b = (degY * Math.PI) / 180;
  const g = (degZ * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cg = Math.cos(g), sg = Math.sin(g);
  return [
    cb * cg, sa * sb * cg - ca * sg, ca * sb * cg + sa * sg,
    cb * sg, sa * sb * sg + ca * cg, ca * sb * sg - sa * cg,
    -sb, sa * cb, ca * cb,
  ];
}
const matVec = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** 基準フレーム base に Euler(度) を適用して断面ジオメトリを作る（center は与えた値）。 */
export function anglesToGeometry(base: SlicerGeometry, center: Vec3, deg: [number, number, number]): SlicerGeometry {
  const R = eulerToMat(deg[0], deg[1], deg[2]);
  return {
    center,
    rowDir: normalize(matVec(R, base.rowDir)),
    colDir: normalize(matVec(R, base.colDir)),
    normal: normalize(matVec(R, base.normal)),
  };
}

/** 現在ジオメトリの base に対する Euler(XYZ) 回転角（度）を返す。R = current·baseᵀ を分解。 */
export function geometryToAngles(base: SlicerGeometry, geom: SlicerGeometry): [number, number, number] {
  const r0 = base.rowDir, c0 = base.colDir, n0 = base.normal;
  const r1 = geom.rowDir, c1 = geom.colDir, n1 = geom.normal;
  // R[i][j] = r1[i]r0[j] + c1[i]c0[j] + n1[i]n0[j]（= M1·M0ᵀ）。
  const R: Mat3 = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) R[i * 3 + j] = r1[i] * r0[j] + c1[i] * c0[j] + n1[i] * n0[j];
  const clamp = (x: number) => Math.max(-1, Math.min(1, x));
  const rad2deg = 180 / Math.PI;
  let ax: number, ay: number, az: number;
  const sy = -R[6]; // -R[2][0] = sin? → β=asin(-R20)
  ay = Math.asin(clamp(sy));
  if (Math.abs(R[6]) < 0.999999) {
    ax = Math.atan2(R[7], R[8]); // atan2(R21,R22)
    az = Math.atan2(R[3], R[0]); // atan2(R10,R00)
  } else {
    // ジンバルロック: β≈±90°。az=0 とし ax を合成から求める。
    az = 0;
    ax = Math.atan2(-R[5], R[4]);
  }
  return [ax * rad2deg, ay * rad2deg, az * rad2deg];
}

/**
 * 再構成プレビュー用の単一 ORTHOGRAPHIC ビューポートだけを有効化する（world 自前描画版 Slicer 用）。
 * 3 面（AX/COR/SAG）は cornerstone を使わず canvas 自前描画するため、cornerstone は recon 表示専用。
 * W/L=右 / Pan=中 / スライス送り=ホイール / Zoom を配線。
 */
export async function setupReconViewport(
  engine: RenderingEngine,
  engineId: string,
  el: HTMLDivElement,
  viewportId: string,
  toolGroupId: string,
): Promise<void> {
  engine.setViewports([
    { viewportId, type: ViewportType.ORTHOGRAPHIC, element: el, defaultOptions: { orientation: OrientationAxis.AXIAL, background: [0, 0, 0] as Types.Point3 } },
  ]);
  let tg = ToolGroupManager.getToolGroup(toolGroupId);
  if (tg) ToolGroupManager.destroyToolGroup(toolGroupId);
  tg = ToolGroupManager.createToolGroup(toolGroupId);
  if (!tg) return;
  tg.addTool(WindowLevelTool.toolName);
  tg.addTool(PanTool.toolName);
  tg.addTool(ZoomTool.toolName);
  tg.addTool(StackScrollTool.toolName);
  tg.addViewport(viewportId, engineId);
  tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
  tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
  tg.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });
  engine.renderViewports([viewportId]);
}

/** Slicer のツールグループ・同期・エンジンを破棄する（アンマウント時）。 */
export function teardownSlicer(engine: RenderingEngine | null, toolGroupId: string): void {
  try {
    if (SynchronizerManager.getSynchronizer(SLICER_VOI_SYNC_ID)) SynchronizerManager.destroySynchronizer(SLICER_VOI_SYNC_ID);
  } catch {
    /* ignore */
  }
  try {
    if (ToolGroupManager.getToolGroup(toolGroupId)) ToolGroupManager.destroyToolGroup(toolGroupId);
  } catch {
    /* ignore */
  }
  try {
    engine?.destroy();
  } catch {
    /* ignore */
  }
}
