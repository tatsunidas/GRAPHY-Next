/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 2D ビューア窓でアシスタントの表示操作を実行する薄い実行器。
// main が中継してきた命令を**もう一度検証**してから、既存の ViewerCommands / SeriesCommands を呼ぶ
// （送信側の検証は信用しない）。registry に載っていない操作は実行できない。
import type { ViewerCommands, ViewerTargetInfo, ViewerViewState } from "../viewer/viewerCommands";
import type { SeriesCommands } from "../viewer/seriesCommands";
import {
  DISPLAY_TOOLS,
  GET_STATE_TOOL,
  projectState,
  validateAction,
  type ActionResult,
  type DisplayTool,
  type InverseStep,
  type RawViewerState,
} from "../assistant/actions/registry";

export interface WlPresetLite {
  key: string;
  label: string;
  center: number;
  width: number;
}

export interface BridgeDeps {
  /** 命令の対象タイル（選択があれば選択、無ければ全タイル）。 */
  targets(): string[];
  allTiles(): string[];
  readInfo(id: string): ViewerTargetInfo | null;
  readView(id: string): ViewerViewState | null;
  run(ids: string[], fn: (c: ViewerCommands) => void): void;
  runSeries(ids: string[], fn: (c: SeriesCommands) => void): void;
  activeTool(): string;
  layoutCols(): number;
  setTool(toolId: string): void;
  setLayoutCols(n: number): void;
  presets(): WlPresetLite[];
  /** 表示系ツールのシンボル名 → 実ツール ID。 */
  toolId(sym: DisplayTool): string;
}

export interface BridgeCommand {
  kind: "action" | "getState";
  id?: string;
  params?: unknown;
  /** ローカル宛のときだけ true（seriesLabel を含める）。 */
  includeLabels?: boolean;
}

/** タイル群の現在状態（識別子を含み得る生の値）。必ず projectState を通してから外へ出す。 */
export function collectRawState(deps: BridgeDeps): RawViewerState {
  const tiles = deps.allTiles().map((id) => {
    const info = deps.readInfo(id);
    const view = deps.readView(id);
    return {
      modality: info?.modality,
      sliceIndex: info?.sliceIndex,
      sliceCount: info?.sliceCount,
      seriesLabel: info?.seriesLabel,
      windowCenter: view?.windowCenter,
      windowWidth: view?.windowWidth,
      unit: view?.unit,
      colormap: view?.colormap,
      invert: view?.invert,
      flipH: view?.flipH,
      flipV: view?.flipV,
      rotation: view?.rotation,
      zoom: view?.zoom,
    };
  });
  return { tiles, activeTool: deps.activeTool(), layoutCols: deps.layoutCols() };
}

/** 実際のツール ID → 表示系シンボル（逆引き）。許可リスト外の現在ツールは undefined＝元に戻せない。 */
function symbolOfTool(deps: BridgeDeps, toolId: string): DisplayTool | undefined {
  return DISPLAY_TOOLS.find((s) => deps.toolId(s) === toolId);
}

export function executeCommand(deps: BridgeDeps, cmd: BridgeCommand): ActionResult {
  if (cmd.kind === "getState") {
    return { ok: true, state: projectState(collectRawState(deps), { includeLabels: cmd.includeLabels === true }) };
  }
  if (cmd.id === GET_STATE_TOOL) return { ok: false, error: "unknown-action" };
  const v = validateAction(cmd.id, cmd.params);
  if (!v.ok) return v;
  const targets = deps.targets();
  if (targets.length === 0) return { ok: false, error: "no-tile" };
  const first = targets[0];
  const view = deps.readView(first);
  const info = deps.readInfo(first);
  const p = v.params;
  const inverse: InverseStep[] = [];

  switch (cmd.id) {
    case "setWindowLevel":
    case "resetWindow":
    case "applyWlPreset": {
      let c: number;
      let w: number;
      if (cmd.id === "applyWlPreset") {
        const q = String(p.name).trim().toLowerCase();
        const hit = deps.presets().find((x) => x.key.toLowerCase() === q || x.label.trim().toLowerCase() === q);
        if (!hit) return { ok: false, error: "unknown-preset" };
        c = hit.center;
        w = hit.width;
      } else {
        c = p.center as number;
        w = p.width as number;
      }
      if (view) inverse.push({ id: "setWindowLevel", params: { center: view.windowCenter, width: Math.max(1, view.windowWidth) } });
      if (cmd.id === "resetWindow") deps.run(targets, (x) => x.resetWindow());
      else deps.run(targets, (x) => x.setWindowLevel(c, w));
      break;
    }
    case "rotate90": {
      const n = (p.times as number | undefined) ?? 1;
      deps.run(targets, (x) => {
        for (let i = 0; i < n; i++) x.rotate90();
      });
      inverse.push({ id: "rotate90", params: { times: 4 - n } });
      break;
    }
    case "flipH":
      deps.run(targets, (x) => x.flipH());
      inverse.push({ id: "flipH", params: {} });
      break;
    case "flipV":
      deps.run(targets, (x) => x.flipV());
      inverse.push({ id: "flipV", params: {} });
      break;
    case "invert":
      deps.run(targets, (x) => x.invert());
      inverse.push({ id: "invert", params: {} });
      break;
    case "goToSlice": {
      const idx = p.index as number;
      if (info && Number.isInteger(info.sliceIndex)) inverse.push({ id: "goToSlice", params: { index: info.sliceIndex } });
      deps.runSeries(targets, (x) => x.goTo({ z: idx }));
      break;
    }
    case "setLayout": {
      inverse.push({ id: "setLayout", params: { cols: Math.min(8, Math.max(1, deps.layoutCols())) } });
      deps.setLayoutCols(p.cols as number);
      break;
    }
    case "setTool": {
      const prev = symbolOfTool(deps, deps.activeTool());
      if (prev) inverse.push({ id: "setTool", params: { tool: prev } });
      deps.setTool(deps.toolId(p.tool as DisplayTool));
      break;
    }
    default:
      return { ok: false, error: "unknown-action" };
  }
  return { ok: true, inverse: inverse.length ? inverse : undefined };
}
