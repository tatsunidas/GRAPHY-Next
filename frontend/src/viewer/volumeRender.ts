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
 * - **VR**: `VOLUME_3D` ビューポート（COMPOSITE）＋色/不透明度プリセット。
 * - **MIP（真の最大値投影）**: `ORTHOGRAPHIC` ビューポート＋full slab＋`setBlendMode(MAXIMUM_INTENSITY_BLEND)`。
 *   ⚠️ `VolumeViewport3D.setBlendMode`/`setSlabThickness` は no-op のため VOLUME_3D では真の MIP を出せない。
 *   `VolumeViewport`（ORTHOGRAPHIC）なら両者が実際に効く（cornerstone/OHIF の MIP と同方式）。モード切替で型を張替える。
 * - W/L は HU/SUV 空間の `voiRange` で駆動（`pixelCalibration` 単一入口・§3.3）。
 * - 視点操作は `TrackballRotateTool`（primary）＋Pan（middle）＋Zoom（wheel）＋W/L（secondary）。
 *
 * メッシュ/ROI 表面/中心線の重畳は cornerstone の Surface representation（`addSurfaceRepresentationToViewport`）
 * を用いる（生 `renderer.addActor` は cornerstone の描画パスでクラッシュするため使わない）。P3 以降で対応。
 */
import { cache, volumeLoader, Enums, type RenderingEngine, type Types } from "@cornerstonejs/core";
import {
  ToolGroupManager,
  TrackballRotateTool,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  OrientationMarkerTool,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { defaultPreset, type RenderMode } from "./transferFunction";

const { ViewportType, OrientationAxis } = Enums;
const { MouseBindings } = csToolsEnums;

/** ボリュームビューポートの最小 shape（VR=VolumeViewport3D / MIP=VolumeViewport 双方を緩く扱う）。 */
type Volume3DViewport = Types.IVolumeViewport & {
  setBlendMode?: (blendMode: number, filterActorUIDs?: string[], immediate?: boolean) => void;
  setSlabThickness?: (slabThickness: number, filterActorUIDs?: string[]) => void;
  resetCamera?: (opts?: { resetPan?: boolean; resetZoom?: boolean; resetToCenter?: boolean }) => void;
  resetProperties?: (volumeId?: string) => void;
};

/** ボリュームの world 対角長（mm）。MIP の full slab 厚に使う（どの角度でも全体を貫く）。 */
function volumeDiagonal(volumeId: string): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = (cache.getVolume(volumeId) as any)?.imageData?.getBounds?.();
    if (Array.isArray(b) && b.length === 6) {
      return Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4]) || 1000;
    }
  } catch {
    /* ignore */
  }
  return 1000;
}

/** ボリュームの scalar 値域 [min,max]（間引きサンプルで概算）。取得不可なら null。 */
function volumeScalarRange(volumeId: string): [number, number] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vol = cache.getVolume(volumeId) as any;
    const sd: ArrayLike<number> | undefined =
      vol?.voxelManager?.getCompleteScalarDataArray?.() ?? vol?.scalarData;
    if (!sd || !sd.length) return null;
    let mn = Infinity;
    let mx = -Infinity;
    const step = Math.max(1, Math.floor(sd.length / 200000));
    for (let i = 0; i < sd.length; i += step) {
      const v = sd[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    return mx > mn ? [mn, mx] : null;
  } catch {
    return null;
  }
}

/** セットアップ直後のカメラ（向き/pan/zoom）を控える。Reset View で回転を戻すために使う。 */
export function snapshotCamera(engine: RenderingEngine, viewportId: string): unknown | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (engine.getViewport(viewportId) as any).getCamera?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * W/L（右ドラッグ）を成立させるため voiRange を初期化する。VolumeViewport3D は `VolumeViewport` の
 * instanceof ではないため、`WindowLevelTool` は `properties.voiRange` 分岐に入る。voiRange 未設定だと
 * 例外になるので、既存値→volume metadata の VOI→モダリティ既定→scalar min/max の順で必ず設定する。
 */
function ensureVoiRange(
  vp: Volume3DViewport,
  volumeId: string,
  modality: string | null,
  force = false,
): void {
  try {
    const cur = vp.getProperties?.();
    if (
      !force &&
      cur?.voiRange &&
      Number.isFinite(cur.voiRange.lower) &&
      Number.isFinite(cur.voiRange.upper)
    ) {
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
 * モード別の TF/blend/slab/VOI を現在のビューポートへ適用する（ビューポート型・カメラ・ツールは触らない）。
 * setup3DViewport（新規作成後）とクリップのボリューム差し替え後の再適用で共用する。
 */
function applyModeRendering(
  vp: Volume3DViewport,
  mode: RenderMode,
  modality: string | null,
  presetName: string | undefined,
  volumeId: string,
): void {
  if (mode === "VR") {
    const preset = presetName ?? defaultPreset(modality, "VR");
    try {
      vp.setProperties({ preset });
    } catch {
      /* プリセット名不一致等は無視 */
    }
  } else {
    // 真の MIP/MinIP/AVG: full slab＋blend mode（ORTHOGRAPHIC の VolumeViewport で実際に効く）。
    const blend =
      mode === "MINIP"
        ? Enums.BlendModes.MINIMUM_INTENSITY_BLEND
        : mode === "AVG"
          ? Enums.BlendModes.AVERAGE_INTENSITY_BLEND
          : Enums.BlendModes.MAXIMUM_INTENSITY_BLEND;
    const diag = volumeDiagonal(volumeId);
    try {
      vp.setSlabThickness?.(diag);
    } catch {
      /* ignore */
    }
    try {
      vp.setBlendMode?.(blend);
    } catch {
      /* ignore */
    }
    // レイサンプリング高品質化（full slab の斑点/moiré 抑制）。
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapper = (vp as any).getDefaultActor?.()?.actor?.getMapper?.();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sp = (cache.getVolume(volumeId) as any)?.spacing as number[] | undefined;
      const fine = sp && sp.length === 3 ? Math.min(sp[0], sp[1], sp[2]) : 1;
      if (mapper && fine > 0) {
        mapper.setSampleDistance?.(fine);
        mapper.setMaximumSamplesPerRay?.(Math.min(8000, Math.ceil(diag / fine) + 16));
      }
    } catch {
      /* ignore */
    }
    // MinIP: scalar 最小近傍（体外空気/背景）を透過して真っ暗を回避。
    if (mode === "MINIP") {
      const range = volumeScalarRange(volumeId);
      if (range) {
        const [mn, mx] = range;
        const span = mx - mn || 1;
        try {
          vp.setProperties({
            colormap: {
              opacity: [
                { value: mn, opacity: 0 },
                { value: mn + span * 0.02, opacity: 0 },
                { value: mn + span * 0.05, opacity: 1 },
                { value: mx, opacity: 1 },
              ],
            },
          });
        } catch {
          /* ignore */
        }
      }
    }
  }
  ensureVoiRange(vp, volumeId, modality);
}

/**
 * モードに応じたビューポートを 1 面（再）作成し、ボリューム・TF・ツールを配線する。
 * - VR: `VOLUME_3D`＋プリセット（COMPOSITE）。
 * - MIP: `ORTHOGRAPHIC`＋full slab＋`MAXIMUM_INTENSITY_BLEND`（真の最大値投影。setBlendMode/SlabThickness が効く型）。
 * モード切替時もこれを呼んでビューポート型ごと張り替える。呼び出し前に `buildMprVolume` で volumeId を用意すること。
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
  const isVr = opts.mode === "VR";
  engine.setViewports([
    {
      viewportId,
      type: isVr ? ViewportType.VOLUME_3D : ViewportType.ORTHOGRAPHIC,
      element: el,
      defaultOptions: {
        background: [0, 0, 0] as Types.Point3,
        // 全モードで初期向きを CORONAL に統一（VR=VOLUME_3D も applyViewOrientation で受け付ける）。
        // これで VR/MIP/MinIP の Reset View 既定角度が一致する（モード間で視点が揃う）。
        orientation: OrientationAxis.CORONAL,
        // **平行投影**に統一。VR(VOLUME_3D) 既定 perspective は回転後に world↔canvas 変換がずれる
        // （cornerstone 3D 幾何バグ）。平行投影なら線形・正確で実空間座標整合が良い（将来の 3D 計測/
        // ピッキングにも有利）。クリップは worldToCanvas 非依存（スライダ＋サブボリューム抽出）で実装。
        parallelProjection: true,
      },
    },
  ]);

  const vp = engine.getViewport(viewportId) as Volume3DViewport;
  await vp.setVolumes([{ volumeId }]);

  // モード別の TF/blend/slab/VOI を適用（クリップのボリューム差し替え後も同じ関数で再適用）。
  applyModeRendering(vp, opts.mode, opts.modality, opts.preset, volumeId);
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
  // 向きギズモ（解剖ラベル付き注釈キューブ。オフライン内蔵で外部アセット不要）。
  tg.addTool(OrientationMarkerTool.toolName, {
    overlayMarkerType: OrientationMarkerTool.OVERLAY_MARKER_TYPES.ANNOTATED_CUBE,
  });
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
  try {
    tg.setToolEnabled(OrientationMarkerTool.toolName);
  } catch {
    /* ギズモは任意。失敗しても本体表示は継続 */
  }

  engine.renderViewports([viewportId]);
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

// ── クリップボックス（自前・サブボリューム抽出方式）──────────────────────────
// worldToCanvas 非依存: 3D ハンドルのピッキングを使わず、6 スライダ（各軸割合）で範囲指定し、
// **実空間でボクセルを切り出した新ローカルボリューム**に差し替える。切り出したボリューム自体が視覚
// フィードバックになる。cornerstone の clipping-plane シェーダ（CONTEXT_LOST）も worldToCanvas バグも回避。

/** クリップ範囲（各軸 0..1 の割合。0=下端, 1=上端）。全開＝{0,1,0,1,0,1}。 */
export interface ClipFractions {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/**
 * ソースボリュームを実空間の直方体（各軸割合）で切り出し、`clippedVolumeId` のローカルボリュームを作成する。
 * origin は切り出し原点のワールド座標へ更新（direction/spacing 継承＝実画像空間で整合）。成功で true。
 */
export function buildClippedVolume(
  sourceVolumeId: string,
  clippedVolumeId: string,
  f: ClipFractions,
): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vol = cache.getVolume(sourceVolumeId) as any;
    if (!vol) return false;
    const dims = vol.dimensions as [number, number, number] | undefined;
    const spacing = vol.spacing as [number, number, number] | undefined;
    const origin = vol.origin as [number, number, number] | undefined;
    const direction = vol.direction as number[] | undefined;
    const src: ArrayLike<number> | undefined =
      vol.voxelManager?.getCompleteScalarDataArray?.() ?? vol.scalarData;
    if (!dims || !spacing || !origin || !direction || !src || !src.length) return false;

    const [W, H, D] = dims;
    const clampIdx = (t: number, n: number) => Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
    let i0 = clampIdx(f.x0, W);
    let i1 = clampIdx(f.x1, W);
    let j0 = clampIdx(f.y0, H);
    let j1 = clampIdx(f.y1, H);
    let k0 = clampIdx(f.z0, D);
    let k1 = clampIdx(f.z1, D);
    if (i1 < i0) [i0, i1] = [i1, i0];
    if (j1 < j0) [j0, j1] = [j1, j0];
    if (k1 < k0) [k0, k1] = [k1, k0];
    const nw = i1 - i0 + 1;
    const nh = j1 - j0 + 1;
    const nd = k1 - k0 + 1;

    // z-major (index = i + j*W + k*W*H) で切り出し。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = (src as any).constructor as { new (len: number): { [i: number]: number; length: number } };
    const out = new Ctor(nw * nh * nd);
    const sliceWH = W * H;
    for (let k = 0; k < nd; k++) {
      const sk = (k + k0) * sliceWH;
      const dk = k * nw * nh;
      for (let j = 0; j < nh; j++) {
        const sj = sk + (j + j0) * W + i0;
        const dj = dk + j * nw;
        for (let i = 0; i < nw; i++) out[dj + i] = src[sj + i];
      }
    }

    // 新 origin = origin + i0*spX*col0 + j0*spY*col1 + k0*spZ*col2（direction 考慮＝実空間）。
    const c0 = [direction[0], direction[1], direction[2]];
    const c1 = [direction[3], direction[4], direction[5]];
    const c2 = [direction[6], direction[7], direction[8]];
    const newOrigin: [number, number, number] = [
      origin[0] + i0 * spacing[0] * c0[0] + j0 * spacing[1] * c1[0] + k0 * spacing[2] * c2[0],
      origin[1] + i0 * spacing[0] * c0[1] + j0 * spacing[1] * c1[1] + k0 * spacing[2] * c2[1],
      origin[2] + i0 * spacing[0] * c0[2] + j0 * spacing[1] * c1[2] + k0 * spacing[2] * c2[2],
    ];

    const metadata = { ...(vol.metadata ?? {}), Rows: nh, Columns: nw };
    try {
      if (cache.getVolume(clippedVolumeId)) cache.removeVolumeLoadObject?.(clippedVolumeId);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (volumeLoader.createLocalVolume as any)(clippedVolumeId, {
      metadata,
      dimensions: [nw, nh, nd],
      spacing,
      origin: newOrigin,
      direction,
      scalarData: out,
    });
    return true;
  } catch {
    return false;
  }
}

/** ビューポートの表示ボリュームを差し替える（クリップの適用/解除）。カメラは保持する。 */
export async function setViewportVolume(
  engine: RenderingEngine,
  viewportId: string,
  volumeId: string,
): Promise<void> {
  try {
    const vp = engine.getViewport(viewportId) as Volume3DViewport;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cam = (vp as any).getCamera?.();
    await vp.setVolumes([{ volumeId }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (cam) {
      try {
        (vp as any).setCamera?.(cam); // setVolumes のカメラフィットを打ち消し、視点を保持
      } catch {
        /* ignore */
      }
    }
    vp.render();
  } catch {
    /* ignore */
  }
}

/** ボリューム差し替え後にモード別 TF/blend/slab/VOI を再適用する（公開ラッパ）。 */
export function reapplyModeRendering(
  engine: RenderingEngine,
  viewportId: string,
  mode: RenderMode,
  modality: string | null,
  preset: string | undefined,
  volumeId: string,
): void {
  try {
    const vp = engine.getViewport(viewportId) as Volume3DViewport;
    applyModeRendering(vp, mode, modality, preset, volumeId);
    vp.render();
  } catch {
    /* ignore */
  }
}

/** ボリュームをキャッシュから安全に破棄する（クリップ一時ボリューム後始末）。 */
export function removeVolumeSafe(volumeId: string): void {
  try {
    if (cache.getVolume(volumeId)) cache.removeVolumeLoadObject(volumeId);
  } catch {
    /* ignore */
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
