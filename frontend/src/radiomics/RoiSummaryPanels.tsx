/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { RoiFeatureRow } from "../api";
import type { TFn } from "../i18n/i18n";
import { formatFeatureValue } from "./GlamFeatureTable";
import { SECONDARY_QUANTITIES, SIX_STATISTICS, summaryLines, type SummaryDef } from "./roiSummaryStats";

/**
 * 結果の表の上に出す「6 統計」「副次量」のまとめ欄。値は下の全特徴の表と同じ行（RadiomicsJ の列）を引くだけ。
 * 定義できない値（null）は 0 と書かず「—（未定義）」と出す。
 */
export function RoiSummaryPanels({ rows, t }: { rows: readonly RoiFeatureRow[]; t: TFn }) {
  return (
    <>
      <Panel title={t("roiFeat.six.title")} defs={SIX_STATISTICS} rows={rows} t={t} testId="roifeat-six" />
      <Panel title={t("roiFeat.secondary.title")} defs={SECONDARY_QUANTITIES} rows={rows} t={t} testId="roifeat-secondary" />
    </>
  );
}

function Panel({ title, defs, rows, t, testId }: {
  title: string; defs: readonly SummaryDef[]; rows: readonly RoiFeatureRow[]; t: TFn; testId: string;
}) {
  const lines = summaryLines(rows, defs);
  if (lines.length === 0) return null;
  return (
    <div style={box} data-testid={testId}>
      <div style={head}>{title}</div>
      <table style={tbl}>
        <tbody>
          {lines.map(({ label, row }) => (
            <tr key={row.column} data-column={row.column}>
              <td style={{ ...cell, fontWeight: 600, width: 110 }}>{label}</td>
              <td style={{ ...cell, textAlign: "right", width: 110 }} data-testid={`${testId}-${label}`}>
                {row.value == null ? t("roiFeat.summary.undefined") : formatFeatureValue(row.value)}
              </td>
              <td style={{ ...cell, width: 90, color: "#5a6672" }}>{row.ibsi ?? t("roiFeat.summary.nonIbsi")}</td>
              <td style={{ ...cell, color: "#6b7785" }}>
                {row.notes.filter((n) => n !== "NON_IBSI").map((n) => t(`roiFeat.note.${n}`)).join("・")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const box: React.CSSProperties = { border: "1px solid #dfe5ec", borderRadius: 8, padding: "8px 12px", marginTop: 10, maxWidth: 900 };
const head: React.CSSProperties = { fontWeight: 600, color: "#0b5cad", marginBottom: 4 };
const tbl: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12 };
const cell: React.CSSProperties = { padding: "2px 6px", verticalAlign: "top" };
