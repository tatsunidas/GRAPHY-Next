/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// バージョン等の情報を表示する読み取り専用パネル。値は /api/status を利用。
import { useEffect, useState } from "react";
import { fetchStatus, type AppStatus } from "../api";
import { useI18n } from "../i18n/i18n";

export function AboutPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStatus()
      .then(setStatus)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  if (error) return <p style={{ fontSize: 13, color: "#b00020" }}>{error}</p>;
  if (!status) return <p style={{ fontSize: 13, color: "#6b7785" }}>{t("app.connecting")}</p>;

  const modeLabel = status.mode === "standalone" ? t("app.mode.desktop") : t("app.mode.web");
  const rows: { label: string; value: string }[] = [
    { label: t("settings.about.app"), value: status.app },
    { label: t("app.status.version"), value: `v${status.version}` },
    { label: t("settings.about.mode"), value: modeLabel },
    { label: t("settings.about.javaVersion"), value: status.javaVersion },
  ];

  return (
    <div>
      <p style={{ fontSize: 13, color: "#6b7785", marginTop: 0 }}>{t("settings.about.note")}</p>
      {rows.map((r) => (
        <Row key={r.label} label={r.label} value={r.value} />
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={row}>
      <div style={{ flex: 1, fontSize: 14, color: "#445" }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: "10px 0",
  borderBottom: "1px solid #f1f3f5",
};
