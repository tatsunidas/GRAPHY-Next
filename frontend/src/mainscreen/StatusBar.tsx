/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { type AppStatus } from "../api";
import { useI18n } from "../i18n/i18n";
import { errorKey, type WatchBarView } from "../settings/importWatchView";
import type { ReceiveAnonBar } from "../settings/receiveAnonView";
import type { JobCounts } from "../computejobs/computeJobsView";

export function StatusBar({
  status,
  error,
  importWatch,
  receiveAnon,
  computeJobs,
  keepAwake,
  onOpenComputeJobs,
  onReloadList,
}: {
  status: AppStatus | null;
  error: string | null;
  /** 監視フォルダの自動取り込みの状態（有効なときだけ visible）。 */
  importWatch?: WatchBarView;
  /** 受信時の匿名化の状態（有効なときだけ visible）。 */
  receiveAnon?: ReceiveAnonBar;
  /** 計算ジョブの数（standalone で数えるものがあるときだけ）。 */
  computeJobs?: JobCounts | null;
  /** 一括の計算のために OS の眠りを止めているか（main の返答）。 */
  keepAwake?: boolean;
  /** 計算ジョブの窓を開く。 */
  onOpenComputeJobs?: () => void;
  /** 新しい取り込みがあるとき、一覧を読み込み直す。 */
  onReloadList?: () => void;
}) {
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
        {importWatch?.visible && (
          <span data-testid="statusbar-import-watch" style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 12 }}>
            {importWatch.error ? (
              <span style={{ color: "#b00020" }} title={t(errorKey(importWatch.error))}>
                {t("importWatch.bar.label")}: {t("importWatch.bar.error")}
              </span>
            ) : (
              <span>
                {t("importWatch.bar.label")}:{" "}
                {t("importWatch.bar.counts", {
                  imported: importWatch.imported,
                  waiting: importWatch.waiting,
                  failed: importWatch.failed,
                })}
                {importWatch.held > 0 && (
                  <span data-testid="statusbar-import-watch-held" style={{ color: "#8a5a00" }}>
                    {" · "}
                    {t("importWatch.bar.held", { n: importWatch.held })}
                  </span>
                )}
              </span>
            )}
            {importWatch.newCount > 0 && onReloadList && (
              <button data-testid="statusbar-import-watch-new" style={reloadBtn} onClick={onReloadList}>
                {t("importWatch.bar.newItems", { n: importWatch.newCount })}
              </button>
            )}
          </span>
        )}
        {receiveAnon?.visible && (
          <span
            data-testid="statusbar-receive-anon"
            style={{ marginLeft: 12, color: receiveAnon.tone === "error" ? "#b00020" : receiveAnon.tone === "warn" ? "#8a5a00" : undefined }}
          >
            {receiveAnon.tone === "error"
              ? t("recvAnon.bar.invalid")
              : t("recvAnon.bar.on", { accepted: receiveAnon.accepted, rejected: receiveAnon.rejected })}
          </span>
        )}
        {computeJobs && (
          <button
            data-testid="statusbar-compute-jobs"
            style={{ ...reloadBtn, marginLeft: 12, ...(computeJobs.failed > 0 ? { background: "#fdeaea", color: "#b00020", borderColor: "#e6b8b8" } : {}) }}
            onClick={onOpenComputeJobs}
          >
            {t("computeJobs.bar.counts", { running: computeJobs.running, queued: computeJobs.queued, failed: computeJobs.failed })}
          </button>
        )}
        {keepAwake && (
          <span data-testid="statusbar-keep-awake" style={{ marginLeft: 8, color: "#667" }}>
            {t("computeJobs.awake")}
          </span>
        )}
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

const reloadBtn: React.CSSProperties = {
  background: "#e8f1fb",
  color: "#0b5cad",
  border: "1px solid #b8d0ea",
  borderRadius: 10,
  padding: "1px 10px",
  fontSize: 12,
  cursor: "pointer",
};
