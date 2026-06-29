/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { type AppStatus } from "../api";
import { useI18n } from "../i18n/i18n";

export function StatusBar({ status, error }: { status: AppStatus | null; error: string | null }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const modeLabel = !status
    ? error
      ? t("main.status.disconnected")
      : t("app.connecting")
    : status.mode === "standalone"
      ? t("app.mode.desktop")
      : t("app.mode.web");

  const dot = !status ? (error ? "#cf4f4f" : "#e3a008") : "#3fb950";

  return (
    <div style={bar}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: dot, display: "inline-block" }} />
        <span>{modeLabel}</span>
        {status && <span style={{ color: "#8a98a6" }}>v{status.version}</span>}
      </div>
      <div style={{ fontVariantNumeric: "tabular-nums", color: "#445" }}>{formatClock(now)}</div>
    </div>
  );
}

function formatClock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "4px 12px",
  borderTop: "1px solid #e6eaee",
  background: "#f7f9fb",
  fontSize: 12,
  color: "#333",
};
