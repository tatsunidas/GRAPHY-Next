/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Cornerstone の計測 ROI に GRAPHY の統計を表示させるための繋ぎ（`fw/roi-stats-design.md` §5.3）。
 *
 * <p>各ツールは描画のたびに `this.configuration.getTextLines(data, targetId)` を呼ぶ。
 * ここをまとめて差し替えることで、**10 種のツール全部が同じ統計・同じ整形**で表示される。
 * ツールごとの `defaultGetTextLines` に任せると、矩形だけ詳しく・ポリゴンは面積だけ・
 * ポリゴンラインは何も出ない、という現状に戻る。
 *
 * <p>⚠ **設定はツール登録時にしか渡せない**（`roiContourTools.ts` に既述:
 * Cornerstone は 2 度目の `addTool` を警告して無視する）。`Viewer2D.wireTools()` の
 * `tg.addTool(name, measureToolConfig(name))` が唯一の適用点。
 */
import { eventTarget } from "@cornerstonejs/core";
import { annotation as csAnnotation, Enums as csToolsEnums } from "@cornerstonejs/tools";
import { tOutsideReact } from "../i18n/i18n";
import { contourToolConfig, renderAnnotations } from "./roiContourTools";
import { getRoiStatsDisplay, subscribeRoiStatsDisplay } from "./roiStatsDisplay";
import { getRoiStatsByData, scheduleRoiStatsSweep } from "./roiStatsStore";
import { pickSampleKind, type RoiStatsResult } from "./roiStats";
import { roiStatsTextLines } from "./roiStatsText";

/**
 * ROI 脇に出す行。**描画ループから毎フレーム呼ばれる**ので、ここでは計算しない。
 *
 * <p>キャッシュを外したときは掃除を予約して空を返す（次のフレームで出る）。掃除は結果が
 * 出せなかった場合も `warnings` 付きで必ず書き込むので、「毎フレーム外して毎フレーム予約する」
 * ループにはならない。
 */
export function graphyGetTextLines(data: unknown): string[] {
  const display = getRoiStatsDisplay();
  // `corner`（右下一覧）では ROI 脇に出さない。`off` も同じ。
  if (display.placement !== "beside") return [];
  const stats = getRoiStatsByData(data);
  if (!stats) {
    scheduleRoiStatsSweep();
    return [];
  }
  if (!canPlaceTextBox(data, stats)) return [];
  return roiStatsTextLines(stats, display.detail, tOutsideReact);
}

/**
 * **いまの `data` に textBox を置けるか。** 純関数。
 *
 * <p>🚨 上流の `_renderStats` は「`getTextLines` が空でない」ときだけ textBox の位置計算へ進み、
 * そこで `data.contour.polyline` の**先頭 2 点**を使う（`getTextBoxCoordsCanvas`）。
 * 輪郭を描いている最中は polyline が**空や 1 点になる瞬間**があり、そこへ行を返すと
 * `Cannot read properties of undefined (reading '1')` で落ちる（実機で踏んだ・2026-08-27）。
 *
 * <p>上流の既定実装は「統計がまだ無いので空を返す」ことで**偶然**これを避けていた。
 * こちらは**キャッシュから返す**（`data` の中身は描画のたびに変わるのにキャッシュは残る）ので、
 * **描画時点の頂点数を必ず見る**必要がある。
 *
 * <p>プローブ（1 点）は別経路（`drawTextBox` をハンドル位置に描く）なので 1 点で足りる。
 */
export function canPlaceTextBox(data: unknown, stats: RoiStatsResult): boolean {
  const d = data as
    | { contour?: { polyline?: unknown[] }; handles?: { points?: unknown[] } }
    | null
    | undefined;
  const n = d?.contour?.polyline?.length ?? d?.handles?.points?.length ?? 0;
  return stats.geometry.kind === "point" ? n >= 1 : n >= 2;
}

/**
 * この統計エンジンが値を出せるツールか。純関数。
 *
 * <p>🔴 **出せないツールの `getTextLines` は差し替えない。** Angle や Bidirectional は
 * 統計エンジンの対象外（折れ線・交差する 2 線分に画素統計の意味が無い）なので、
 * 差し替えると**角度や L/W のラベルごと消える**——改善のつもりで既存の計測を壊す。
 * 表示の ON/OFF は `textBoxVisibility` 側で効くので、そちらは全ツール共通に掛かる。
 */
export function isMeasurableTool(toolName: string): boolean {
  return pickSampleKind(toolName, undefined) !== "none";
}

/**
 * ツールを ToolGroup へ登録するときの設定。**輪郭系の既存設定に統計表示を足したもの。**
 * 純関数（`getTextLines` は同一の関数参照を返す）。
 */
export function measureToolConfig(toolName: string): Record<string, unknown> {
  const base = contourToolConfig(toolName);
  return isMeasurableTool(toolName) ? { ...base, getTextLines: graphyGetTextLines } : base;
}

/**
 * 「どの ROI に統計を出すか」を注釈スタイルへ反映する。
 *
 * <p>`getTextLines` には annotationUID が渡ってこない（§4.6）ので、**どの ROI に出すかは
 * `textBoxVisibility` で決める**。Cornerstone の各ツールは `_renderStats` の冒頭で
 * `options.visibility` を見るため、これを落とせば textBox ごと消える。
 *
 * <p>既定スタイル（全体）と注釈ごとのスタイルの両方を張る。既定だけだと、選択中のみ表示の
 * 切り替えが効かない。注釈ごとだけだと、これから描く ROI が一瞬だけ表示されてしまう。
 */
export function applyTextBoxVisibility(): void {
  const { placement, selectedOnly } = getRoiStatsDisplay();
  const on = placement === "beside";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = csAnnotation.config.style as any;
    cfg.setDefaultToolStyles?.({ ...(cfg.getDefaultToolStyles?.() ?? {}), textBoxVisibility: on });
  } catch {
    /* 既定のまま */
  }

  let selected = new Set<string>();
  if (on && selectedOnly) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      selected = new Set((csAnnotation.selection as any).getAnnotationsSelected?.() ?? []);
    } catch {
      /* 選択が取れないなら「消さない」側へ倒す（黙って消えるより良い） */
      selectedOnlyFallback(on);
      return;
    }
  }
  for (const uid of allAnnotationUids()) {
    const visible = on && (!selectedOnly || selected.has(uid));
    setTextBoxVisible(uid, visible);
  }
}

function selectedOnlyFallback(on: boolean): void {
  for (const uid of allAnnotationUids()) setTextBoxVisible(uid, on);
}

function setTextBoxVisible(uid: string, visible: boolean): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (csAnnotation.config.style as any).setAnnotationStyles(uid, { textBoxVisibility: visible });
  } catch {
    /* 消えた ROI は無視 */
  }
}

function allAnnotationUids(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = (csAnnotation.state as any).getAllAnnotations?.() ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (all as any[]).map((a) => a?.annotationUID).filter((v): v is string => !!v);
  } catch {
    return [];
  }
}

let watching = false;

/**
 * 表示モード・選択・ROI 追加に追従して {@link applyTextBoxVisibility} を掛け直す。
 * アプリ（2D Viewer 画面）から 1 度だけ呼ぶ。
 */
export function installRoiStatsDisplayWatcher(): () => void {
  if (watching) return () => undefined;
  watching = true;
  const apply = () => {
    applyTextBoxVisibility();
    renderAnnotations();
  };
  const offDisplay = subscribeRoiStatsDisplay(apply);
  const E = csToolsEnums.Events;
  eventTarget.addEventListener(E.ANNOTATION_SELECTION_CHANGE, apply);
  eventTarget.addEventListener(E.ANNOTATION_ADDED, apply);
  apply();
  return () => {
    offDisplay();
    eventTarget.removeEventListener(E.ANNOTATION_SELECTION_CHANGE, apply);
    eventTarget.removeEventListener(E.ANNOTATION_ADDED, apply);
    watching = false;
  };
}
