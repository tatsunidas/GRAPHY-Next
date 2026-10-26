/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 2D ビューア窓でアシスタントの表示操作を実行する薄い実行器。
// main が中継してきた命令を**もう一度検証**してから、既存の ViewerCommands / SeriesCommands を呼ぶ
// （送信側の検証は信用しない）。registry に載っていない操作は実行できない。
import type { ViewerCommands, ViewerTargetInfo, ViewerViewState } from "../viewer/viewerCommands";
import type { CreateRoiRequest } from "../viewer/roiCreate";
import type { SeriesCommands } from "../viewer/seriesCommands";
import {
  DISPLAY_TOOLS,
  GET_STATE_TOOL,
  isWriteAction,
  projectRois,
  projectState,
  validateAction,
  type ActionResult,
  type DisplayTool,
  type InverseStep,
  type RawRoi,
  type RawViewerState,
} from "../assistant/actions/registry";

export interface WlPresetLite {
  key: string;
  label: string;
  center: number;
  width: number;
}

export interface CapturedImage {
  dataUrl: string;
  mimeType: "image/png" | "image/jpeg";
  w: number;
  h: number;
}

export interface BridgeDeps {
  /** 命令の対象タイル（選択があれば選択、無ければ全タイル）。 */
  targets(): string[];
  allTiles(): string[];
  readInfo(id: string): ViewerTargetInfo | null;
  readView(id: string): ViewerViewState | null;
  /** 全タイルの ROI（識別子・座標を含み得る生の値）。必ず projectRois を通してから外へ出す。 */
  readRois(): RawRoi[];
  /** タイルの表示画像（縮小済み）。ROI を重ねるか選べる。取れなければ null。 */
  captureTile(id: string, withRoi: boolean): Promise<CapturedImage | null>;
  run(ids: string[], fn: (c: ViewerCommands) => void): void;
  runSeries(ids: string[], fn: (c: SeriesCommands) => void): void;
  activeTool(): string;
  layoutCols(): number;
  setTool(toolId: string): void;
  setLayoutCols(n: number): void;
  presets(): WlPresetLite[];
  /** 表示系ツールのシンボル名 → 実ツール ID。 */
  toolId(sym: DisplayTool): string;
  /** 表示中のスライスへ ROI を作る（出自の印は呼び出し側＝アシスタントとして付く）。 */
  createRoi(id: string, req: CreateRoiRequest): ReturnType<ViewerCommands["createRoi"]> | null;
  /** アシスタントが作った ROI だけを消す。 */
  removeAssistantRoi(roiUid: string): boolean;
}

export interface BridgeCommand {
  kind: "action" | "getState" | "getMeasurements" | "captureView";
  id?: string;
  params?: unknown;
  /** ローカル宛のときだけ true（seriesLabel を含める）。 */
  includeLabels?: boolean;
  /** captureView: ROI の線と計測文字を重ねるか。 */
  withRoi?: boolean;
  /** main が利用者の承認を取ったあとにだけ付ける。データを変える操作はこれが無いと実行しない。 */
  approved?: boolean;
  /** main が確認の前に付ける。検証（引数・対象）だけして何も実行しない。write 操作にだけ使える。 */
  dryRun?: boolean;
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

/**
 * 表示中のタイルの画像を取る（読み取りだけ。表示状態・ROI・ファイルは変えない）。利用者のボタンからだけ呼ばれる＝モデルのツールではない。
 * 対象は選択中の先頭タイル（無ければ先頭）。
 */
export async function executeCaptureView(deps: BridgeDeps, cmd: BridgeCommand): Promise<ActionResult> {
  const id = deps.targets()[0] ?? deps.allTiles()[0];
  if (!id) return { ok: false, error: "no-tile" };
  const image = await deps.captureTile(id, cmd.withRoi === true).catch(() => null);
  if (!image) return { ok: false, error: "capture-failed" };
  return { ok: true, image };
}

export function executeCommand(deps: BridgeDeps, cmd: BridgeCommand): ActionResult {
  if (cmd.kind === "getState") {
    return { ok: true, state: projectState(collectRawState(deps), { includeLabels: cmd.includeLabels === true }) };
  }
  if (cmd.kind === "getMeasurements") {
    return { ok: true, measurements: projectRois(deps.readRois(), { includeLabels: cmd.includeLabels === true }) };
  }
  if (cmd.id === GET_STATE_TOOL) return { ok: false, error: "unknown-action" };
  const v = validateAction(cmd.id, cmd.params);
  if (!v.ok) return v;
  if (cmd.dryRun === true) {
    if (!isWriteAction(cmd.id)) return { ok: false, error: "bad-command" };
    return deps.targets().length === 0 ? { ok: false, error: "no-tile" } : { ok: true };
  }
  if (isWriteAction(cmd.id) && cmd.approved !== true) return { ok: false, error: "approval-required" };
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
    case "clearMeasurements":
      // 取り消せない（ROI/計測は 2D の undo の対象外）。inverse は返さない。
      deps.run(targets, (x) => x.clearAnnotations("measure"));
      break;
    case "createRoi": {
      const r = deps.createRoi(first, {
        tool: p.shape === "rectangle" ? "RectangleROI" : "EllipticalROI",
        centerView: [p.u as number, p.v as number],
        radiiMm: [p.radiusXmm as number, p.radiusYmm as number],
      });
      if (!r) return { ok: false, error: "no-tile" };
      if (!r.ok) return { ok: false, error: `roi-${r.reason}` };
      // 取り消しは「作った ROI だけ消す」。手描きの ROI には触れない。
      inverse.push({ id: "removeAssistantRoi", params: { roiUid: r.roiUid } });
      break;
    }
    case "createContourRoi": {
      const r = deps.createRoi(first, {
        tool: p.shape === "freehand" ? "FreehandROI" : "PolygonROI",
        verticesView: p.points as [number, number][],
      });
      if (!r) return { ok: false, error: "no-tile" };
      if (!r.ok) return { ok: false, error: `roi-${r.reason}` };
      inverse.push({ id: "removeAssistantRoi", params: { roiUid: r.roiUid } });
      break;
    }
    case "removeAssistantRoi":
      if (!deps.removeAssistantRoi(p.roiUid as string)) return { ok: false, error: "not-removable" };
      break;
    default:
      return { ok: false, error: "unknown-action" };
  }
  return { ok: true, inverse: inverse.length ? inverse : undefined };
}
