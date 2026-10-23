/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 2D ビューア窓で main 中継のアシスタント命令を受けて実行する（実行器は assistantBridge.ts）。
import { useEffect, useRef } from "react";
import { desktop } from "../desktopBridge";
import { queryViewerCommand, runViewerCommand } from "../viewer/viewerCommands";
import { runSeriesCommand } from "../viewer/seriesCommands";
import { TOOL_IDS } from "../viewer/toolIds";
import type { DisplayTool } from "../assistant/actions/registry";
import { executeCommand, type BridgeDeps, type WlPresetLite } from "./assistantBridge";

const TOOL_BY_SYMBOL: Record<DisplayTool, string> = {
  windowLevel: TOOL_IDS.windowLevel,
  pan: TOOL_IDS.pan,
  zoom: TOOL_IDS.zoom,
  magnify: TOOL_IDS.magnify,
  length: TOOL_IDS.length,
  angle: TOOL_IDS.angle,
};

export interface AssistantBridgeInput {
  tileIds: string[];
  /** 命令の対象（選択タイル → 無ければ全タイル）。 */
  resolveTargets: () => string[];
  activeTool: string;
  layoutCols: number;
  setTool: (toolId: string) => void;
  setLayoutCols: (n: number) => void;
  presets: WlPresetLite[];
}

/** 最新の入力を ref で持ち、購読は 1 回だけ張る（命令のたびに外れて取りこぼさない）。 */
export function useAssistantBridge(input: AssistantBridgeInput): void {
  const ref = useRef(input);
  ref.current = input;
  useEffect(() => {
    const d = desktop();
    if (!d?.onViewerCmd || !d.viewerCmdResult) return;
    const deps: BridgeDeps = {
      targets: () => ref.current.resolveTargets(),
      allTiles: () => ref.current.tileIds,
      readInfo: (id) => queryViewerCommand(id, (c) => c.getTargetInfo()),
      readView: (id) => queryViewerCommand(id, (c) => c.getViewState()),
      run: (ids, fn) => runViewerCommand(ids, fn),
      runSeries: (ids, fn) => runSeriesCommand(ids, fn),
      activeTool: () => ref.current.activeTool,
      layoutCols: () => ref.current.layoutCols,
      setTool: (t) => ref.current.setTool(t),
      setLayoutCols: (n) => ref.current.setLayoutCols(n),
      presets: () => ref.current.presets,
      toolId: (s) => TOOL_BY_SYMBOL[s],
    };
    return d.onViewerCmd((cmd) => {
      let result;
      try {
        result = executeCommand(deps, { kind: cmd.kind, id: cmd.id, params: cmd.params, includeLabels: cmd.includeLabels, approved: cmd.approved === true });
      } catch (e) {
        result = { ok: false as const, error: `exec-failed:${e instanceof Error ? e.message.slice(0, 80) : "error"}` };
      }
      d.viewerCmdResult?.(cmd.reqId, result);
    });
  }, []);
}
