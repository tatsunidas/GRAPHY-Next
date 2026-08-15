/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 解析タスク・ランチャー（`fw/angio-design.md` §21.2・A13-2）。
 *
 * <p>カードを 1 枚選ぶと、必要なら 2D ビューアを開いた上で**その解析のダイアログ**が開く。
 * **既存の導線（2D ビューアのボタン）は残したまま**の*追加*の入口である。
 *
 * <p>⚠️ ここに解析の判定を書かない。押せるかどうかは `viewer/xaTaskCatalog.ts` の純関数、
 * 実体は `SeriesViewer` のダイアログ。**この画面は入口だけ**にする（二重に持つと必ずずれる）。
 */
import { type Series, type Study } from "../api";
import { desktop } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import {
  ANALYSIS_TASKS,
  type AnalysisTaskDef,
  taskAvailability,
} from "../viewer/xaTaskCatalog";
import { requestXaTask, type XaTaskTarget } from "../viewer/xaTaskLaunch";

export function TaskLauncherDialog({
  open,
  onClose,
  study,
  series,
  isStandalone,
  onOpenReport,
}: {
  open: boolean;
  onClose: () => void;
  study: Study | null;
  series: Series | null;
  isStandalone: boolean;
  /** 報告書のカード。メインウィンドウ側で完結するので、既存のレポート編集をそのまま呼ぶ。 */
  onOpenReport: () => void;
}) {
  const { t } = useI18n();
  if (!open) return null;

  const ctx = {
    hasStudy: !!study,
    seriesModality: series?.modality ?? null,
    standalone: isStandalone,
  };

  const launch = (def: AnalysisTaskDef) => {
    if (def.opens === "report") {
      onClose();
      onOpenReport();
      return;
    }
    if (!study || !series || !def.opens) return;

    // 🔑 シリーズを開く経路は**既存のものをそのまま使う**（新方式を発明しない・§21.2）。
    localStorage.setItem(
      "graphy-viewer-ctx",
      JSON.stringify({ study, series, ts: Date.now() }),
    );
    // 「開いた上で何をするか」だけを別経路で送る（`viewer/xaTaskLaunch.ts` の冒頭を参照）。
    requestXaTask({
      id: `${def.id}:${Date.now()}`,
      target: def.opens as XaTaskTarget,
      studyUid: study.studyInstanceUid,
      seriesUid: series.seriesInstanceUid,
      at: Date.now(),
    });
    const d = desktop();
    if (d?.openViewer) void d.openViewer("2dviewer");
    else window.open(`${window.location.pathname}#2dviewer`, "graphy-2dviewer");
    onClose();
  };

  return (
    <div style={backdrop} data-testid="task-launcher">
      <div style={panel}>
        <div style={header}>
          <strong>{t("xa.task.title")}</strong>
          <button style={closeBtn} data-testid="task-launcher-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div style={subtitle}>
          {study
            ? t("xa.task.context", {
                study: study.studyDescription || study.studyInstanceUid,
                series: series ? `${series.modality} / ${series.seriesDescription || series.seriesNumber}` : t("xa.task.noSeries"),
              })
            : t("xa.task.reason.noStudy")}
        </div>
        <div style={grid}>
          {ANALYSIS_TASKS.map((def) => {
            const av = taskAvailability(def, ctx);
            return (
              <button
                key={def.id}
                data-testid={`task-card-${def.id}`}
                data-enabled={av.enabled ? "1" : "0"}
                data-reason={av.reasonKey ?? ""}
                disabled={!av.enabled}
                onClick={() => launch(def)}
                style={{
                  ...card,
                  // 未実装は淡色（§21.2）。押せない理由が「未実装」かどうかで見た目を変える ——
                  // 「今は押せない」と「そもそも無い」は別の情報。
                  opacity: def.implemented ? (av.enabled ? 1 : 0.7) : 0.55,
                  cursor: av.enabled ? "pointer" : "default",
                  borderStyle: def.implemented ? "solid" : "dashed",
                }}
              >
                <div style={cardTitle}>{t(def.labelKey)}</div>
                <div style={cardDesc}>{t(def.descKey)}</div>
                {/* 🚨 押せないカードには必ず理由を出す（無言で押せないボタンを並べない・§21.2）。 */}
                {!av.enabled && (
                  <div style={reason} data-testid={`task-reason-${def.id}`}>
                    {t(av.reasonKey as string, av.params)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
        <div style={footNote}>{t("xa.task.footnote")}</div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 90,
};
const panel: React.CSSProperties = {
  background: "#fff",
  borderRadius: 8,
  padding: 16,
  width: 760,
  maxWidth: "94vw",
  maxHeight: "88vh",
  overflow: "auto",
  boxShadow: "0 10px 40px rgba(0,0,0,0.3)",
  fontSize: 13,
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 6,
  fontSize: 15,
};
const closeBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  fontSize: 16,
  cursor: "pointer",
};
const subtitle: React.CSSProperties = { color: "#5a6672", marginBottom: 12 };
const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
  gap: 10,
};
const card: React.CSSProperties = {
  textAlign: "left",
  border: "1px solid #d3dae1",
  borderRadius: 8,
  padding: "10px 12px",
  background: "#fbfcfd",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minHeight: 92,
};
const cardTitle: React.CSSProperties = { fontWeight: 600, fontSize: 13.5 };
const cardDesc: React.CSSProperties = { color: "#5a6672", fontSize: 12, lineHeight: 1.5 };
const reason: React.CSSProperties = { color: "#8a5a00", fontSize: 11.5, marginTop: 2 };
const footNote: React.CSSProperties = { marginTop: 12, color: "#7a848e", fontSize: 11.5 };
