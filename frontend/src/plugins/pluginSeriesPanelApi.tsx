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
 * <h3>なぜ H31 では足りなかったか</h3>
 *
 * 実機で「ソースとターゲットを別々に出すより、**位置合わせのフュージョン結果**を見たい」
 * となった。フュージョンは本体に既にある機能（`FusionImageViewer` ＋ `registrationToTransform`）
 * なので、**それを作り直さずに借りる**のが正しい。プラグインは React を呼べないので、
 * host 側で React ルートを立てて差し込む。
 *
 * <h3>🔴 実シリーズしか出せない</h3>
 *
 * `SeriesViewer` は `instances`（保管庫の実体）を受け取る作りなので、**保管庫にあるシリーズ**
 * しか出せない。プラグインが計算した値ボリューム（差分など）はここには載らない。
 * そちらは H31（合成ローダのビューポート）を使う。
 */
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
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

/**
 * シリーズビューパネルを貸す（H34）。
 *
 * @param el プラグインが用意した器。**この要素の中身は host が管理する**
 *   （React ルートを張るので、プラグイン側から中身を触らない）。
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

  let fusionNode: Any = null;
  if (opts.fusion) {
    const fusionStudy = resolveStudy(opts.fusion.series);
    if (fusionStudy) {
      const fusionInstances = await fetchInstances(fusionStudy, opts.fusion.series.seriesUid);
      if (fusionInstances.length) {
        // 位置合わせの結果は**本体の型へ戻してから**渡す。プラグインには `transform` を
        // 「中身を見ない値」として渡してあるので、ここで元に戻すのが唯一の正しい経路。
        const transform = registrationToTransform(
          (opts.fusion.transform as RegistrationResult | null) ?? null,
        );
        const opacity = opts.fusion.opacity ?? 0.5;
        const lut = opts.fusion.lut === undefined ? "Hot_Iron" : opts.fusion.lut;
        fusionNode = (ctx: Any) =>
          createElement(FusionImageViewer as Any, {
            rect: ctx.rect,
            baseImageId: ctx.imageId,
            baseIndex: ctx.index,
            baseCount: ctx.count,
            viewportId: ctx.viewportId,
            instances: fusionInstances,
            mode,
            studyUid: fusionStudy,
            seriesUid: opts.fusion!.series.seriesUid,
            overlayC: opts.fusion!.series.c ?? 0,
            overlayT: opts.fusion!.series.t ?? 0,
            lut,
            opacity,
            windowCenter: null,
            windowWidth: null,
            registration: transform,
          });
      }
    }
  }

  const root: Root = createRoot(el);
  root.render(
    createElement(SeriesViewer as Any, {
      instances,
      mode,
      studyUid: baseStudy,
      seriesUid: base.seriesUid,
      fillHeight: true,
      showControls: opts.showControls !== false,
      renderFusionOverlay: fusionNode ?? undefined,
    }),
  );

  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      // React 18 の unmount は同期呼び出しを嫌うので、次のタスクで落とす
      // （render 中に unmount すると警告が出る）。
      setTimeout(() => {
        try {
          root.unmount();
        } catch (e) {
          console.error("[plugin-series-panel] unmount failed", e);
        }
      }, 0);
    },
  };
}
