/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D Viewer 表示コア（P1）。Cornerstone3D の `VOLUME_3D` ビューポート（`VolumeViewport3D`）で
 * VR(DVR)/MIP/MinIP をレンダリングする。旧 GRAPHY `VolumeRenderer`+`GLCanvas` の GPU レイマーチに相当。
 *
 * 方針（設計 `fw/3d-viewer-design.md` §5.4 / §6）:
 * - ボリュームは MPR/Slicer と共通の `buildMprVolume`（CT チルト時は `gantryTiltCorrect` 済み直交 volume）。
 *   → **実画像空間（患者 LPS）で幾何が閉じる**（cornerstone 3D 幾何バグの回避＝要件）。`vtkImageData` の
 *   origin/direction/spacing がそのまま効くため、旧実装の X ミラーや軸位化は不要。
 * - モード = `setBlendMode`（COMPOSITE / MAXIMUM_/MINIMUM_INTENSITY_BLEND）。色/不透明度 TF は VR プリセット。
 * - W/L は HU/SUV 空間の `voiRange` で駆動（`pixelCalibration` 単一入口・§3.3）。
 * - 視点操作は `TrackballRotateTool`（primary）＋Pan（middle）＋Zoom（secondary）。
 *
 * メッシュ/ROI 表面/中心線/内視鏡経路の重畳（`renderer.addActor`）は P3 以降でこのビューポート内 vtk.js
 * renderer に足す。ここでは volume 表示のライフサイクルに限定する。
 */
import { cache, Enums, type RenderingEngine, type Types } from "@cornerstonejs/core";
import {
  ToolGroupManager,
  TrackballRotateTool,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { blendModeFor, defaultPreset, type RenderMode } from "./transferFunction";

const { ViewportType } = Enums;
const { MouseBindings } = csToolsEnums;

/** VolumeViewport3D の型（`setBlendMode` は VolumeViewport3D 固有のため最小 shape で持つ）。 */
type Volume3DViewport = Types.IVolumeViewport & {
  setBlendMode?: (blendMode: number, filterActorUIDs?: string[], immediate?: boolean) => void;
  resetCamera?: (opts?: { resetPan?: boolean; resetZoom?: boolean; resetToCenter?: boolean }) => void;
  resetProperties?: (volumeId?: string) => void;
};

/** 現在ビューポートに設定されている volumeId を取得（VolumeViewport3D 用のゆるい shape 経由）。 */
function currentVolumeId(vp: Volume3DViewport): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyVp = vp as any;
  return anyVp.getVolumeId?.() ?? anyVp.getAllVolumeIds?.()?.[0] ?? "";
}

/**
 * W/L（右ドラッグ）を成立させるため voiRange を初期化する。VolumeViewport3D は `VolumeViewport` の
 * instanceof ではないため、`WindowLevelTool` は `properties.voiRange` 分岐に入る。voiRange 未設定だと
 * 例外になるので、既存値→volume metadata の VOI→モダリティ既定→scalar min/max の順で必ず設定する。
 */
function ensureVoiRange(vp: Volume3DViewport, volumeId: string, modality: string | null): void {
  try {
    const cur = vp.getProperties?.();
    if (cur?.voiRange && Number.isFinite(cur.voiRange.lower) && Number.isFinite(cur.voiRange.upper)) {
      return; // 既に設定済み（通常は volume ロード時に既定 VOI が入る）
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vol = cache.getVolume(volumeId) as any;
    let center: number | undefined;
    let width: number | undefined;
    const voiLut = vol?.metadata?.voiLut;
    if (Array.isArray(voiLut) && voiLut[0]) {
      center = Number(voiLut[0].windowCenter);
      width = Number(voiLut[0].windowWidth);
    }
    if (!(Number.isFinite(center) && Number.isFinite(width) && (width as number) > 0)) {
      const m = (modality ?? "").toUpperCase();
      if (m === "CT") {
        center = 40;
        width = 400;
      }
    }
    if (!(Number.isFinite(center) && Number.isFinite(width) && (width as number) > 0)) {
      // 最終手段: scalar の min/max（ローカルボリューム時のみ取得可能）。
      const sd = vol?.voxelManager?.getCompleteScalarDataArray?.() ?? vol?.scalarData;
      if (sd && sd.length) {
        let mn = Infinity;
        let mx = -Infinity;
        const step = Math.max(1, Math.floor(sd.length / 100000)); // 疎サンプルで概算
        for (let i = 0; i < sd.length; i += step) {
          const v = sd[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        if (mx > mn) {
          center = (mn + mx) / 2;
          width = mx - mn;
        }
      }
    }
    if (Number.isFinite(center) && Number.isFinite(width) && (width as number) > 0) {
      const c = center as number;
      const w = width as number;
      vp.setProperties({ voiRange: { lower: c - w / 2, upper: c + w / 2 } });
    }
  } catch {
    /* ignore */
  }
}

/**
 * `VOLUME_3D` ビューポートを 1 面有効化し、ボリュームを設定、既定プリセット＋モードを適用、
 * ツールグループ（Trackball/Pan/Zoom）を配線する。呼び出し前に `buildMprVolume` で volumeId を用意すること。
 */
export async function setup3DViewport(
  engine: RenderingEngine,
  engineId: string,
  el: HTMLDivElement,
  viewportId: string,
  volumeId: string,
  toolGroupId: string,
  opts: { modality: string | null; mode: RenderMode; preset?: string },
): Promise<void> {
  engine.setViewports([
    {
      viewportId,
      type: ViewportType.VOLUME_3D,
      element: el,
      defaultOptions: { background: [0, 0, 0] as Types.Point3 },
    },
  ]);

  const vp = engine.getViewport(viewportId) as Volume3DViewport;
  await vp.setVolumes([{ volumeId }]);

  // 色/不透明度 TF ＝ VR プリセット。次いで blendMode でモード（VR/MIP/MinIP）を確定。
  const preset = opts.preset ?? defaultPreset(opts.modality, opts.mode);
  try {
    vp.setProperties({ preset });
  } catch {
    /* プリセット名不一致等は無視（既定 TF で表示） */
  }
  vp.setBlendMode?.(blendModeFor(opts.mode));
  // W/L（右ドラッグ）用に voiRange を初期化してから resetCamera。
  ensureVoiRange(vp, volumeId, opts.modality);
  vp.resetCamera?.();

  // ── ツールグループ（回転・Pan・Zoom(ホイール)・W/L） ──
  let tg = ToolGroupManager.getToolGroup(toolGroupId);
  if (tg) ToolGroupManager.destroyToolGroup(toolGroupId);
  tg = ToolGroupManager.createToolGroup(toolGroupId);
  if (!tg) return;
  tg.addTool(TrackballRotateTool.toolName);
  tg.addTool(PanTool.toolName);
  tg.addTool(ZoomTool.toolName);
  tg.addTool(WindowLevelTool.toolName);
  tg.addViewport(viewportId, engineId);
  // 左ドラッグ=回転、中ドラッグ=Pan、ホイール=Zoom、右ドラッグ=W/L（コントラスト調整）。
  tg.setToolActive(TrackballRotateTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });
  tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
  tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });
  tg.setToolActive(WindowLevelTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Secondary }],
  });

  engine.renderViewports([viewportId]);
}

/** レンダリングモード（VR/MIP/MinIP/AVG）を切り替える。 */
export function setRenderMode(
  engine: RenderingEngine,
  viewportId: string,
  mode: RenderMode,
  modality: string | null,
  preset?: string,
): void {
  try {
    const vp = engine.getViewport(viewportId) as Volume3DViewport;
    if (mode === "VR") {
      // VR(DVR): 色/不透明度プリセットを適用。
      const p = preset ?? defaultPreset(modality, "VR");
      try {
        vp.setProperties({ preset: p });
      } catch {
        /* ignore */
      }
    } else {
      // MIP/MinIP/AVG: 色プリセットを外してグレースケール既定へ戻す。プリセットの固定転送関数だと
      // 右ドラッグ W/L（voiRange）が視覚的に効かないため、グレースケール＋voiRange で投影輝度の
      // ウィンドウ調整を効かせる（旧 GRAPHY の MIP と同じくコントラストは W/L で操作）。
      try {
        vp.resetProperties?.();
      } catch {
        /* ignore */
      }
    }
    ensureVoiRange(vp, currentVolumeId(vp), modality);
    vp.setBlendMode?.(blendModeFor(mode));
    vp.render();
  } catch {
    /* ignore */
  }
}

/**
 * 視点・コントラストを初期状態へ戻す（Reset View）。
 * `resetProperties`（VOI/colormap/preset を既定へ＝コントラスト初期化）→ モード再適用（VR は色プリセット、
 * MIP/MinIP はグレースケール）→ `resetCamera`（回転・パン・ズーム初期化）。
 */
export function reset3DView(
  engine: RenderingEngine,
  viewportId: string,
  mode: RenderMode,
  modality: string | null,
  preset?: string,
): void {
  try {
    const vp = engine.getViewport(viewportId) as Volume3DViewport;
    try {
      vp.resetProperties?.(); // VOI・colormap・preset を既定へ（＝コントラストを初期値に戻す）
    } catch {
      /* ignore */
    }
    if (mode === "VR") {
      const p = preset ?? defaultPreset(modality, "VR");
      try {
        vp.setProperties({ preset: p });
      } catch {
        /* ignore */
      }
    }
    ensureVoiRange(vp, currentVolumeId(vp), modality);
    vp.setBlendMode?.(blendModeFor(mode));
    vp.resetCamera?.(); // 回転・パン・ズームを初期位置へ
    vp.render();
  } catch {
    /* ignore */
  }
}

/** VR/色/不透明度プリセット（`VIEWPORT_PRESETS.name`）を適用する。 */
export function applyPreset(engine: RenderingEngine, viewportId: string, presetName: string): void {
  try {
    const vp = engine.getViewport(viewportId) as Volume3DViewport;
    vp.setProperties({ preset: presetName });
    vp.render();
  } catch {
    /* ignore */
  }
}

/** W/L（HU/SUV の center/width）を `voiRange` として適用する。MIP/MinIP で特に有用。 */
export function applyVrWl(
  engine: RenderingEngine,
  viewportId: string,
  center: number,
  width: number,
): void {
  try {
    const vp = engine.getViewport(viewportId) as Volume3DViewport;
    vp.setProperties({ voiRange: { lower: center - width / 2, upper: center + width / 2 } });
    vp.render();
  } catch {
    /* ignore */
  }
}

/** 色 LUT（登録済みカラーマップ名）を適用する。色は現在の VOI レンジへマップされる。 */
export function applyColormap(engine: RenderingEngine, viewportId: string, colormapName: string): void {
  try {
    const vp = engine.getViewport(viewportId) as Volume3DViewport;
    vp.setProperties({ colormap: { name: colormapName } });
    vp.render();
  } catch {
    /* ignore */
  }
}

/** 不透明度カーブ点。`value` は HU/SUV（scalar 値）、`opacity` は 0..1。 */
export interface OpacityPoint {
  value: number;
  opacity: number;
}

/** 不透明度転送関数（3D LUT カーブ）を適用する。VR の見た目（不透明度）を制御する。 */
export function applyOpacityPoints(
  engine: RenderingEngine,
  viewportId: string,
  points: OpacityPoint[],
): void {
  if (!points.length) return;
  try {
    const vp = engine.getViewport(viewportId) as Volume3DViewport;
    // value 昇順に整列（vtkPiecewiseFunction は単調増加の x を要求）。
    const opacity = points.slice().sort((a, b) => a.value - b.value);
    vp.setProperties({ colormap: { opacity } });
    vp.render();
  } catch {
    /* ignore */
  }
}

/** ボリュームの scalar ヒストグラム（HU/SUV）。3D LUT カーブダイアログの背景に使う。 */
export interface VolumeHistogram {
  counts: number[];
  min: number;
  max: number;
}

/**
 * volumeId から scalar ヒストグラムを計算する。ローカル/streaming どちらも `voxelManager` または
 * `scalarData` から取得。大容量は間引きサンプルで概算する。取得不可なら null。
 */
export function volumeHistogram(volumeId: string, bins = 256): VolumeHistogram | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vol = cache.getVolume(volumeId) as any;
    const sd: ArrayLike<number> | undefined =
      vol?.voxelManager?.getCompleteScalarDataArray?.() ?? vol?.scalarData;
    if (!sd || !sd.length) return null;
    const len = sd.length;
    const step = Math.max(1, Math.floor(len / 2_000_000)); // 走査上限 ~200 万サンプル
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < len; i += step) {
      const v = sd[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!(max > min)) return null;
    const counts = new Array<number>(bins).fill(0);
    const scale = (bins - 1) / (max - min);
    for (let i = 0; i < len; i += step) {
      counts[Math.round((sd[i] - min) * scale)]++;
    }
    return { counts, min, max };
  } catch {
    return null;
  }
}

/** ビューポートのプロパティ（プリセット/VOI）を既定へ戻す。 */
export function resetVrProperties(engine: RenderingEngine, viewportId: string): void {
  try {
    const vp = engine.getViewport(viewportId) as Volume3DViewport;
    vp.resetProperties?.();
    vp.render();
  } catch {
    /* ignore */
  }
}

/** カメラを初期位置（ボリューム中心・全体表示）へ戻す。 */
export function reset3DCamera(engine: RenderingEngine, viewportId: string): void {
  try {
    const vp = engine.getViewport(viewportId) as Volume3DViewport;
    vp.resetCamera?.();
    vp.render();
  } catch {
    /* ignore */
  }
}

/** 3D Viewer のツールグループ・ビューポート・エンジンを破棄する（アンマウント時）。 */
export function teardown3D(engine: RenderingEngine | null, toolGroupId: string): void {
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
