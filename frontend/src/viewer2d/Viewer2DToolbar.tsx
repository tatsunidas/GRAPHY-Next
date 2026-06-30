/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useI18n } from "../i18n/i18n";
import { WL_PRESETS } from "./wlPresets";

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
  /** LUT 選択ダイアログを開く（適用は選択時に対象タイルへ）。 */
  openLut(): void;
  /** レイアウト列数（0=自動）。 */
  setLayoutCols(cols: number): void;
  toggleRefLines(): void;
  /** 対象タイルの Sync を一括 ON/OFF。 */
  setSyncTargets(on: boolean): void;
  /** 未実装機能の「近日対応」通知（メニュー用プレースホルダ）。 */
  comingSoon(name: string): void;
}

/** 2D Viewer 画面ツールバー。グループ分けしたアイコン行（対象=選択 or 全）。 */
export function Viewer2DToolbar({
  actions,
  layoutCols,
  refLines,
  selectedCount,
  targetCount,
}: {
  actions: ViewerActions;
  layoutCols: number;
  refLines: boolean;
  selectedCount: number;
  targetCount: number;
}) {
  const { t } = useI18n();
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
      {/* W/L プリセット（対象タイル） */}
      <select
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__default__") actions.resetWindow();
          else {
            const p = WL_PRESETS.find((x) => x.key === v);
            if (p) actions.setWindowLevel(p.center, p.width);
          }
          e.target.value = "";
        }}
        style={select}
        title={t("viewer2d.wl.preset")}
      >
        <option value="">{t("viewer2d.wl.preset")}</option>
        <option value="__default__">{t("viewer2d.wl.default")}</option>
        {WL_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>{t(p.labelKey)}</option>
        ))}
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
