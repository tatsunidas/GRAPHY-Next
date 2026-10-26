/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useMemo, useState } from "react";
import type { RoiFeatureResult } from "../api";
import type { TFn } from "../i18n/i18n";
import { formatFeatureValue } from "./GlamFeatureTable";
import {
  DEFAULT_GROUPS, GROUP_NAMES, WideCsvError, duplicateScale, parseGroupText, roiFeatureWideCsv,
  roiFeatureWideDefinitionsCsv, scaleTable, type GroupName, type ScaleGroups,
} from "./roiScaleTable";

const GROUPS_KEY = "graphy.roiFeat.scaleGroups";

const textsOf = (g: ScaleGroups): Record<GroupName, string> =>
  ({ fine: g.fine.join(", "), medium: g.medium.join(", "), coarse: g.coarse.join(", ") });

/** 前回の割り当て（無い・壊れていれば文献の既定）。保存できなくても動く。 */
function loadTexts(): Record<GroupName, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "null");
    if (raw && GROUP_NAMES.every((g) => typeof raw[g] === "string")) return raw;
  } catch { /* 既定を使う */ }
  return textsOf(DEFAULT_GROUPS);
}

/**
 * 「統計 × スケール」の表。値は各スケールの結果の同じ列をそのまま写したもので、計算はしない。
 * 組（fine・medium・coarse）は見出しに添えるだけで、組ごとの値は作らない。
 */
export function ScaleCompareTable({ full, t, fileBase, caseLabel, onDownload }: {
  full: RoiFeatureResult;
  t: TFn;
  fileBase: string;
  caseLabel: string;
  onDownload: (text: string, filename: string) => void;
}) {
  const [texts, setTexts] = useState<Record<GroupName, string>>(loadTexts);
  const [message, setMessage] = useState<string | null>(null);
  /** 横長の CSV に 6 統計以外の共通の行も書くか（既定は 6 統計だけ）。 */
  const [others, setOthers] = useState(false);

  const parsed = GROUP_NAMES.map((g) => parseGroupText(texts[g]));
  const badName = GROUP_NAMES.find((_, i) => parsed[i] == null);
  const groups: ScaleGroups | null = parsed.every((p) => p != null)
    ? { fine: parsed[0]!, medium: parsed[1]!, coarse: parsed[2]! } : null;
  const dup = groups ? duplicateScale(groups) : null;
  const problem = badName ? t("roiFeat.compare.err.number", { group: badName })
    : dup != null ? t("roiFeat.compare.err.dup", { r: dup }) : null;
  // 割り当てが不正な間は既定で表を出し続け、書き出しだけ止める（値は割り当てに依らない）
  const usable = problem == null && groups ? groups : DEFAULT_GROUPS;
  const table = useMemo(() => scaleTable(full, usable), [full, usable]);

  const edit = (g: GroupName, v: string) => {
    const next = { ...texts, [g]: v };
    setTexts(next);
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify(next)); } catch { /* 保存は任意 */ }
  };
  const reset = () => {
    const d = textsOf(DEFAULT_GROUPS);
    setTexts(d);
    try { localStorage.removeItem(GROUPS_KEY); } catch { /* 保存は任意 */ }
  };

  const save = () => {
    setMessage(null);
    try {
      onDownload(roiFeatureWideCsv(full, caseLabel, usable, others), `${fileBase}_wide.csv`);
      onDownload(roiFeatureWideDefinitionsCsv(full, usable, others), `${fileBase}_wide_definitions.csv`);
    } catch (e) {
      if (e instanceof WideCsvError) setMessage(t("roiFeat.compare.err.write", { reason: e.message }));
      else throw e;
    }
  };

  const six = table.rows.filter((r) => r.label != null);
  const rest = table.rows.filter((r) => r.label == null);
  const groupLabel = (g: string) => t(`roiFeat.compare.group.${g}`);
  const fmt = (v: number | null) => (v == null ? t("roiFeat.summary.undefined") : formatFeatureValue(v));

  const renderRows = (rows: typeof table.rows, testId: string) => (
    <tbody data-testid={testId}>
      {rows.map((r) => (
        <tr key={r.base} data-column={r.base}>
          <td style={{ ...td, textAlign: "left", fontWeight: 600 }} title={r.base}>{r.label ?? r.base}</td>
          {r.values.map((v, i) => (
            <td key={table.columns[i].scaleMm} style={td}
              data-testid={`roifeat-compare-${r.label ?? r.base}-${table.columns[i].scaleMm}`}>{fmt(v)}</td>
          ))}
        </tr>
      ))}
    </tbody>
  );

  return (
    <div data-testid="roifeat-compare" style={{ marginTop: 8 }}>
      <div style={note}>{t("roiFeat.compare.note")}</div>
      {table.rows.length === 0 ? (
        <div style={warn} data-testid="roifeat-compare-empty">{t("roiFeat.compare.empty")}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={tbl} data-testid="roifeat-compare-table">
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "left" }} rowSpan={2}>{t("roiFeat.compare.statistic")}</th>
                {table.columns.map((c) => (
                  <th key={c.scaleMm} style={th} data-testid={`roifeat-compare-group-${c.scaleMm}`}
                    data-group={c.group}>{groupLabel(c.group)}</th>
                ))}
              </tr>
              <tr>
                {table.columns.map((c) => (
                  <th key={c.scaleMm} style={{ ...th, fontWeight: 400 }}>
                    r {c.scaleMm}{c.sigmaMm == null ? "" : <><br />σ {c.sigmaMm}</>}
                  </th>
                ))}
              </tr>
            </thead>
            {six.length > 0 && renderRows(six, "roifeat-compare-six")}
          </table>
          {rest.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: "pointer", fontSize: 12 }}>
                {t("roiFeat.compare.rest", { n: rest.length })}
              </summary>
              <table style={tbl} data-testid="roifeat-compare-rest-table">{renderRows(rest, "roifeat-compare-rest")}</table>
            </details>
          )}
        </div>
      )}
      <div style={{ ...row, marginTop: 8 }} data-testid="roifeat-compare-groups">
        <span style={{ fontSize: 12 }}>{t("roiFeat.compare.groups")}</span>
        {GROUP_NAMES.map((g) => (
          <label key={g} style={{ fontSize: 12 }}>
            {g}{" "}
            <input value={texts[g]} onChange={(e) => edit(g, e.target.value)} style={inp}
              data-testid={`roifeat-compare-input-${g}`} />
          </label>
        ))}
        <button onClick={reset} style={btn} data-testid="roifeat-compare-reset">{t("roiFeat.compare.reset")}</button>
      </div>
      {problem && <div style={warn} data-testid="roifeat-compare-problem">⚠ {problem}</div>}
      <div style={row}>
        {rest.length > 0 && six.length > 0 && (
          <label style={{ fontSize: 12 }}>
            <input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)}
              data-testid="roifeat-compare-others" /> {t("roiFeat.compare.others", { n: rest.length * table.columns.length })}
          </label>
        )}
        <button onClick={save} style={btn} disabled={problem != null || table.rows.length === 0}
          data-testid="roifeat-compare-csv">{t("roiFeat.compare.csv")}</button>
      </div>
      {message && <div style={warn} data-testid="roifeat-compare-error">⚠ {message}</div>}
    </div>
  );
}

const note: React.CSSProperties = { fontSize: 12, color: "#5a6672", margin: "4px 0" };
const warn: React.CSSProperties = { fontSize: 12, color: "#8a4b00", background: "#fff6e5", padding: "4px 8px", borderRadius: 6, margin: "6px 0" };
const tbl: React.CSSProperties = { borderCollapse: "collapse", fontSize: 12, marginTop: 6 };
const th: React.CSSProperties = { border: "1px solid #dfe5ec", padding: "2px 8px", background: "#f5f7fa", textAlign: "right" };
const td: React.CSSProperties = {
  border: "1px solid #dfe5ec", padding: "2px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums",
};
const row: React.CSSProperties = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "6px 0" };
const inp: React.CSSProperties = { width: 90, fontSize: 12, padding: "2px 4px" };
const btn: React.CSSProperties = { fontSize: 12, padding: "3px 10px", cursor: "pointer" };
