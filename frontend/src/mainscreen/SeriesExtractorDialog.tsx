/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchStudies,
  fetchTagDictionary,
  seriesExtractCopy,
  seriesExtractVerify,
  seriesExtractZip,
  type SeriesCondition,
  type SeriesVerifyResult,
  type StudyFilters,
  type TagDictEntry,
  type TagPath,
} from "../api";
import { desktop } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import { NestedTagBuilder } from "./NestedTagBuilder";
import { dictMap, pathDisplay, parseConditions, serializeConditions } from "./tagPathUtil";

const PLANES = ["AXIAL", "SAGITTAL", "CORONAL"];
const NUMERIC_VR = new Set(["DS", "IS", "FL", "FD", "SL", "SS", "UL", "US"]);
const DATETIME_VR = new Set(["DA", "DT", "TM"]);

function opsForVr(vr: string): string[] {
  const v = (vr || "").toUpperCase();
  if (NUMERIC_VR.has(v) || DATETIME_VR.has(v)) return ["EQUALS", "GE", "LE", "RANGE"];
  return ["EQUALS", "CONTAINS"];
}

/**
 * SeriesExtractor（GRAPHY 移植）。タグ条件（Include/Exclude・演算子・シーケンス/Private）＋平面フィルタで
 * 検索リスト全体から一致シリーズを検証し、standalone は親フォルダへコピー、web は ZIP で取得する。
 */
export function SeriesExtractorDialog({
  open,
  onClose,
  filters,
  mode,
}: {
  open: boolean;
  onClose: () => void;
  filters: StudyFilters | null;
  mode: string;
}) {
  const { t } = useI18n();
  const isWeb = mode === "web";
  const [dict, setDict] = useState<TagDictEntry[]>([]);
  const dmap = useMemo(() => dictMap(dict), [dict]);

  const [conditions, setConditions] = useState<SeriesCondition[]>([]);
  const [planes, setPlanes] = useState<Set<string>>(new Set());
  const [sequentialRename, setSequentialRename] = useState(true);
  const [destination, setDestination] = useState<string | null>(null);
  const [nestedOpen, setNestedOpen] = useState(false);

  const [result, setResult] = useState<SeriesVerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || dict.length > 0) return;
    fetchTagDictionary().then(setDict).catch(() => setError(t("tagext.err.dict")));
  }, [open, dict.length, t]);

  if (!open) return null;

  const vrOfPath = (p: TagPath): string => {
    const last = p.segments[p.segments.length - 1];
    return last ? dmap.get(last.tag)?.vr ?? "" : "";
  };

  const addCondition = (p: TagPath) => {
    const vr = vrOfPath(p);
    const op = opsForVr(vr)[0];
    setConditions((cs) => [...cs, { segments: p.segments, vr, exclude: false, op, value1: "", value2: "" }]);
    setNestedOpen(false);
  };
  const updateCond = (i: number, patch: Partial<SeriesCondition>) =>
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const removeCond = (i: number) => setConditions((cs) => cs.filter((_, idx) => idx !== i));

  const togglePlane = (p: string) =>
    setPlanes((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const resolveStudyUids = async (): Promise<string[] | null> => {
    if (!filters) {
      setError(t("tagext.err.noSearch"));
      return null;
    }
    const studies = await fetchStudies(filters);
    if (studies.length === 0) {
      setError(t("tagext.err.noStudies"));
      return null;
    }
    return studies.map((s) => s.studyInstanceUid);
  };

  const req = (studyUids: string[]) => ({
    studyUids,
    conditions: conditions.map((c) => ({ ...c, segments: c.segments })),
    planes: [...planes],
    destination: destination ?? undefined,
    sequentialRename,
  });

  const verify = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const studyUids = await resolveStudyUids();
      if (!studyUids) return;
      const r = await seriesExtractVerify(req(studyUids));
      setResult(r);
      setInfo(t("seriesext.verified", { series: r.seriesCount, studies: r.studyCount }));
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const pickDest = async () => {
    const d = desktop();
    if (d?.pickDirectory) {
      const p = await d.pickDirectory();
      if (p) setDestination(p);
    } else {
      setError(t("seriesext.err.noPicker"));
    }
  };

  const extract = async () => {
    if (!result || result.seriesCount === 0) {
      setError(t("seriesext.err.verifyFirst"));
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const studyUids = await resolveStudyUids();
      if (!studyUids) return;
      if (isWeb) {
        const { blob, filename } = await seriesExtractZip(req(studyUids));
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setInfo(t("seriesext.zipped"));
      } else {
        if (!destination) {
          setError(t("seriesext.err.noDest"));
          return;
        }
        const r = await seriesExtractCopy(req(studyUids));
        setInfo(t("seriesext.copied", { series: r.copiedSeries, files: r.copiedFiles }));
        if (r.errors.length > 0) setError(r.errors.slice(0, 3).join(" / "));
      }
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const saveConditions = () => {
    const blob = new Blob([serializeConditions(conditions, [...planes])], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "series-conditions.properties";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  const loadConditions = async (file: File) => {
    try {
      const { conditions: cs, planes: ps } = parseConditions(await file.text());
      setConditions(cs);
      setPlanes(new Set(ps));
      setInfo(t("seriesext.loaded", { count: cs.length }));
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    }
  };

  const canExtract = !busy && !!result && result.seriesCount > 0 && (isWeb || !!destination);

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("seriesext.title")}</span>
          <button style={closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: "10px 16px", borderBottom: "1px solid #eef1f4", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, color: "#6b7785" }}>{t("tagext.scope.searchList")}</div>

          {/* 条件リスト */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#33404d" }}>{t("seriesext.conditions")}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button style={btn} onClick={() => setNestedOpen(true)}>{t("seriesext.addCondition")}</button>
              <button style={miniBtn} onClick={saveConditions} disabled={conditions.length === 0} title={t("seriesext.saveConditions")}>💾</button>
              <button style={miniBtn} onClick={() => fileInputRef.current?.click()} title={t("seriesext.loadConditions")}>📂</button>
              <input ref={fileInputRef} type="file" accept=".properties,.txt" style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadConditions(f); e.target.value = ""; }} />
            </div>
          </div>
          <div style={condBox}>
            {conditions.length === 0 && <div style={{ color: "#8a98a6", fontSize: 12, padding: 4 }}>{t("seriesext.conditions.empty")}</div>}
            {conditions.map((c, i) => (
              <div key={i} style={condRow}>
                <select style={sel} value={c.exclude ? "ex" : "in"} onChange={(e) => updateCond(i, { exclude: e.target.value === "ex" })}>
                  <option value="in">{t("seriesext.include")}</option>
                  <option value="ex">{t("seriesext.exclude")}</option>
                </select>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5 }}
                  title={pathDisplay(dmap, { segments: c.segments, label: "" })}>
                  {pathDisplay(dmap, { segments: c.segments, label: "" })} <span style={{ color: "#8a98a6" }}>{c.vr}</span>
                </span>
                <select style={sel} value={c.op} onChange={(e) => updateCond(i, { op: e.target.value })}>
                  {opsForVr(c.vr).map((op) => <option key={op} value={op}>{t(`seriesext.op.${op}`)}</option>)}
                </select>
                <input style={{ ...inp, width: 110 }} value={c.value1} onChange={(e) => updateCond(i, { value1: e.target.value })} placeholder={t("seriesext.value")} />
                {c.op === "RANGE" && (
                  <input style={{ ...inp, width: 110 }} value={c.value2} onChange={(e) => updateCond(i, { value2: e.target.value })} placeholder={t("seriesext.value2")} />
                )}
                <button style={{ ...miniBtn, color: "#b00020" }} onClick={() => removeCond(i)}>✕</button>
              </div>
            ))}
          </div>

          {/* 平面フィルタ + オプション */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "#556" }}>{t("seriesext.plane")}:</span>
            {PLANES.map((p) => (
              <label key={p} style={opt}>
                <input type="checkbox" checked={planes.has(p)} onChange={() => togglePlane(p)} />
                {t(`seriesext.plane.${p}`)}
              </label>
            ))}
            <label style={opt}>
              <input type="checkbox" checked={sequentialRename} onChange={(e) => setSequentialRename(e.target.checked)} />
              {t("seriesext.sequential")}
            </label>
          </div>

          {/* 出力先 */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {isWeb ? (
              <span style={{ fontSize: 12, color: "#6b7785" }}>{t("seriesext.webZipNote")}</span>
            ) : (
              <>
                <button style={btn} onClick={() => void pickDest()}>{t("seriesext.pickDest")}</button>
                <span style={{ fontSize: 12, color: destination ? "#33404d" : "#8a98a6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {destination ?? t("seriesext.noDest")}
                </span>
              </>
            )}
          </div>
        </div>

        {/* 検証結果 */}
        <div style={resultPane}>
          {!result && <div style={{ color: "#8a98a6", fontSize: 12 }}>{t("seriesext.notVerified")}</div>}
          {result && (
            <div style={{ overflow: "auto", height: "100%" }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>{t("qr.col.studyDate")}</th>
                    <th style={th}>{t("field.patientId")}</th>
                    <th style={th}>{t("qr.col.modality")}</th>
                    <th style={th}>{t("qr.col.seriesDesc")}</th>
                    <th style={th}>{t("qr.col.instances")}</th>
                    <th style={th}>{t("seriesext.folder")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.matched.map((m, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #eef1f4" }}>
                      <td style={td}>{m.studyDate}</td>
                      <td style={td}>{m.patientId}</td>
                      <td style={td}>{m.modality}</td>
                      <td style={td}>{m.seriesDescription}</td>
                      <td style={td}>{m.instances}</td>
                      <td style={td} title={m.folderName}>{m.folderName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.errors.length > 0 && (
                <div style={errBox}>{result.errors.slice(0, 30).map((e, i) => <div key={i}>{e}</div>)}</div>
              )}
            </div>
          )}
        </div>

        <div style={footer}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {info && <span style={{ color: "#2e5d27" }}>{info}</span>}
            {error && <span style={{ color: "#b00020" }}>{error}</span>}
          </div>
          <button style={btn} onClick={onClose}>{t("common.close")}</button>
          <button style={btn} onClick={() => void verify()} disabled={busy}>{busy ? t("seriesext.verifying") : t("seriesext.verify")}</button>
          <button
            style={{ ...btn, background: canExtract ? "#0b5cad" : "#9fb6cf", color: "#fff", border: "none", cursor: canExtract ? "pointer" : "default" }}
            onClick={() => void extract()}
            disabled={!canExtract}
          >
            {isWeb ? t("seriesext.downloadZip") : t("seriesext.extract")}
          </button>
        </div>
      </div>

      <NestedTagBuilder
        open={nestedOpen}
        dict={dict}
        dictMapByTag={dmap}
        onClose={() => setNestedOpen(false)}
        onConfirm={addCondition}
      />
    </div>
  );
}

const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 };
const dialog: React.CSSProperties = { width: 920, maxWidth: "97vw", height: 700, maxHeight: "94vh", background: "#fff", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "system-ui, sans-serif", color: "#1a1a1a" };
const header: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #eee" };
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const condBox: React.CSSProperties = { border: "1px solid #e1e7ee", borderRadius: 6, padding: 6, maxHeight: 180, overflow: "auto", display: "flex", flexDirection: "column", gap: 4, background: "#fafbfc" };
const condRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const resultPane: React.CSSProperties = { flex: 1, minHeight: 0, padding: "8px 16px", overflow: "hidden" };
const tableStyle: React.CSSProperties = { borderCollapse: "collapse", fontSize: 12, width: "100%", whiteSpace: "nowrap" };
const th: React.CSSProperties = { position: "sticky", top: 0, background: "#f7f9fb", border: "1px solid #e1e7ee", padding: "4px 8px", textAlign: "left", fontWeight: 600 };
const td: React.CSSProperties = { border: "1px solid #eef1f4", padding: "3px 8px", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" };
const errBox: React.CSSProperties = { marginTop: 8, padding: 8, background: "#fff4f4", border: "1px solid #f0d0d0", borderRadius: 6, fontSize: 11.5, color: "#a11" };
const footer: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderTop: "1px solid #eee" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" };
const miniBtn: React.CSSProperties = { minWidth: 26, padding: "4px 8px", border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 13 };
const sel: React.CSSProperties = { padding: "4px 6px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 12.5 };
const inp: React.CSSProperties = { padding: "4px 7px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 12.5 };
const opt: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, cursor: "pointer" };
