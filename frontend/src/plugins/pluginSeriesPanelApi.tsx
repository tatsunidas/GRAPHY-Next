/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * **H34 — シリーズビューパネルの貸し出し（フュージョン込み）**。
 *
 * `SeriesViewer` を**そのまま**プラグインの DOM へ差し込む。H31（Cornerstone のビューポートを
 * 素で貸す）との違いは、**本体の画面が丸ごと付いてくる**こと——W/L バー・スライダ・
 * ThickSlab・参照線・計測・シネ・そして**フュージョン重畳**。
 *
 * <h3>🔴 `createRoot` で独立したルートを立ててはいけない</h3>
 *
 * 最初はプラグインの要素に `createRoot()` して `<SeriesViewer/>` を描いた。**動かない**:
 *
 * ```
 * Uncaught Error: useI18n must be used within I18nProvider
 *     at SeriesViewer (SeriesViewer.tsx:153)
 * ```
 *
 * 独立したルートは本体のプロバイダの**外**にあるので、`SeriesViewer` とその子が使っている
 * context（i18n・設定・LUT プリセット …）が 1 つも引けない。必要なプロバイダを数え上げて
 * 並べ直す手もあるが、**子が増えるたびに壊れる**（そして壊れ方は「画面が出ない」だけで、
 * 何が足りないかは実行するまで分からない）。
 *
 * そこで**本体のツリーの中から `createPortal` で差し込む**。ポータルは DOM の行き先だけを
 * 変えて **React の文脈はツリー上の位置から引く**ので、プロバイダは全部そのまま効く。
 *
 * 使い方: 本体側は `<PluginSeriesPanels />` を**プロバイダの内側**に 1 つ置く
 * （`Viewer2DScreen` の JSX 直下）。プラグインからは `mountSeriesPanel()` を呼ぶだけ。
 *
 * <h3>🔴 実シリーズしか出せない</h3>
 *
 * `SeriesViewer` は `instances`（保管庫の実体）を受け取る作りなので、**保管庫にあるシリーズ**
 * しか出せない。プラグインが計算した値ボリューム（差分など）はここには載らない。
 * そちらは H31（合成ローダのビューポート）を使う。
 */
import { Component, createElement, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fetchInstances } from "../api";
import type { ViewerMode } from "../viewer/imageId";
import { SeriesViewer } from "../viewer/SeriesViewer";
import { FusionImageViewer } from "../viewer/FusionOverlayViewer";
import { registrationToTransform, type RegistrationResult } from "../viewer/regResult";
import type { PluginSeriesRef } from "./pluginTypes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface PluginSeriesPanelOptions {
  /** 重ねるシリーズ（省略でフュージョンなし）。 */
  fusion?: {
    series: PluginSeriesRef;
    /** `registerVolumes`（H21）が返した `transform`。省略すると幾何だけで重ねる。 */
    transform?: unknown;
    /** 重ねる側の不透明度（0〜1・既定 0.5）。 */
    opacity?: number;
    /** 重ねる側の LUT 名（本体の LUT 名。既定 `Hot_Iron`）。 */
    lut?: string | null;
  };
  /** 画像下の操作パネルを出すか（既定 true）。 */
  showControls?: boolean;
}

export interface PluginSeriesPanelHandle {
  destroy(): void;
}

interface PanelRequest {
  id: number;
  el: HTMLElement;
  mode: ViewerMode;
  instances: Any[];
  studyUid: string;
  seriesUid: string;
  showControls: boolean;
  fusion: {
    instances: Any[];
    studyUid: string;
    seriesUid: string;
    c: number;
    t: number;
    lut: string | null;
    opacity: number;
    transform: Any;
  } | null;
}

// ── 貸し出し中のパネル（本体のツリーが購読する） ─────────────────────────────
let panels: PanelRequest[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): PanelRequest[] {
  return panels;
}

/**
 * シリーズビューパネルを貸す（H34）。
 *
 * @param el プラグインが用意した器。**この要素の中身は host が管理する**
 *   （ポータルの行き先になるので、プラグイン側から子要素を触らない）。
 */
export async function mountSeriesPanel(
  el: HTMLElement,
  mode: ViewerMode,
  resolveStudy: (ref: PluginSeriesRef) => string | null,
  base: PluginSeriesRef,
  opts: PluginSeriesPanelOptions = {},
): Promise<PluginSeriesPanelHandle | null> {
  const baseStudy = resolveStudy(base);
  if (!baseStudy) return null;
  const instances = await fetchInstances(baseStudy, base.seriesUid);
  if (!instances.length) return null;

  let fusion: PanelRequest["fusion"] = null;
  if (opts.fusion) {
    const fusionStudy = resolveStudy(opts.fusion.series);
    if (fusionStudy) {
      const fusionInstances = await fetchInstances(fusionStudy, opts.fusion.series.seriesUid);
      if (fusionInstances.length) {
        fusion = {
          instances: fusionInstances,
          studyUid: fusionStudy,
          seriesUid: opts.fusion.series.seriesUid,
          c: opts.fusion.series.c ?? 0,
          t: opts.fusion.series.t ?? 0,
          lut: opts.fusion.lut === undefined ? "Hot_Iron" : opts.fusion.lut,
          opacity: opts.fusion.opacity ?? 0.5,
          // 位置合わせの結果は**本体の型へ戻してから**渡す。プラグインには `transform` を
          // 「中身を見ない値」として渡してあるので、ここで戻すのが唯一の正しい経路。
          transform: registrationToTransform(
            (opts.fusion.transform as RegistrationResult | null) ?? null,
          ),
        };
      }
    }
  }

  seq += 1;
  const id = seq;
  panels = [
    ...panels,
    {
      id,
      el,
      mode,
      instances,
      studyUid: baseStudy,
      seriesUid: base.seriesUid,
      showControls: opts.showControls !== false,
      fusion,
    },
  ];
  emit();

  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      panels = panels.filter((p) => p.id !== id);
      emit();
    },
  };
}

/** 貸し出し中のパネルを全部落とす（ビューアを離れるときに本体から呼ぶ）。 */
export function closeAllSeriesPanels(): void {
  if (panels.length === 0) return;
  panels = [];
  emit();
}

/**
 * 1 枚が壊れても他を巻き込まないための境界。**理由をその場に出す**
 * ——黒いままだと原因を追う材料が 1 つも残らない（H31 で同じ目に遭った）。
 */
class PanelBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[plugin-series-panel] render failed", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            color: "#ff8a80",
            font: '11px/1.5 system-ui, "Segoe UI", sans-serif',
            textAlign: "center",
            whiteSpace: "pre-wrap",
            overflow: "auto",
          }}
        >
          {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * 貸し出し中のシリーズビューパネルを描く。
 *
 * 🔴 **本体のプロバイダの内側に置くこと。** ここがツリー上のどこにあるかで、
 * `SeriesViewer` が引ける context が決まる（DOM 上の位置ではない）。
 */
export function PluginSeriesPanels(): ReactNode {
  const requests = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <>
      {requests.map((req) =>
        createPortal(
          <PanelBoundary key={req.id}>
            {createElement(SeriesViewer as Any, {
              instances: req.instances,
              mode: req.mode,
              studyUid: req.studyUid,
              seriesUid: req.seriesUid,
              fillHeight: true,
              showControls: req.showControls,
              renderFusionOverlay: req.fusion
                ? (ctx: Any) =>
                    createElement(FusionImageViewer as Any, {
                      rect: ctx.rect,
                      baseImageId: ctx.imageId,
                      baseIndex: ctx.index,
                      baseCount: ctx.count,
                      viewportId: ctx.viewportId,
                      instances: req.fusion!.instances,
                      mode: req.mode,
                      studyUid: req.fusion!.studyUid,
                      seriesUid: req.fusion!.seriesUid,
                      overlayC: req.fusion!.c,
                      overlayT: req.fusion!.t,
                      lut: req.fusion!.lut,
                      opacity: req.fusion!.opacity,
                      windowCenter: null,
                      windowWidth: null,
                      registration: req.fusion!.transform,
                    })
                : undefined,
            })}
          </PanelBoundary>,
          req.el,
          String(req.id),
        ),
      )}
    </>
  );
}
