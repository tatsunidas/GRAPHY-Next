/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * `mouseBindings.ts` の割り当てを Cornerstone の ToolGroup へ適用する。
 *
 * <p>⚠️ `setToolActive` はバインドを「マージ」する（足すだけで外せない。`mpr.ts` の注記）。そのため、
 * 関わるツールは先に `removeAllBindings` で全部外してから、求めたバインドだけを付け直す。
 */
import { Enums as csToolsEnums, PanTool, WindowLevelTool, ZoomTool } from "@cornerstonejs/tools";
import { computeToolBindings, type AbstractButton, type MouseBindingTable } from "./mouseBindings";

const { MouseBindings } = csToolsEnums;

/** 2 本指タッチ（ピンチ拡大縮小＋平行移動）。ZoomTool に割り当てる。 */
const TOUCH_ZOOM_BINDING = { numTouchPoints: 2 } as const;

type Binding = { mouseButton: number } | { numTouchPoints: number };

function toBinding(b: AbstractButton): Binding {
  switch (b) {
    case "primary":
      return { mouseButton: MouseBindings.Primary };
    case "auxiliary":
      return { mouseButton: MouseBindings.Auxiliary };
    case "secondary":
      return { mouseButton: MouseBindings.Secondary };
    case "touch2":
      return TOUCH_ZOOM_BINDING;
  }
}

/** 呼び出しに必要な ToolGroup の面だけ（テストで偽物に差し替えられる）。 */
export interface BindingToolGroup {
  setToolPassive(name: string, opts?: { removeAllBindings?: boolean }): void;
  setToolActive(name: string, opts: { bindings: Binding[] }): void;
}

/**
 * @param tools 左ボタンに割り当て得るツールの全部（先に全バインドを外す対象）。W/L・Pan・Zoom は必ず含める。
 * @param primaryTool 左ボタンのツール（`tools` のどれか）。
 */
export function applyMouseBindings(
  tg: BindingToolGroup,
  tools: Iterable<string>,
  primaryTool: string,
  table: MouseBindingTable,
  opts: { touchZoom: boolean },
): void {
  const names = { windowLevel: WindowLevelTool.toolName, pan: PanTool.toolName, zoom: ZoomTool.toolName };
  const want = computeToolBindings(primaryTool, table, names, opts);
  const all = new Set<string>([...tools, names.windowLevel, names.pan, names.zoom]);
  for (const tn of all) tg.setToolPassive(tn, { removeAllBindings: true });
  for (const [tn, buttons] of Object.entries(want)) {
    tg.setToolActive(tn, { bindings: buttons.map(toBinding) });
  }
}
