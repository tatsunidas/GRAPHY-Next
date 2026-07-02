/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useI18n } from "../i18n/i18n";
import { presetLabel } from "./wlPresets";
import { useWlPresets } from "./wlPresetStore";
import { TOOL_IDS } from "../viewer/toolIds";
import { type SortMode } from "../viewer/seriesSort";

/** メニュー/ツールバー共通のアクション。対象は「選択タイル→無ければ全タイル」（TileGrid 側で解決）。 */
export interface ViewerActions {
  fit(): void;
  reset(): void;
  rotate90(): void;
  flipH(): void;
  flipV(): void;
  invert(): void;
  undo(): void;
  redo(): void;
  /** W/L プリセット適用。 */
  setWindowLevel(center: number, width: number): void;
  /** DICOM 既定ウィンドウに戻す。 */
  resetWindow(): void;
  /** W/L プリセット編集ダイアログを開く。 */
  editPresets(): void;
  /** Z 並べ替え（InstanceNumber / IPP, 昇順・降順）。対象タイルのシリーズに適用。 */
  sort(mode: SortMode): void;
  /** 左ドラッグの操作/計測/ブラシツールを切替（全タイルに適用＝グローバルなツールモード）。 */
  setTool(toolName: string): void;
  /** ROI ブラシ径(px)。 */
  setBrushSize(size: number): void;
  /** 2D Wand のトレランス（シード輝度からの許容差）。 */
  setWandTolerance(tol: number): void;
  /** 計測 ROI を全消去（対象タイル）。 */
  clearRois(): void;
  /** ROI マネージャ（右パネル）の表示切替。 */
  toggleRoiManager(): void;
  /** LUT 選択ダイアログを開く（適用は選択時に対象タイルへ）。 */
  openLut(): void;
  /** コントラスト調整（W/L）ダイアログを開く（対象=選択→無ければ先頭タイル）。 */
  openWindowLevel(): void;
  /** レイアウト列数（0=自動）。行は自動。 */
  setLayoutCols(cols: number): void;
  /** Row×Col レイアウト指定（各 0=自動）。任意レイアウト用。 */
  setLayoutGrid(rows: number, cols: number): void;
  toggleRefLines(): void;
  /** 対象タイルの Sync を一括 ON/OFF。 */
  setSyncTargets(on: boolean): void;
  /** 未実装機能の「近日対応」通知（メニュー用プレースホルダ）。 */
  comingSoon(name: string): void;
  /** 対象シリーズを ImageJ の HyperStack として開く（ローカル ImageJ 起動）。 */
  bridgeImageJ(): void;
  /** 対象タイルのシリーズで MPR ウィンドウを開く。 */
  launchMpr(): void;
  /** 対象タイルのシリーズで Slicer ウィンドウを開く。 */
  launchSlicer(): void;
  /** 対象タイルのシリーズで Curved MPR ウィンドウを開く。 */
  launchCurvedMpr(): void;
  /** 対象タイルのシリーズで Histogram 解析ダイアログを開く。 */
  openHistogram(): void;
  /** 対象タイル（PET のみ）で SUV 校正ダイアログを開く。 */
  openSuv(): void;
  /** 対象タイルのシリーズで Tag Viewer（DICOM 属性表示）を開く。 */
  openTagViewer(): void;
  /** 対象タイルのシリーズで Texture（Radiomics 可視化マップ）ダイアログを開く。 */
  openTexture(): void;
}

/** 2D Viewer 画面ツールバー。グループ分けしたアイコン行（対象=選択 or 全）。 */
export function Viewer2DToolbar({
  actions,
  layoutCols,
  refLines,
  activeTool,
  selectedCount,
  targetCount,
}: {
  actions: ViewerActions;
  layoutCols: number;
  refLines: boolean;
  activeTool: string;
  selectedCount: number;
  targetCount: number;
}) {
  const { t } = useI18n();
  const presets = useWlPresets();
  return (
    <div style={bar}>
      {/* レイアウト */}
      <select
        value={layoutCols}
        onChange={(e) => actions.setLayoutCols(Number(e.target.value))}
        style={select}
        title={t("viewer2d.layout")}
      >
        <option value={0}>{t("viewer2d.layout.auto")}</option>
        {[1, 2, 3, 4].map((c) => (
          <option key={c} value={c}>{c} {t("viewer2d.layout.cols")}</option>
        ))}
      </select>

      <Sep />
      {/* 同期 / 参照線（全体） */}
      <button onClick={() => actions.setSyncTargets(true)} style={btn} title={t("viewer2d.tb.syncOn")}>🔗 ON</button>
      <button onClick={() => actions.setSyncTargets(false)} style={btn} title={t("viewer2d.tb.syncOff")}>🔗 OFF</button>
      <button onClick={actions.toggleRefLines} style={{ ...btn, ...(refLines ? on : null) }} title={t("viewer2d.refLines.toggle")}>┼</button>

      <Sep />
      {/* 操作ツール（ラジオ・全タイルに適用） */}
      <button onClick={() => actions.setTool(TOOL_IDS.windowLevel)} style={{ ...btn, ...(activeTool === TOOL_IDS.windowLevel ? on : null) }} title={t("viewer.status.wl")}>W/L</button>
      <button onClick={() => actions.setTool(TOOL_IDS.pan)} style={{ ...btn, ...(activeTool === TOOL_IDS.pan ? on : null) }} title={t("viewer.pan")}>✋</button>
      <button onClick={() => actions.setTool(TOOL_IDS.zoom)} style={{ ...btn, ...(activeTool === TOOL_IDS.zoom ? on : null) }} title={t("viewer.zoomIn")}>🔍</button>
      {(activeTool === TOOL_IDS.brush || activeTool === TOOL_IDS.eraser) && (
        <label style={{ fontSize: 11, color: "#33404d", display: "inline-flex", alignItems: "center", gap: 3 }} title={t("viewer2d.tool.brushSize")}>
          🖌
          <input
            type="number"
            min={1}
            max={200}
            defaultValue={25}
            onChange={(e) => actions.setBrushSize(Number(e.target.value))}
            style={{ width: 52, ...select }}
          />
        </label>
      )}

      <Sep />
      {/* W/L プリセット（対象タイル） */}
      <select
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__default__") actions.resetWindow();
          else if (v === "__edit__") actions.editPresets();
          else {
            const p = presets.find((x) => x.key === v);
            if (p) actions.setWindowLevel(p.center, p.width);
          }
          e.target.value = "";
        }}
        style={select}
        title={t("viewer2d.wl.preset")}
      >
        <option value="">{t("viewer2d.wl.preset")}</option>
        <option value="__default__">{t("viewer2d.wl.default")}</option>
        {presets.map((p) => (
          <option key={p.key} value={p.key}>{presetLabel(p, t)}</option>
        ))}
        <option value="__edit__">{t("viewer2d.wl.edit")}</option>
      </select>

      {/* 画像調整（対象タイル） */}
      <button onClick={actions.invert} style={btn} title={t("viewer.invert")}>◐</button>
      <button onClick={actions.openLut} style={btn} title={t("viewer.lut")}>{t("viewer.lut")}</button>
      <button onClick={actions.rotate90} style={btn} title={t("viewer.rotate")}>⟳</button>
      <button onClick={actions.flipH} style={btn} title={t("viewer.flipH")}>⇄</button>
      <button onClick={actions.flipV} style={btn} title={t("viewer.flipV")}>⇅</button>

      <Sep />
      {/* 表示リセット / Undo-Redo（対象タイル） */}
      <button onClick={actions.fit} style={btn} title={t("viewer.fit")}>{t("viewer.fit")}</button>
      <button onClick={actions.reset} style={btn} title={t("viewer.reset")}>{t("viewer.reset")}</button>
      <button onClick={actions.undo} style={btn} title={t("viewer.undo")}>↶</button>
      <button onClick={actions.redo} style={btn} title={t("viewer.redo")}>↷</button>

      <span style={{ marginLeft: "auto", fontSize: 11, color: "#6b7785" }}>
        {selectedCount > 0
          ? t("viewer2d.tb.targetSelected", { n: selectedCount })
          : t("viewer2d.tb.targetAll", { n: targetCount })}
      </span>
    </div>
  );
}

function Sep() {
  return <span style={{ width: 1, alignSelf: "stretch", background: "#dde4ea", margin: "0 3px" }} />;
}

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexWrap: "nowrap",
  overflowX: "auto",
  padding: "5px 8px",
  background: "#f2f5f8",
  borderBottom: "1px solid #e1e7ee",
};
const btn: React.CSSProperties = {
  flexShrink: 0,
  minWidth: 30,
  padding: "3px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
const on: React.CSSProperties = { background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
const select: React.CSSProperties = {
  flexShrink: 0,
  padding: "3px 6px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  fontSize: 13,
};
