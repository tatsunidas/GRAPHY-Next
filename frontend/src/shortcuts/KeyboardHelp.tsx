import { SHORTCUTS, displayCombo, type ShortcutGroup } from "./registry";
import { useI18n } from "../i18n/i18n";

export function KeyboardHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  if (!open) return null;

  const groups: { group: ShortcutGroup; titleKey: string }[] = [
    { group: "global", titleKey: "sc.group.global" },
    { group: "tools", titleKey: "sc.group.tools" },
    { group: "navigation", titleKey: "sc.group.navigation" },
    { group: "display", titleKey: "sc.group.display" },
    { group: "system", titleKey: "sc.group.system" },
  ];

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("sc.title")}</span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>
        <div style={{ padding: "12px 18px", overflow: "auto" }}>
          {groups.map((g) => {
            const items = SHORTCUTS.filter((s) => s.group === g.group);
            return (
              <section key={g.group} style={{ marginBottom: 18 }}>
                <h3 style={sectionTitle}>{t(g.titleKey)}</h3>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <tbody>
                    {items.map((s) => (
                      <tr key={s.id} style={{ borderBottom: "1px solid #f1f3f5" }}>
                        <td style={{ padding: "6px 10px", width: 160 }}>
                          <kbd style={kbd}>{displayCombo(s.combo)}</kbd>
                        </td>
                        <td style={{ padding: "6px 10px", color: s.planned ? "#9aa7b3" : "#222" }}>
                          {t(s.descriptionKey)}
                          {s.planned && <span style={{ marginLeft: 6, fontSize: 11 }}>{t("sc.planned")}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1001,
};
const dialog: React.CSSProperties = {
  width: 520,
  maxWidth: "92vw",
  maxHeight: "84vh",
  background: "#fff",
  borderRadius: 10,
  boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: "system-ui, sans-serif",
  color: "#1a1a1a",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  borderBottom: "1px solid #eee",
};
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const sectionTitle: React.CSSProperties = {
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "#8a98a6",
  margin: "0 0 6px",
};
const kbd: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 5,
  background: "#f6f8fa",
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
};
