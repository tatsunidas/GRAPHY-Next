// 取り込みの進捗バーと中止ボタン（フォルダ・ファイル・ZIP 共通）。
import type { ImportJobStatus } from "../api";
import { useI18n } from "../i18n/i18n";
import { progressPercent } from "./importJob";

export function ImportProgressBanner({
  status,
  cancelling,
  onCancel,
}: {
  status: ImportJobStatus;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const pct = progressPercent(status);
  const counts = {
    processed: status.processed,
    total: status.total,
    imported: status.imported,
    skipped: status.skipped,
    failed: status.failed,
  };
  const label = cancelling
    ? t("main.import.cancelling")
    : status.state === "QUEUED" || status.state === "SCANNING"
      ? t("main.import.scanning")
      : t(status.total > 0 ? "main.import.progress" : "main.import.progressNoTotal", counts);
  return (
    <div style={wrap} data-testid="import-progress">
      <span style={text}>{label}</span>
      <div style={track} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <div style={{ ...fill, width: pct === null ? "30%" : `${pct}%`, opacity: pct === null ? 0.6 : 1 }} />
      </div>
      <button onClick={onCancel} disabled={cancelling} style={btn} data-testid="import-cancel">
        {t("main.import.cancel")}
      </button>
    </div>
  );
}

const wrap: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "6px 14px",
  background: "#eef6ec",
  borderBottom: "1px solid #d6e6d0",
  fontSize: 13,
  color: "#2e5d27",
};
const text: React.CSSProperties = { whiteSpace: "nowrap" };
const track: React.CSSProperties = { flex: 1, height: 8, background: "#d6e6d0", borderRadius: 4, overflow: "hidden" };
const fill: React.CSSProperties = { height: "100%", background: "#4c9a3f", transition: "width 0.2s" };
const btn: React.CSSProperties = { padding: "2px 12px", fontSize: 12, cursor: "pointer" };
