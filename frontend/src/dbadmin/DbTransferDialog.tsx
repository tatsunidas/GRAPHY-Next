/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 検査を別の DB フォルダへコピー・移動する（デスクトップのみ）。
 *
 * <p>移し先の索引には触れず、移し先の inbox に置くだけ。移し先の DB を次に開いたときに取り込まれる。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "../i18n/i18n";
import { desktop, type DbFolderRow } from "../desktopBridge";
import { formatBytes } from "./charts";
import { transferStudies, type TransferMode, type TransferResult } from "./dbTransferApi";
import { targetCandidates, transferReasonKey } from "./dbTransferView";

export function DbTransferDialog({
  studyUid,
  studyLabel,
  onClose,
  onMoved,
}: {
  studyUid: string;
  studyLabel: string;
  onClose: () => void;
  /** 移動して移し元から消えたとき（一覧を読み直す）。 */
  onMoved: () => void;
}) {
  const { t } = useI18n();
  const d = desktop();
  const [targets, setTargets] = useState<DbFolderRow[]>([]);
  const [target, setTarget] = useState<string>("");
  const [mode, setMode] = useState<TransferMode>("copy");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<TransferResult | null>(null);

  useEffect(() => {
    if (!d?.dbFoldersList) return;
    d.dbFoldersList()
      .then((l) => {
        const c = targetCandidates(l.folders);
        setTargets(c);
        setTarget((cur) => cur || c[0]?.path || "");
      })
      .catch((e: unknown) => setError(String(e)));
  }, [d]);

  const pick = async () => {
    if (!d?.dbFoldersPick) return;
    const r = await d.dbFoldersPick(t("dbTransfer.pickTitle"));
    if (r.ok && r.folder) {
      const folder = r.folder;
      setTargets((ts) => (ts.some((x) => x.path === folder) ? ts : [...ts, { path: folder, isDefault: false, exists: true, active: false }]));
      setTarget(folder);
    } else if (!r.ok && !r.canceled) {
      setError(t("settings.dbFolder.error", { reason: t("dbTransfer.reason.targetNotDbFolder"), code: r.reason ?? "?" }));
    }
  };

  const run = async () => {
    if (!target) return;
    if (mode === "move" && !window.confirm(t("dbTransfer.moveConfirm", { desc: studyLabel, target }))) return;
    setBusy(true);
    setError(null);
    try {
      const r = await transferStudies([studyUid], target, mode);
      setDone(r);
      if (r.sourceDeleted) onMoved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const key = transferReasonKey(msg);
      setError(key ? t(key) : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay} onClick={busy ? undefined : onClose}>
      <div data-testid="db-transfer-dialog" style={dialog} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>{t("dbTransfer.title")}</h3>
        <div style={{ marginBottom: 8 }}>{studyLabel}</div>
        <p style={note}>{t("dbTransfer.help")}</p>

        {done ? (
          <div data-testid="db-transfer-done" style={{ margin: "10px 0" }}>
            {t(done.mode === "move" ? "dbTransfer.doneMove" : "dbTransfer.doneCopy", {
              files: done.files,
              size: formatBytes(done.bytes),
            })}
          </div>
        ) : (
          <>
            <div style={label}>{t("dbTransfer.target")}</div>
            {targets.length === 0 && <div style={note}>{t("dbTransfer.noTargets")}</div>}
            {targets.map((f) => (
              <label key={f.path} style={radioRow}>
                <input type="radio" name="db-target" checked={target === f.path} onChange={() => setTarget(f.path)} />
                <span style={{ wordBreak: "break-all" }}>{f.path}</span>
              </label>
            ))}
            <button style={btn} disabled={busy} onClick={() => void pick()}>
              {t("dbTransfer.pick")}
            </button>

            <div style={{ ...label, marginTop: 12 }}>{t("dbTransfer.mode")}</div>
            <label style={radioRow}>
              <input type="radio" name="db-mode" checked={mode === "copy"} onChange={() => setMode("copy")} />
              {t("dbTransfer.copy")}
            </label>
            <label style={radioRow}>
              <input type="radio" name="db-mode" checked={mode === "move"} onChange={() => setMode("move")} />
              {t("dbTransfer.move")}
            </label>
          </>
        )}

        {error && <div style={{ color: "#b00020", margin: "8px 0" }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          {!done && (
            <button style={{ ...btn, fontWeight: 600 }} disabled={busy || !target} onClick={() => void run()}>
              {busy ? t("dbTransfer.running") : t(mode === "move" ? "dbTransfer.runMove" : "dbTransfer.runCopy")}
            </button>
          )}
          <button style={btn} disabled={busy} onClick={onClose}>
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
const label: CSSProperties = { fontSize: 13, fontWeight: 600, margin: "6px 0 4px" };
const radioRow: CSSProperties = { display: "flex", gap: 6, alignItems: "flex-start", fontSize: 13, margin: "3px 0" };
const btn: CSSProperties = { padding: "4px 12px", fontSize: 13, cursor: "pointer" };
