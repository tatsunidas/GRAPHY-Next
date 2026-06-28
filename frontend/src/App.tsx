import { useEffect, useState } from "react";
import { fetchStatus, type AppStatus } from "./api";
import { StudyList } from "./StudyList";
import { SettingsDialog } from "./settings/SettingsDialog";
import { DbAdminDialog } from "./dbadmin/DbAdminDialog";
import { KeyboardHelp } from "./shortcuts/KeyboardHelp";
import { useGlobalShortcuts } from "./shortcuts/useGlobalShortcuts";
import { useI18n } from "./i18n/i18n";

export function App() {
  const { t } = useI18n();
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dbOpen, setDbOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    fetchStatus()
      .then(setStatus)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useGlobalShortcuts({
    "open-settings": () => setSettingsOpen(true),
    "open-db": () => {
      if (status?.mode === "standalone") setDbOpen(true);
    },
    "show-help": () => setHelpOpen(true),
    // Esc: 開いているダイアログを閉じる（文脈依存。ビューア実装後はビューア側でリセットに割当）
    "close-dialog": () => {
      setSettingsOpen(false);
      setDbOpen(false);
      setHelpOpen(false);
    },
  });

  const modeLabel =
    status?.mode === "standalone"
      ? t("app.mode.desktop")
      : status?.mode === "web"
        ? t("app.mode.web")
        : status?.mode ?? "—";

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 760,
        margin: "8vh auto",
        padding: "0 1rem",
        color: "#1a1a1a",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>GRAPHY-Next</h1>
          <p style={{ color: "#666", marginTop: 0 }}>{t("app.subtitle")}</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {status?.mode === "standalone" && (
            <button onClick={() => setDbOpen(true)} title={t("app.btn.dbTitle")} style={iconBtn}>
              🗄 {t("app.btn.db")}
            </button>
          )}
          <button onClick={() => setHelpOpen(true)} title={t("sc.title")} style={iconBtn}>
            ⌨
          </button>
          <button onClick={() => setSettingsOpen(true)} title={t("app.btn.settingsTitle")} style={iconBtn}>
            ⚙
          </button>
        </div>
      </div>

      {error && <div style={{ color: "#b00020" }}>{t("app.backendError", { error })}</div>}

      {!error && !status && <div>{t("app.connecting")}</div>}

      {status && (
        <table style={{ borderCollapse: "collapse", marginTop: 16 }}>
          <tbody>
            <Row label={t("app.status.mode")} value={modeLabel} highlight />
            <Row label={t("app.status.app")} value={status.app} />
            <Row label={t("app.status.version")} value={status.version} />
            <Row label={t("app.status.profiles")} value={status.activeProfiles.join(", ") || "(default)"} />
            <Row label={t("app.status.java")} value={status.javaVersion} />
          </tbody>
        </table>
      )}

      <StudyList />

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <DbAdminDialog open={dbOpen} onClose={() => setDbOpen(false)} />
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </main>
  );
}

const iconBtn: React.CSSProperties = {
  border: "1px solid #d0d7de",
  background: "#fff",
  borderRadius: 8,
  padding: "6px 10px",
  cursor: "pointer",
  fontSize: 14,
};

function Row({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <tr>
      <td style={{ padding: "6px 16px 6px 0", color: "#666" }}>{label}</td>
      <td
        style={{
          padding: "6px 0",
          fontWeight: highlight ? 700 : 400,
          color: highlight ? "#0b5cad" : "inherit",
        }}
      >
        {value}
      </td>
    </tr>
  );
}
