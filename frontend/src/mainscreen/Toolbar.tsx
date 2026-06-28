import { useI18n } from "../i18n/i18n";

export function Toolbar({
  isStandalone,
  onRefresh,
  onOpenDb,
  onOpenSettings,
  onOpenHelp,
}: {
  isStandalone: boolean;
  onRefresh: () => void;
  onOpenDb: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
}) {
  const { t } = useI18n();
  return (
    <div style={bar}>
      <ToolButton icon="🔄" label={t("main.toolbar.refresh")} onClick={onRefresh} />
      {isStandalone && <ToolButton icon="🗄" label={t("app.btn.dbTitle")} onClick={onOpenDb} />}
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
  gap: 4,
  padding: "6px 10px",
  borderBottom: "1px solid #e6eaee",
  background: "#f7f9fb",
};
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
