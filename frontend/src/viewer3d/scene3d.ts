/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D シーンコントローラ（`fw/3d-viewer-design.md` §5.4, §8）。
 *
 * pure VTK.js の描画レンダラ（`vtkVolumeView` 内部の `vtkRenderer`）に、メッシュ / 3D ROI の
 * `vtkActor` を addActor して重畳する。ボリューム表示と**同一 LPS mm シーン**に共存させ、深度・カメラを共有。
 * 重い vtk データ（`vtkPolyData` / `LabelVolume` / `vtkActor`）はここで非リアクティブに保持し、
 * 軽量メタは `scene3dStore.ts`（React 購読）に反映する。
 */
import vtkPlane from "@kitware/vtk.js/Common/DataModel/Plane";
import {
  type LabelVolume,
  type VolumeGeom,
  countForeground,
  voxelToWorld,
} from "../viewer/labelVolume";
import {
  makeSurfaceActor,
  updateActorAppearance,
  measureMesh,
  getMeshArrays,
  type MeshActor,
} from "../viewer/mesh3d";
import { labelVolumeToMesh, meshToLabelVolume } from "../viewer/roiMesh";
import { Centerline3D } from "../viewer/centerline";
import { extractCenterlineGraph, graphSummary, type CenterlineGraph } from "../viewer/centerlineGraph";
import { createEndoController, type EndoController } from "../viewer/endoscopy";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkTubeFilter from "@kitware/vtk.js/Filters/General/TubeFilter";
import vtkSphereSource from "@kitware/vtk.js/Filters/Sources/SphereSource";
import {
  addSceneObject,
  getSceneObject,
  nextSceneId,
  removeSceneObject,
  updateSceneObject,
  clearSceneObjects,
  getSceneObjects,
  type SceneObject,
} from "./scene3dStore";
import { record, clearUndo } from "./undoStore";
import {
  makeActorTransform,
  pointInPolygon,
  type CutMode,
  type Projector,
} from "./volumeCut";
import { rayTriangleIntersect, type Ray } from "./measure3d";
import {
  getEndoPath,
  setEndoPath,
  clearEndoPath,
} from "./endoPathStore";
import {
  addMeasurement,
  removeMeasurement,
  clearMeasurements,
  getMeasurements,
  nextMeasureId,
  type Measurement3D,
} from "./measureStore";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type V3 = [number, number, number];

const PALETTE: V3[] = [
  [0.9, 0.4, 0.4],
  [0.4, 0.75, 0.95],
  [0.55, 0.85, 0.45],
  [0.95, 0.8, 0.35],
  [0.75, 0.55, 0.9],
  [0.4, 0.85, 0.8],
  [0.95, 0.6, 0.35],
  [0.85, 0.55, 0.7],
];

interface SceneData {
  polydata?: Any; // 表示メッシュ（ROI は表面メッシュ, 中心線はチューブ）
  labelVolume?: LabelVolume; // ROI のマスク本体
  centerline?: Centerline3D; // 中心線（内視鏡 fly-through と共通の親パス）
  ma?: MeshActor;
}

let renderer: Any = null;
let renderFn: (() => void) | null = null;
/** ボリュームの不透明度を一律スケール（`vtkVolumeView.setOpacityScale`）。fly-through 減光用。 */
let volumeOpacityScaleFn: ((factor: number) => void) | null = null;
const dataById = new Map<string, SceneData>();
let colorSeq = 0;

// ── クリップ箱の共有状態（埋め込み表示のため）──────────────────
// ボリューム側（`vtkVolumeView`）のクリップ箱（index extent）と幾何を保持し、
// 「埋め込み(embedded)」オブジェクトの mapper に同じ範囲のクリップ平面を付ける。
let clipGeom: VolumeGeom | null = null;
let clipExtent: number[] | null = null; // [i0,i1,j0,j1,k0,k1]（index）
let fullExtent: number[] | null = null;

/** レンダラ（`vtkVolumeView.getSceneParts()`）を接続する。`setVolumeOpacityScale` を渡すと
 * fly-through 開始時に生ボリュームを減光できる（`vtkVolumeView.setOpacityScale`）。 */
export function attachSceneRenderer(parts: {
  renderer: Any;
  render: () => void;
  setVolumeOpacityScale?: (factor: number) => void;
}): void {
  renderer = parts.renderer;
  renderFn = parts.render;
  volumeOpacityScaleFn = parts.setVolumeOpacityScale ?? null;
  // 接続時、既存オブジェクトのアクターを（あれば）付け直す。
  for (const [, d] of dataById) {
    if (d.ma && renderer) {
      try {
        renderer.addActor(d.ma.actor);
      } catch {
        /* ignore */
      }
    }
  }
  renderFn?.();
}

/** レンダラを切り離し、全シーンを破棄する（ビューアのアンマウント時）。 */
export function resetScene(): void {
  for (const [, d] of dataById) {
    disposeData(d);
  }
  dataById.clear();
  clearSceneObjects();
  clearMeasurements();
  clearEndoPath();
  clearUndo();
  stopEndoscopy();
  centerlineSourceId.clear();
  renderer = null;
  renderFn = null;
  volumeOpacityScaleFn = null;
  colorSeq = 0;
  clipGeom = null;
  clipExtent = null;
  fullExtent = null;
}

/** クリップ箱の幾何（表示ボリュームの実空間幾何）を設定する（埋め込み表示の基準）。 */
export function setClipContext(geom: VolumeGeom | null): void {
  clipGeom = geom;
  fullExtent = geom
    ? [0, geom.dims[0] - 1, 0, geom.dims[1] - 1, 0, geom.dims[2] - 1]
    : null;
}

/**
 * ボリューム側のクリップ箱（index extent）が変化したら呼ぶ。
 * 埋め込み(embedded)オブジェクトの mapper にクリップ平面を張り直す。
 */
export function updateClip(extent: number[] | null): void {
  clipExtent = extent && extent.length === 6 ? extent.slice() : null;
  for (const [id] of dataById) applyObjectClip(id);
  render();
}

/** クリップが実効的に効いているか（全域より内側に縮んでいるか）。 */
function isClipActive(): boolean {
  if (!clipExtent || !fullExtent) return false;
  for (let a = 0; a < 3; a++) {
    if (clipExtent[a * 2] > fullExtent[a * 2] + 1e-6) return true;
    if (clipExtent[a * 2 + 1] < fullExtent[a * 2 + 1] - 1e-6) return true;
  }
  return false;
}

/** クリップ箱（index extent + geom）から 6 枚の world 空間クリップ平面を作る。 */
function computeClipPlanes(): Any[] {
  if (!clipExtent || !clipGeom) return [];
  const g = clipGeom;
  const d = g.direction;
  const xAxis: V3 = [d[0], d[3], d[6]]; // +i 方向（world 単位）
  const yAxis: V3 = [d[1], d[4], d[7]]; // +j
  const zAxis: V3 = [d[2], d[5], d[8]]; // +k
  const [i0, i1, j0, j1, k0, k1] = clipExtent;
  const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
  const plane = (origin: V3, normal: V3): Any => {
    const p: Any = vtkPlane.newInstance();
    p.setOrigin(origin[0], origin[1], origin[2]);
    p.setNormal(normal[0], normal[1], normal[2]);
    return p;
  };
  return [
    plane(voxelToWorld(g, i0, 0, 0), xAxis), // i>=i0 を残す
    plane(voxelToWorld(g, i1, 0, 0), neg(xAxis)), // i<=i1
    plane(voxelToWorld(g, 0, j0, 0), yAxis),
    plane(voxelToWorld(g, 0, j1, 0), neg(yAxis)),
    plane(voxelToWorld(g, 0, 0, k0), zAxis),
    plane(voxelToWorld(g, 0, 0, k1), neg(zAxis)),
  ];
}

/** オブジェクトの mapper に、表示モード＋現在のクリップ状態に応じてクリップ平面を適用/解除。 */
function applyObjectClip(id: string): void {
  const d = dataById.get(id);
  const obj = getSceneObject(id);
  const mapper = d?.ma?.mapper;
  if (!mapper) return;
  try {
    mapper.removeAllClippingPlanes();
    if (obj?.displayMode === "embedded" && isClipActive()) {
      for (const p of computeClipPlanes()) mapper.addClippingPlane(p);
    }
  } catch {
    /* ignore */
  }
}

function disposeData(d: SceneData): void {
  try {
    if (d.ma && renderer) renderer.removeActor(d.ma.actor);
  } catch {
    /* ignore */
  }
  try {
    d.ma?.actor?.delete?.();
    d.ma?.mapper?.delete?.();
  } catch {
    /* ignore */
  }
}

function render(): void {
  renderFn?.();
}

function nextColor(preferred?: V3): V3 {
  if (preferred) return preferred;
  return PALETTE[colorSeq++ % PALETTE.length];
}

// ── attach/detach（Undo/Redo で再利用。アクターは delete せず保持）──────
function attachObjectInternal(id: string, obj: SceneObject, data: SceneData): void {
  dataById.set(id, data);
  if (renderer && data.ma) {
    try {
      renderer.addActor(data.ma.actor);
    } catch {
      /* ignore */
    }
  }
  addSceneObject(obj);
  applyObjectClip(id);
  render();
}
function detachObjectInternal(id: string): void {
  const d = dataById.get(id);
  if (d?.ma && renderer) {
    try {
      renderer.removeActor(d.ma.actor);
    } catch {
      /* ignore */
    }
  }
  dataById.delete(id);
  removeSceneObject(id);
  render();
}

// ── 外観適用（記録なし。undo/redo から呼ぶ内部関数）──────────────
function applyColorInternal(id: string, color: V3): void {
  const d = dataById.get(id);
  if (d?.ma) updateActorAppearance(d.ma, { color });
  updateSceneObject(id, { color });
  render();
}
function applyOpacityInternal(id: string, opacity: number): void {
  const d = dataById.get(id);
  if (d?.ma) updateActorAppearance(d.ma, { opacity });
  updateSceneObject(id, { opacity });
  render();
}
function applyVisibleInternal(id: string, visible: boolean): void {
  const d = dataById.get(id);
  if (d?.ma) updateActorAppearance(d.ma, { visible });
  updateSceneObject(id, { visible });
  render();
}
function applyDisplayModeInternal(id: string, mode: "float" | "embedded"): void {
  updateSceneObject(id, { displayMode: mode });
  applyObjectClip(id);
  render();
}

export interface AddOptions {
  name?: string;
  color?: V3;
  opacity?: number;
}

/** メッシュ（`vtkPolyData`, LPS mm）をシーンに追加。追加した id を返す。 */
export function addMeshObject(polydata: Any, opts: AddOptions = {}): string | null {
  if (!polydata || polydata.getNumberOfPoints?.() === 0) return null;
  const id = nextSceneId("mesh");
  const color = nextColor(opts.color);
  const opacity = opts.opacity ?? 1;
  const ma = makeSurfaceActor(polydata, { color, opacity, visible: true });
  const data: SceneData = { polydata, ma };
  const m = measureMesh(polydata);
  const obj: SceneObject = {
    id,
    kind: "mesh",
    name: opts.name ?? `Mesh ${id.split("-")[1]}`,
    color,
    opacity,
    visible: true,
    displayMode: "float",
    volumeMm3: m.volumeMm3,
    volumeMl: m.volumeMl,
    surfaceAreaMm2: m.surfaceAreaMm2,
    diameters: m.diameters,
    numTriangles: m.numTriangles,
  };
  attachObjectInternal(id, obj, data);
  recordAdd(id, obj, data);
  return id;
}

/**
 * パラメトリック 3D 球（`sphere3dStore.ts` の `Sphere3D`）を、Mask への焼き込み・再インポートを
 * 経由せず直接メッシュとしてシーンへ追加する（`fw/mask-driven-pipelines-gap-analysis.md` 課題#7）。
 */
export function addSphereObject(center: V3, radiusMm: number, opts: AddOptions = {}): string | null {
  if (!(radiusMm > 0)) return null;
  const src: Any = vtkSphereSource.newInstance();
  src.setCenter(center[0], center[1], center[2]);
  src.setRadius(radiusMm);
  src.setThetaResolution(32);
  src.setPhiResolution(32);
  return addMeshObject(src.getOutputData(), opts);
}

/**
 * 3D ROI（LabelVolume, 実空間 labelmap）をシーンに追加。
 * 表面メッシュ（marching cubes）を生成して描画し、体積はボクセルから確定計算する。
 */
export function addRoiObject(lv: LabelVolume, opts: AddOptions = {}): string | null {
  const surf = labelVolumeToMesh(lv);
  if (!surf) return null;
  const id = nextSceneId("roi");
  const color = nextColor(opts.color);
  const opacity = opts.opacity ?? 0.5;
  const ma = makeSurfaceActor(surf, { color, opacity, visible: true });
  const data: SceneData = { polydata: surf, labelVolume: lv, ma };
  const voxels = countForeground(lv);
  const volumeMm3 = voxels * lv.voxelMm3;
  const m = measureMesh(surf);
  const obj: SceneObject = {
    id,
    kind: "roi",
    name: opts.name ?? `ROI ${id.split("-")[1]}`,
    color,
    opacity,
    visible: true,
    displayMode: "float",
    voxels,
    volumeMm3,
    volumeMl: volumeMm3 / 1000,
    surfaceAreaMm2: m.surfaceAreaMm2,
    diameters: m.diameters,
    numTriangles: m.numTriangles,
  };
  attachObjectInternal(id, obj, data);
  recordAdd(id, obj, data);
  return id;
}

/** add 操作を Undo/Redo に記録（undo=detach, redo=attach。アクターは保持）。 */
function recordAdd(id: string, obj: SceneObject, data: SceneData): void {
  record({
    label: obj.name,
    undo: () => detachObjectInternal(id),
    redo: () => attachObjectInternal(id, obj, data),
  });
}

/** 表示モード（float=カット非対象 / embedded=クリップ箱と一緒にカット）を設定。 */
export function setObjectDisplayMode(id: string, mode: "float" | "embedded"): void {
  const old = getSceneObject(id)?.displayMode ?? "float";
  if (old === mode) return;
  applyDisplayModeInternal(id, mode);
  record({
    label: `Display: ${mode}`,
    undo: () => applyDisplayModeInternal(id, old),
    redo: () => applyDisplayModeInternal(id, mode),
  });
}

export function setObjectColor(id: string, color: V3): void {
  const old = getSceneObject(id)?.color;
  applyColorInternal(id, color);
  if (old) {
    record({
      label: "Color",
      coalesceKey: `color:${id}`,
      undo: () => applyColorInternal(id, old),
      redo: () => applyColorInternal(id, color),
    });
  }
}

export function setObjectOpacity(id: string, opacity: number): void {
  const old = getSceneObject(id)?.opacity;
  applyOpacityInternal(id, opacity);
  if (old != null) {
    record({
      label: "Opacity",
      coalesceKey: `opacity:${id}`,
      undo: () => applyOpacityInternal(id, old),
      redo: () => applyOpacityInternal(id, opacity),
    });
  }
}

export function setObjectVisible(id: string, visible: boolean): void {
  const old = getSceneObject(id)?.visible ?? true;
  applyVisibleInternal(id, visible);
  record({
    label: visible ? "Show" : "Hide",
    undo: () => applyVisibleInternal(id, old),
    redo: () => applyVisibleInternal(id, visible),
  });
}

export function renameObject(id: string, name: string): void {
  updateSceneObject(id, { name });
}

export function removeObject(id: string): void {
  const d = dataById.get(id);
  const obj = getSceneObject(id);
  if (!d || !obj) {
    removeSceneObject(id);
    return;
  }
  // アクターは delete せず detach（undo で復元できるよう data/obj を closure が保持）。
  detachObjectInternal(id);
  record({
    label: `Delete ${obj.name}`,
    undo: () => attachObjectInternal(id, obj, d),
    redo: () => detachObjectInternal(id),
  });
}

/** ROI → メッシュ（新規メッシュオブジェクトを生成）。生成した id か null。 */
export function convertRoiToMesh(id: string): string | null {
  const d = dataById.get(id);
  const obj = getSceneObject(id);
  if (!d?.labelVolume) return null;
  const mesh = labelVolumeToMesh(d.labelVolume);
  if (!mesh) return null;
  return addMeshObject(mesh, { name: `${obj?.name ?? "ROI"} → mesh` });
}

/** メッシュ → 3D ROI（指定幾何にボクセル化して新規 ROI オブジェクトを生成）。生成した id か null。 */
export function convertMeshToRoi(id: string, geom: VolumeGeom): string | null {
  const d = dataById.get(id);
  const obj = getSceneObject(id);
  if (!d?.polydata) return null;
  const lv = meshToLabelVolume(d.polydata, geom);
  if (!lv) return null;
  return addRoiObject(lv, { name: `${obj?.name ?? "Mesh"} → ROI` });
}

/** エクスポート用: 表示メッシュ（ROI は表面メッシュ）を取得。 */
export function getObjectPolyData(id: string): Any | null {
  return dataById.get(id)?.polydata ?? null;
}

export function getObjectLabelVolume(id: string): LabelVolume | null {
  return dataById.get(id)?.labelVolume ?? null;
}

// ── 3D Cut（lasso スカルプト）──────────────────────────────────
/**
 * ROI の labelmap データを差し替え、表面メッシュ・計測サマリを再構築する（記録なし・内部）。
 * data の長さは既存 geom と一致している前提。
 */
function applyRoiVolumeInternal(id: string, data: Uint8Array): void {
  const d = dataById.get(id);
  if (!d?.labelVolume || !d.ma) return;
  const lv: LabelVolume = { geom: d.labelVolume.geom, data, voxelMm3: d.labelVolume.voxelMm3 };
  d.labelVolume = lv;
  const surf = labelVolumeToMesh(lv);
  d.polydata = surf ?? undefined;
  try {
    d.ma.mapper.setInputData(surf ?? vtkPolyData.newInstance());
  } catch {
    /* ignore */
  }
  const voxels = countForeground(lv);
  const volumeMm3 = voxels * lv.voxelMm3;
  const m = surf ? measureMesh(surf) : null;
  updateSceneObject(id, {
    voxels,
    volumeMm3,
    volumeMl: volumeMm3 / 1000,
    surfaceAreaMm2: m?.surfaceAreaMm2 ?? 0,
    diameters: m?.diameters ?? [0, 0, 0],
    numTriangles: m?.numTriangles ?? 0,
  });
  applyObjectClip(id);
  render();
}

/** カット結果。 */
export interface CutResult {
  removed: number;
}

/**
 * 選択 ROI に対し、画面上の投げ縄（`polygon`, CSS px）で視線方向のパンチカットを行う。
 * 各前景ボクセルを `project`（world→CSS。カメラ状態から作る）で投影し、多角形内/外で除去する。
 * mode="inside" は多角形内を除去、"outside" は多角形内だけ残す。
 *
 * - 座標は全て実空間 LPS mm（`voxelToWorld`）。actor 回転で蓄積した向きはアクター行列で反映。
 * - 1 個も除去しなければ変更せず `{removed:0}`。除去があれば Undo/Redo に記録。
 */
export function cutRoiLasso(
  id: string,
  polygon: [number, number][],
  project: Projector,
  mode: CutMode,
): CutResult | null {
  const d = dataById.get(id);
  if (!d?.labelVolume || !d.ma || polygon.length < 3) return null;
  const lv = d.labelVolume;
  const [nx, ny, nz] = lv.geom.dims;
  const frame = nx * ny;
  const src = lv.data;
  if (src.length !== frame * nz) return null;

  const xform = makeActorTransform(d.ma.actor);
  const next = src.slice();
  let removed = 0;
  for (let k = 0; k < nz; k++) {
    const kBase = k * frame;
    for (let j = 0; j < ny; j++) {
      const jBase = kBase + j * nx;
      for (let i = 0; i < nx; i++) {
        const idx = jBase + i;
        if (src[idx] === 0) continue;
        const world = xform(voxelToWorld(lv.geom, i, j, k));
        const css = project(world);
        const inside = css ? pointInPolygon(css, polygon) : false;
        const remove = mode === "inside" ? inside : !inside;
        if (remove) {
          next[idx] = 0;
          removed++;
        }
      }
    }
  }
  if (removed === 0) return { removed: 0 };

  const before = src; // 現在の配列を undo 用に温存
  applyRoiVolumeInternal(id, next);
  record({
    label: `Cut ${mode}`,
    undo: () => applyRoiVolumeInternal(id, before),
    redo: () => applyRoiVolumeInternal(id, next),
  });
  return { removed };
}

// ── 3D 計測（ルーラー・ピッキング）────────────────────────────
/** 表面ピッキング結果。 */
export interface SurfaceHit {
  /** ヒット点（患者 LPS mm）。 */
  point: V3;
  /** レイ原点からの距離 mm。 */
  dist: number;
  objectId: string;
}

/**
 * world 視線レイをシーンの**可視なメッシュ/ROI/中心線表面**に交差させ、最も手前のヒット点を返す。
 * `RayMeshIntersector`（Möller-Trumbore）を全可視表面に適用。ヒットなしは null。
 * actor 回転モードで蓄積した向きは各オブジェクトのアクター行列で反映（頂点を rendered-world へ）。
 */
export function pickSurfacePoint(ray: Ray): SurfaceHit | null {
  let best: SurfaceHit | null = null;
  for (const [id, d] of dataById) {
    if (!d.polydata) continue;
    if (getSceneObject(id)?.visible === false) continue;
    let arrays: { points: Float64Array; tris: Uint32Array };
    try {
      arrays = getMeshArrays(d.polydata);
    } catch {
      continue;
    }
    const { points, tris } = arrays;
    if (!tris.length) continue;
    const xform = makeActorTransform(d.ma?.actor);
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      const v0 = xform([points[a], points[a + 1], points[a + 2]]);
      const v1 = xform([points[b], points[b + 1], points[b + 2]]);
      const v2 = xform([points[c], points[c + 1], points[c + 2]]);
      const dist = rayTriangleIntersect(ray, v0, v1, v2);
      if (dist != null && (!best || dist < best.dist)) {
        best = {
          point: [
            ray.origin[0] + ray.dir[0] * dist,
            ray.origin[1] + ray.dir[1] * dist,
            ray.origin[2] + ray.dir[2] * dist,
          ],
          dist,
          objectId: id,
        };
      }
    }
  }
  return best;
}

/** 2 点（患者 LPS mm）から計測ラインを追加し Undo に記録。追加した id を返す。 */
export function addMeasurement3D(a: V3, b: V3): string {
  const id = nextMeasureId();
  const distMm = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const m: Measurement3D = { id, a, b, distMm };
  addMeasurement(m);
  render();
  record({
    label: `Measure ${distMm.toFixed(1)}mm`,
    undo: () => {
      removeMeasurement(id);
      render();
    },
    redo: () => {
      addMeasurement(m);
      render();
    },
  });
  return id;
}

/** 計測ラインを削除し Undo に記録。 */
export function removeMeasurement3D(id: string): void {
  const m = getMeasurements().find((x) => x.id === id);
  if (!m) return;
  removeMeasurement(id);
  render();
  record({
    label: "Delete measurement",
    undo: () => {
      addMeasurement(m);
      render();
    },
    redo: () => {
      removeMeasurement(id);
      render();
    },
  });
}

// ── 手動内視鏡経路（点の追加/移動/削除）─────────────────────────
/**
 * world 視線レイから経路制御点の world 位置を決める。
 * 表面ヒットがあればその点（構造の上に置ける）、無ければカメラ焦点を通る**視線直交平面**との交点にフォールバック。
 */
export function pickPathPoint(ray: Ray): V3 {
  const hit = pickSurfacePoint(ray);
  if (hit) return hit.point;
  try {
    const cam: Any = renderer?.getActiveCamera?.();
    if (cam) {
      const f = cam.getFocalPoint() as number[];
      const n = cam.getDirectionOfProjection() as number[];
      const denom = ray.dir[0] * n[0] + ray.dir[1] * n[1] + ray.dir[2] * n[2];
      if (Math.abs(denom) > 1e-6) {
        const t =
          ((f[0] - ray.origin[0]) * n[0] + (f[1] - ray.origin[1]) * n[1] + (f[2] - ray.origin[2]) * n[2]) / denom;
        if (t > 0) {
          return [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, ray.origin[2] + ray.dir[2] * t];
        }
      }
    }
  } catch {
    /* ignore */
  }
  return [ray.origin[0] + ray.dir[0] * 100, ray.origin[1] + ray.dir[1] * 100, ray.origin[2] + ray.dir[2] * 100];
}

/** 経路点列をライブ更新（記録なし・ドラッグ中の連続反映に使う）。 */
export function applyEndoPath(next: V3[]): void {
  setEndoPath(next);
  render();
}

/**
 * 経路編集を確定して Undo に記録する（before/after の全配列スナップショット）。
 * 追加/削除/クリアは 1 回で、ドラッグ移動は down 時の before と up 時の after で 1 コマンドにまとめる。
 */
export function commitEndoPath(before: V3[], after: V3[], label: string): void {
  const b = before.map((p) => [p[0], p[1], p[2]] as V3);
  const a = after.map((p) => [p[0], p[1], p[2]] as V3);
  setEndoPath(a);
  render();
  record({
    label,
    undo: () => {
      setEndoPath(b);
      render();
    },
    redo: () => {
      setEndoPath(a);
      render();
    },
  });
}

/** 現在の手動経路（>=2 点）を中心線オブジェクトに変換して追加。追加した id か null。 */
export function commitEndoPathAsCenterline(name?: string): string | null {
  const pts = getEndoPath();
  if (pts.length < 2) return null;
  const cl = new Centerline3D();
  for (const p of pts) cl.addControlPoint(p);
  return addCenterlineObject(cl, { name: name ?? "Manual path" });
}

/** カメラ fit 用: 全オブジェクトの有無。 */
export function hasSceneObjects(): boolean {
  return getSceneObjects().length > 0;
}

// ── 中心線（Centerline3D）オブジェクト & 内視鏡 ───────────────────

/** Centerline3D を 1mm 間隔でサンプルした world 点列。 */
function sampleCenterline(cl: Centerline3D, stepMm = 1): V3[] {
  const total = cl.getTotalLength();
  const pts: V3[] = [];
  if (total <= 0) {
    return cl.size() ? [cl.getControlPoint(0) as V3] : [];
  }
  const n = Math.max(2, Math.ceil(total / stepMm) + 1);
  for (let i = 0; i < n; i++) {
    const arc = (total * i) / (n - 1);
    pts.push(cl.frameAt(arc, "ROTATION_MINIMIZING").position as V3);
  }
  return pts;
}

/** 点列 → チューブ polydata（中心線の可視化）。 */
function buildTube(points: V3[], radiusMm: number): Any {
  const flat = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    flat[i * 3] = points[i][0];
    flat[i * 3 + 1] = points[i][1];
    flat[i * 3 + 2] = points[i][2];
  }
  const lines = new Uint32Array(points.length + 1);
  lines[0] = points.length;
  for (let i = 0; i < points.length; i++) lines[i + 1] = i;
  const pd: Any = vtkPolyData.newInstance();
  pd.getPoints().setData(flat, 3);
  pd.getLines().setData(lines);
  const tube: Any = vtkTubeFilter.newInstance();
  tube.setInputData(pd);
  tube.setRadius(radiusMm);
  tube.setNumberOfSides(10);
  tube.setCapping(true);
  const out = tube.getOutputData();
  return out && out.getNumberOfPoints?.() > 0 ? out : pd;
}

/** Centerline3D をシーンに追加（チューブ表示）。fly-through のパスにもなる。 */
export function addCenterlineObject(cl: Centerline3D, opts: AddOptions = {}): string | null {
  const pts = sampleCenterline(cl, 1);
  if (pts.length < 2) return null;
  const id = nextSceneId("cl");
  const color = opts.color ?? [0, 0.9, 1]; // シアン
  const opacity = opts.opacity ?? 1;
  const total = cl.getTotalLength();
  const radius = Math.max(0.4, Math.min(2, total / 200));
  const tube = buildTube(pts, radius);
  const ma = makeSurfaceActor(tube, { color, opacity, visible: true });
  const data: SceneData = { polydata: tube, centerline: cl, ma };
  const obj: SceneObject = {
    id,
    kind: "centerline",
    name: opts.name ?? `Centerline ${id.split("-")[1]}`,
    color,
    opacity,
    visible: true,
    displayMode: "float",
    lengthMm: total,
    lengthMl: undefined,
  };
  attachObjectInternal(id, obj, data);
  recordAdd(id, obj, data);
  return id;
}

export function getObjectCenterline(id: string): Centerline3D | null {
  return dataById.get(id)?.centerline ?? null;
}

/** 中心線抽出結果（解析サマリ）。 */
export interface CenterlineExtractResult {
  centerlineId: string;
  summary: ReturnType<typeof graphSummary>;
}

/**
 * 選択オブジェクト（ROI or メッシュ）から中心線を抽出し、最長路をシーンに追加する。
 * メッシュは表示ボリューム幾何（`setClipContext` の geom）へボクセル化してから骨格化。
 */
export function extractCenterlineFromObject(
  id: string,
  opts: { simplifyEpsilonMm?: number; pruneMinLengthMm?: number } = {},
): CenterlineExtractResult | null {
  const d = dataById.get(id);
  const obj = getSceneObject(id);
  if (!d) return null;
  // labelVolume を用意（ROI はそのまま、メッシュはボクセル化）。
  let lv: LabelVolume | null = d.labelVolume ?? null;
  if (!lv && d.polydata && clipGeom) lv = meshToLabelVolume(d.polydata, clipGeom);
  if (!lv) return null;
  const graph: CenterlineGraph | null = extractCenterlineGraph(lv, {
    simplifyEpsilonMm: opts.simplifyEpsilonMm ?? 0.5,
    pruneMinLengthMm: opts.pruneMinLengthMm ?? 5,
  });
  if (!graph) return null;
  const cl = graph.longestPath();
  if (!cl || cl.size() < 2) return null;
  const centerlineId = addCenterlineObject(cl, { name: `${obj?.name ?? "Object"} centerline` });
  if (!centerlineId) return null;
  // マスク由来の中心線であることを記録（fly-through 開始時に元 ROI/メッシュ表面を強調するため。
  // 手動クリックの内視鏡パス（`commitEndoPathAsCenterline`）由来には元オブジェクトが無いので記録しない）。
  centerlineSourceId.set(centerlineId, id);
  return { centerlineId, summary: graphSummary(graph) };
}

// ── 内視鏡（単一のアクティブコントローラ）──────────────────────
let endo: EndoController | null = null;
let endoCenterlineId: string | null = null;
/** 中心線 id → 抽出元の ROI/メッシュ scene object id（`extractCenterlineFromObject` が記録）。 */
const centerlineSourceId = new Map<string, string>();
/** fly-through 中だけ強調表示している元オブジェクトの id（stop 時に外観を復元）。 */
let endoHighlightObjectId: string | null = null;
/** マスク由来 fly-through 中に生ボリュームを減光する係数（0.15＝ほぼ透明）。 */
const ENDO_VOLUME_DIM = 0.15;

/**
 * 指定中心線オブジェクトで内視鏡（fly-through）を開始。マスク由来の中心線（`extractCenterlineFromObject`
 * 経由）なら、抽出元の ROI/メッシュ表面を強調し生ボリュームを減光する（`fw/mask-driven-pipelines-gap-analysis.md`
 * 課題#6）。手動クリックのパス由来（元オブジェクト無し）は減光/強調をスキップし、従来どおり生ボリュームを描画。
 */
export function startEndoscopy(centerlineId: string): EndoController | null {
  const cl = dataById.get(centerlineId)?.centerline;
  if (!cl || !renderer || !renderFn) return null;
  stopEndoscopy();
  // 一人称視界を塞がないよう、パスのチューブは fly-through 中だけ隠す（store の visible は保持）。
  const d = dataById.get(centerlineId);
  if (d?.ma) updateActorAppearance(d.ma, { visible: false });
  endoCenterlineId = centerlineId;

  const sourceId = centerlineSourceId.get(centerlineId);
  if (sourceId) {
    const srcData = dataById.get(sourceId);
    const srcObj = getSceneObject(sourceId);
    if (srcData?.ma && srcObj) {
      updateActorAppearance(srcData.ma, { visible: true, opacity: Math.max(srcObj.opacity, 0.9) });
      endoHighlightObjectId = sourceId;
      volumeOpacityScaleFn?.(ENDO_VOLUME_DIM);
    }
  }

  endo = createEndoController({ renderer, render: renderFn }, cl);
  endo.start();
  return endo;
}

export function stopEndoscopy(): void {
  if (endo) {
    try {
      endo.destroy();
    } catch {
      /* ignore */
    }
    endo = null;
  }
  if (endoHighlightObjectId) {
    const d = dataById.get(endoHighlightObjectId);
    const obj = getSceneObject(endoHighlightObjectId);
    // fly-through 前の外観（store の opacity/visible）に戻す。
    if (d?.ma && obj) updateActorAppearance(d.ma, { visible: obj.visible !== false, opacity: obj.opacity });
    endoHighlightObjectId = null;
    volumeOpacityScaleFn?.(1);
  }
  if (endoCenterlineId) {
    const d = dataById.get(endoCenterlineId);
    const obj = getSceneObject(endoCenterlineId);
    // fly-through 前の可視状態（store の visible）に戻す。
    if (d?.ma) updateActorAppearance(d.ma, { visible: obj?.visible !== false });
    endoCenterlineId = null;
    render();
  }
}

export function getEndoController(): EndoController | null {
  return endo;
}
