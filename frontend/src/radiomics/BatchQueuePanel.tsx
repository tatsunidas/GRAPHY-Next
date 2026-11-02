/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useRef } from "react";
import { useI18n } from "../i18n/i18n";
import { ERR_DUPLICATE_PREFIX, ERR_NO_PAIRS, queueSummary, type QueueEntry } from "./batchQueue";

/** 一括抽出ダイアログの「定義の一覧」。状態は親が持つ（実行中の更新を受けるため）。 */
export function BatchQueuePanel({
  entries, onChange, running, busy, canAddCurrent, onAddFiles, onAddCurrent, onRun, onCancel,
}: {
  entries: readonly QueueEntry[];
  onChange: (next: QueueEntry[]) => void;
  /** 一覧を実行中。 */
  running: boolean;
  /** 単独実行が動いている（一覧の実行は始められない）。 */
  busy: boolean;
  canAddCurrent: boolean;
  onAddFiles: (files: File[]) => void;
  onAddCurrent: () => void;
  onRun: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= entries.length) return;
    const next = [...entries];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const set = (id: number, p: Partial<QueueEntry>) => onChange(entries.map((e) => (e.id === id ? { ...e, ...p } : e)));
  const s = queueSummary(entries);
  const stateText = (e: QueueEntry): string => {
    const m = e.message ?? "";
    switch (e.state) {
      case "done": return t("roiFeat.batch.queue.state.done", { n: e.files });
      case "failed": {
        const reason = m === ERR_NO_PAIRS ? t("roiFeat.batch.queue.err.noPairs")
          : m.startsWith(ERR_DUPLICATE_PREFIX) ? t("roiFeat.batch.queue.err.duplicate", { labels: m.slice(ERR_DUPLICATE_PREFIX.length) })
          : m;
        return t("roiFeat.batch.queue.state.failed", { message: reason });
      }
      case "qcStopped": return t("roiFeat.batch.queue.state.qcStopped", { message: m });
      default: return t(`roiFeat.batch.queue.state.${e.state}`);
    }
  };
  const enabledCount = entries.filter((e) => e.enabled).length;
  return (
    <div style={{ marginTop: 12, borderTop: "1px solid #eef2f6", paddingTop: 6 }} data-testid="batch-queue">
      <div style={{ fontWeight: 600, color: "#0b5cad" }}>{t("roiFeat.batch.queue.title")}</div>
      <div style={note}>{t("roiFeat.batch.queue.note")}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
        <button type="button" style={btn} data-testid="batch-queue-add" disabled={running} onClick={() => fileRef.current?.click()}>
          {t("roiFeat.batch.queue.add")}
        </button>
        <input ref={fileRef} data-testid="batch-queue-file" type="file" multiple accept=".json,application/json" style={{ display: "none" }}
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length > 0) onAddFiles(fs); e.target.value = ""; }} />
        <button type="button" style={btn} data-testid="batch-queue-add-current" disabled={running || !canAddCurrent} onClick={onAddCurrent}>
          {t("roiFeat.batch.queue.addCurrent")}
        </button>
        <button type="button" style={btnPrimary} data-testid="batch-queue-run" disabled={running || busy || enabledCount === 0} onClick={onRun}>
          {t("roiFeat.batch.queue.run")}
        </button>
        {running && <button type="button" style={btn} data-testid="batch-queue-cancel" onClick={onCancel}>{t("roiFeat.batch.queue.cancel")}</button>}
        {entries.length > 0 && (
          <span style={note} data-testid="batch-queue-summary">
            {t("roiFeat.batch.queue.summary", { done: s.done, failed: s.failed, qc: s.qcStopped, pending: s.pending })}
          </span>
        )}
      </div>
      {entries.length === 0 ? (
        <div style={note} data-testid="batch-queue-empty">{t("roiFeat.batch.queue.empty")}</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4 }}>
          <tbody>
            {entries.map((e, i) => (
              <tr key={e.id} data-testid={`batch-queue-row-${i}`} style={{ borderTop: "1px solid #eef2f6" }}>
                <td style={td}>
                  <input type="checkbox" data-testid={`batch-queue-enabled-${i}`} checked={e.enabled} disabled={running}
                    onChange={(ev) => set(e.id, { enabled: ev.target.checked })} />
                </td>
                <td style={td}>{i + 1}. {e.spec.output.prefix || "roi-features-batch"}</td>
                <td style={td}>{t(`roiFeat.batch.queue.kind.${e.spec.kind}`)}</td>
                <td style={td} title={e.spec.sha256}>{e.spec.sha256.slice(0, 8)}</td>
                <td style={td}>
                  <button type="button" style={mini} disabled={running || i === 0} title={t("roiFeat.batch.queue.up")} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" style={mini} disabled={running || i === entries.length - 1} title={t("roiFeat.batch.queue.down")} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" style={mini} disabled={running} title={t("roiFeat.batch.queue.remove")} data-testid={`batch-queue-remove-${i}`}
                    onClick={() => onChange(entries.filter((x) => x.id !== e.id))}>×</button>
                </td>
                <td style={td} data-testid={`batch-queue-state-${i}`}>{e.enabled ? stateText(e) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const note: React.CSSProperties = { color: "#6b7785", fontSize: 11, marginTop: 4, lineHeight: 1.5 };
const td: React.CSSProperties = { padding: "3px 6px", verticalAlign: "top" };
const btn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "5px 12px" };
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
const mini: React.CSSProperties = { ...btn, padding: "1px 6px", marginRight: 2 };
