/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState } from "react";
import { cancelUrlImport, getUrlImport, submitUrlImport, type ImportResult, type UrlImportStatus } from "../api";
import { useI18n } from "../i18n/i18n";

const POLL_MS = 500;

/**
 * URL を指定して取り込む（standalone のみ・fw/dicom-data-layer.md §4.4）。backend が http/https から落とし、
 * DICOM はそのまま取り込む。それ以外は落としたパスを渡して、非 DICOM 取り込みのダイアログで続ける。
 */
export function UrlImportDialog({
  open,
  onClose,
  onDicomImported,
  onFile,
}: {
  open: boolean;
  onClose: () => void;
  onDicomImported: (r: ImportResult) => void;
  onFile: (path: string, jobId: string) => void;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<UrlImportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const running = status !== null && ["QUEUED", "DOWNLOADING", "IMPORTING"].includes(status.state);

  const stopPolling = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  useEffect(() => {
    if (!open) return;
    setUrl("");
    setStatus(null);
    setError(null);
    return stopPolling;
  }, [open]);

  if (!open) return null;

  const start = async () => {
    setError(null);
    try {
      const s = await submitUrlImport(url);
      setStatus(s);
      stopPolling();
      timer.current = setInterval(async () => {
        try {
          const cur = await getUrlImport(s.jobId);
          setStatus(cur);
          if (["DONE", "FAILED", "CANCELLED"].includes(cur.state)) {
            stopPolling();
            if (cur.state === "FAILED") setError(cur.error);
            if (cur.state === "DONE" && cur.kind === "dicom" && cur.importResult) onDicomImported(cur.importResult);
            if (cur.state === "DONE" && cur.kind === "file" && cur.path) onFile(cur.path, cur.jobId);
          }
        } catch (e) {
          stopPolling();
          setError(String(e));
        }
      }, POLL_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const cancel = () => {
    if (status) void cancelUrlImport(status.jobId).catch(() => undefined);
  };

  const close = () => {
    if (running) cancel(); // 閉じたら取得も止める（裏で落とし続けない）
    stopPolling();
    onClose();
  };

  const pct = status && status.totalBytes > 0 ? Math.min(100, (status.receivedBytes / status.totalBytes) * 100) : null;
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);

  return (
    <div style={overlay} onClick={close}>
      <div style={dialog} onClick={(e) => e.stopPropagation()} data-testid="url-import-dialog">
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("urlImport.title")}</span>
          <button style={closeBtn} onClick={close} aria-label={t("common.close")}>
            ✕
          </button>
        </div>
        <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            style={input}
            disabled={running}
            data-testid="url-import-input"
            onKeyDown={(e) => {
              if (e.key === "Enter" && url.trim() && !running) void start();
            }}
          />
          <div style={{ fontSize: 12, color: "#667" }}>{t("urlImport.help")}</div>
          {status && (
            <div data-testid="url-import-progress" style={{ fontSize: 12 }}>
              <div style={{ height: 8, background: "#eef1f4", borderRadius: 4, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: pct === null ? (running ? "30%" : "100%") : `${pct}%`,
                    background: status.state === "FAILED" ? "#b00020" : "#0b5cad",
                  }}
                />
              </div>
              <div style={{ marginTop: 4 }}>
                {t(`urlImport.state.${status.state}`)}
                {" — "}
                {status.totalBytes > 0 ? `${mb(status.receivedBytes)} / ${mb(status.totalBytes)} MB` : `${mb(status.receivedBytes)} MB`}
              </div>
              {status.state === "DONE" && status.kind === "dicom" && status.importResult && (
                <div style={{ color: "#2e7d32" }} data-testid="url-import-done">
                  {t("main.import.result", {
                    imported: status.importResult.imported,
                    skipped: status.importResult.skipped,
                    failed: status.importResult.failed,
                  })}
                </div>
              )}
            </div>
          )}
          {error && (
            <div style={{ color: "#b00020", fontSize: 13 }} data-testid="url-import-error">
              {error}
            </div>
          )}
        </div>
        <div style={footer}>
          {running ? (
            <button onClick={cancel} style={btn} data-testid="url-import-cancel">
              {t("urlImport.cancel")}
            </button>
          ) : (
            <button onClick={close} style={btn}>
              {t("common.close")}
            </button>
          )}
          <button
            onClick={() => void start()}
            disabled={!url.trim() || running}
            style={{ ...btn, background: url.trim() && !running ? "#0b5cad" : "#9fb6cf", color: "#fff" }}
            data-testid="url-import-start"
          >
            {t("urlImport.start")}
          </button>
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
  zIndex: 1000,
};
const dialog: React.CSSProperties = {
  width: 560,
  maxWidth: "96vw",
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
const footer: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 16px", borderTop: "1px solid #eee" };
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const input: React.CSSProperties = { padding: "6px 8px", border: "1px solid #cdd5de", borderRadius: 6, fontSize: 13, width: "100%", boxSizing: "border-box" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
