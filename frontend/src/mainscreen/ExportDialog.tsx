/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState } from "react";
import {
  exportZip,
  fetchSeries,
  fetchStudies,
  type ExportSelection,
  type Series,
  type Study,
} from "../api";
import { fetchPatients, type Patient } from "../dbadmin/dbAdminApi";
import { useI18n } from "../i18n/i18n";

/**
 * Export: 複数患者を選択 → そのスタディ/シリーズをツリー表示 → 選択シリーズを
 * DICOM 交換メディア（PS3.10）形式の ZIP として書き出す。
 *
 * Export 対象の粒度は<b>シリーズ</b>。スタディのチェックは配下シリーズの一括選択トグル
 * （スタディが選択されていても、実際に Export されるのは選択中シリーズのみ）。
 */
export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();

  // 患者検索・選択
  const [pq, setPq] = useState("");
  const [patients, setPatients] = useState<Patient[] | null>(null);
  const [selectedPatients, setSelectedPatients] = useState<Set<string>>(new Set());

  // ツリー（選択患者のスタディ/シリーズ）
  const [studiesByPatient, setStudiesByPatient] = useState<Map<string, Study[]>>(new Map());
  const [seriesByStudy, setSeriesByStudy] = useState<Map<string, Series[]>>(new Map());
  const [expandedStudies, setExpandedStudies] = useState<Set<string>>(new Set());
  const [checkedSeries, setCheckedSeries] = useState<Set<string>>(new Set());
  const [seriesStudy] = useState<Map<string, string>>(() => new Map());

  // オプション
  const [includeDicomDir, setIncludeDicomDir] = useState(false);
  const [includePortable, setIncludePortable] = useState(false);
  const [includeReadme, setIncludeReadme] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    fetchPatients("")
      .then(setPatients)
      .catch((e: unknown) => setError(String(e)));
  }, [open]);

  if (!open) return null;

  const searchPatients = () => {
    setError(null);
    fetchPatients(pq)
      .then(setPatients)
      .catch((e: unknown) => setError(String(e)));
  };

  // 患者チェック → スタディ読み込み / 解除 → 配下選択を破棄
  const togglePatient = async (pid: string) => {
    const next = new Set(selectedPatients);
    if (next.has(pid)) {
      next.delete(pid);
      setSelectedPatients(next);
      // 配下スタディのシリーズ選択を破棄（隠れた選択で誤 Export を防ぐ）
      const studies = studiesByPatient.get(pid) ?? [];
      const cs = new Set(checkedSeries);
      for (const st of studies) {
        for (const ser of seriesByStudy.get(st.studyInstanceUid) ?? []) {
          cs.delete(ser.seriesInstanceUid);
        }
      }
      setCheckedSeries(cs);
      return;
    }
    next.add(pid);
    setSelectedPatients(next);
    if (!studiesByPatient.has(pid)) {
      try {
        const studies = await fetchStudies({ patientId: pid });
        setStudiesByPatient((m) => new Map(m).set(pid, studies));
      } catch (e) {
        setError(String(e));
      }
    }
  };

  const loadSeries = async (studyUid: string): Promise<Series[]> => {
    const cached = seriesByStudy.get(studyUid);
    if (cached) return cached;
    const series = await fetchSeries(studyUid);
    for (const s of series) seriesStudy.set(s.seriesInstanceUid, studyUid);
    setSeriesByStudy((m) => new Map(m).set(studyUid, series));
    return series;
  };

  const toggleExpand = async (studyUid: string) => {
    const next = new Set(expandedStudies);
    if (next.has(studyUid)) {
      next.delete(studyUid);
    } else {
      next.add(studyUid);
      try {
        await loadSeries(studyUid);
      } catch (e) {
        setError(String(e));
      }
    }
    setExpandedStudies(next);
  };

  const toggleSeries = (seriesUid: string, studyUid: string) => {
    seriesStudy.set(seriesUid, studyUid);
    const cs = new Set(checkedSeries);
    if (cs.has(seriesUid)) cs.delete(seriesUid);
    else cs.add(seriesUid);
    setCheckedSeries(cs);
  };

  // スタディのチェック状態（配下シリーズから導出）
  const studyCheckState = (studyUid: string): "all" | "some" | "none" => {
    const series = seriesByStudy.get(studyUid);
    if (!series || series.length === 0) return "none";
    const n = series.filter((s) => checkedSeries.has(s.seriesInstanceUid)).length;
    return n === 0 ? "none" : n === series.length ? "all" : "some";
  };

  const toggleStudy = async (studyUid: string) => {
    let series = seriesByStudy.get(studyUid);
    if (!series) {
      try {
        series = await loadSeries(studyUid);
        setExpandedStudies((s) => new Set(s).add(studyUid));
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    const cs = new Set(checkedSeries);
    const allChecked = series.every((s) => cs.has(s.seriesInstanceUid));
    for (const s of series) {
      seriesStudy.set(s.seriesInstanceUid, studyUid);
      if (allChecked) cs.delete(s.seriesInstanceUid);
      else cs.add(s.seriesInstanceUid);
    }
    setCheckedSeries(cs);
  };

  const buildSelections = (): ExportSelection[] => {
    const byStudy = new Map<string, string[]>();
    for (const seriesUid of checkedSeries) {
      const studyUid = seriesStudy.get(seriesUid);
      if (!studyUid) continue;
      if (!byStudy.has(studyUid)) byStudy.set(studyUid, []);
      byStudy.get(studyUid)!.push(seriesUid);
    }
    return [...byStudy].map(([studyUid, seriesUids]) => ({ studyUid, seriesUids }));
  };

  const run = async () => {
    const selections = buildSelections();
    if (selections.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { blob, filename } = await exportZip({
        selections,
        includeDicomDir,
        includePortableViewer: includePortable,
        includeReadme,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const selectedSeriesCount = checkedSeries.size;
  const dicomDirForced = includePortable; // portable viewer は DICOMDIR を必須化

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("export.title")}</span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>

        <div style={body}>
          {/* 左: 患者検索・選択 */}
          <div style={leftPane}>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <input
                value={pq}
                onChange={(e) => setPq(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchPatients()}
                placeholder={t("export.patient.search")}
                style={input}
              />
              <button onClick={searchPatients} style={btn}>
                {t("common.search")}
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#667", marginBottom: 6 }}>{t("export.patient.hint")}</div>
            <div style={listScroll}>
              {!patients && <div style={{ color: "#888" }}>{t("common.loading")}</div>}
              {patients && patients.length === 0 && (
                <div style={{ color: "#888" }}>{t("common.noData")}</div>
              )}
              {patients?.map((p) => (
                <label key={p.patientId} style={patientRow}>
                  <input
                    type="checkbox"
                    checked={selectedPatients.has(p.patientId)}
                    onChange={() => void togglePatient(p.patientId)}
                  />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <b>{p.patientName || "—"}</b>
                    <span style={{ color: "#8a98a6", fontSize: 11 }}> {p.patientId}</span>
                    <span style={{ color: "#8a98a6", fontSize: 11 }}>
                      {" "}
                      ({t("field.studyCount")}: {p.numberOfStudies})
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* 右: 選択患者のスタディ/シリーズツリー */}
          <div style={rightPane}>
            {selectedPatients.size === 0 ? (
              <div style={{ color: "#888", padding: 12 }}>{t("export.tree.empty")}</div>
            ) : (
              [...selectedPatients].map((pid) => {
                const studies = studiesByPatient.get(pid);
                const pat = patients?.find((p) => p.patientId === pid);
                return (
                  <div key={pid} style={{ marginBottom: 10 }}>
                    <div style={patientHead}>
                      {pat?.patientName || pid}
                      <span style={{ color: "#8a98a6", fontSize: 11 }}> {pid}</span>
                    </div>
                    {!studies && <div style={{ color: "#888", paddingLeft: 18 }}>{t("common.loading")}</div>}
                    {studies?.length === 0 && (
                      <div style={{ color: "#888", paddingLeft: 18 }}>{t("study.empty")}</div>
                    )}
                    {studies?.map((st) => {
                      const expanded = expandedStudies.has(st.studyInstanceUid);
                      const cstate = studyCheckState(st.studyInstanceUid);
                      const series = seriesByStudy.get(st.studyInstanceUid);
                      return (
                        <div key={st.studyInstanceUid}>
                          <div style={studyRow}>
                            <button
                              style={expander}
                              onClick={() => void toggleExpand(st.studyInstanceUid)}
                              aria-label="expand"
                            >
                              {expanded ? "▾" : "▸"}
                            </button>
                            <TriCheckbox
                              state={cstate}
                              onChange={() => void toggleStudy(st.studyInstanceUid)}
                            />
                            <span
                              style={{ cursor: "pointer" }}
                              onClick={() => void toggleExpand(st.studyInstanceUid)}
                            >
                              {st.studyDate || "—"} / {st.studyDescription || "—"}
                              <span style={{ color: "#8a98a6", fontSize: 11 }}>
                                {" "}
                                {st.modality || ""} ({st.numberOfInstances})
                              </span>
                            </span>
                          </div>
                          {expanded && (
                            <div style={{ paddingLeft: 40 }}>
                              {!series && <div style={{ color: "#888" }}>{t("common.loading")}</div>}
                              {series?.length === 0 && (
                                <div style={{ color: "#888" }}>{t("series.empty")}</div>
                              )}
                              {series?.map((ser) => (
                                <label key={ser.seriesInstanceUid} style={seriesRow}>
                                  <input
                                    type="checkbox"
                                    checked={checkedSeries.has(ser.seriesInstanceUid)}
                                    onChange={() =>
                                      toggleSeries(ser.seriesInstanceUid, st.studyInstanceUid)
                                    }
                                  />
                                  <span>
                                    #{ser.seriesNumber ?? "—"} {ser.modality || ""}{" "}
                                    {ser.seriesDescription || "—"}
                                    <span style={{ color: "#8a98a6", fontSize: 11 }}>
                                      {" "}
                                      ({ser.numberOfInstances})
                                    </span>
                                  </span>
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* オプション + 実行 */}
        <div style={footer}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", flex: 1 }}>
            <label style={opt}>
              <input
                type="checkbox"
                checked={includeDicomDir || dicomDirForced}
                disabled={dicomDirForced}
                onChange={(e) => setIncludeDicomDir(e.target.checked)}
              />
              {t("export.opt.dicomdir")}
            </label>
            <label style={opt}>
              <input
                type="checkbox"
                checked={includePortable}
                onChange={(e) => setIncludePortable(e.target.checked)}
              />
              {t("export.opt.portable")}
            </label>
            <label style={opt}>
              <input
                type="checkbox"
                checked={includeReadme}
                onChange={(e) => setIncludeReadme(e.target.checked)}
              />
              {t("export.opt.readme")}
            </label>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, color: "#556" }}>
              {t("export.selectedCount", { count: selectedSeriesCount })}
            </span>
            <button onClick={onClose} style={btn}>
              {t("common.close")}
            </button>
            <button
              onClick={run}
              disabled={busy || selectedSeriesCount === 0}
              style={{
                ...btn,
                background: busy || selectedSeriesCount === 0 ? "#9fb6cf" : "#0b5cad",
                color: "#fff",
                cursor: busy || selectedSeriesCount === 0 ? "default" : "pointer",
              }}
            >
              {busy ? t("export.running") : t("export.run")}
            </button>
          </div>
        </div>
        {error && <div style={{ color: "#b00020", padding: "0 16px 10px" }}>{error}</div>}
      </div>
    </div>
  );
}

/** indeterminate を扱える 3 状態チェックボックス。 */
function TriCheckbox({ state, onChange }: { state: "all" | "some" | "none"; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return <input ref={ref} type="checkbox" checked={state === "all"} onChange={onChange} />;
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
  width: 920,
  maxWidth: "96vw",
  height: 640,
  maxHeight: "92vh",
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
const body: React.CSSProperties = { flex: 1, display: "flex", minHeight: 0 };
const leftPane: React.CSSProperties = {
  width: 300,
  borderRight: "1px solid #eee",
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};
const rightPane: React.CSSProperties = { flex: 1, overflow: "auto", padding: "12px 16px", fontSize: 13 };
const listScroll: React.CSSProperties = { flex: 1, overflow: "auto", border: "1px solid #eef1f4", borderRadius: 6 };
const patientRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 8px",
  fontSize: 13,
  borderBottom: "1px solid #f3f5f7",
  cursor: "pointer",
};
const patientHead: React.CSSProperties = { fontWeight: 700, fontSize: 13, padding: "2px 0", color: "#223" };
const studyRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "3px 0" };
const seriesRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "2px 0", cursor: "pointer" };
const expander: React.CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 12,
  width: 16,
  color: "#667",
  padding: 0,
};
const footer: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 16px",
  borderTop: "1px solid #eee",
};
const opt: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" };
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const input: React.CSSProperties = { padding: "6px 8px", border: "1px solid #cdd5de", borderRadius: 6, fontSize: 13, flex: 1, boxSizing: "border-box" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
