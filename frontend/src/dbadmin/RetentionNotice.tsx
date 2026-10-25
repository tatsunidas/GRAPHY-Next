/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 自動削除が動いたあとの知らせ（standalone のみ）。見ていない実行があれば、閉じるまで出す。
 * 閉じると backend に「見た」と伝え、同じ実行では二度と出さない。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { emitDbChanged } from "../dbEvents";
import { useI18n } from "../i18n/i18n";
import { RetentionLogDialog } from "../settings/RetentionLogDialog";
import { ackRetentionNotice, fetchRetentionNotice } from "../settings/retentionApi";
import { formatBytes, noticeKind, splitWarnings, warningView, type RetentionRun } from "../settings/retentionView";

const POLL_MS = 60_000;

export function RetentionNotice({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n();
  const [run, setRun] = useState<RetentionRun | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  const shownId = useRef<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const r = await fetchRetentionNotice();
      if (!r || r.id === shownId.current) return;
      shownId.current = r.id;
      setRun(r);
      if (r.deleted + r.partial > 0) {
        emitDbChanged({ reason: "retention" }, { includeSelf: true });
        onChanged();
      }
    } catch {
      // web モード・古い backend には無い。知らせることが無いだけなので黙る
    }
  }, [onChanged]);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  if (!run) return null;
  const close = () => {
    setRun(null);
    void ackRetentionNotice().catch(() => undefined);
  };
  const warnings = splitWarnings(run.warnings).filter((w) => !w.startsWith("protected:"));
  const kind = noticeKind(run);

  return (
    <>
      <div data-testid="retention-notice" data-kind={kind} style={box}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {kind === "deleted"
            ? t("retention.notice.deleted", { n: run.deleted + run.partial, size: formatBytes(run.bytesFreed) })
            : t("retention.notice.warning")}
        </div>
        {run.partial + run.failed > 0 && (
          <div style={{ fontSize: 12, color: "#8a5a00" }}>
            {t("retention.notice.failures", { partial: run.partial, failed: run.failed })}
          </div>
        )}
        {!run.satisfied && <div style={{ fontSize: 12, color: "#8a5a00" }}>{t("retention.notice.unsatisfied")}</div>}
        {warnings.map((w) => (
          <div key={w} style={{ fontSize: 12, color: "#8a5a00" }}>
            {t(warningView(w).key)}
          </div>
        ))}
        <div style={{ textAlign: "right", marginTop: 6, display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button data-testid="retention-notice-log" onClick={() => setLogOpen(true)} style={{ fontSize: 12 }}>
            {t("retention.notice.viewLog")}
          </button>
          <button data-testid="retention-notice-close" onClick={close} style={{ fontSize: 12 }}>
            {t("common.close")}
          </button>
        </div>
      </div>
      {logOpen && <RetentionLogDialog onClose={() => setLogOpen(false)} />}
    </>
  );
}

const box: CSSProperties = {
  position: "fixed",
  right: 16,
  bottom: 100,
  zIndex: 1050,
  maxWidth: 520,
  background: "#fffbe6",
  border: "1px solid #e6d27a",
  borderRadius: 6,
  padding: "10px 12px",
  boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
  fontFamily: "system-ui, sans-serif",
};
