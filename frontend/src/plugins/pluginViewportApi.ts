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
import { ENGINE_ID } from "../viewer/Viewer2D";
import { setup3DViewport, removeVolumeSafe } from "../viewer/volumeRender";
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

  await setup3DViewport(engine, ENGINE_ID, el as HTMLDivElement, viewportId, volumeId, toolGroupId, {
    modality: "OT",
    mode,
    preset: opts.preset,
  });

  let destroyed = false;
  return {
    async setMode(next: PluginVolumeViewMode) {
      if (destroyed) return;
      mode = next;
      await setup3DViewport(
        engine,
        ENGINE_ID,
        el as HTMLDivElement,
        viewportId,
        volumeId,
        toolGroupId,
        { modality: "OT", mode, preset: opts.preset },
      );
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
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
