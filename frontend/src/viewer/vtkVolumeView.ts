/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D Viewer の描画コア（**pure VTK.js**）。旧 GRAPHY（LWJGL 自前 GL）の思想をブラウザの vtk.js で再現する。
 *
 * 設計判断（2026-07-02・ユーザー選択）: cornerstone VOLUME_3D の制約（blend no-op / clipping-plane CONTEXT_LOST /
 * オフスクリーン interactor でウィジェット操作不可 / 回転後 worldToCanvas 不正確）を回避するため、`#viewer3d` の
 * **描画＋操作だけ pure VTK.js** にする。ボリューム構築（`buildMprVolume`＝ガントリチルト補正込み）は cornerstone を
 * 流用し、その `vtkImageData` を**横取り**して pure vtk の `vtkGenericRenderWindow`（オンスクリーン＋本物の interactor）
 * に渡す。これにより:
 *  - vtk ウィジェット（`ImageCroppingWidget`）の**マウスドラッグがそのまま効く**（GRAPHY 的なドラッグ ROI）。
 *  - 座標変換は vtk 本来のカメラ数学で正確（回転しても破綻しない）。
 *  - 真の MIP/MinIP（`setBlendModeToMaximumIntensity/MinimumIntensity`）。
 *  - クリップは `vtkImageCropFilter`（imageData を extent 切り出し）で**ライブ**適用（クリッピングシェーダ非使用＝クラッシュ回避）。
 *
 * vtk.js の型宣言が無いモジュールは `viewer/vtkModules.d.ts` で ambient 宣言している（any 扱い）。
 */
import { cache, CONSTANTS } from "@cornerstonejs/core";
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkVolume from "@kitware/vtk.js/Rendering/Core/Volume";
import vtkVolumeMapper from "@kitware/vtk.js/Rendering/Core/VolumeMapper";
import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";
import vtkPiecewiseFunction from "@kitware/vtk.js/Common/DataModel/PiecewiseFunction";
import vtkInteractorStyleManipulator from "@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator";
import vtkMouseCameraTrackballRotateManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator";
import vtkMouseCameraTrackballPanManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator";
import vtkMouseCameraTrackballZoomManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomManipulator";
import vtkMouseRangeManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseRangeManipulator";
import vtkImageCropFilter from "@kitware/vtk.js/Filters/General/ImageCropFilter";
import vtkWidgetManager from "@kitware/vtk.js/Widgets/Core/WidgetManager";
import vtkImageCroppingWidget from "@kitware/vtk.js/Widgets/Widgets3D/ImageCroppingWidget";
import vtkOrientationMarkerWidget from "@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget";
import vtkAnnotatedCubeActor from "@kitware/vtk.js/Rendering/Core/AnnotatedCubeActor";
import { Corners as OrientationCorners } from "@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget/Constants";
import { createOrthoSlices, type OrthoSlices } from "./vtkOrthoSlices";
import actorRotateManipulator from "./actorRotateManipulator";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** レンダリングモード。 */
export type VtkRenderMode = "VR" | "MIP" | "MINIP" | "ORTHO";

/** 不透明度カーブ点（value=HU/SUV, opacity=0..1）。 */
export interface VtkOpacityPoint {
  value: number;
  opacity: number;
}

/** 表示状態（Info オーバーレイ表示・Representation State の取得/適用に使う）。 */
export interface VtkViewState {
  position: [number, number, number];
  focalPoint: [number, number, number];
  viewUp: [number, number, number];
  parallelScale: number;
  /** 視線方向から算出した方位角/仰角（度・表示用）。 */
  azimuth: number;
  elevation: number;
  center: number;
  width: number;
  mode: VtkRenderMode;
}

/** Cinematic（lit-VR）パラメータ。 */
export interface VtkCinematicParams {
  /** 陰影（shade）ON/OFF。 */
  enabled: boolean;
  ambient: number;
  diffuse: number;
  specular: number;
  specularPower: number;
  /** 勾配不透明度（境界を強調）ON/OFF。 */
  gradientOpacity: boolean;
  gradientOpacityMin: number;
  gradientOpacityMax: number;
  // ── シネマティック（WebGL2 VolumeMapper の散乱/大域照明。旧 LWJGL パストレーサのリアルタイム近似）──
  /** 不透明度勾配から法線を計算（サーフェス的な陰影＝あの質感の要）。 */
  computeNormalFromOpacity: boolean;
  /** ボリューム散乱ブレンド（0..1・ソフトシャドウ/散乱）。0=陰影のみ。 */
  scattering: number;
  /** 大域照明の到達距離（0..1）。 */
  giReach: number;
  /** 位相関数の異方性（-1..1・正=前方散乱）。 */
  anisotropy: number;
  /** ローカル・アンビエントオクルージョン（クレバスの陰）ON/OFF。 */
  ambientOcclusion: boolean;
}

/** pure-vtk 3D ビューのコントローラ。 */
export interface VtkVolumeView {
  setMode(mode: VtkRenderMode): void;
  setWindowLevel(center: number, width: number): void;
  /** Ortho モードの各軸スライス位置（0..1 の割合）。 */
  setOrthoPositions(fx: number, fy: number, fz: number): void;
  /** 色 LUT（256 の r/g/b 0..255）を適用。null でグレースケールへ。 */
  setColorLut(lut: { r: number[]; g: number[]; b: number[] } | null): void;
  /** VR プリセット（cornerstone VIEWPORT_PRESETS 名）を適用。null で解除（グレースケール/W-L へ）。 */
  applyPreset(name: string | null): void;
  /** 不透明度カーブ（HU 点）を適用。null でモード既定へ。 */
  setOpacityPoints(points: VtkOpacityPoint[] | null): void;
  /** クリップ箱（ドラッグ可能）ON/OFF。 */
  setClipEnabled(on: boolean): void;
  /** 向きギズモ（患者 LPS ラベル付き AnnotatedCube）ON/OFF。既定 ON。 */
  setAxesEnabled(on: boolean): void;
  /**
   * 現在の色 TF＋不透明度 TF を data レンジ全体で 256×4 RGBA に焼き込む（W/L・LUT・不透明度カーブを反映）。
   * Cinematic v2 パストレーサ（`viewer/cinematicPathTracer.ts`）の LUT テクスチャ用。
   */
  getLut256(): Uint8Array;
  resetView(): void;
  resize(): void;
  render(): void;
  /** scalar 値域 [min,max]。 */
  getScalarRange(): [number, number];
  /**
   * シーン重畳用: 内部 vtk renderer / render 関数 / 表示 imageData を返す。
   * mesh・3D ROI 表面アクターを同一 LPS シーンへ `renderer.addActor` するために使う（`viewer3d/scene3d.ts`）。
   */
  getSceneParts(): { renderer: Any; render: () => void; imageData: Any };
  /**
   * クロップ箱（index extent [i0,i1,j0,j1,k0,k1]）変化を購読する。
   * 埋め込み(embedded)な mesh/3D ROI をボリュームと同じ範囲でカットするのに使う（`viewer3d/scene3d.ts`）。
   * 登録直後に現在値で 1 回コールバックする。戻り値で購読解除。
   */
  subscribeClip(cb: (extent: number[]) => void): () => void;
  /** 現在の表示状態を取得（Info オーバーレイ・Representation State 用）。 */
  getState(): VtkViewState;
  /** 表示状態を適用（指定フィールドのみ反映）。camera/W-L/モードを再現。 */
  applyState(state: Partial<VtkViewState>): void;
  /** 初期向きから azimuth/elevation/roll（度）だけ回転して向きを再現。pan/zoom は据置。 */
  applyOrientation(azimuth: number, elevation: number, roll: number): void;
  /** カメラ操作終了・W/L 変更・モード変更などの状態変化を購読（Info オーバーレイの更新用）。 */
  onStateChanged(cb: () => void): () => void;
  /** Cinematic（lit-VR）パラメータを適用。 */
  setCinematic(params: VtkCinematicParams): void;
  /** 現在の Cinematic パラメータを取得。 */
  getCinematic(): VtkCinematicParams;
  /** 左ドラッグ回転モード: "camera"（カメラ周回）/ "actor"（カメラ固定・被写体回転）。既定=actor。 */
  setRotateMode(mode: "camera" | "actor"): void;
  getRotateMode(): "camera" | "actor";
  destroy(): void;
}

/**
 * Cornerstone のキャッシュ volume から、**scalar を pointData に持つ独立した `vtkImageData`** を組み立てる。
 * ⚠️ cornerstone の streaming volume の `imageData` は scalar を vtk pointData に持たない（voxelManager が別管理）ため、
 * それをそのまま vtk フィルタ/mapper に渡すと「No scalars from input」になる。ここで scalar 配列＋幾何から作り直す。
 * 幾何（dimensions/spacing/origin/direction）は cornerstone の imageData から取得（＝実画像空間で一致）。
 */
export function vtkImageDataFromVolume(volumeId: string): Any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vol = cache.getVolume(volumeId) as any;
    if (!vol) return null;
    const src = vol.imageData;
    const dims = (src?.getDimensions?.() ?? vol.dimensions) as number[] | undefined;
    const spacing = (src?.getSpacing?.() ?? vol.spacing) as number[] | undefined;
    const origin = (src?.getOrigin?.() ?? vol.origin) as number[] | undefined;
    const direction = (src?.getDirection?.() ?? vol.direction) as number[] | undefined;
    const scalarArray: ArrayLike<number> | undefined =
      vol.voxelManager?.getCompleteScalarDataArray?.() ?? vol.scalarData;
    if (!dims || !spacing || !origin || !scalarArray || !scalarArray.length) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id: Any = vtkImageData.newInstance();
    id.setDimensions(dims); // vtk セッターは配列/spread 両対応
    id.setSpacing(spacing);
    id.setOrigin(origin);
    if (direction && direction.length === 9) id.setDirection(Float32Array.from(direction));
    const scalars = vtkDataArray.newInstance({
      numberOfComponents: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      values: scalarArray as any,
    });
    id.getPointData().setScalars(scalars);
    return id;
  } catch {
    return null;
  }
}

/**
 * クリップ箱ハンドルを type 別に着色する（面=黄 / 辺=シアン / 角=青）。
 * ハンドルは `color`（スカラー）mixin なので、各ハンドル state にスカラー値を割り当て、
 * グリフマッパーの LUT でそのスカラー→RGB にマップする（vtkColorTransferFunction）。
 */
function styleClipHandles(widget: Any, viewWidget: Any): void {
  try {
    const st = widget.getWidgetState();
    const setColors = (label: string, scalar: number) => {
      const states = st.getStatesWithLabel(label);
      if (Array.isArray(states)) states.forEach((s: Any) => s.setColor?.(scalar));
    };
    setColors("faces", 0.0); // 面中心 → 黄
    setColors("edges", 0.5); // 辺中心 → シアン
    setColors("corners", 1.0); // 角 → 青

    const ctf = vtkColorTransferFunction.newInstance();
    ctf.addRGBPoint(0.0, 1, 1, 0); // 黄
    ctf.addRGBPoint(0.5, 0, 1, 1); // シアン
    ctf.addRGBPoint(1.0, 0, 0, 1); // 青

    // 球ハンドル代表（getNestedProps()[0]）のグリフマッパーへ LUT を適用（アウトラインには触れない）。
    const reps = viewWidget.getNestedProps?.() ?? [];
    const handleRep = reps[0];
    const actors = handleRep?.getActors?.() ?? [];
    actors.forEach((actor: Any) => {
      const m = actor.getMapper?.();
      if (m?.setLookupTable) {
        m.setLookupTable(ctf);
        m.setUseLookupTableScalarRange?.(true);
        m.setScalarRange?.(0, 1);
      }
    });
  } catch {
    /* ignore */
  }
}

/** パース済み VR プリセット（色 TF・不透明度・陰影パラメータ）。 */
interface ParsedPreset {
  color: { x: number; r: number; g: number; b: number }[];
  opacity: { x: number; o: number }[];
  shade: boolean;
  ambient: number;
  diffuse: number;
  specular: number;
  specularPower: number;
}

/**
 * cornerstone `VIEWPORT_PRESETS` の 1 件（`colorTransfer`/`scalarOpacity` は "count v v v..." 文字列）を
 * パースする。colorTransfer は 4 値組（x,r,g,b）、scalarOpacity は 2 値組（x,o）。
 */
function parseViewportPreset(name: string): ParsedPreset | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const presets: Any[] = (CONSTANTS as Any)?.VIEWPORT_PRESETS ?? [];
    const p = presets.find((x) => x?.name === name);
    if (!p) return null;
    const nums = (s: string): number[] =>
      String(s ?? "")
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((v) => !Number.isNaN(v));
    const ct = nums(p.colorTransfer).slice(1); // 先頭は個数
    const so = nums(p.scalarOpacity).slice(1);
    const color: ParsedPreset["color"] = [];
    for (let i = 0; i + 3 < ct.length; i += 4) color.push({ x: ct[i], r: ct[i + 1], g: ct[i + 2], b: ct[i + 3] });
    const opacity: ParsedPreset["opacity"] = [];
    for (let i = 0; i + 1 < so.length; i += 2) opacity.push({ x: so[i], o: so[i + 1] });
    if (!color.length || !opacity.length) return null;
    return {
      color,
      opacity,
      shade: String(p.shade) === "1" || p.shade === 1,
      ambient: Number(p.ambient) || 0.1,
      diffuse: Number(p.diffuse) || 0.9,
      specular: Number(p.specular) || 0.2,
      specularPower: Number(p.specularPower) || 10,
    };
  } catch {
    return null;
  }
}

/** imageData の scalar 値域。 */
function scalarRangeOf(imageData: Any): [number, number] {
  try {
    const r = imageData.getPointData().getScalars().getRange();
    if (Array.isArray(r) && r.length >= 2 && r[1] > r[0]) return [r[0], r[1]];
  } catch {
    /* ignore */
  }
  return [0, 1];
}

/** グレースケール色 TF を [lo,hi] に設定。 */
function setGrayscale(ctf: Any, lo: number, hi: number): void {
  ctf.removeAllPoints();
  ctf.addRGBPoint(lo, 0, 0, 0);
  ctf.addRGBPoint(hi, 1, 1, 1);
}

/** LUT（r/g/b 各 256）を色 TF に設定（[lo,hi] に等間隔マップ）。 */
function setLutColor(ctf: Any, lut: { r: number[]; g: number[]; b: number[] }, lo: number, hi: number): void {
  ctf.removeAllPoints();
  const n = Math.min(lut.r.length, lut.g.length, lut.b.length);
  const denom = n > 1 ? n - 1 : 1;
  for (let i = 0; i < n; i++) {
    const v = lo + ((hi - lo) * i) / denom;
    ctf.addRGBPoint(v, lut.r[i] / 255, lut.g[i] / 255, lut.b[i] / 255);
  }
}

/** モード既定の不透明度を otf に設定（W/L の [lo,hi] を基準）。 */
function setModeOpacity(
  otf: Any,
  mode: VtkRenderMode,
  lo: number,
  hi: number,
  range: [number, number],
): void {
  otf.removeAllPoints();
  const [mn, mx] = range;
  if (mode === "MINIP") {
    // 体外空気/背景（最小近傍）を透過し、その上を不透明に（真っ暗回避）。
    const span = mx - mn || 1;
    otf.addPoint(mn, 0);
    otf.addPoint(mn + span * 0.02, 0);
    otf.addPoint(mn + span * 0.05, 1);
    otf.addPoint(mx, 1);
  } else if (mode === "MIP") {
    // MIP: 全域不透明（最大値投影を素直に見せる。輝度は色 TF の W/L で）。
    otf.addPoint(mn, 1);
    otf.addPoint(mx, 1);
  } else {
    // VR: W/L 窓で 0→0.9 に立ち上げる（下は透明、上は不透明）ランプ。
    otf.addPoint(lo, 0);
    otf.addPoint((lo + hi) / 2, 0.15);
    otf.addPoint(hi, 0.9);
  }
}

export function createVtkVolumeView(
  container: HTMLDivElement,
  imageData: Any,
  opts: { mode: VtkRenderMode; center: number; width: number },
): VtkVolumeView {
  const range = scalarRangeOf(imageData);

  // ── レンダーウィンドウ（オンスクリーン＋本物の interactor）──
  const grw = vtkGenericRenderWindow.newInstance({ background: [0, 0, 0] });
  grw.setContainer(container);
  const renderer = grw.getRenderer();
  const renderWindow = grw.getRenderWindow();
  const interactor = renderWindow.getInteractor();
  // interactor style（回転/Pan/Zoom/W-L の割当）は applyWL・ortho 定義後に manipulator で設定する（下記）。

  // ── クロップフィルタ（imageData → crop → mapper）──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cropFilter: Any = vtkImageCropFilter.newInstance();
  cropFilter.setInputData(imageData);
  // クロップ箱（index extent）変化の購読者（埋め込み mesh/ROI をボリュームと一緒にカットするため）。
  const clipListeners = new Set<(ext: number[]) => void>();
  let currentClipExtent: number[] = (imageData.getExtent() as number[]).slice();
  // クロップ範囲を全域/任意 extent に設定するヘルパー（vtk の可変長シグネチャを緩く扱う）。
  const setCropExtent = (ext: number[]) => {
    try {
      if (ext.length === 6) cropFilter.setCroppingPlanes(ext[0], ext[1], ext[2], ext[3], ext[4], ext[5]);
    } catch {
      /* ignore */
    }
    if (ext.length === 6) {
      currentClipExtent = ext.slice();
      clipListeners.forEach((l) => {
        try {
          l(currentClipExtent);
        } catch {
          /* ignore */
        }
      });
    }
  };
  setCropExtent(imageData.getExtent());

  // ── ボリューム（mapper + actor + TF）──
  const mapper = vtkVolumeMapper.newInstance();
  mapper.setInputConnection(cropFilter.getOutputPort());
  const sp = imageData.getSpacing?.() ?? [1, 1, 1];
  const fine = Math.min(sp[0], sp[1], sp[2]) || 1;
  mapper.setSampleDistance(fine);
  mapper.setMaximumSamplesPerRay(8000);

  const actor = vtkVolume.newInstance();
  actor.setMapper(mapper);
  const ctf = vtkColorTransferFunction.newInstance();
  const otf = vtkPiecewiseFunction.newInstance();
  const prop = actor.getProperty();
  prop.setRGBTransferFunction(0, ctf);
  prop.setScalarOpacity(0, otf);
  prop.setInterpolationTypeToLinear();
  prop.setUseGradientOpacity?.(0, false);
  renderer.addVolume(actor);

  // ── クロップウィジェット（ドラッグ可能な箱）──
  const widgetManager = vtkWidgetManager.newInstance();
  widgetManager.setRenderer(renderer);
  const cropWidget = vtkImageCroppingWidget.newInstance();
  cropWidget.copyImageDataDescription(imageData);
  let clipViewWidget: Any = null;
  let clipSub: { unsubscribe?: () => void } | null = null;
  let clipEnabled = false;

  // ── 状態 ──
  let mode: VtkRenderMode = opts.mode;
  let center = opts.center;
  let width = opts.width;
  let lut: { r: number[]; g: number[]; b: number[] } | null = null;
  let customOpacity: VtkOpacityPoint[] | null = null;
  let presetActive = false; // VR プリセット適用中は grayscale/W-L/opacity 既定で上書きしない

  const rebuildColor = () => {
    if (presetActive) return;
    const lo = center - width / 2;
    const hi = center + width / 2;
    if (lut) setLutColor(ctf, lut, lo, hi);
    else setGrayscale(ctf, lo, hi);
  };
  const rebuildOpacity = () => {
    if (presetActive) return;
    const lo = center - width / 2;
    const hi = center + width / 2;
    if (customOpacity && customOpacity.length) {
      otf.removeAllPoints();
      customOpacity
        .slice()
        .sort((a, b) => a.value - b.value)
        .forEach((p) => otf.addPoint(p.value, p.opacity));
    } else {
      setModeOpacity(otf, mode, lo, hi, range);
    }
  };
  const applyBlend = () => {
    if (mode === "MIP") mapper.setBlendModeToMaximumIntensity();
    else if (mode === "MINIP") mapper.setBlendModeToMinimumIntensity();
    else mapper.setBlendModeToComposite();
  };

  const render = () => {
    try {
      renderWindow.render();
    } catch {
      /* ignore */
    }
  };

  // Ortho（3 直交スライス）。初期は非表示。VR/MIP/MinIP と排他で表示切替。
  const ortho: OrthoSlices = createOrthoSlices(renderer, imageData, render, { center, width });

  // 状態変化の通知（Info オーバーレイ更新用）。
  const stateListeners = new Set<() => void>();
  const notifyState = () => {
    stateListeners.forEach((cb) => {
      try {
        cb();
      } catch {
        /* ignore */
      }
    });
  };

  // W/L の内部適用（public setWindowLevel と右ドラッグ manipulator の両方から使う）。
  const applyWL = (c: number, w: number) => {
    center = c;
    width = Math.max(1e-3, w);
    rebuildColor();
    rebuildOpacity();
    ortho.setWindowLevel(center, width);
    render();
    notifyState();
  };

  // モード切替（setMode と applyState で共用）。render/notify は呼び元で行う。
  const applyMode = (next: VtkRenderMode) => {
    mode = next;
    customOpacity = null;
    const isOrtho = next === "ORTHO";
    try {
      actor.setVisibility(!isOrtho);
    } catch {
      /* ignore */
    }
    ortho.setVisible(isOrtho);
    if (isOrtho) {
      ortho.setWindowLevel(center, width);
    } else {
      applyBlend();
      rebuildOpacity();
    }
  };

  // Cinematic（lit-VR）。既定は無効（従来の VR と同じ見た目）。
  let cinematic: VtkCinematicParams = {
    enabled: false,
    ambient: 0.2,
    diffuse: 0.7,
    specular: 0.3,
    specularPower: 8,
    gradientOpacity: false,
    gradientOpacityMin: 0,
    gradientOpacityMax: Math.max(1, (range[1] - range[0]) * 0.25),
    // 有効化時の既定＝軟部/骨のシネマティックに寄せた値。
    computeNormalFromOpacity: true,
    scattering: 0.6,
    giReach: 0.4,
    anisotropy: 0.3,
    ambientOcclusion: true,
  };
  const applyCinematic = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: Any = actor.getProperty();
    const on = cinematic.enabled;
    try {
      p.setShade(on);
      p.setAmbient(cinematic.ambient);
      p.setDiffuse(cinematic.diffuse);
      p.setSpecular(cinematic.specular);
      p.setSpecularPower(cinematic.specularPower);
      p.setUseGradientOpacity(0, cinematic.gradientOpacity);
      if (cinematic.gradientOpacity) {
        p.setGradientOpacityMinimumValue(0, cinematic.gradientOpacityMin);
        p.setGradientOpacityMaximumValue(0, cinematic.gradientOpacityMax);
        p.setGradientOpacityMinimumOpacity(0, 0);
        p.setGradientOpacityMaximumOpacity(0, 1);
      }
    } catch {
      /* ignore */
    }
    // ── シネマティック散乱（WebGL2 VolumeMapper）: ソフトシャドウ＋大域照明＋AO ──
    // 有効時のみ ON。無効時は 0/false に戻して従来の VR に戻す。散乱は COMPOSITE(VR) でのみ効く。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m: Any = mapper;
    try {
      m.setComputeNormalFromOpacity?.(on && cinematic.computeNormalFromOpacity);
      m.setVolumetricScatteringBlending?.(on ? cinematic.scattering : 0);
      m.setGlobalIlluminationReach?.(on ? cinematic.giReach : 0);
      m.setAnisotropy?.(on ? cinematic.anisotropy : 0);
      m.setLocalAmbientOcclusion?.(on && cinematic.ambientOcclusion);
      if (on && cinematic.ambientOcclusion) {
        m.setLAOKernelSize?.(15);
        m.setLAOKernelRadius?.(7);
      }
    } catch {
      /* 旧 vtk.js で散乱 API 非対応でも lit-VR は動作 */
    }
  };

  // 初期化。
  applyBlend();
  rebuildColor();
  rebuildOpacity();
  renderer.resetCamera();
  grw.resize();
  render();

  // ── interactor 割当（回転=左 / Pan=中 / Zoom=ホイール / W-L=右ドラッグ）──
  // pure vtk の TrackballCamera は右=ドリーで W/L が無いため、Manipulator で明示割当する。
  const iStyle = vtkInteractorStyleManipulator.newInstance();
  const panManip = vtkMouseCameraTrackballPanManipulator.newInstance({ button: 2 }); // 中ドラッグ=Pan
  // Zoom はホイールのみ（drag 無効）。scroll 判定は修飾キー一致を見るため control 等は付けない。
  const zoomManip = vtkMouseCameraTrackballZoomManipulator.newInstance({ scrollEnabled: true, dragEnabled: false });
  const wlManip = vtkMouseRangeManipulator.newInstance({ button: 3 }); // 右ドラッグ=W/L
  const rspan = range[1] - range[0] || 1;
  wlManip.setHorizontalListener(range[0], range[1], rspan / 500, () => center, (v: number) => applyWL(v, width)); // 左右=Level
  wlManip.setVerticalListener(1, rspan * 2, rspan / 500, () => width, (v: number) => applyWL(center, v)); // 上下=Window

  // 左ドラッグ回転: Camera（カメラが被写体を周回・focal を中心に固定）/ Actor（カメラ固定・被写体が回る）。既定=Actor。
  const volCenter = (imageData.getCenter?.() ?? [0, 0, 0]) as number[];
  const camRotate = vtkMouseCameraTrackballRotateManipulator.newInstance({
    button: 1,
    useFocalPointAsCenterOfRotation: true,
  });
  const actorRotate = actorRotateManipulator.newInstance({ button: 1, center: volCenter });
  let rotateMode: "camera" | "actor" = "camera";
  // 全マウスマニピュレータを張り替える（個別 remove より確実）。回転だけ mode で差し替え。
  const installManipulators = () => {
    iStyle.removeAllMouseManipulators();
    iStyle.addMouseManipulator(rotateMode === "camera" ? camRotate : actorRotate);
    iStyle.addMouseManipulator(panManip);
    iStyle.addMouseManipulator(zoomManip);
    iStyle.addMouseManipulator(wlManip);
  };
  const applyRotateMode = (m: "camera" | "actor") => {
    rotateMode = m;
    installManipulators();
  };
  installManipulators();
  interactor.setInteractorStyle(iStyle);

  // ── 向きギズモ（AnnotatedCube・患者 LPS ラベル）──
  // 旧 GRAPHY `AxesGizmo` を vtk.js 標準の OrientationMarkerWidget で代替（設計 §6.5）。
  // DICOM 患者 LPS: +X=Left(L) / +Y=Posterior(P) / +Z=Superior(S)。裏面は R/A/I。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const axesCube: Any = vtkAnnotatedCubeActor.newInstance();
  axesCube.setDefaultStyle({
    fontColor: "white",
    fontStyle: "bold",
    fontSizeScale: (res: number) => res / 2,
    faceColor: "#2b333b",
    edgeThickness: 0.1,
    edgeColor: "#8b97a3",
    resolution: 400,
  });
  axesCube.setXPlusFaceProperty({ text: "L", faceColor: "#5b3a3a" });
  axesCube.setXMinusFaceProperty({ text: "R", faceColor: "#5b3a3a" });
  axesCube.setYPlusFaceProperty({ text: "P", faceColor: "#3a5b3a" });
  axesCube.setYMinusFaceProperty({ text: "A", faceColor: "#3a5b3a" });
  axesCube.setZPlusFaceProperty({ text: "S", faceColor: "#3a3a5b" });
  axesCube.setZMinusFaceProperty({ text: "I", faceColor: "#3a3a5b" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let axesWidget: Any = null;
  try {
    axesWidget = vtkOrientationMarkerWidget.newInstance({
      actor: axesCube,
      interactor,
      viewportCorner: OrientationCorners.BOTTOM_RIGHT,
      viewportSize: 0.15,
      minPixelSize: 80,
      maxPixelSize: 180,
    });
    axesWidget.setEnabled(true);
    axesWidget.updateMarkerOrientation?.();
  } catch {
    axesWidget = null;
  }

  // 初期カメラ（向き/位置/pan/zoom）を控える。Reset View で完全復元する
  // （vtk の resetCamera は再フィットのみで回転を戻さないため）。
  const cam0 = renderer.getActiveCamera();
  const initialCamera = {
    position: cam0.getPosition() as number[],
    focalPoint: cam0.getFocalPoint() as number[],
    viewUp: cam0.getViewUp() as number[],
    parallelScale: cam0.getParallelScale() as number,
  };

  // カメラ操作（回転/Pan/Zoom）を Info オーバーレイへ反映するため購読。
  try {
    cam0.onModified(() => notifyState());
  } catch {
    /* ignore */
  }

  return {
    setMode(next) {
      applyMode(next);
      applyCinematic(); // 陰影設定を維持
      render();
      notifyState();
    },
    setWindowLevel(c, w) {
      applyWL(c, w);
    },
    setOrthoPositions(fx, fy, fz) {
      ortho.setPositions(fx, fy, fz);
    },
    setColorLut(next) {
      lut = next;
      presetActive = false; // LUT 指定は grayscale/LUT 経路（preset 解除）
      rebuildColor();
      render();
    },
    applyPreset(name) {
      if (!name) {
        presetActive = false;
        rebuildColor();
        rebuildOpacity();
        render();
        return;
      }
      const p = parseViewportPreset(name);
      if (!p) return;
      ctf.removeAllPoints();
      p.color.forEach((c) => ctf.addRGBPoint(c.x, c.r, c.g, c.b));
      otf.removeAllPoints();
      p.opacity.forEach((o) => otf.addPoint(o.x, o.o));
      presetActive = true;
      customOpacity = null;
      lut = null;
      // 陰影をプリセットに合わせ、Cinematic 状態も同期。
      cinematic = {
        ...cinematic,
        enabled: p.shade,
        ambient: p.ambient,
        diffuse: p.diffuse,
        specular: p.specular,
        specularPower: p.specularPower,
      };
      applyCinematic();
      render();
    },
    setOpacityPoints(points) {
      customOpacity = points;
      rebuildOpacity();
      render();
    },
    setClipEnabled(on) {
      if (on === clipEnabled) return;
      clipEnabled = on;
      if (on) {
        clipViewWidget = widgetManager.addWidget(cropWidget);
        widgetManager.enablePicking();
        styleClipHandles(cropWidget, clipViewWidget); // 面=黄/辺=シアン/角=青
        // ドラッグでハンドルが動く → crop 面（index extent）を crop フィルタへ渡してライブ切り出し。
        const planeState = cropWidget.getWidgetState().getCroppingPlanes();
        clipSub = cropWidget.getWidgetState().onModified(() => {
          const planes = planeState.getPlanes();
          if (Array.isArray(planes) && planes.length === 6) setCropExtent(planes as number[]);
          render();
        });
      } else {
        try {
          clipSub?.unsubscribe?.();
        } catch {
          /* ignore */
        }
        clipSub = null;
        try {
          widgetManager.removeWidget(cropWidget);
        } catch {
          /* ignore */
        }
        clipViewWidget = null;
        // クロップ解除＝全域へ。
        setCropExtent(imageData.getExtent());
      }
      render();
    },
    resetView() {
      // Actor 回転モードで蓄積した各アクターの回転を初期表示（原点・無回転）に戻す。
      // ⚠️ rotateWXYZ は model.rotation 行列に蓄積するが model.orientation(Euler) は変えないため、
      // setOrientation(0,0,0) は「orientation 未変化＝早期 return」で rotation 行列をクリアしない。
      // 一旦別値にしてから 0 に戻すことで rotation 行列を確実に identity へリセットする。
      try {
        const props: Any[] = [...renderer.getActors(), ...renderer.getVolumes()];
        props.forEach((p) => {
          if (!p.setOrientation) return;
          p.setOrientation(0, 0, 0.0001);
          p.setOrientation(0, 0, 0);
          p.setOrigin?.(0, 0, 0);
        });
      } catch {
        /* ignore */
      }
      // 初期カメラを完全復元（向き＋pan＋zoom）。resetCamera だけだと回転が戻らない。
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cam: Any = renderer.getActiveCamera();
        const p = initialCamera.position;
        const f = initialCamera.focalPoint;
        const u = initialCamera.viewUp;
        cam.setPosition(p[0], p[1], p[2]);
        cam.setFocalPoint(f[0], f[1], f[2]);
        cam.setViewUp(u[0], u[1], u[2]);
        cam.setParallelScale(initialCamera.parallelScale);
        renderer.resetCameraClippingRange();
      } catch {
        renderer.resetCamera();
      }
      render();
      notifyState();
    },
    resize() {
      try {
        grw.resize();
      } catch {
        /* ignore */
      }
      render();
    },
    render,
    getScalarRange() {
      return range;
    },
    getSceneParts() {
      return { renderer, render, imageData };
    },
    subscribeClip(cb) {
      clipListeners.add(cb);
      try {
        cb(currentClipExtent);
      } catch {
        /* ignore */
      }
      return () => {
        clipListeners.delete(cb);
      };
    },
    getState() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cam: Any = renderer.getActiveCamera();
      const position = cam.getPosition() as number[];
      const focalPoint = cam.getFocalPoint() as number[];
      const viewUp = cam.getViewUp() as number[];
      const parallelScale = cam.getParallelScale() as number;
      const dx = position[0] - focalPoint[0];
      const dy = position[1] - focalPoint[1];
      const dz = position[2] - focalPoint[2];
      const rlen = Math.hypot(dx, dy, dz) || 1;
      const azimuth = (Math.atan2(dx, dz) * 180) / Math.PI;
      const elevation = (Math.asin(Math.max(-1, Math.min(1, dy / rlen))) * 180) / Math.PI;
      return {
        position: [position[0], position[1], position[2]],
        focalPoint: [focalPoint[0], focalPoint[1], focalPoint[2]],
        viewUp: [viewUp[0], viewUp[1], viewUp[2]],
        parallelScale,
        azimuth,
        elevation,
        center,
        width,
        mode,
      };
    },
    applyState(s) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cam: Any = renderer.getActiveCamera();
      if (s.mode && s.mode !== mode) applyMode(s.mode);
      if (s.position) cam.setPosition(s.position[0], s.position[1], s.position[2]);
      if (s.focalPoint) cam.setFocalPoint(s.focalPoint[0], s.focalPoint[1], s.focalPoint[2]);
      if (s.viewUp) cam.setViewUp(s.viewUp[0], s.viewUp[1], s.viewUp[2]);
      if (typeof s.parallelScale === "number" && s.parallelScale > 0) cam.setParallelScale(s.parallelScale);
      if (typeof s.center === "number" || typeof s.width === "number") {
        applyWL(s.center ?? center, s.width ?? width);
      }
      try {
        renderer.resetCameraClippingRange();
      } catch {
        /* ignore */
      }
      applyCinematic();
      render();
      notifyState();
    },
    applyOrientation(azimuth, elevation, roll) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cam: Any = renderer.getActiveCamera();
      const p = initialCamera.position;
      const f = initialCamera.focalPoint;
      const u = initialCamera.viewUp;
      cam.setPosition(p[0], p[1], p[2]);
      cam.setFocalPoint(f[0], f[1], f[2]);
      cam.setViewUp(u[0], u[1], u[2]);
      if (azimuth) cam.azimuth(azimuth);
      if (elevation) cam.elevation(elevation);
      if (roll) cam.roll(roll);
      try {
        cam.orthogonalizeViewUp();
        renderer.resetCameraClippingRange();
      } catch {
        /* ignore */
      }
      render();
      notifyState();
    },
    onStateChanged(cb) {
      stateListeners.add(cb);
      return () => {
        stateListeners.delete(cb);
      };
    },
    setCinematic(params) {
      cinematic = { ...cinematic, ...params };
      applyCinematic();
      render();
    },
    getCinematic() {
      return { ...cinematic };
    },
    setRotateMode(m) {
      applyRotateMode(m);
    },
    getRotateMode() {
      return rotateMode;
    },
    setAxesEnabled(on) {
      try {
        axesWidget?.setEnabled(on);
        if (on) axesWidget?.updateMarkerOrientation?.();
        render();
      } catch {
        /* ignore */
      }
    },
    getLut256() {
      const out = new Uint8Array(256 * 4);
      const [lo, hi] = range;
      const rgb: number[] = [0, 0, 0];
      for (let i = 0; i < 256; i++) {
        const v = lo + ((hi - lo) * i) / 255;
        try {
          ctf.getColor(v, rgb);
        } catch {
          rgb[0] = rgb[1] = rgb[2] = i / 255;
        }
        let a = 0;
        try {
          a = (otf as Any).getValue(v);
        } catch {
          a = i / 255;
        }
        out[i * 4] = Math.max(0, Math.min(255, Math.round(rgb[0] * 255)));
        out[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(rgb[1] * 255)));
        out[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(rgb[2] * 255)));
        out[i * 4 + 3] = Math.max(0, Math.min(255, Math.round((Number.isFinite(a) ? a : 0) * 255)));
      }
      return out;
    },
    destroy() {
      try {
        axesWidget?.setEnabled(false);
        axesWidget?.delete?.();
      } catch {
        /* ignore */
      }
      try {
        ortho.destroy();
      } catch {
        /* ignore */
      }
      try {
        clipSub?.unsubscribe?.();
      } catch {
        /* ignore */
      }
      try {
        widgetManager.delete?.();
      } catch {
        /* ignore */
      }
      try {
        grw.delete();
      } catch {
        /* ignore */
      }
      void clipViewWidget;
    },
  };
}
