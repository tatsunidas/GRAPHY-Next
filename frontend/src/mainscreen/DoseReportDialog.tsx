/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { fetchStudyDose, type DoseItem, type Study, type StudyDoseDto } from "../api";
import { useI18n } from "../i18n/i18n";

/**
 * 被ばく線量レポート（RDSR）ビューア（`fw/angio-design.md` §14.2 / A9）。
 *
 * <p>検査に含まれる X-Ray Radiation Dose SR を解析し、積算線量のサマリと照射イベント一覧を出す。
 *
 * <p>🚨 **線量管理システム（OpenREM 等）の代替ではない**。皮膚線量分布の計算・警告閾値・
 * 施設 DRL 比較はやらない ——「読み取りと表示まで」。この断りは画面にも常時出す。
 *
 * <p>装置ごとにコードの言い回しが違うため、サマリ（DAP 合計等）は取れないことがある。
 * その場合も**全項目はそのまま表**に出るので、値が失われることはない。
 */
export function DoseReportDialog({
  open,
  onClose,
  study,
}: {
  open: boolean;
  onClose: () => void;
  study: Study | null;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<StudyDoseDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !study) return;
    setData(null);
    setError(null);
    let cancelled = false;
    fetchStudyDose(study.studyInstanceUid)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError(t("dose.error"));
      });
    return () => {
      cancelled = true;
    };
  }, [open, study, t]);

  if (!open) return null;

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={title}>{t("dose.title")}</div>
        <div style={caveat}>{t("dose.notADoseManagementSystem")}</div>

        {error && <div style={errorText}>{error}</div>}
        {!data && !error && <div style={hint}>{t("common.loading")}</div>}

        {data && data.reports.length === 0 && <div style={hint}>{t("dose.none")}</div>}

        {data && data.reports.length > 0 && (
          <>
            <div style={section}>
              <div style={sectionTitle}>{t("dose.summary")}</div>
              <table style={table}>
                <tbody>
                  <tr>
                    <td style={th}>{t("dose.dapTotal")}</td>
                    <td style={td}>{fmt(data.summary.doseAreaProductTotal)}</td>
                    <td style={th}>{t("dose.rpTotal")}</td>
                    <td style={td}>{fmt(data.summary.doseRpTotal)}</td>
                  </tr>
                  <tr>
                    <td style={th}>{t("dose.fluoroTime")}</td>
                    <td style={td}>{fmt(data.summary.fluoroTimeTotal)}</td>
                    <td style={th}>{t("dose.eventCount")}</td>
                    <td style={td}>{data.summary.irradiationEventCount}</td>
                  </tr>
                </tbody>
              </table>
              <div style={hint}>{t("dose.summaryHint")}</div>
            </div>

            {data.reports.map((r) => (
              <div key={r.sopInstanceUid} style={section}>
                <div style={sectionTitle}>
                  {r.manufacturer ?? "—"} · {r.contentDateTime ?? "—"}
                </div>

                <div style={subTitle}>{t("dose.accumulated")}</div>
                <ItemTable items={r.accumulated} emptyLabel={t("dose.noItems")} />

                <div style={subTitle}>{t("dose.events")}</div>
                {r.events.length === 0 ? (
                  <div style={hint}>{t("dose.noItems")}</div>
                ) : (
                  <table style={table}>
                    <thead>
                      <tr>
                        <th style={th}>#</th>
                        <th style={th}>{t("dose.eventType")}</th>
                        <th style={th}>{t("dose.eventValues")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.events.map((e) => (
                        <tr key={`${e.index}-${e.eventUid ?? ""}`}>
                          <td style={td}>{e.index + 1}</td>
                          <td style={tdLeft}>{e.eventType ?? "—"}</td>
                          <td style={tdLeft}>
                            {e.items
                              .filter((i) => i.numericValue != null)
                              .map((i) => `${i.meaning ?? i.code ?? "?"} ${i.numericValue} ${i.unit ?? ""}`)
                              .join(" / ") || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button style={btn} onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ItemTable({ items, emptyLabel }: { items: DoseItem[]; emptyLabel: string }) {
  if (!items.length) return <div style={hint}>{emptyLabel}</div>;
  return (
    <table style={table}>
      <tbody>
        {items.map((i, idx) => (
          <tr key={`${i.code ?? ""}-${idx}`}>
            <td style={tdLeft}>{i.meaning ?? i.code ?? "—"}</td>
            <td style={td}>{i.numericValue != null ? i.numericValue : (i.textValue ?? "—")}</td>
            <td style={tdLeft}>{i.unit ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 値が無いときは 0 ではなく「—」（「取れなかった」と「0 だった」を区別する）。 */
function fmt(v: number | null): string {
  return v == null ? "—" : String(Number(v.toFixed(3)));
}

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const panel: React.CSSProperties = {
  background: "#f4f6f8",
  color: "#22303c",
  borderRadius: 6,
  padding: 16,
  minWidth: 620,
  maxWidth: "90vw",
  maxHeight: "86vh",
  overflowY: "auto",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
};
const title: React.CSSProperties = { fontWeight: 600, fontSize: 15, marginBottom: 6 };
const caveat: React.CSSProperties = { fontSize: 11, color: "#a5642a", marginBottom: 10 };
const section: React.CSSProperties = {
  border: "1px solid #d5dde4",
  borderRadius: 4,
  padding: 10,
  marginBottom: 10,
};
const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, marginBottom: 6, color: "#44586a" };
const subTitle: React.CSSProperties = { fontSize: 11, fontWeight: 600, margin: "8px 0 4px", color: "#66788a" };
const table: React.CSSProperties = { fontSize: 12, borderCollapse: "collapse", width: "100%" };
const th: React.CSSProperties = { textAlign: "left", padding: "2px 10px 2px 0", color: "#66788a", fontWeight: 500 };
const td: React.CSSProperties = { textAlign: "right", padding: "2px 16px 2px 0", fontVariantNumeric: "tabular-nums" };
const tdLeft: React.CSSProperties = { textAlign: "left", padding: "2px 16px 2px 0" };
const hint: React.CSSProperties = { fontSize: 11, color: "#66788a", marginTop: 4 };
const errorText: React.CSSProperties = { fontSize: 12, color: "#b3452f", marginBottom: 8 };
const btn: React.CSSProperties = {
  padding: "3px 10px",
  background: "#e6ecf1",
  border: "1px solid #c3ced9",
  borderRadius: 4,
  cursor: "pointer",
};
