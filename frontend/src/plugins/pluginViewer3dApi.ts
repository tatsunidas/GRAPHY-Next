/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * **視点とクリップ面を指定して本体の 3D ビューアを開く**（プラグイン host API）。
 *
 * <p>プラグインが渡すのは患者座標（LPS mm）の視線・上・注視点とクリップ面だけ。描画・操作・計測は本体の 3D 窓が行う
 * （プラグインに 3D の幾何を書かせない。`pluginCurvedMprApi.ts` / H73 と同じ理由）。
 * どの面・どの向きにするかはプラグインが決め、当てるのは本体。
 *
 * <p>規約: 画面右 = 視線 × 上（右手系）。クリップ面は **法線の向く側を残す**。
 * 3D 窓には「プラグイン <名前> の視点」の札が出る（出所は host が入れる。プラグインは名乗れない）。
 *
 * <p>🔴 戻り値は「検証と起動要求まで」。窓は非同期に開くので描けたかは分からない。`applied` は検証・正規化した値。
 */
import { desktop } from "../desktopBridge";
import type { Series, Study } from "../api";
import { writeViewer3dContext, type Viewer3DPluginView } from "../viewer3d/viewer3dCtx";
import { cameraFromView, validateClipPlanes } from "../viewer/viewer3dCamera";
import type { ZRange } from "../viewer/virtualLayout";
import type { PluginSeriesRef } from "./pluginTypes";

type Vec3 = [number, number, number];

export interface PluginViewer3dCamera {
  /** 視線方向（カメラ→注視点）。長さは問わない（0・非有限は拒否）。 */
  direction: Vec3;
  /** 画面の上。視線に直交でなくてよい（本体が直交化して返す）。視線と平行なら拒否。 */
  up: Vec3;
  /** 注視点（LPS mm）。省略時は最初のクリップ面の原点、それも無ければボリューム中心。 */
  focalPoint?: Vec3;
  /** カメラから注視点までの距離（mm、> 0）。省略時は窓の今の距離。 */
  distanceMm?: number;
  /** 省略時は窓の現在値。 */
  projection?: "perspective" | "parallel";
  /** 平行投影のとき、画面の縦の半分に写る長さ（mm、> 0）。 */
  parallelScaleMm?: number;
}

export interface PluginViewer3dClipPlane {
  /** 面上の 1 点（LPS mm）。 */
  origin: Vec3;
  /** 法線。**向く側を残す**。長さは問わない（0・非有限は拒否）。 */
  normal: Vec3;
  /** 右パネルの一覧に出す短い名前。 */
  label?: string;
}

export interface PluginViewer3dSpec {
  /** 開いているタイルのシリーズ（c/t 可）。一時シリーズ・連結タイルは不可。 */
  source: PluginSeriesRef;
  camera?: PluginViewer3dCamera;
  /** 最大 6 枚。`[]` で全部消す。省略は変えない。 */
  clipPlanes?: PluginViewer3dClipPlane[];
  /** ORTHO・SLAB は視点がモードの意味を変えるので受けない。省略は変えない。 */
  mode?: "VR" | "MIP" | "MINIP";
  /** VR のプリセット名（3D 窓の一覧にある名前）。省略は変えない。 */
  preset?: string;
  /** 札に出す短い説明。プラグイン名は host が必ず付ける。 */
  title?: string;
}

export interface PluginViewer3dResult {
  ok: boolean;
  error?: string;
  /** 本体が適用する値（正規化・直交化後）。検証の結果であり、描画の結果ではない。 */
  applied?: {
    direction: Vec3 | null;
    up: Vec3 | null;
    right: Vec3 | null;
    /** 省略時は null（窓がクリップ面の原点かボリューム中心に決める）。 */
    focalPoint: Vec3 | null;
    clipPlanes: { origin: Vec3; normal: Vec3; label?: string }[];
  };
}

export type PluginViewer3dProducer = { id: string; name: string; version: string };

/** 開いているタイルの情報。呼び出し側（2D 画面）が `patient.tiles` から引く。 */
export interface Viewer3dTileInfo {
  study: Study;
  series: Series;
  /** 範囲つきで開いたタイルならその範囲（3D も同じ範囲で組む）。 */
  range?: ZRange;
  transient?: boolean;
  concat?: boolean;
  /** 表示中のチャンネル・時相（spec.source が省略したときの既定）。 */
  c: number;
  t: number;
}
export type Viewer3dTileResolver = (seriesUid: string) => Viewer3dTileInfo | undefined;

const MODES = ["VR", "MIP", "MINIP"];
const PROJECTIONS = ["perspective", "parallel"];
const MAX_TITLE = 200;

type Validated =
  | { ok: true; tile: Viewer3dTileInfo; applied: NonNullable<PluginViewer3dResult["applied"]> }
  | { ok: false; error: string };

/** 起動の前に弾けるものを弾く（窓は開かない・何も書かない）。純関数。 */
export function validateViewer3dSpec(spec: PluginViewer3dSpec, resolve: Viewer3dTileResolver): Validated {
  const src = spec?.source;
  if (!src || typeof src.seriesUid !== "string" || !src.seriesUid) return { ok: false, error: "source.seriesUid が必要です" };
  const tile = resolve(src.seriesUid);
  if (!tile) return { ok: false, error: "指定のシリーズは開いているタイルにありません" };
  if (src.studyUid && src.studyUid !== tile.study.studyInstanceUid) {
    return { ok: false, error: "source.studyUid が開いているタイルのスタディと一致しません" };
  }
  if (tile.transient) return { ok: false, error: "一時シリーズ（保管庫に無い画像）は 3D で開けません" };
  if (tile.concat) return { ok: false, error: "連結したタイルは、この API では 3D で開けません" };
  if (spec.mode !== undefined && !MODES.includes(spec.mode)) return { ok: false, error: `mode は ${MODES.join(" / ")} のいずれかです（ORTHO・SLAB は指定できません）` };
  if (spec.preset !== undefined && (typeof spec.preset !== "string" || spec.preset.trim() === "")) return { ok: false, error: "preset は空でない文字列です" };
  if (spec.title !== undefined && (typeof spec.title !== "string" || spec.title.length > MAX_TITLE)) return { ok: false, error: `title は ${MAX_TITLE} 文字以内の文字列です` };

  const applied: NonNullable<PluginViewer3dResult["applied"]> = { direction: null, up: null, right: null, focalPoint: null, clipPlanes: [] };
  const cam = spec.camera;
  if (cam) {
    if (cam.projection !== undefined && !PROJECTIONS.includes(cam.projection)) return { ok: false, error: "camera.projection は perspective / parallel のどちらかです" };
    if (cam.parallelScaleMm !== undefined && !(Number.isFinite(cam.parallelScaleMm) && cam.parallelScaleMm > 0)) return { ok: false, error: "camera.parallelScaleMm は正の数です" };
    if (cam.distanceMm !== undefined && !(Number.isFinite(cam.distanceMm) && cam.distanceMm > 0)) return { ok: false, error: "camera.distanceMm は正の数です" };
    if (cam.focalPoint !== undefined && !(Array.isArray(cam.focalPoint) && cam.focalPoint.length === 3 && cam.focalPoint.every((x) => Number.isFinite(x)))) {
      return { ok: false, error: "camera.focalPoint は有限な数 3 つ [x,y,z] です" };
    }
    if (!Array.isArray(cam.direction) || cam.direction.length !== 3 || !Array.isArray(cam.up) || cam.up.length !== 3) {
      return { ok: false, error: "camera.direction と camera.up は [x,y,z] です" };
    }
    // 向きの検証と直交化だけを見る（位置は窓が決める）。
    const r = cameraFromView({ direction: cam.direction, up: cam.up, focalPoint: [0, 0, 0], distanceMm: 1 });
    if (!r.ok) return { ok: false, error: `camera: ${r.reason}` };
    applied.direction = r.direction;
    applied.up = r.viewUp;
    applied.right = r.right;
  }
  if (spec.clipPlanes !== undefined) {
    if (!Array.isArray(spec.clipPlanes)) return { ok: false, error: "clipPlanes は配列です" };
    for (let i = 0; i < spec.clipPlanes.length; i++) {
      const l = spec.clipPlanes[i]?.label;
      if (l !== undefined && typeof l !== "string") return { ok: false, error: `clipPlanes[${i}].label は文字列です` };
    }
    const v = validateClipPlanes(spec.clipPlanes);
    if (!v.ok) return { ok: false, error: v.reason };
    applied.clipPlanes = v.planes.map((p, i) => ({ origin: p.origin, normal: p.normal, ...(spec.clipPlanes![i].label ? { label: spec.clipPlanes![i].label } : {}) }));
  }
  applied.focalPoint = cam?.focalPoint ? [...cam.focalPoint] : applied.clipPlanes[0] ? [...applied.clipPlanes[0].origin] : null;
  return { ok: true, tile, applied };
}

let lastSeq = 0;
/** 単調増加の `seq`（窓は新しいものだけを適用する）。 */
export function nextViewer3dSeq(now: number = Date.now()): number {
  lastSeq = Math.max(lastSeq + 1, now);
  return lastSeq;
}

/**
 * 窓に渡す起動コンテキストを組む。**出所は host が入れる**（spec に何が書かれていても使わない）。
 * 省略したフィールドは `pluginView` に入れない（窓は「変えない」と読む）。
 */
export function buildViewer3dContext(
  tile: Viewer3dTileInfo,
  spec: PluginViewer3dSpec,
  producer: PluginViewer3dProducer,
  seq: number,
  now: number = Date.now(),
) {
  const pluginView: Viewer3DPluginView = {
    seq,
    provenance: {
      pluginId: producer.id,
      pluginName: producer.name,
      pluginVersion: producer.version,
      ...(spec.title ? { title: spec.title } : {}),
    },
  };
  if (spec.camera) {
    const c = spec.camera;
    pluginView.camera = {
      direction: [...c.direction],
      up: [...c.up],
      ...(c.focalPoint ? { focalPoint: [...c.focalPoint] as Vec3 } : {}),
      ...(c.distanceMm !== undefined ? { distanceMm: c.distanceMm } : {}),
      ...(c.projection ? { projection: c.projection } : {}),
      ...(c.parallelScaleMm !== undefined ? { parallelScaleMm: c.parallelScaleMm } : {}),
    };
  }
  if (spec.clipPlanes !== undefined) {
    pluginView.clipPlanes = spec.clipPlanes.map((p) => ({ origin: [...p.origin] as Vec3, normal: [...p.normal] as Vec3, ...(p.label ? { label: p.label } : {}) }));
  }
  if (spec.mode) pluginView.mode = spec.mode;
  if (spec.preset !== undefined) pluginView.preset = spec.preset;
  return {
    study: tile.study,
    series: tile.series,
    c: spec.source.c ?? tile.c,
    t: spec.source.t ?? tile.t,
    ...(tile.range ? { range: tile.range } : {}),
    pluginView,
    ts: now,
  };
}

export async function openViewer3dFromPlugin(
  spec: PluginViewer3dSpec,
  producer: PluginViewer3dProducer,
  resolve: Viewer3dTileResolver,
): Promise<PluginViewer3dResult> {
  const v = validateViewer3dSpec(spec, resolve);
  if (!v.ok) return { ok: false, error: v.error };
  const ctx = buildViewer3dContext(v.tile, spec, producer, nextViewer3dSeq());
  // 書いて開いている窓へ知らせる。窓が無ければ誰も受けず、openViewer が新しく開く（開いた窓が ctx の pluginView を適用する）。
  writeViewer3dContext(ctx);
  const d = desktop();
  if (d?.openViewer) void d.openViewer("viewer3d");
  else window.open(`${window.location.pathname}#viewer3d`, "graphy-viewer3d");
  return { ok: true, applied: v.applied };
}
