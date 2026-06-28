import { useI18n } from "../i18n/i18n";

export type ViewerKind = "2d" | "3d" | "mpr" | "slicer";
export type ToolKind = "export" | "nonDicomImport" | "anonymizer" | "tagExtractor" | "seriesExtractor";

export function Toolbar({
  isStandalone,
  canImport,
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
      {canImport && <ToolButton icon="📁" label={t("main.import.action")} onClick={onImport} />}
      <ToolButton icon="📤" label={t("main.toolbar.export")} onClick={() => onOpenTool("export")} />
      <ToolButton icon="🎞" label={t("main.toolbar.nonDicomImport")} onClick={() => onOpenTool("nonDicomImport")} />
      <ToolButton icon="🕶" label={t("main.toolbar.anonymizer")} onClick={() => onOpenTool("anonymizer")} />
      <ToolButton icon="🏷" label={t("main.toolbar.tagExtractor")} onClick={() => onOpenTool("tagExtractor")} />
      <ToolButton icon="🧬" label={t("main.toolbar.seriesExtractor")} onClick={() => onOpenTool("seriesExtractor")} />
      <ToolButton icon="🔄" label={t("main.toolbar.refresh")} onClick={onRefresh} />
      {isStandalone && <ToolButton icon="🗄" label={t("app.btn.dbTitle")} onClick={onOpenDb} />}
      <span style={sep} />
      {/* ビューア */}
      <ToolButton icon="🖼" label={t("main.toolbar.viewer2d")} onClick={() => onOpenViewer("2d")} />
      <ToolButton icon="🧊" label={t("main.toolbar.viewer3d")} onClick={() => onOpenViewer("3d")} />
      <ToolButton icon="➕" label={t("main.toolbar.mpr")} onClick={() => onOpenViewer("mpr")} />
      <ToolButton icon="🔪" label={t("main.toolbar.slicer")} onClick={() => onOpenViewer("slicer")} />
      <div style={{ flex: 1 }} />
      <ToolButton icon="⌨" label={t("sc.title")} onClick={onOpenHelp} />
      <ToolButton icon="⚙" label={t("app.btn.settingsTitle")} onClick={onOpenSettings} />
    </div>
  );
}

function ToolButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} title={label} style={btn}>
      <span style={{ fontSize: 15 }}>{icon}</span>
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
