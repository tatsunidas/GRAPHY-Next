/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useI18n } from "../i18n/i18n";
import { ToolIcon } from "../icons/ToolIcon";
import { UI_ICON_FILES } from "../icons/toolIcons";

export type ViewerKind = "2d" | "3d" | "mpr" | "slicer" | "qr";
export type ToolKind =
  | "export"
  | "send"
  | "nonDicomImport"
  | "anonymizer"
  | "tagExtractor"
  | "seriesExtractor"
  | "tagViewer"
  | "report"
  | "reportManager";

export function Toolbar({
  isStandalone,
  canImport,
  isDemo,
  onImport,
  onRefresh,
  onOpenDb,
  onOpenTool,
  onOpenViewer,
  onOpenSettings,
  onOpenHelp,
}: {
  isStandalone: boolean;
  canImport: boolean;
  /** 公開デモ（backendが該当APIを403にする）。Export/Anonymizer/SeriesExtractor/QRボタンを隠す。 */
  isDemo: boolean;
  onImport: () => void;
  onRefresh: () => void;
  onOpenDb: () => void;
  onOpenTool: (kind: ToolKind) => void;
  onOpenViewer: (kind: ViewerKind) => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
}) {
  const { t } = useI18n();
  return (
    <div style={bar}>
      {/* データ I/O・ユーティリティ */}
      {canImport && <ToolButton iconFile={UI_ICON_FILES.import} icon="📁" label={t("main.import.action")} onClick={onImport} />}
      {!isDemo && <ToolButton iconFile={UI_ICON_FILES.export} icon="📤" label={t("main.toolbar.export")} onClick={() => onOpenTool("export")} />}
      <ToolButton iconFile={UI_ICON_FILES.send} icon="📡" label={t("main.toolbar.send")} onClick={() => onOpenTool("send")} />
      <ToolButton iconFile={UI_ICON_FILES.nonDicomImport} icon="🎞" label={t("main.toolbar.nonDicomImport")} onClick={() => onOpenTool("nonDicomImport")} />
      {!isDemo && <ToolButton iconFile={UI_ICON_FILES.anonymizer} icon="🕶" label={t("main.toolbar.anonymizer")} onClick={() => onOpenTool("anonymizer")} />}
      <ToolButton iconFile={UI_ICON_FILES.tagExtractor} icon="🏷" label={t("main.toolbar.tagExtractor")} onClick={() => onOpenTool("tagExtractor")} />
      <ToolButton iconFile={UI_ICON_FILES.tagViewer} icon="🔖" label={t("main.toolbar.tagViewer")} onClick={() => onOpenTool("tagViewer")} />
      {!isDemo && <ToolButton iconFile={UI_ICON_FILES.seriesExtractor} icon="🧬" label={t("main.toolbar.seriesExtractor")} onClick={() => onOpenTool("seriesExtractor")} />}
      <ToolButton icon="📝" label={t("main.toolbar.report")} onClick={() => onOpenTool("report")} />
      <ToolButton icon="🗂" label={t("main.toolbar.reportManager")} onClick={() => onOpenTool("reportManager")} />
      <ToolButton iconFile={UI_ICON_FILES.refresh} icon="🔄" label={t("main.toolbar.refresh")} onClick={onRefresh} />
      {isStandalone && <ToolButton iconFile={UI_ICON_FILES.db} icon="🗄" label={t("app.btn.dbTitle")} onClick={onOpenDb} />}
      <span style={sep} />
      {/* ビューア */}
      {!isDemo && <ToolButton iconFile={UI_ICON_FILES.qr} icon="🔎" label={t("qr.title")} onClick={() => onOpenViewer("qr")} />}
      <ToolButton testId="viewer2d-toolbar-button" iconFile={UI_ICON_FILES.viewer2d} icon="🖼" label={t("main.toolbar.viewer2d")} onClick={() => onOpenViewer("2d")} />
      <ToolButton iconFile={UI_ICON_FILES.viewer3d} icon="🧊" label={t("main.toolbar.viewer3d")} onClick={() => onOpenViewer("3d")} />
      {/* MPR は適切なアイコンが無いためグリフ（十字）を維持 */}
      <ToolButton icon="➕" label={t("main.toolbar.mpr")} onClick={() => onOpenViewer("mpr")} />
      <ToolButton iconFile={UI_ICON_FILES.slicer} icon="🔪" label={t("main.toolbar.slicer")} onClick={() => onOpenViewer("slicer")} />
      <div style={{ flex: 1 }} />
      {/* ショートカット一覧は適切なアイコンが無いためグリフ（キーボード）を維持 */}
      <ToolButton icon="⌨" label={t("sc.title")} onClick={onOpenHelp} />
      <ToolButton iconFile={UI_ICON_FILES.settings} icon="⚙" label={t("app.btn.settingsTitle")} onClick={onOpenSettings} />
    </div>
  );
}

function ToolButton({
  icon,
  iconFile,
  label,
  onClick,
  testId,
}: {
  /** アイコン未整備ボタン用のフォールバック絵文字。 */
  icon: string;
  /** tools/ 配下の PNG ファイル名（指定時はこちらを優先表示）。 */
  iconFile?: string;
  label: string;
  onClick: () => void;
  /** E2E検証(automator)用の安定セレクタ。 */
  testId?: string;
}) {
  return (
    <button data-testid={testId} onClick={onClick} title={label} style={btn}>
      {iconFile ? <ToolIcon file={iconFile} size={16} /> : <span style={{ fontSize: 15 }}>{icon}</span>}
      <span style={{ fontSize: 12 }}>{label}</span>
    </button>
  );
}

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 4,
  padding: "6px 10px",
  borderBottom: "1px solid #e6eaee",
  background: "#f7f9fb",
};
const sep: React.CSSProperties = { width: 1, alignSelf: "stretch", background: "#dde4ea", margin: "2px 4px" };
const btn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid #d7dde3",
  borderRadius: 7,
  background: "#fff",
  padding: "5px 10px",
  cursor: "pointer",
};
