import { useEffect, useState } from "react";
import { fetchStatus, type AppStatus } from "./api";

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStatus()
      .then(setStatus)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const modeLabel =
    status?.mode === "standalone"
      ? "Desktop (Electron / standalone)"
      : status?.mode === "web"
        ? "Web (browser)"
        : status?.mode ?? "—";

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 560,
        margin: "10vh auto",
        padding: "0 1rem",
        color: "#1a1a1a",
      }}
    >
      <h1 style={{ marginBottom: 4 }}>GRAPHY-Next</h1>
      <p style={{ color: "#666", marginTop: 0 }}>最小構成 起動確認</p>

      {error && (
        <div style={{ color: "#b00020" }}>
          バックエンドに接続できません: {error}
        </div>
      )}

      {!error && !status && <div>接続中…</div>}

      {status && (
        <table style={{ borderCollapse: "collapse", marginTop: 16 }}>
          <tbody>
            <Row label="起動モード" value={modeLabel} highlight />
            <Row label="アプリ" value={status.app} />
            <Row label="バージョン" value={status.version} />
            <Row label="Active profiles" value={status.activeProfiles.join(", ") || "(default)"} />
            <Row label="Java" value={status.javaVersion} />
          </tbody>
        </table>
      )}
    </main>
  );
}

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
