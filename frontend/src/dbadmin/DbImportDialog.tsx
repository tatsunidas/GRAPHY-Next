/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 外付けドライブなどの荷物を、今の DB に取り込む（デスクトップのみ）。
 *
 * <p>取り込み元のフォルダ選択と内容の確認は Electron main が出す。この画面はフォルダの場所を知らない。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "../i18n/i18n";
import { desktop, type DbImportJob } from "../desktopBridge";
import { backdropClose } from "../ui/backdropClose";

const KNOWN_REASONS = [
  "busy", "no-packages", "only-interrupted", "too-new", "invalid-manifest", "not-enough-space", "source-is-current",
];

export function DbImportDialog({ onClose, onImported, pollMs = 1000 }: {
  onClose: () => void;
  /** 何か取り込んだとき（一覧を読み直す）。 */
  onImported: () => void;
  pollMs?: number;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<"idle" | "choosing" | "running" | "done">("idle");
  const [status, setStatus] = useState<DbImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reasonText = (reason: string | undefined) =>
    reason && KNOWN_REASONS.includes(reason) ? t(`dbImport.reason.${reason}`) : t("dbImport.reason.other", { code: reason ?? "?" });

  const fail = (reason: string | undefined) => {
    setError(reasonText(reason));
    setPhase("idle");
  };

  const poll = async (jobId: string) => {
    const s = await desktop()!.dbImportStatus!(jobId);
    if (!alive.current) return;
    if (!s.ok) return fail(s.reason);
    setStatus(s);
    if (s.state === "running") {
      setTimeout(() => void poll(jobId), pollMs);
      return;
    }
    setPhase("done");
    if (s.studies > 0) onImported();
  };

  const run = async () => {
    setError(null);
    setStatus(null);
    setPhase("choosing");
    try {
      const r = await desktop()!.dbImportStart!();
      if (!alive.current) return;
      if (!r.ok || !r.jobId) {
        if (r.canceled) return setPhase("idle");
        return fail(r.reason);
      }
      setPhase("running");
      await poll(r.jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  const busy = phase === "choosing" || phase === "running";
  const warn = !!status && (status.state === "failed" || status.packages.some((p) => p.outcome !== "imported" || p.failed > 0 || p.conflicts > 0));

  return (
    <div style={overlay} {...(busy ? {} : backdropClose(onClose))}>
      <div data-testid="db-import-dialog" style={dialog} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>{t("dbImport.title")}</h3>
        <p style={note}>{t("dbImport.help")}</p>

        {phase === "running" && <div data-testid="db-import-running">{t("dbImport.running")}</div>}
        {phase === "done" && status && (
          <div data-testid="db-import-result" style={{ margin: "8px 0" }}>
            <div style={{ fontWeight: 600 }}>
              {status.state === "failed" ? t("dbImport.stopped") : t("dbImport.done", { studies: status.studies })}
            </div>
            {status.packages.map((p, i) => (
              <div key={i} style={{ fontSize: 13, margin: "6px 0" }}>
                <div>
                  {t("dbImport.package", { n: i + 1 })}:{" "}
                  {p.outcome === "imported"
                    ? t("dbImport.counts", {
                        imported: p.imported, skipped: p.skippedExisting, failed: p.failed,
                        added: p.relatedInserted, same: p.relatedSame, conflicts: p.conflicts,
                      })
                    : t(`dbImport.outcome.${p.outcome}`)}
                </div>
                {p.pluginNotes.map((n) => (
                  <div key={n.id} data-testid="db-import-plugin-note" style={warnText}>
                    {t(`dbTransfer.plugin.${n.kind}`, { id: n.id, from: n.sourceVersion ?? "?", to: n.localVersion ?? "?" })}
                  </div>
                ))}
              </div>
            ))}
            {warn && <div style={warnText}>{t("dbImport.kept")}</div>}
          </div>
        )}

        {error && <div data-testid="db-import-error" style={{ color: "#b00020", margin: "8px 0" }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          {phase !== "done" && (
            <button data-testid="db-import-run" style={{ ...btn, fontWeight: 600 }} disabled={busy} onClick={() => void run()}>
              {t("dbImport.choose")}
            </button>
          )}
          <button data-testid="db-import-close" style={btn} disabled={busy} onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1100,
};
const dialog: CSSProperties = {
  background: "#fff",
  borderRadius: 8,
  padding: 18,
  width: 560,
  maxWidth: "92vw",
  maxHeight: "86vh",
  overflow: "auto",
  boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
  fontFamily: "system-ui, sans-serif",
};
const note: CSSProperties = { fontSize: 12, color: "#666", margin: "0 0 8px" };
const warnText: CSSProperties = { fontSize: 12, color: "#8a5a00" };
const btn: CSSProperties = { padding: "4px 12px", fontSize: 13, cursor: "pointer" };
