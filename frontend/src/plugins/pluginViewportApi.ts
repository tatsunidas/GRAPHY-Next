/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * **H31 — ビューポートの貸し出し** ／ **H32 — 3D 表示（MIP / MINIP / VR）**
 * （`fw/subtraction-design.md` §15.4）。
 *
 * プラグインが渡した DOM に**本体のビューポート**を立てる。W/L・パン/ズーム・スライス送り・
 * 座標の扱いは本体の実装がそのまま効く。
 *
 * <h3>なぜ host API にするのか</h3>
 *
 * `ui.js` は単一ファイルで配信され、**bare specifier を import できない**ので、
 * プラグインから cornerstone も vtk.js も呼べない（§15.7-1）。自前で同梱すれば動くように見えるが、
 * **本体と二重ロードになり、単一の共有 RenderingEngine という前提が壊れる**
 * （`CLAUDE.md` 絶対ルール 1・4）。だから「描画は貸す」形にする。
 *
 * <h3>🔴 このファイルはサブトラクションを知らない</h3>
 *
 * 受け取るのは「値ボリューム」と「表示の指定」だけである。特定の機能の語を本体へ持ち込まない
 * （§12.1）。
 */
import {
  Enums,
  RenderingEngine,
  getRenderingEngine,
  volumeLoader,
  metaData,
  utilities as csUtilities,
  type Types,
} from "@cornerstonejs/core";
import { ENGINE_ID, scheduleEngineResize } from "../viewer/Viewer2D";
import {
  ToolGroupManager,
  TrackballRotateTool,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  StackScrollTool,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { reapplyModeRendering, removeVolumeSafe } from "../viewer/volumeRender";
import { geomFromIndexToWorld } from "./pluginMeshApi";
import { createValueStack, releaseValueStack, autoWindow } from "./pluginVolumeScheme";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** プラグインが渡す値ボリューム（`PluginVolume` の部分集合）。 */
export interface PluginValueVolume {
  data: Float32Array;
  dims: [number, number, number];
  indexToWorld: number[];
  unit?: string;
}

export interface PluginViewportOptions {
  /** 表示窓。省略時は値域の 1〜99% から決める。 */
  window?: { center: number; width: number };
  /** 本体の LUT 名（例 `"Hot_Iron"`）。省略/null はグレースケール。 */
  colormap?: string | null;
  /** 最初に出すスライス。 */
  sliceIndex?: number;
}

export interface PluginViewportHandle {
  setSlice(index: number): void;
  getSlice(): number;
  setWindowLevel(center: number, width: number): void;
  destroy(): void;
}

export type PluginVolumeViewMode = "MIP" | "MINIP" | "VR";

export interface PluginVolumeViewHandle {
  setMode(mode: PluginVolumeViewMode): Promise<void>;
  destroy(): void;
}

/** 本体が LUT を cornerstone の colormap として登録するときの接頭辞（`Viewer2D` と同じ）。 */
const LUT_COLORMAP_PREFIX = "graphy-lut-";

/**
 * host が**必ず用意する**発散カラーマップの名前。差分のように「0 を挟んで正負に意味がある」
 * 値を出すためのもので、負＝青 / 0＝暗灰 / 正＝赤。
 *
 * 🔴 本体の LUT 名（`Hot_Iron` など）は**ユーザーが 1 度 LUT ダイアログで使うまで
 * cornerstone に登録されない**。プラグインがそれを当てにすると「指定したのに灰色のまま」
 * になる（実機で踏んだ）。だから発散色だけは host 側で先に登録しておく。
 */
export const PLUGIN_DIVERGENT_COLORMAP = "divergent";

let divergentRegistered = false;

function ensureDivergentColormap(): void {
  if (divergentRegistered) return;
  const api = (csUtilities as Any)?.colormap;
  if (!api?.registerColormap) return;
  divergentRegistered = true;
  if (api.getColormap?.(PLUGIN_DIVERGENT_COLORMAP)) return;
  // 0 を中心に対称。中心を暗くしておくと「変化なし」が背景に沈み、正負だけが立つ。
  api.registerColormap({
    ColorSpace: "RGB",
    Name: PLUGIN_DIVERGENT_COLORMAP,
    RGBPoints: [
      0.0, 0.13, 0.4, 1.0,
      0.25, 0.1, 0.2, 0.55,
      0.5, 0.08, 0.08, 0.08,
      0.75, 0.7, 0.18, 0.1,
      1.0, 1.0, 0.35, 0.15,
    ],
  });
}

/**
 * プラグインが渡した LUT 名を、実際に登録されている colormap 名へ解決する。
 *
 * 🔴 **未登録の名前を黙って渡さない。** cornerstone は知らない colormap 名を無視するので、
 * 「指定したのに灰色のまま」という、原因の分からない状態になる。ここで解決できなければ
 * **colormap を付けずに（グレースケールで）出し、コンソールに理由を残す**。
 *
 * <p>名前の解釈は `showOverlay`（H4a）と揃えてある: 本体の LUT ダイアログの名前
 * （例 `"Hot_Iron"`）を受け取り、`graphy-lut-<名前>` を探す。生の cornerstone colormap 名も
 * そのまま通す（`"hsv"` など）。**LUT はユーザーが 1 度使えば登録済みになる**が、
 * 一度も開いていないと未登録なので、必ずこの分岐を通す。
 */
function colormapProperty(name?: string | null): { colormap?: { name: string } } {
  if (!name) return {};
  ensureDivergentColormap();
  const registered = (csUtilities as Any)?.colormap?.getColormap;
  const prefixed = `${LUT_COLORMAP_PREFIX}${name}`;
  if (typeof registered === "function") {
    if (registered(prefixed)) return { colormap: { name: prefixed } };
    if (registered(name)) return { colormap: { name } };
    console.warn(
      `[plugin-viewport] colormap "${name}" is not registered; showing greyscale. ` +
        "Open the LUT dialog once, or pass a cornerstone colormap name.",
    );
    return {};
  }
  return { colormap: { name: prefixed } };
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;

/**
 * 本体の共有 RenderingEngine。**新しく作らない**——複数の RenderingEngine は
 * `CLAUDE.md` 絶対ルール 1・4 が避けている構成そのものである。
 */
function sharedEngine(): RenderingEngine | null {
  return (getRenderingEngine(ENGINE_ID) as RenderingEngine | undefined) ?? null;
}

/**
 * **H31** — 値ボリュームを 2D のスタックビューポートとして貸す。
 *
 * @param el 貸してもらう DOM（プラグインのウィンドウの中の要素）
 * @param volume 表示する値ボリューム
 * @param referenceImageIds 幾何とメタデータの委譲先。**z 昇順で、ボリュームの k と 1:1**。
 *   並びが違うと「もっともらしいが別スライスの絵」になるので、呼び出し側で必ず確かめること。
 */
export async function mountValueViewport(
  el: HTMLElement,
  pluginId: string,
  volume: PluginValueVolume,
  referenceImageIds: string[],
  opts: PluginViewportOptions = {},
): Promise<PluginViewportHandle | null> {
  const engine = sharedEngine();
  if (!engine) return null;

  const { token, imageIds } = createValueStack({
    pluginId,
    data: volume.data,
    dims: volume.dims,
    nativeIds: referenceImageIds,
    unit: volume.unit,
    window: opts.window ?? null,
  });

  const viewportId = nextId(`plugin-vp-${pluginId}`);
  const toolGroupId = nextId(`plugin-vp-tg-${pluginId}`);
  engine.enableElement({
    viewportId,
    type: Enums.ViewportType.STACK,
    element: el as HTMLDivElement,
    defaultOptions: { background: [0, 0, 0] as Types.Point3 },
  });
  const viewport = engine.getViewport(viewportId) as Any;
  const start = Math.min(imageIds.length - 1, Math.max(0, opts.sliceIndex ?? 0));
  await viewport.setStack(imageIds, start);
  const win = opts.window ?? autoWindow(volume.data);
  viewport.setProperties({
    voiRange: {
      lower: win.center - win.width / 2,
      upper: win.center + win.width / 2,
    },
    ...colormapProperty(opts.colormap),
  });
  attachTools(toolGroupId, viewportId, "2d");
  const stopResize = observeResize(el, engine);
  viewport.render();

  let destroyed = false;
  return {
    setSlice(index: number) {
      if (destroyed) return;
      viewport.setImageIdIndex?.(Math.min(imageIds.length - 1, Math.max(0, index)));
      viewport.render();
    },
    getSlice() {
      return destroyed ? -1 : (viewport.getCurrentImageIdIndex?.() ?? 0);
    },
    setWindowLevel(center: number, width: number) {
      if (destroyed) return;
      viewport.setProperties({
        voiRange: { lower: center - width / 2, upper: center + width / 2 },
      });
      viewport.render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      // 順番が大事: ビューポートを外してからスタックを捨てる。逆にすると
      // 描画中のスライスがキャッシュから消えて例外になる。
      stopResize();
      releaseTools(toolGroupId);
      try {
        engine.disableElement(viewportId);
      } catch {
        /* 既に外れていれば何もしない */
      }
      releaseValueStack(token);
    },
  };
}

/**
 * 🔴 **`setup3DViewport()` を共有エンジンに対して呼んではいけない。**
 *
 * あちらは `engine.setViewports([1 つだけ])` で始まる。3D ビューア画面のように
 * **専用のエンジン**を持つ側では正しいが、共有エンジンに対して呼ぶと
 * **他のビューポートが全部消える** — プラグインが直前に立てた 2D の面も、
 * **本体の 2D タイルも**。実機 1 回目で正確にこれを踏んだ（2D 3 面が黒く、MIP だけ残った）。
 *
 * そこでここでは `enableElement()` で**足す**。向き・投影・blend・slab の作法は
 * `setup3DViewport` と揃えてある（CORONAL / 平行投影 / モード別 TF は
 * `reapplyModeRendering` に委譲）。ツールは付けない——共有エンジンのツールグループを
 * 触るのは影響範囲が読めないため、まずは表示だけにする。
 */
async function mount3D(
  engine: RenderingEngine,
  el: HTMLDivElement,
  viewportId: string,
  volumeId: string,
  mode: PluginVolumeViewMode,
  preset: string | undefined,
  toolGroupId: string,
  centroid: [number, number, number] | null,
): Promise<void> {
  const isVr = mode === "VR";
  engine.enableElement({
    viewportId,
    type: isVr ? Enums.ViewportType.VOLUME_3D : Enums.ViewportType.ORTHOGRAPHIC,
    element: el,
    defaultOptions: {
      background: [0, 0, 0] as Types.Point3,
      orientation: Enums.OrientationAxis.CORONAL,
      // 平行投影に統一（`setup3DViewport` と同じ理由。perspective は world↔canvas がずれる）。
      parallelProjection: true,
    },
  });
  const vp = engine.getViewport(viewportId) as Any;
  await vp.setVolumes([{ volumeId }]);
  reapplyModeRendering(engine, viewportId, mode as Any, "OT", preset, volumeId);
  vp.resetCamera?.();
  // 🔴 回転の中心を**中身の重心**へ。箱の中心のままだと、隅に固まった差分が
  // 回すたびに画面の外へ振り回される。
  if (centroid) lookAt(vp, centroid);
  attachTools(toolGroupId, viewportId, "3d");
  engine.renderViewports([viewportId]);
}

const { MouseBindings } = csToolsEnums;

/**
 * 貸したビューポートにマウス操作を付ける。
 *
 * 🔴 **プラグイン専用のツールグループを作り、そのビューポートだけを入れる。**
 * 本体のツールグループへ足すと、本体のタイルの操作割り当てまで変わってしまう。
 * `setup3DViewport` を共有エンジンに対して呼んで他の面を消した件と同じ性質の事故になる。
 *
 * ⚠️ 前回 `setup3DViewport` を使うのをやめたとき、ここまで一緒に落としてしまい
 * **3D が回せなくなった**（実機で指摘を受けた）。表示だけ移して操作を忘れない。
 */
function attachTools(toolGroupId: string, viewportId: string, kind: "2d" | "3d"): void {
  try {
    if (ToolGroupManager.getToolGroup(toolGroupId)) {
      ToolGroupManager.destroyToolGroup(toolGroupId);
    }
    const tg = ToolGroupManager.createToolGroup(toolGroupId);
    if (!tg) return;
    tg.addTool(PanTool.toolName);
    tg.addTool(ZoomTool.toolName);
    tg.addTool(WindowLevelTool.toolName);
    if (kind === "3d") tg.addTool(TrackballRotateTool.toolName);
    else tg.addTool(StackScrollTool.toolName);
    tg.addViewport(viewportId, ENGINE_ID);

    // 割り当ては本体の 3D ビューアと揃える: 左=回転（2D はスライス送り）/ 中=Pan /
    // ホイール=Zoom（2D はスライス送り）/ 右=W/L。
    tg.setToolActive(kind === "3d" ? TrackballRotateTool.toolName : StackScrollTool.toolName, {
      bindings: [{ mouseButton: MouseBindings.Primary }],
    });
    tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
    tg.setToolActive(
      kind === "3d" ? ZoomTool.toolName : StackScrollTool.toolName,
      { bindings: [{ mouseButton: MouseBindings.Wheel }] },
    );
    tg.setToolActive(WindowLevelTool.toolName, {
      bindings: [{ mouseButton: MouseBindings.Secondary }],
    });
  } catch (e) {
    // 操作が付かなくても表示は続ける（**黙って落とさず**理由は残す）。
    console.warn(`[plugin-viewport] could not attach tools to ${viewportId}`, e);
  }
}

/**
 * 要素の大きさが変わったら**アスペクト比を作り直す**。
 *
 * 🔴 これが無いと、プラグインのウィンドウをリサイズしたときに canvas だけが引き伸ばされ、
 * **画像の縦横比が崩れる**（実機で指摘を受けた）。cornerstone は要素の変化を自分では見ない。
 *
 * ⚠️ 共有エンジンなので `engine.resize()` を直に叩かない。本体の `scheduleEngineResize()` は
 * rAF で 1 回に束ね、**resize の前に全ビューポートの相対 zoom を退避して復元する**。
 * 直に叩くと本体のタイルの表示倍率が resize のたびにずれる（`Viewer2D.tsx` の長い注記）。
 */
function observeResize(el: HTMLElement, engine: RenderingEngine): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(() => scheduleEngineResize(engine));
  observer.observe(el);
  return () => observer.disconnect();
}

/**
 * 値が入っているところの重心（患者 LPS mm）。**回転の中心**に使う。
 *
 * 🔴 ボリュームの箱の中心ではない。閾値後の差分は視野の隅に固まっていることが普通で、
 * 箱の中心を回転中心にすると**見たいものが画面の外へ振り回される**（実機で指摘を受けた）。
 */
function contentCentroid(
  data: Float32Array,
  dims: [number, number, number],
  indexToWorld: number[],
  background: number,
): [number, number, number] | null {
  const [nx, ny] = dims;
  const nxy = nx * ny;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === background) continue;
    const k = (i / nxy) | 0;
    const rem = i - k * nxy;
    const j = (rem / nx) | 0;
    sx += rem - j * nx;
    sy += j;
    sz += k;
    n++;
  }
  if (n === 0) return null;
  const i0 = sx / n;
  const j0 = sy / n;
  const k0 = sz / n;
  const m = indexToWorld;
  return [
    m[0] * i0 + m[1] * j0 + m[2] * k0 + m[3],
    m[4] * i0 + m[5] * j0 + m[6] * k0 + m[7],
    m[8] * i0 + m[9] * j0 + m[10] * k0 + m[11],
  ];
}

/**
 * カメラの注視点を動かす。**視線の向きと距離は保つ**（位置も同じだけずらす）。
 * 注視点だけ動かすと向きが変わってしまう。
 */
function lookAt(vp: Any, target: [number, number, number]): void {
  try {
    const cam = vp.getCamera();
    if (!cam?.focalPoint || !cam?.position) return;
    const d = [
      target[0] - cam.focalPoint[0],
      target[1] - cam.focalPoint[1],
      target[2] - cam.focalPoint[2],
    ];
    vp.setCamera({
      focalPoint: target,
      position: [cam.position[0] + d[0], cam.position[1] + d[1], cam.position[2] + d[2]],
    });
  } catch {
    /* カメラが未初期化なら何もしない */
  }
}

function releaseTools(toolGroupId: string): void {
  try {
    if (ToolGroupManager.getToolGroup(toolGroupId)) {
      ToolGroupManager.destroyToolGroup(toolGroupId);
    }
  } catch {
    /* 既に無ければ何もしない */
  }
}

/**
 * **H32** — 値ボリュームを 3D（MIP / MINIP / VR）で貸す。
 *
 * 🔴 **`NaN` は投影の前に潰す。** MIP はレイに沿った最大値なので、`NaN` が 1 つでも混じると
 * GPU 側の比較が未定義になり、**画面全体が壊れる**か「最大値が NaN の面」になる。
 * ここでは `background`（既定は有限値の最小）で埋める——最小で埋めれば MIP で勝つことはなく、
 * MINIP では逆に負けないよう最大で埋める。**どちらも「無い」を「勝たせない」ための選択**である。
 */
export async function mountVolumeView(
  el: HTMLElement,
  pluginId: string,
  volume: PluginValueVolume,
  opts: { mode?: PluginVolumeViewMode; background?: number; preset?: string } = {},
): Promise<PluginVolumeViewHandle | null> {
  const engine = sharedEngine();
  if (!engine) return null;
  const geom = geomFromIndexToWorld(volume.dims, volume.indexToWorld);
  if (!geom) return null;

  let mode: PluginVolumeViewMode = opts.mode ?? "MIP";

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < volume.data.length; i++) {
    const v = volume.data[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 0;
  }
  const fill = Number.isFinite(opts.background as number)
    ? (opts.background as number)
    : mode === "MINIP"
      ? max
      : min;
  const scalarData = new Float32Array(volume.data.length);
  for (let i = 0; i < volume.data.length; i++) {
    const v = volume.data[i];
    scalarData[i] = Number.isFinite(v) ? v : fill;
  }

  const volumeId = nextId(`pluginVolume:${pluginId}`);
  const viewportId = nextId(`plugin-3d-${pluginId}`);
  const toolGroupId = nextId(`plugin-3d-tg-${pluginId}`);

  (volumeLoader.createLocalVolume as Any)(volumeId, {
    metadata: {
      BitsAllocated: 32,
      BitsStored: 32,
      SamplesPerPixel: 1,
      HighBit: 31,
      PhotometricInterpretation: "MONOCHROME2",
      PixelRepresentation: 1,
      Modality: "OT",
      ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
      PixelSpacing: [geom.spacing[1], geom.spacing[0]],
      Columns: geom.dims[0],
      Rows: geom.dims[1],
      voiLut: [{ windowCenter: (max + min) / 2, windowWidth: Math.max(1, max - min) }],
    },
    dimensions: geom.dims,
    spacing: geom.spacing,
    origin: geom.origin,
    direction: geom.direction,
    scalarData,
  });

  const centroid = contentCentroid(scalarData, volume.dims, volume.indexToWorld, fill);
  await mount3D(engine, el as HTMLDivElement, viewportId, volumeId, mode, opts.preset, toolGroupId, centroid);
  const stopResize = observeResize(el, engine);

  let destroyed = false;
  return {
    async setMode(next: PluginVolumeViewMode) {
      if (destroyed) return;
      mode = next;
      await mount3D(engine, el as HTMLDivElement, viewportId, volumeId, mode, opts.preset, toolGroupId, centroid);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopResize();
      releaseTools(toolGroupId);
      try {
        engine.disableElement(viewportId);
      } catch {
        /* 既に外れていれば何もしない */
      }
      removeVolumeSafe(volumeId);
    },
  };
}

/** 診断用。メタデータが引けるかを見るだけ（プラグインからは使わない）。 */
export function hasImageMetadata(imageId: string): boolean {
  return Boolean(metaData.get("imagePlaneModule", imageId));
}
